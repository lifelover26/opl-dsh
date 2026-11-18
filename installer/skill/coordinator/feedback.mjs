/** Read public feedback metadata and send reserved coordinator intents through Codex queue. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

const taskStates = new Set([
  'queued',
  'accepted',
  'running',
  'waiting_approval',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
])
const deliveryStages = new Set(['enqueued', 'delivered', 'received', 'review-started'])
const receiptStages = ['received', 'review-started', 'consumed']
const humanStates = new Set(['waiting_approval', 'waiting_input'])
const textId = (value) =>
  typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f]/u.test(value)
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function assertProject(project) {
  if (
    !project ||
    !textId(project.projectId) ||
    !textId(project.threadId) ||
    project.threadId === 'manual' ||
    !Number.isSafeInteger(project.authorityEpoch) ||
    project.authorityEpoch < 1 ||
    !Array.isArray(project.workItems)
  )
    throw new Error('Invalid registered feedback project')
  const seen = new Set()
  for (const work of project.workItems) {
    if (!textId(work.workId)) throw new Error('Invalid registered workId')
    if (work.taskId === undefined && work.operationId === undefined) continue
    if (!textId(work.taskId) || !textId(work.operationId) || seen.has(work.taskId))
      throw new Error('Feedback taskId and operationId must be registered exactly once')
    seen.add(work.taskId)
  }
}

function event(project, type, fields) {
  return {
    eventId: 'dsh-feedback-' + digest([project.projectId, project.authorityEpoch, type, fields]),
    type,
    authorityEpoch: project.authorityEpoch,
    ...fields,
  }
}

function unavailable(reason) {
  return { status: 'unavailable', reason, observations: [], pending: [], consumed: [], events: [] }
}

function targetMatches(record, project) {
  return record.target?.kind === 'codex-thread' && record.target.threadId === project.threadId
}

function executionMatches(record, work) {
  return (
    record.execution?.kind === 'dsh-session' ||
    (record.execution?.kind === 'harness-session' &&
      record.execution.operationId === work.operationId)
  )
}

function sameExecution(a, b) {
  return ['kind', 'harnessSessionId', 'harnessRef', 'combination', 'taskId', 'operationId'].every(
    (key) => a?.[key] === b?.[key],
  )
}

/** Pick one public snapshot row without relying on response order. Conflicting versions fail closed. */
function newest(
  rows,
  id,
  fields,
  compare = (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
) {
  const byId = new Map()
  for (const row of rows) {
    if (!timestamp(row.updatedAt)) throw new Error('Invalid feedback timestamp')
    const prior = byId.get(row[id])
    if (!prior || compare(row, prior) > 0) byId.set(row[id], row)
    else if (
      compare(row, prior) === 0 &&
      fields.some((field) => JSON.stringify(row[field]) !== JSON.stringify(prior[field]))
    )
      throw new Error('Conflicting feedback rows')
  }
  return byId
}

/**
 * Project only exact registered task/operation references; never return prompts, summaries or questions.
 * Receipt consumption closes a notification, not a work item. Lease expiry grants no retry permission.
 * @param {object} project Registered project with threadId, authorityEpoch and workItems.
 * @param {object} snapshot Public tasks, outbox and receipts arrays; reads may span different commits.
 * @returns {object} Metadata observations and idempotent coordinator events, or unavailable on invalid data.
 */
export function projectFeedback(project, snapshot) {
  assertProject(project)
  if (!snapshot || !['tasks', 'outbox', 'receipts'].every((key) => Array.isArray(snapshot[key])))
    return unavailable('invalid-feedback')
  try {
    const bindings = new Map(
      project.workItems
        .filter((work) => work.taskId !== undefined)
        .map((work) => [work.taskId, work]),
    )
    const tasks = newest(
      snapshot.tasks.filter(
        (task) =>
          bindings.has(task?.taskId) &&
          targetMatches(task, project) &&
          executionMatches(task, bindings.get(task.taskId)),
      ),
      'taskId',
      ['state', 'execution', 'target'],
    )
    const outbox = newest(
      snapshot.outbox.filter(
        (delivery) => tasks.has(delivery?.taskId) && targetMatches(delivery, project),
      ),
      'deliveryId',
      ['taskId', 'stage', 'retired', 'payload'],
    )
    const receipts = newest(
      snapshot.receipts.filter((receipt) => tasks.has(receipt?.taskId)),
      'deliveryId',
      ['taskId', 'status', 'ownerId', 'claimEpoch'],
      (a, b) => {
        // Consumption cannot be undone by a stale response or a renewed claim.
        if (a.status === 'consumed' || b.status === 'consumed')
          return (
            Number(a.status === 'consumed') - Number(b.status === 'consumed') ||
            Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
          )
        return (
          a.claimEpoch - b.claimEpoch ||
          receiptStages.indexOf(a.status) - receiptStages.indexOf(b.status) ||
          Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
        )
      },
    )
    const observations = [],
      pending = [],
      consumed = [],
      events = []
    for (const task of [...tasks.values()].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
      if (!taskStates.has(task.state)) throw new Error('Unknown task state')
      const work = bindings.get(task.taskId)
      const observation = {
        workId: work.workId,
        taskId: task.taskId,
        operationId: work.operationId,
        state: task.state,
        updatedAt: task.updatedAt,
        ...(task.execution?.kind === 'harness-session' && textId(task.execution.harnessSessionId)
          ? { harnessSessionId: task.execution.harnessSessionId }
          : {}),
      }
      observations.push(observation)
      if (humanStates.has(task.state) || ['cancelled', 'disconnected'].includes(task.state)) {
        events.push(
          event(project, 'work.update', {
            workId: work.workId,
            taskId: task.taskId,
            operationId: work.operationId,
            status: humanStates.has(task.state) ? 'waiting_human' : 'blocked',
            evidence: { source: 'dsh-feedback', state: task.state, observedAt: task.updatedAt },
          }),
        )
      }
    }
    for (const delivery of [...outbox.values()].sort((a, b) =>
      a.deliveryId.localeCompare(b.deliveryId),
    )) {
      const work = bindings.get(delivery.taskId),
        task = tasks.get(delivery.taskId)
      if (
        !textId(delivery.deliveryId) ||
        !deliveryStages.has(delivery.stage) ||
        typeof delivery.retired !== 'boolean' ||
        delivery.payload?.taskId !== delivery.taskId ||
        !taskStates.has(delivery.payload.state) ||
        !executionMatches(delivery.payload, work) ||
        !sameExecution(delivery.payload.execution, task.execution)
      )
        throw new Error('Invalid registered delivery')
      const receipt = receipts.get(delivery.deliveryId)
      if (
        receipt &&
        (receipt.taskId !== delivery.taskId ||
          !receiptStages.includes(receipt.status) ||
          !Number.isSafeInteger(receipt.claimEpoch) ||
          receipt.claimEpoch < 0 ||
          !(receipt.ownerId === null || textId(receipt.ownerId)) ||
          !(receipt.leaseExpiresAt === null || timestamp(receipt.leaseExpiresAt)))
      )
        throw new Error('Invalid registered receipt')
      if (receipt?.status === 'consumed') {
        const item = {
          deliveryId: delivery.deliveryId,
          taskId: delivery.taskId,
          workId: work.workId,
          operationId: work.operationId,
        }
        consumed.push(item)
        events.push(event(project, 'feedback.consumed', item))
        continue
      }
      if (delivery.retired) continue
      const item = {
        deliveryId: delivery.deliveryId,
        taskId: delivery.taskId,
        workId: work.workId,
        operationId: work.operationId,
        state: task.state,
        deliveryState: delivery.payload.state,
        stage: delivery.stage,
        receiptStatus: receipt?.status ?? null,
        claimEpoch: receipt?.claimEpoch ?? null,
        consumerId: receipt?.ownerId ?? null,
        leaseExpiresAt: receipt?.leaseExpiresAt ?? null,
        stale: humanStates.has(delivery.payload.state) && delivery.payload.state !== task.state,
      }
      pending.push(item)
      // Renewal timestamps do not create a new reason to wake the same reviewer.
      const { leaseExpiresAt: _lease, ...stable } = item
      events.push(event(project, 'feedback.pending', stable))
    }
    return { status: 'available', observations, pending, consumed, events }
  } catch {
    // Public output may change across releases; unavailable never authorizes a worker retry.
    return unavailable('invalid-feedback')
  }
}

/**
 * Bounded argv-only process adapter. Output is private to the parser; callers never surface child errors.
 * @param {string} command Executable to run.
 * @param {string[]} args Unquoted argv.
 * @param {object} options Deadline and output limit.
 * @returns {Promise<object>} Exit evidence; timeout or buffer exhaustion does not prove refusal.
 */
export function runProcess(command, args, { timeoutMs = 15000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer },
      (error, stdout) => {
        if (!error) return resolve({ outcome: 'exited', code: 0, stdout })
        if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code))
          return resolve({ outcome: 'not-started', code: null, stdout: '' })
        resolve({
          outcome: error.killed
            ? 'timed-out'
            : typeof error.code === 'number'
              ? 'exited'
              : 'unknown',
          code: typeof error.code === 'number' ? error.code : null,
          stdout: '',
        })
      },
    )
  })
}

/**
 * Query the installed helper, which alone owns IPC credentials. These three commands never autostart DSH.
 * @param {object} options Absolute controlPath, registered project and optional process adapter.
 * @returns {Promise<object>} Safe projection, or unavailable without launching a desktop or returning raw errors.
 */
export async function readFeedback({ controlPath, project, run = runProcess, timeoutMs = 15000 }) {
  assertProject(project)
  if (typeof controlPath !== 'string' || !isAbsolute(controlPath))
    throw new Error('controlPath must be an absolute installed helper path')
  try {
    const commands = ['tasks', 'outbox', 'receipts']
    const settled = await Promise.allSettled(
      commands.map((command) =>
        run(process.execPath, [controlPath, command, '--no-autostart'], { timeoutMs }),
      ),
    )
    if (settled.some((result) => result.status !== 'fulfilled'))
      return unavailable('dsh-unavailable')
    const results = settled.map((result) => result.value)
    if (results.some((result) => result?.outcome !== 'exited' || result.code !== 0))
      return unavailable('dsh-unavailable')
    return projectFeedback(
      project,
      Object.fromEntries(results.map((result, i) => [commands[i], JSON.parse(result.stdout)])),
    )
  } catch {
    // Neither private bridge errors nor arbitrary process output belong in coordinator diagnostics.
    return unavailable('dsh-unavailable')
  }
}

/**
 * Read the active collaboration plugin's public queue configuration through the installed helper.
 * Local coordinator files never own a second copy of the wake settings.
 * @param {object} options Absolute helper path and optional bounded process adapter.
 * @returns {Promise<object>} Current queue configuration, or unavailable without starting DSH.
 */
export async function readWakeSettings({ controlPath, run = runProcess, timeoutMs = 15000 }) {
  if (typeof controlPath !== 'string' || !isAbsolute(controlPath))
    throw new Error('controlPath must be an absolute installed helper path')
  try {
    const result = await run(
      process.execPath,
      [controlPath, 'coordination-status', '--no-autostart'],
      { timeoutMs },
    )
    if (result?.outcome !== 'exited' || result.code !== 0)
      return unavailable('wake-settings-unavailable')
    return { status: 'available', queue: resolveQueueConfig(JSON.parse(result.stdout)) }
  } catch {
    // Raw Host output can include private diagnostics; only a fixed status is returned.
    return unavailable('wake-settings-unavailable')
  }
}

/**
 * Validate explicit public wake settings. The Skill's executable field launches DSH and is never a queue path.
 * @param {object} settings Explicit wakeTransport, wakeExecution, wakeExecutable, wakeDistro and timeoutMs.
 * @returns {object} Queue configuration or an unconnected configuration; no credentials or files are read.
 */
export function resolveQueueConfig(settings) {
  if (!settings || settings.wakeTransport === 'unconnected') return { transport: 'unconnected' }
  const {
    wakeTransport,
    wakeExecution,
    wakeExecutable,
    wakeDistro = '',
    timeoutMs = 15000,
  } = settings
  if (
    wakeTransport !== 'codex-queue' ||
    !['native', 'wsl'].includes(wakeExecution) ||
    !textId(wakeExecutable) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    (wakeExecution === 'native' && (!isAbsolute(wakeExecutable) || wakeDistro !== '')) ||
    (wakeExecution === 'wsl' &&
      (!wakeExecutable.startsWith('/') || !textId(wakeDistro) || wakeDistro.startsWith('-')))
  )
    throw new Error('Invalid explicit Codex queue configuration')
  return {
    transport: 'codex-queue',
    execution: wakeExecution,
    executable: wakeExecutable,
    distro: wakeDistro,
    timeoutMs,
  }
}

/**
 * Send one durably reserved intent. The owner must persist sending before calling and never replay uncertain sends.
 * Exit zero proves transport acceptance only. No command resumes a paused thread, reviews work or retries a worker.
 * @param {object} options Resolved config, stable intent, and optional process adapter.
 * @returns {Promise<object>} Accepted, refused-before-start, or uncertain; all require owner reconciliation before retry.
 */
export async function sendQueueIntent({ config, intent, run = runProcess }) {
  if (
    !intent ||
    !textId(intent.intentId) ||
    !textId(intent.threadId) ||
    intent.threadId === 'manual' ||
    !textId(intent.projectId) ||
    !Number.isSafeInteger(intent.authorityEpoch) ||
    intent.authorityEpoch < 1
  )
    throw new Error('Invalid reserved queue intent')
  const result = (status) => ({ intentId: intent.intentId, status, retryable: false })
  if (config?.transport === 'unconnected') return result('refused')
  const validated = resolveQueueConfig({
    wakeTransport: config?.transport,
    wakeExecution: config?.execution,
    wakeExecutable: config?.executable,
    wakeDistro: config?.distro,
    timeoutMs: config?.timeoutMs,
  })
  const message = JSON.stringify({
    type: 'opl-project-coordinator',
    projectId: intent.projectId,
    intentId: intent.intentId,
    authorityEpoch: intent.authorityEpoch,
    instruction:
      'Reconcile the registered project; verify current authority and pause state before acting.',
  })
  const args = ['queue', '--thread', intent.threadId, '--message', message]
  const command = validated.execution === 'wsl' ? 'wsl' : validated.executable
  const argv =
    validated.execution === 'wsl'
      ? ['-d', validated.distro, '--', validated.executable, ...args]
      : args
  try {
    const sent = await run(command, argv, { timeoutMs: validated.timeoutMs })
    if (sent?.outcome === 'exited' && sent.code === 0) return result('accepted')
    return result(sent?.outcome === 'not-started' ? 'refused' : 'uncertain')
  } catch {
    return result('uncertain')
  }
}
