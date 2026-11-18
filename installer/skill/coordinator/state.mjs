/**
 * Deterministic project coordination; never executes a worker or sends a message.
 *
 * ProjectStore({root, now?}): init(spec), get(id), list(), apply(id,event), decide(id,input),
 * reviewAction(id,{actionId,reviewRunId,consumerId,claimEpoch,authorityEpoch,runId,turnId,
 * kind:'review'|'consume'},effect). The injected fixed operation resolves
 * {status:'accepted'|'uncertain',evidence?}; any other result or thrown error is uncertain.
 * spec: {projectId,cwd,threadId,authorization,workItems:[{workId,dependsOn,acceptance,
 * required?,status?,taskId?,operationId?}],budgets?:{maxIntents,maxNoProgress?:1}}.
 * Every event has {eventId,type,authorityEpoch}; optional threadId/cwd must match.
 * Events and their payloads:
 * work.update: {workId,status,taskId?,operationId?,evidence?,acceptance?}
 * work.bound: {workId,taskId,operationId} binds one ready work item without changing its plan.
 * work.observed: {workId,taskId,operationId,observedAt,state,events?:[projectionEvent]}
 * stores a monotonic DSH metadata watermark; older snapshots skip all projection events.
 * Projection events have their own eventId and are work.update/feedback.pending/consumed,
 * scoped to the same work/task/operation and inheriting the outer authorization epoch.
 * project.pause/resume: {reason}; project.complete: {evidence}
 * runtime.bind: {threadId,cwd,runId,pid,processBirth?,transcriptPath?,backendVersion?}
 * runtime.started: {runId,turnId}; runtime.stopped: {runId,turnId,terminal?}
 * runtime.entering: {threadId,cwd,turnId} suppresses queue admissions until that turn starts.
 * runtime.failed/user_interrupt/uncertain: {runId,turnId?,reason?,terminal?}
 * runtime.recovered: {runId,previousRunId,previousExited:true,pid?,processBirth?}
 * runtime.rebind: {runId,previousTranscriptPath,newBinding,previousExhausted:true}
 * requires a terminal/recovered old run and clears its cursor before reading the new file.
 * runtime.observed: {runId,expectedObservationRevision,observationId,binding?,cursor?,
 * observations?:[{eventId,type,runId?,turnId?,terminal?,reason?}]} atomically commits
 * cleaned binding/cursor and deduplicated started/stopped/failed/user_interrupt/uncertain
 * subevents. Subevents inherit the outer admission epoch; cursor CAS precedes all effects.
 * feedback.pending: {deliveryId,taskId,workId,state?,claimEpoch?,consumerId?}
 * feedback.consumed: {deliveryId}
 * intent.accepted/uncertain: {intentId,evidence?}; intent.received: {intentId,turnId?,entering?:true,evidence?}
 * A received intent can be claimed again only by the same recorded receiving turn.
 * First receipt with entering:true atomically records that turn's ingress marker.
 * review.started: {reviewRunId,consumerId,deliveryId,claimEpoch,runId}
 * review.checkpoint: {reviewRunId,consumerId,claimEpoch,workId,checkpoint}
 * review.finished: {reviewRunId,consumerId,claimEpoch,workId,status,evidence}
 * checkpoint: {artifactRevision,checks:[{id,result,evidence}],reviewWritten?,consumed?}.
 * decide(id,{via:'stop'|'queue',threadId,cwd,turnId?,stopHookActive?}) atomically
 * returns {action:'continue'|'queue'|'none',reason,intent?,state}.
 * Stop observations use terminal:false; only verified terminal logs use terminal:true.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const VERSION = 1
const MAX_BYTES = 2 * 1024 * 1024
const MAX_EVENTS = 8192
const MAX_ITEMS = 256
const MAX_INTENTS = 128
const MAX_ACTIONS = 1024
const STATUS = new Set([
  'ready',
  'running',
  'review_due',
  'waiting_human',
  'waiting_external',
  'accepted',
  'blocked',
])
const queues = new Map()
const OBSERVATIONS = new Set([
  'runtime.started',
  'runtime.stopped',
  'runtime.failed',
  'runtime.user_interrupt',
  'runtime.uncertain',
])
const TASK_STATES = new Set([
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

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}
function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID', `${name} must be an object`)
  return value
}
function string(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    fail('INVALID', `${name} is invalid`)
  return value
}
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail('INVALID', `${name} is invalid`)
  return value
}
function array(value, name, max) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID', `${name} is invalid`)
  return value
}
function json(value) {
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${json(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function digest(value) {
  return createHash('sha256').update(json(value)).digest('hex')
}
function cwd(value) {
  string(value, 'cwd', 4096)
  if (!isAbsolute(value)) fail('INVALID', 'cwd must be absolute')
  return resolve(value)
}
function identity(state, input, required = false) {
  if (required || input.threadId !== undefined) {
    if (string(input.threadId, 'threadId', 256) !== state.threadId)
      fail('TARGET_MISMATCH', 'target thread differs from project')
  }
  if (required || input.cwd !== undefined) {
    if (cwd(input.cwd) !== state.cwd) fail('TARGET_MISMATCH', 'target cwd differs from project')
  }
}
function work(state, id) {
  const item = state.workItems.find((entry) => entry.workId === string(id, 'workId', 256))
  if (!item) fail('NOT_FOUND', 'work item is not registered')
  return item
}
function runtime(state, event) {
  if (string(event.runId, 'runId', 256) !== state.runtime.runId)
    fail('STALE_RUN', 'runtime run is not current')
  if (event.turnId !== undefined) string(event.turnId, 'turnId', 256)
}
function currentReview(state, event, finished = false) {
  const review = state.reviews.find(
    (entry) => entry.reviewRunId === string(event.reviewRunId, 'reviewRunId', 256),
  )
  if (
    !review ||
    !(finished
      ? review.status === 'finished' && ['accepted', 'changes_requested'].includes(review.result)
      : review.status === 'running') ||
    review.authorityEpoch !== state.authorityEpoch ||
    review.runId !== state.runtime.runId ||
    review.turnId !== state.runtime.turnId ||
    review.consumerId !== event.consumerId ||
    review.claimEpoch !== event.claimEpoch
  )
    fail('STALE_REVIEW', 'review owner or run is not current')
  if (event.workId !== undefined && review.workId !== event.workId)
    fail('STALE_REVIEW', 'review belongs to another work item')
  const feedback = state.feedback.find((entry) => entry.deliveryId === review.deliveryId)
  const item = work(state, review.workId)
  if (
    !feedback ||
    feedback.status !== 'pending' ||
    (feedback.claimEpoch !== undefined && feedback.claimEpoch !== review.claimEpoch) ||
    (feedback.consumerId !== undefined && feedback.consumerId !== review.consumerId) ||
    item.taskId !== review.taskId ||
    (item.operationId ?? null) !== review.operationId ||
    item.acceptance !== review.acceptance ||
    !['running', 'stopping'].includes(state.runtime.status)
  )
    fail('STALE_REVIEW', 'review claim or runtime is no longer live')
  if (state.mode !== 'active') fail('PAUSED', 'project is not active')
  return review
}
function progress(state) {
  const checkpoints = {}
  for (const review of state.reviews)
    if (review.checkpoint) checkpoints[review.workId] = review.checkpoint
  return digest({
    work: state.workItems.map(({ feedbackObservation: _watermark, ...item }) => item),
    feedback: state.feedback.map(({ deliveryId, taskId, workId, state: observed, status }) => ({
      deliveryId,
      taskId,
      workId,
      observed,
      status,
    })),
    checkpoints,
  })
}
function checkpoint(value) {
  record(value, 'checkpoint')
  const result = {
    artifactRevision: string(value.artifactRevision, 'artifactRevision', 256),
    checks: array(value.checks, 'checks', 128).map((check) => {
      record(check, 'check')
      if (!['passed', 'failed', 'pending'].includes(check.result))
        fail('INVALID', 'check result is invalid')
      return {
        id: string(check.id, 'check id', 256),
        result: check.result,
        evidence: string(check.evidence, 'check evidence', 8192),
      }
    }),
  }
  for (const field of ['reviewWritten', 'consumed'])
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') fail('INVALID', `${field} must be boolean`)
      result[field] = value[field]
    }
  return result
}
function exactKeys(value, keys, name) {
  record(value, name)
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    fail('INVALID', `${name} fields are invalid`)
}
function feedbackObservation(value, item) {
  exactKeys(value, ['taskId', 'operationId', 'observedAt', 'state'], 'feedback observation')
  string(value.taskId, 'taskId', 256)
  string(value.operationId, 'operationId', 256)
  if (value.taskId !== item.taskId || value.operationId !== item.operationId)
    fail('CONFLICT', 'feedback observation differs from registered task or operation')
  string(value.observedAt, 'observedAt', 128)
  if (!Number.isFinite(Date.parse(value.observedAt)) || !TASK_STATES.has(value.state))
    fail('INVALID', 'feedback observation time or state is invalid')
  return { ...value }
}
function observationBinding(value, state) {
  exactKeys(
    value,
    ['codexHome', 'transcriptPath', 'threadId', 'sessionId', 'agentId', 'turnId', 'backendVersion'],
    'runtime binding',
  )
  for (const field of ['codexHome', 'transcriptPath']) {
    string(value[field], field, 4096)
    if (!isAbsolute(value[field])) fail('INVALID', `${field} must be absolute`)
  }
  for (const field of ['threadId', 'sessionId', 'backendVersion']) string(value[field], field, 256)
  for (const field of ['agentId', 'turnId'])
    if (value[field] !== null) string(value[field], field, 256)
  if (value.threadId !== state.threadId)
    fail('TARGET_MISMATCH', 'observed thread differs from project')
  return { ...value }
}
function observationCursor(value) {
  exactKeys(
    value,
    [
      'version',
      'identity',
      'offset',
      'headerHash',
      'anchorHash',
      'pendingLength',
      'pendingHash',
      'activeTurnId',
    ],
    'transcript cursor',
  )
  if (value.version !== 1) fail('INVALID', 'transcript cursor version is invalid')
  if (
    typeof value.identity !== 'string' ||
    value.identity.length > 256 ||
    !/^[0-9]+:[0-9]+:-?[0-9]+$/.test(value.identity)
  )
    fail('INVALID', 'transcript file identity is invalid')
  integer(value.offset, 'transcript offset')
  integer(value.pendingLength, 'transcript pendingLength', 0, 2 * 1024 * 1024)
  for (const field of ['headerHash', 'anchorHash', 'pendingHash'])
    if (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field]))
      fail('INVALID', `${field} is invalid`)
  if (value.activeTurnId !== null) string(value.activeTurnId, 'activeTurnId', 256)
  return { ...value }
}
function cancelIntents(state) {
  for (const intent of state.intents)
    if (!['received', 'cancelled'].includes(intent.status)) intent.status = 'cancelled'
  for (const review of state.reviews) if (review.status === 'running') review.status = 'fenced'
}
function fenceReviews(state) {
  for (const review of state.reviews) if (review.status === 'running') review.status = 'fenced'
}
function markEntering(state, turnId) {
  state.runtime.enteringTurnId = string(turnId, 'entering turnId', 256)
  state.runtime.status = 'unknown'
  state.runtime.terminal = false
}
function validateDependencies(items) {
  const ids = new Set(items.map((item) => item.workId))
  if (ids.size !== items.length) fail('INVALID', 'work ids must be unique')
  const visiting = new Set(),
    visited = new Set()
  function visit(id) {
    if (visiting.has(id)) fail('INVALID', 'work dependencies contain a cycle')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of items.find((item) => item.workId === id).dependsOn) {
      if (!ids.has(dependency)) fail('INVALID', 'dependency is not registered')
      visit(dependency)
    }
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
}
function validateState(state) {
  record(state, 'project')
  if (state.schemaVersion !== VERSION) fail('UNSUPPORTED_SCHEMA', 'unsupported project schema')
  string(state.projectId, 'projectId', 256)
  string(state.threadId, 'threadId', 256)
  cwd(state.cwd)
  string(state.authorization, 'authorization', 8192)
  if (!['active', 'paused_by_user', 'completed'].includes(state.mode))
    fail('INVALID', 'project mode is invalid')
  integer(state.revision, 'revision', 1)
  integer(state.progressRevision, 'progressRevision', 1)
  integer(state.authorityEpoch, 'authorityEpoch', 1)
  for (const item of array(state.workItems, 'workItems', MAX_ITEMS)) {
    record(item, 'work item')
    string(item.workId, 'workId', 256)
    string(item.acceptance, 'acceptance', 8192)
    if (!STATUS.has(item.status)) fail('INVALID', 'work status is invalid')
    if (typeof item.required !== 'boolean') fail('INVALID', 'required must be boolean')
    for (const id of array(item.dependsOn, 'dependsOn', MAX_ITEMS)) string(id, 'dependency', 256)
    if (item.status === 'accepted') string(item.evidence, 'acceptance evidence', 8192)
    if (item.feedbackObservation !== undefined) feedbackObservation(item.feedbackObservation, item)
  }
  validateDependencies(state.workItems)
  record(state.runtime, 'runtime')
  if (
    !['unknown', 'running', 'stopping', 'idle', 'failed', 'interrupted'].includes(
      state.runtime.status,
    )
  )
    fail('INVALID', 'runtime status is invalid')
  for (const field of ['runId', 'turnId', 'processBirth'])
    if (state.runtime[field] !== undefined) string(state.runtime[field], field, 256)
  if (state.runtime.enteringTurnId !== undefined)
    string(state.runtime.enteringTurnId, 'enteringTurnId', 256)
  if (state.runtime.pid !== undefined) integer(state.runtime.pid, 'pid', 1)
  if (state.runtime.terminal !== undefined && typeof state.runtime.terminal !== 'boolean')
    fail('INVALID', 'runtime terminal must be boolean')
  if (state.runtime.observationRevision !== undefined)
    integer(state.runtime.observationRevision, 'observationRevision')
  if (state.runtime.binding !== undefined) observationBinding(state.runtime.binding, state)
  if (state.runtime.cursor !== undefined) observationCursor(state.runtime.cursor)
  if (state.runtime.lastObservationId !== undefined)
    string(state.runtime.lastObservationId, 'lastObservationId', 256)
  if (state.runtime.lastObservationFingerprint !== undefined)
    string(state.runtime.lastObservationFingerprint, 'lastObservationFingerprint', 64)
  for (const item of array(state.seenEvents, 'seenEvents', MAX_EVENTS)) {
    string(item.eventId, 'eventId', 256)
    string(item.fingerprint, 'fingerprint', 64)
  }
  for (const intent of array(state.intents, 'intents', MAX_INTENTS)) {
    string(intent.intentId, 'intentId', 256)
    if (intent.threadId !== state.threadId || intent.cwd !== state.cwd)
      fail('INVALID', 'intent target is invalid')
    integer(intent.authorityEpoch, 'intent authorityEpoch', 1)
    integer(intent.progressRevision, 'intent progressRevision', 1)
    if (intent.receivedTurnId !== undefined) {
      string(intent.receivedTurnId, 'receivedTurnId', 256)
      if (intent.status !== 'received')
        fail('INVALID', 'receiving turn belongs to an unreceived intent')
    }
    if (!['reserved', 'accepted', 'received', 'uncertain', 'cancelled'].includes(intent.status))
      fail('INVALID', 'intent status is invalid')
  }
  for (const feedback of array(state.feedback, 'feedback', MAX_EVENTS)) {
    string(feedback.deliveryId, 'deliveryId', 256)
    string(feedback.taskId, 'taskId', 256)
    work(state, feedback.workId)
    if (feedback.claimEpoch !== undefined) integer(feedback.claimEpoch, 'claimEpoch')
    if (feedback.consumerId !== undefined) string(feedback.consumerId, 'consumerId', 256)
    if (!['pending', 'consumed'].includes(feedback.status))
      fail('INVALID', 'feedback status is invalid')
  }
  for (const review of array(state.reviews, 'reviews', MAX_EVENTS)) {
    string(review.reviewRunId, 'reviewRunId', 256)
    work(state, review.workId)
    string(review.runId, 'runId', 256)
    string(review.consumerId, 'consumerId', 256)
    integer(review.claimEpoch, 'claimEpoch')
    integer(review.authorityEpoch, 'review authorityEpoch', 1)
    if (review.checkpoint !== undefined) checkpoint(review.checkpoint)
    if (!['running', 'finished', 'fenced'].includes(review.status))
      fail('INVALID', 'review status is invalid')
    for (const action of array(review.actions ?? [], 'review actions', MAX_ACTIONS)) {
      string(action.actionId, 'actionId', 256)
      if (
        !['review', 'consume'].includes(action.kind) ||
        !['reserved', 'accepted', 'uncertain'].includes(action.status)
      )
        fail('INVALID', 'review action kind or status is invalid')
      for (const field of [
        'reviewRunId',
        'consumerId',
        'claimEpoch',
        'authorityEpoch',
        'runId',
        'turnId',
        'workId',
        'taskId',
        'operationId',
        'deliveryId',
        'acceptance',
      ])
        if (action[field] !== review[field])
          fail('INVALID', 'review action owner or work differs from its review')
      integer(action.createdAt, 'action createdAt')
      integer(action.updatedAt, 'action updatedAt')
      if (action.evidence !== undefined) string(action.evidence, 'action evidence', 8192)
    }
  }
  const actions = state.reviews.flatMap((review) => review.actions ?? [])
  if (
    actions.length > MAX_ACTIONS ||
    new Set(actions.map((action) => action.actionId)).size !== actions.length
  )
    fail('INVALID', 'review action ids or count are invalid')
  for (const [items, key] of [
    [state.seenEvents, 'eventId'],
    [state.intents, 'intentId'],
    [state.feedback, 'deliveryId'],
    [state.reviews, 'reviewRunId'],
  ])
    if (new Set(items.map((entry) => entry[key])).size !== items.length)
      fail('INVALID', 'stored record ids must be unique')
  record(state.budgets, 'budgets')
  integer(state.budgets.maxIntents, 'maxIntents', 1, MAX_INTENTS)
  integer(state.budgets.maxNoProgress, 'maxNoProgress', 1, 1)
  return state
}

async function atomicWrite(path, value) {
  const bytes = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('LIMIT', 'project state exceeds size limit')
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path)
        break
      } catch (error) {
        if (
          process.platform !== 'win32' ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
          attempt >= 49
        )
          throw error
        await delay(5)
      }
    }
    // Directory fsync is unsupported on Windows; rename still publishes one complete file.
    if (process.platform !== 'win32') {
      const directory = await open(resolve(path, '..'), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    if (handle) await handle.close()
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    // EPERM and a reused PID do not establish exit; both keep the lock occupied.
    return true
  }
}

/** Local-process bakery mutex. Unique ticket paths cannot delete a replacement owner. */
async function lock(directory, action) {
  await mkdir(directory, { recursive: true })
  const token = `${process.pid}-${randomUUID()}`
  const path = join(directory, `${token}.json`)
  const choosingPath = join(directory, `${token}.choosing`)
  const deadline = Date.now() + 10000
  async function participants() {
    const result = []
    const names = await readdir(directory),
      observed = new Set()
    if (names.length > 4096) fail('LIMIT', 'project lock participant count exceeds limit')
    for (const name of names) {
      const match = /^(\d+)-([0-9a-f-]{36})\.(json|choosing)$/.exec(name)
      if (!match) continue
      const otherToken = `${match[1]}-${match[2]}`
      if (observed.has(otherToken)) continue
      observed.add(otherToken)
      const otherPath = join(directory, `${otherToken}.json`),
        otherChoosing = join(directory, `${otherToken}.choosing`),
        pid = Number(match[1])
      if (!alive(pid)) {
        await unlink(otherPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        await unlink(otherChoosing).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        continue
      }
      if (names.includes(`${otherToken}.choosing`)) {
        result.push({ token: otherToken, choosing: true, number: 0 })
        continue
      }
      try {
        const bytes = await readFile(otherPath, 'utf8')
        if (bytes.length > 1024) fail('LOCK_CORRUPT', 'lock ticket is invalid')
        const ticket = JSON.parse(bytes)
        if (
          ticket.pid !== pid ||
          ticket.token !== otherToken ||
          !Number.isSafeInteger(ticket.number) ||
          ticket.number < 0 ||
          typeof ticket.choosing !== 'boolean'
        )
          fail('LOCK_CORRUPT', 'lock ticket is invalid')
        result.push(ticket)
      } catch (error) {
        if (error.code === 'ENOENT') continue
        // Windows may deny opens while a peer's ticket is delete-pending. Keep the
        // participant occupied until a later scan confirms removal or the lock deadline.
        if (
          error instanceof SyntaxError ||
          (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
        )
          result.push({ token: otherToken, choosing: true, number: 0 })
        else throw error
      }
    }
    return result
  }
  try {
    const handle = await open(choosingPath, 'wx', 0o600)
    await handle.close()
    const number = 1 + Math.max(0, ...(await participants()).map((ticket) => ticket.number))
    await atomicWrite(path, { pid: process.pid, token, choosing: false, number })
    await unlink(choosingPath)
    for (;;) {
      const blocked = (await participants()).some(
        (ticket) =>
          ticket.token !== token &&
          (ticket.choosing ||
            ticket.number < number ||
            (ticket.number === number && ticket.token < token)),
      )
      if (!blocked) return await action()
      if (Date.now() >= deadline)
        fail('LOCK_BUSY', 'project is locked by a live or unverifiable process')
      await delay(10)
    }
  } finally {
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    await unlink(choosingPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Persistent project plan and continuation admissions, scoped to a single target. */
export class ProjectStore {
  /** @param {{root:string,now?:()=>number}} options Store directory and optional timestamp clock. */
  constructor({ root, now = Date.now }) {
    this.root = resolve(string(root, 'root', 4096))
    this.now = now
  }
  paths(projectId) {
    const key = digest(string(projectId, 'projectId', 256))
    return { file: join(this.root, `${key}.json`), lock: join(this.root, 'locks', key) }
  }
  async transaction(projectId, action) {
    const paths = this.paths(projectId)
    await mkdir(this.root, { recursive: true })
    const previous = queues.get(paths.file) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => lock(paths.lock, () => action(paths.file)))
    queues.set(paths.file, pending)
    try {
      return await pending
    } finally {
      if (queues.get(paths.file) === pending) queues.delete(paths.file)
    }
  }
  async read(path) {
    const info = await stat(path)
    if (info.size > MAX_BYTES) fail('LIMIT', 'project state exceeds size limit')
    const bytes = await readFile(path, 'utf8')
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail('LIMIT', 'project state exceeds size limit')
    let parsed
    try {
      parsed = JSON.parse(bytes)
    } catch (error) {
      fail('CORRUPT', 'project state is not valid JSON')
    }
    return validateState(parsed)
  }
  /** Register an immutable project target and its initial authorized work. */
  async init(spec) {
    record(spec, 'project spec')
    string(spec.projectId, 'projectId', 256)
    return this.transaction(spec.projectId, async (path) => {
      try {
        const existing = await this.read(path)
        identity(existing, spec, true)
        if (existing.authorization !== spec.authorization)
          fail('CONFLICT', 'project authorization is already registered')
        return existing
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const time = this.now()
      const items = array(spec.workItems, 'workItems', MAX_ITEMS).map((input) => {
        record(input, 'work item')
        if (input.required !== undefined && typeof input.required !== 'boolean')
          fail('INVALID', 'required must be boolean')
        return {
          workId: string(input.workId, 'workId', 256),
          dependsOn: array(input.dependsOn ?? [], 'dependsOn', MAX_ITEMS),
          acceptance: string(input.acceptance, 'acceptance', 8192),
          required: input.required !== false,
          status: input.status ?? 'ready',
          ...(input.taskId ? { taskId: string(input.taskId, 'taskId', 256) } : {}),
          ...(input.operationId
            ? { operationId: string(input.operationId, 'operationId', 256) }
            : {}),
        }
      })
      const state = validateState({
        schemaVersion: VERSION,
        projectId: spec.projectId,
        cwd: cwd(spec.cwd),
        threadId: string(spec.threadId, 'threadId', 256),
        authorization: string(spec.authorization, 'authorization', 8192),
        mode: 'active',
        authorityEpoch: 1,
        revision: 1,
        progressRevision: 1,
        createdAt: time,
        updatedAt: time,
        workItems: items,
        runtime: { status: 'unknown', observationRevision: 0 },
        feedback: [],
        reviews: [],
        intents: [],
        seenEvents: [],
        budgets: {
          maxIntents: spec.budgets?.maxIntents ?? 16,
          maxNoProgress: spec.budgets?.maxNoProgress ?? 1,
        },
      })
      await atomicWrite(path, state)
      return state
    })
  }
  /** Read a complete atomic snapshot; does not infer completion or start applications. */
  async get(projectId) {
    const state = await this.read(this.paths(projectId).file)
    if (state.projectId !== projectId) fail('INVALID', 'project id differs from stored record')
    return state
  }
  /** List at most 1024 registered project snapshots. */
  async list() {
    let names
    try {
      names = await readdir(this.root)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const files = names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()
    if (files.length > 1024) fail('LIMIT', 'project count exceeds limit')
    return Promise.all(files.map((name) => this.read(join(this.root, name))))
  }
  /** Apply one deduplicated event under project authorization and review fencing. */
  async apply(projectId, event) {
    record(event, 'event')
    string(event.eventId, 'eventId', 256)
    string(event.type, 'event type', 64)
    if (Buffer.byteLength(JSON.stringify(event)) > 32768) fail('LIMIT', 'event exceeds size limit')
    return this.transaction(projectId, async (path) => {
      const state = await this.read(path)
      identity(state, event)
      const fingerprint = digest(event),
        seen = state.seenEvents.find((item) => item.eventId === event.eventId)
      if (seen) {
        if (seen.fingerprint !== fingerprint)
          fail('CONFLICT', 'event id was reused with different fields')
        return state
      }
      if (event.authorityEpoch !== state.authorityEpoch)
        fail('STALE_EPOCH', 'project authorization epoch has changed')
      if (state.seenEvents.length >= MAX_EVENTS) fail('LIMIT', 'project event budget is exhausted')
      const progressBefore = progress(state)
      this.reduce(state, event)
      if (progress(state) !== progressBefore) state.progressRevision++
      state.seenEvents.push({ eventId: event.eventId, fingerprint })
      state.revision++
      state.updatedAt = this.now()
      validateState(state)
      await atomicWrite(path, state)
      return state
    })
  }
  /**
   * Fence one fixed Host review/consume operation before its external effect.
   * The callback starts under the reservation lock and must return its Promise promptly.
   * Host completion holds no project lock; late outcomes cannot restore paused authority.
   * A reserved, accepted or uncertain action is never executed again under the same id.
   * @param {string} projectId Registered project.
   * @param {object} request Current owner/epoch/run/turn and immutable action id/kind.
   * @param {()=>Promise<{status:'accepted'|'uncertain',evidence?:string}>} effect Existing Host operation.
   * @returns {Promise<object>} Persisted action, project snapshot and replay indicator.
   */
  async reviewAction(projectId, request, effect) {
    record(request, 'review action request')
    string(request.actionId, 'actionId', 256)
    if (!['review', 'consume'].includes(request.kind) || typeof effect !== 'function')
      fail('INVALID', 'review action requires a fixed kind and effect')
    const actionId = request.actionId
    let pending
    const admission = await this.transaction(projectId, async (path) => {
      const state = await this.read(path)
      if (request.authorityEpoch !== state.authorityEpoch)
        fail('STALE_EPOCH', 'project authorization epoch has changed')
      if (request.runId !== state.runtime.runId || request.turnId !== state.runtime.turnId)
        fail('STALE_RUN', 'review action runtime or turn is not current')
      const review = currentReview(state, request, request.kind === 'consume')
      const actions = state.reviews.flatMap((entry) => entry.actions ?? [])
      const existing = actions.find((entry) => entry.actionId === request.actionId)
      if (existing) {
        if (
          existing.kind !== request.kind ||
          existing.workId !== review.workId ||
          existing.taskId !== review.taskId ||
          existing.operationId !== review.operationId ||
          existing.deliveryId !== review.deliveryId ||
          existing.acceptance !== review.acceptance
        )
          fail('CONFLICT', 'review action id belongs to another operation')
        return { status: existing.status, action: existing, state, replayed: true }
      }
      if (actions.length >= MAX_ACTIONS) fail('LIMIT', 'project review action budget is exhausted')
      const action = {
        actionId: request.actionId,
        kind: request.kind,
        status: 'reserved',
        createdAt: this.now(),
        updatedAt: this.now(),
      }
      for (const field of [
        'reviewRunId',
        'consumerId',
        'claimEpoch',
        'authorityEpoch',
        'runId',
        'turnId',
        'workId',
        'taskId',
        'operationId',
        'deliveryId',
        'acceptance',
      ])
        action[field] = review[field]
      review.actions ??= []
      review.actions.push(action)
      state.revision++
      state.updatedAt = this.now()
      validateState(state)
      await atomicWrite(path, state)
      try {
        pending = Promise.resolve(effect())
      } catch (error) {
        // Host failures cannot establish whether the external write committed.
        pending = Promise.resolve({ status: 'uncertain' })
      }
      pending = pending.catch(() => ({ status: 'uncertain' }))
      return { replayed: false }
    })
    if (admission.replayed) return admission
    const outcome = await pending
    return this.transaction(projectId, async (path) => {
      const state = await this.read(path)
      const action = state.reviews
        .flatMap((review) => review.actions ?? [])
        .find((entry) => entry.actionId === actionId)
      if (!action || action.status !== 'reserved')
        fail('CONFLICT', 'reserved review action is no longer available')
      let ownerCurrent = true
      try {
        currentReview(state, action, action.kind === 'consume')
      } catch (error) {
        // Pause, claim replacement and runtime changes fence an in-flight Host result.
        ownerCurrent = false
      }
      action.status = ownerCurrent && outcome?.status === 'accepted' ? 'accepted' : 'uncertain'
      if (
        typeof outcome?.evidence === 'string' &&
        outcome.evidence.trim() &&
        outcome.evidence.length <= 8192 &&
        !outcome.evidence.includes('\0')
      )
        action.evidence = outcome.evidence
      action.updatedAt = this.now()
      state.revision++
      state.updatedAt = this.now()
      validateState(state)
      await atomicWrite(path, state)
      return { status: action.status, action, state, replayed: false }
    })
  }
  reduce(state, event) {
    switch (event.type) {
      case 'project.pause':
        if (state.mode === 'completed') fail('COMPLETED', 'completed project cannot pause')
        state.mode = 'paused_by_user'
        state.pauseReason = string(event.reason, 'pause reason')
        state.authorityEpoch++
        cancelIntents(state)
        return
      case 'project.resume':
        if (state.mode === 'completed') fail('COMPLETED', 'completed project cannot resume')
        string(event.reason, 'resume reason')
        state.mode = 'active'
        state.authorityEpoch++
        delete state.pauseReason
        cancelIntents(state)
        return
      case 'project.complete':
        if (
          state.mode !== 'active' ||
          state.workItems.some(
            (item) => item.required && (item.status !== 'accepted' || !item.evidence),
          ) ||
          state.feedback.some((item) => item.status !== 'consumed') ||
          state.reviews.some((item) => item.status === 'running')
        )
          fail('INCOMPLETE', 'required work or reviews remain open')
        state.completionEvidence = string(event.evidence, 'completion evidence', 8192)
        state.mode = 'completed'
        state.authorityEpoch++
        cancelIntents(state)
        return
      case 'work.update': {
        if (state.mode === 'completed') fail('COMPLETED', 'completed project cannot change work')
        const item = work(state, event.workId)
        if (
          (event.taskId !== undefined && event.taskId !== item.taskId) ||
          (event.operationId !== undefined && event.operationId !== item.operationId)
        )
          delete item.feedbackObservation
        if (!STATUS.has(event.status)) fail('INVALID', 'work status is invalid')
        if (event.status === 'accepted') {
          if (state.mode !== 'active') fail('PAUSED', 'paused project cannot accept work')
          if (
            state.feedback.some(
              (feedback) => feedback.workId === item.workId && feedback.status === 'pending',
            )
          )
            fail('STALE_REVIEW', 'active review must finish through its owner')
          item.evidence = string(event.evidence, 'acceptance evidence', 8192)
        } else if (event.evidence !== undefined)
          item.evidence = string(event.evidence, 'evidence', 8192)
        item.status = event.status
        for (const field of ['taskId', 'operationId', 'acceptance'])
          if (event[field] !== undefined)
            item[field] = string(event[field], field, field === 'acceptance' ? 8192 : 256)
        return
      }
      case 'work.bound': {
        if (state.mode !== 'active') fail('PAUSED', 'paused project cannot bind a task')
        const item = work(state, event.workId)
        const taskId = string(event.taskId, 'taskId', 256)
        const operationId = string(event.operationId, 'operationId', 256)
        if (item.taskId !== undefined || item.operationId !== undefined) {
          if (item.taskId !== taskId || item.operationId !== operationId)
            fail('CONFLICT', 'registered work already belongs to another task operation')
          return
        }
        if (
          item.status !== 'ready' ||
          item.dependsOn.some((id) => work(state, id).status !== 'accepted') ||
          state.workItems.some((other) => other.workId !== item.workId && other.taskId === taskId)
        )
          fail('CONFLICT', 'task cannot bind to this registered work item')
        item.taskId = taskId
        item.operationId = operationId
        return
      }
      case 'work.observed': {
        const item = work(state, event.workId)
        const observed = feedbackObservation(
          {
            taskId: event.taskId,
            operationId: event.operationId,
            observedAt: event.observedAt,
            state: event.state,
          },
          item,
        )
        const children = array(event.events ?? [], 'feedback projection events', 128)
        if (item.feedbackObservation) {
          const order =
            Date.parse(observed.observedAt) - Date.parse(item.feedbackObservation.observedAt)
          if (order < 0) return
          if (order === 0 && observed.state !== item.feedbackObservation.state)
            fail('CONFLICT', 'feedback state differs at the same observation time')
        }
        if (state.seenEvents.length + children.length + 1 > MAX_EVENTS)
          fail('LIMIT', 'project event budget is exhausted')
        for (const input of children) {
          record(input, 'feedback projection event')
          const keys =
            input.type === 'work.update'
              ? ['eventId', 'type', 'workId', 'taskId', 'operationId', 'status', 'evidence']
              : input.type === 'feedback.pending'
                ? [
                    'eventId',
                    'type',
                    'workId',
                    'taskId',
                    'operationId',
                    'deliveryId',
                    'state',
                    'deliveryState',
                    'stage',
                    'receiptStatus',
                    'claimEpoch',
                    'consumerId',
                    'stale',
                  ]
                : input.type === 'feedback.consumed'
                  ? ['eventId', 'type', 'workId', 'taskId', 'operationId', 'deliveryId']
                  : null
          if (!keys || Object.keys(input).some((key) => !keys.includes(key)))
            fail('INVALID', 'feedback projection event fields are invalid')
          if (
            (input.workId !== undefined && input.workId !== event.workId) ||
            (input.taskId !== undefined && input.taskId !== observed.taskId) ||
            (input.operationId !== undefined && input.operationId !== observed.operationId)
          )
            fail('CONFLICT', 'feedback projection event differs from its observed work')
          const child = {
            ...input,
            eventId: string(input.eventId, 'projection eventId', 256),
            workId: event.workId,
            taskId: observed.taskId,
            operationId: observed.operationId,
          }
          if (child.eventId === event.eventId)
            fail('CONFLICT', 'projection and batch event ids must differ')
          if (child.type === 'work.update' && child.status === 'accepted')
            fail('INVALID', 'feedback metadata cannot accept project work')
          const fingerprint = digest(child),
            seen = state.seenEvents.find((entry) => entry.eventId === child.eventId)
          if (seen) {
            if (seen.fingerprint !== fingerprint)
              fail('CONFLICT', 'projection event id was reused with different fields')
            continue
          }
          if (child.type === 'feedback.consumed') {
            const feedback = state.feedback.find((row) => row.deliveryId === child.deliveryId)
            if (!feedback || feedback.workId !== item.workId || feedback.taskId !== observed.taskId)
              fail('NOT_FOUND', 'consumed feedback is not registered for observed work')
          }
          if (child.type !== 'work.update' || item.status !== 'accepted') this.reduce(state, child)
          state.seenEvents.push({ eventId: child.eventId, fingerprint })
        }
        item.feedbackObservation = observed
        return
      }
      case 'runtime.bind': {
        identity(state, event, true)
        const runId = string(event.runId, 'runId', 256)
        if (state.runtime.runId && state.runtime.runId !== runId)
          fail('STALE_RUN', 'replace a runtime only after verified recovery')
        if (
          (state.runtime.pid !== undefined && state.runtime.pid !== event.pid) ||
          (state.runtime.processBirth !== undefined &&
            state.runtime.processBirth !== event.processBirth)
        )
          fail('STALE_RUN', 'runtime identity cannot change within a run')
        state.runtime = {
          ...state.runtime,
          runId,
          pid: integer(event.pid, 'pid', 1),
          ...(event.processBirth !== undefined
            ? { processBirth: string(event.processBirth, 'processBirth', 256) }
            : {}),
        }
        for (const field of ['transcriptPath', 'backendVersion'])
          if (event[field] !== undefined) state.runtime[field] = string(event[field], field, 4096)
        return
      }
      case 'runtime.entering':
        identity(state, event, true)
        markEntering(state, event.turnId)
        return
      case 'runtime.started':
        runtime(state, event)
        string(event.turnId, 'turnId', 256)
        if (state.runtime.enteringTurnId === event.turnId) delete state.runtime.enteringTurnId
        if (state.runtime.turnId === event.turnId && state.runtime.terminal === true) return
        if (state.runtime.turnId !== event.turnId) fenceReviews(state)
        state.runtime = {
          ...state.runtime,
          status: 'running',
          turnId: string(event.turnId, 'turnId', 256),
          terminal: false,
          recovery: false,
        }
        return
      case 'runtime.stopped':
        runtime(state, event)
        string(event.turnId, 'turnId', 256)
        if (state.runtime.turnId && state.runtime.turnId !== event.turnId)
          fail('STALE_RUN', 'terminal belongs to a different turn')
        if (state.runtime.terminal === true && event.terminal !== true) return
        state.runtime = {
          ...state.runtime,
          status: event.terminal === true ? 'idle' : 'stopping',
          turnId: string(event.turnId, 'turnId', 256),
          terminal: event.terminal === true,
        }
        if (event.terminal === true) fenceReviews(state)
        return
      case 'runtime.failed':
      case 'runtime.uncertain':
      case 'runtime.user_interrupt':
        runtime(state, event)
        if (event.turnId && state.runtime.turnId && state.runtime.turnId !== event.turnId)
          fail('STALE_RUN', 'observation belongs to a different turn')
        if (
          event.type === 'runtime.failed' &&
          state.runtime.terminal === true &&
          event.terminal !== true
        )
          return
        state.runtime.status =
          event.type === 'runtime.failed'
            ? 'failed'
            : event.type === 'runtime.user_interrupt'
              ? 'interrupted'
              : 'unknown'
        state.runtime.terminal = event.terminal === true
        if (event.terminal === true) fenceReviews(state)
        if (event.reason !== undefined)
          state.runtime.reason = string(event.reason, 'runtime reason')
        if (event.type === 'runtime.user_interrupt' && state.mode !== 'completed') {
          state.mode = 'paused_by_user'
          state.pauseReason = event.reason ?? 'user interrupt'
          state.authorityEpoch++
          cancelIntents(state)
        }
        return
      case 'runtime.recovered':
        if (
          event.previousExited !== true ||
          event.previousRunId !== state.runtime.runId ||
          event.runId === event.previousRunId
        )
          fail('STALE_RUN', 'recovery requires the prior runtime exit')
        state.runtime = {
          ...state.runtime,
          status: 'idle',
          terminal: true,
          recovery: true,
          runId: string(event.runId, 'runId', 256),
          pid: event.pid === undefined ? undefined : integer(event.pid, 'pid', 1),
          processBirth:
            event.processBirth === undefined
              ? undefined
              : string(event.processBirth, 'processBirth', 256),
        }
        for (const review of state.reviews)
          if (review.status === 'running') review.status = 'fenced'
        return
      case 'runtime.observed': {
        runtime(state, event)
        integer(event.expectedObservationRevision, 'expectedObservationRevision')
        const observationId = string(event.observationId, 'observationId', 256)
        const binding =
          event.binding === undefined ? undefined : observationBinding(event.binding, state)
        const cursor = event.cursor === undefined ? undefined : observationCursor(event.cursor)
        const observations = array(event.observations ?? [], 'observations', 128).map((child) => {
          record(child, 'runtime observation')
          if (!OBSERVATIONS.has(child.type)) fail('INVALID', 'unsupported runtime observation type')
          for (const key of Object.keys(child))
            if (!['eventId', 'type', 'runId', 'turnId', 'terminal', 'reason'].includes(key))
              fail('INVALID', 'runtime observation fields are invalid')
          if (child.runId !== undefined && child.runId !== event.runId)
            fail('STALE_RUN', 'observation run differs from batch')
          if (child.terminal !== undefined && typeof child.terminal !== 'boolean')
            fail('INVALID', 'runtime observation terminal must be boolean')
          const result = {
            eventId: string(child.eventId, 'observation eventId', 256),
            type: child.type,
            runId: event.runId,
          }
          if (result.eventId === event.eventId)
            fail('CONFLICT', 'observation and batch event ids must differ')
          if (child.turnId !== undefined)
            result.turnId = string(child.turnId, 'observation turnId', 256)
          if (child.reason !== undefined) result.reason = string(child.reason, 'observation reason')
          if (child.terminal !== undefined) result.terminal = child.terminal
          return result
        })
        const fingerprint = digest({ binding, cursor, observations })
        if (state.runtime.lastObservationId === observationId) {
          if (state.runtime.lastObservationFingerprint !== fingerprint)
            fail('CONFLICT', 'observation id was reused with different fields')
          return
        }
        if (event.expectedObservationRevision !== (state.runtime.observationRevision ?? 0))
          fail('STALE_OBSERVATION', 'runtime observation revision has advanced')
        if (binding && state.runtime.binding)
          for (const field of [
            'codexHome',
            'transcriptPath',
            'threadId',
            'sessionId',
            'agentId',
            'backendVersion',
          ])
            if (binding[field] !== state.runtime.binding[field])
              fail('TARGET_MISMATCH', 'runtime observation binding has changed')
        if (
          cursor &&
          state.runtime.cursor &&
          (cursor.identity !== state.runtime.cursor.identity ||
            cursor.headerHash !== state.runtime.cursor.headerHash ||
            cursor.offset < state.runtime.cursor.offset)
        )
          fail('STALE_OBSERVATION', 'transcript cursor identity changed or moved backwards')
        if (state.seenEvents.length + observations.length + 1 > MAX_EVENTS)
          fail('LIMIT', 'project event budget is exhausted')
        for (const child of observations) {
          const childFingerprint = digest(child),
            seen = state.seenEvents.find((entry) => entry.eventId === child.eventId)
          if (seen) {
            if (seen.fingerprint !== childFingerprint)
              fail('CONFLICT', 'runtime event id was reused with different fields')
            continue
          }
          this.reduce(state, child)
          state.seenEvents.push({ eventId: child.eventId, fingerprint: childFingerprint })
        }
        if (binding) state.runtime.binding = binding
        if (cursor) state.runtime.cursor = cursor
        state.runtime.lastObservationId = observationId
        state.runtime.lastObservationFingerprint = fingerprint
        state.runtime.observationRevision = (state.runtime.observationRevision ?? 0) + 1
        return
      }
      case 'runtime.rebind': {
        runtime(state, event)
        if (
          event.previousExhausted !== true ||
          state.runtime.terminal !== true ||
          !['idle', 'failed', 'interrupted'].includes(state.runtime.status)
        )
          fail(
            'STALE_OBSERVATION',
            'transcript rebinding requires an exhausted terminal or recovered runtime',
          )
        if (
          !state.runtime.binding ||
          event.previousTranscriptPath !== state.runtime.binding.transcriptPath
        )
          fail('TARGET_MISMATCH', 'previous transcript does not match the registered binding')
        const binding = observationBinding(event.newBinding, state)
        for (const field of ['codexHome', 'sessionId', 'agentId'])
          if (binding[field] !== state.runtime.binding[field])
            fail('TARGET_MISMATCH', 'transcript rebind changes the registered session')
        if (binding.transcriptPath === state.runtime.binding.transcriptPath)
          fail('CONFLICT', 'new transcript must differ from the previous transcript')
        state.runtime.binding = binding
        state.runtime.transcriptPath = binding.transcriptPath
        delete state.runtime.cursor
        delete state.runtime.lastObservationId
        delete state.runtime.lastObservationFingerprint
        delete state.runtime.turnId
        state.runtime.observationRevision = (state.runtime.observationRevision ?? 0) + 1
        state.runtime.status = 'unknown'
        state.runtime.terminal = false
        return
      }
      case 'feedback.pending': {
        const item = work(state, event.workId),
          deliveryId = string(event.deliveryId, 'deliveryId', 256),
          taskId = string(event.taskId, 'taskId', 256)
        if (item.taskId !== undefined && item.taskId !== taskId)
          fail('CONFLICT', 'feedback task differs from registered work')
        const existing = state.feedback.find((entry) => entry.deliveryId === deliveryId)
        if (existing && (existing.workId !== item.workId || existing.taskId !== taskId))
          fail('CONFLICT', 'delivery belongs to another task or work item')
        if (existing?.status === 'consumed') return
        if (existing?.claimEpoch !== undefined && event.claimEpoch !== undefined) {
          if (event.claimEpoch < existing.claimEpoch)
            fail('STALE_CLAIM', 'feedback claim epoch has advanced')
          if (
            event.claimEpoch === existing.claimEpoch &&
            existing.consumerId !== undefined &&
            event.consumerId !== undefined &&
            existing.consumerId !== event.consumerId
          )
            fail('STALE_CLAIM', 'feedback claim consumer differs at the same epoch')
        }
        const feedback = existing ?? { deliveryId, taskId, workId: item.workId, status: 'pending' }
        if (!existing) state.feedback.push(feedback)
        item.taskId = taskId
        if (event.claimEpoch !== undefined)
          feedback.claimEpoch = integer(event.claimEpoch, 'claimEpoch')
        if (event.consumerId !== undefined)
          feedback.consumerId = string(event.consumerId, 'consumerId', 256)
        if (event.state !== undefined) feedback.state = string(event.state, 'feedback state', 64)
        if (['waiting_input', 'waiting_approval'].includes(feedback.state))
          item.status = 'waiting_human'
        else if (item.status !== 'accepted') item.status = 'review_due'
        return
      }
      case 'feedback.consumed': {
        const feedback = state.feedback.find(
          (item) => item.deliveryId === string(event.deliveryId, 'deliveryId', 256),
        )
        if (!feedback) fail('NOT_FOUND', 'feedback is not registered')
        feedback.status = 'consumed'
        return
      }
      case 'intent.accepted':
      case 'intent.received':
      case 'intent.uncertain': {
        const intent = state.intents.find(
          (item) => item.intentId === string(event.intentId, 'intentId', 256),
        )
        if (
          !intent ||
          intent.authorityEpoch !== state.authorityEpoch ||
          intent.status === 'cancelled'
        )
          fail('STALE_INTENT', 'intent authorization is no longer current')
        const next = event.type.slice(7)
        const receivingTurn =
          next === 'received' && event.turnId !== undefined
            ? string(event.turnId, 'receiving turnId', 256)
            : undefined
        if (
          event.entering !== undefined &&
          (next !== 'received' || event.entering !== true || receivingTurn === undefined)
        )
          fail('INVALID', 'entering receipt requires a receiving turn')
        if (intent.status === 'received') {
          if (receivingTurn !== undefined && receivingTurn !== intent.receivedTurnId)
            fail('STALE_INTENT', 'intent was already received by another or unrecorded turn')
          return
        }
        if (intent.status === 'accepted' && next === 'uncertain') return
        intent.status = next
        if (receivingTurn !== undefined) intent.receivedTurnId = receivingTurn
        if (event.entering === true) markEntering(state, receivingTurn)
        if (event.evidence !== undefined)
          intent.evidence = string(event.evidence, 'intent evidence', 8192)
        return
      }
      case 'review.started': {
        if (state.mode !== 'active') fail('PAUSED', 'project is not active')
        runtime(state, event)
        if (!['running', 'stopping'].includes(state.runtime.status))
          fail('STALE_RUN', 'review requires a live registered runtime')
        const reviewRunId = string(event.reviewRunId, 'reviewRunId', 256),
          consumerId = string(event.consumerId, 'consumerId', 256),
          claimEpoch = integer(event.claimEpoch, 'claimEpoch')
        const feedback = state.feedback.find(
          (item) => item.deliveryId === event.deliveryId && item.status === 'pending',
        )
        if (!feedback) fail('NOT_FOUND', 'pending feedback is not registered')
        if (feedback.claimEpoch !== undefined && feedback.claimEpoch !== claimEpoch)
          fail('STALE_REVIEW', 'feedback claim has changed')
        if (feedback.consumerId !== undefined && feedback.consumerId !== consumerId)
          fail('STALE_REVIEW', 'feedback consumer has changed')
        const existing = state.reviews.find((item) => item.reviewRunId === reviewRunId)
        if (existing) {
          currentReview(state, event)
          if (existing.deliveryId !== event.deliveryId)
            fail('CONFLICT', 'review id belongs to another delivery')
          return
        }
        if (state.reviews.some((item) => item.status === 'running'))
          fail('REVIEW_BUSY', 'another review run is active, including for this consumer')
        feedback.consumerId = consumerId
        feedback.claimEpoch = claimEpoch
        state.reviews.push({
          reviewRunId,
          consumerId,
          claimEpoch,
          deliveryId: feedback.deliveryId,
          workId: feedback.workId,
          taskId: work(state, feedback.workId).taskId,
          operationId: work(state, feedback.workId).operationId ?? null,
          acceptance: work(state, feedback.workId).acceptance,
          runId: event.runId,
          turnId: state.runtime.turnId,
          authorityEpoch: state.authorityEpoch,
          status: 'running',
        })
        return
      }
      case 'review.checkpoint': {
        const review = currentReview(state, event)
        review.checkpoint = checkpoint(event.checkpoint)
        return
      }
      case 'review.finished': {
        const review = currentReview(state, event),
          item = work(state, review.workId)
        if (!['accepted', 'changes_requested'].includes(event.status))
          fail('INVALID', 'review result is invalid')
        review.evidence = string(event.evidence, 'review evidence', 8192)
        review.result = event.status
        review.status = 'finished'
        item.status = event.status === 'accepted' ? 'accepted' : 'ready'
        item.evidence = review.evidence
        return
      }
      default:
        fail('INVALID', 'unsupported project event')
    }
  }
  /** Reserve one immutable intent shared by Stop and queue without doing transport I/O. */
  async decide(projectId, input) {
    record(input, 'decision input')
    return this.transaction(projectId, async (path) => {
      const state = await this.read(path)
      identity(state, input, true)
      if (!['stop', 'queue'].includes(input.via)) fail('INVALID', 'decision path is invalid')
      const none = (reason) => ({ action: 'none', reason, state })
      if (state.mode !== 'active') return none(state.mode)
      if (state.workItems.some((item) => item.status === 'waiting_human'))
        return none('waiting_human')
      if (input.via === 'queue' && state.runtime.enteringTurnId !== undefined)
        return none('runtime_entering')
      if (input.via === 'stop') {
        if (
          !['stopping', 'running'].includes(state.runtime.status) ||
          input.turnId !== state.runtime.turnId
        )
          return none('runtime_not_at_stop')
      } else if (!(
        ['idle', 'failed', 'interrupted'].includes(state.runtime.status) &&
        state.runtime.terminal === true
      ))
        return none('runtime_not_idle')
      if (input.via === 'queue' && state.reviews.some((review) => review.status === 'running'))
        return none('review_running')
      if (
        state.intents.some(
          (intent) =>
            intent.authorityEpoch === state.authorityEpoch &&
            !['received', 'cancelled'].includes(intent.status),
        )
      )
        return none('intent_already_reserved')
      let ready = state.workItems.filter(
        (item) =>
          ['ready', 'review_due'].includes(item.status) &&
          item.dependsOn.every((id) => work(state, id).status === 'accepted'),
      )
      let pending = state.feedback.filter(
        (item) => item.status === 'pending' && work(state, item.workId).status !== 'waiting_human',
      )
      if (input.via === 'queue') {
        // taskFeedback owns the initial result notice. Only an acquired review or unfinished
        // work after receipt consumption can justify a later chief continuation.
        const handled = (item) =>
          item.status === 'consumed' ||
          (Number.isSafeInteger(item.claimEpoch) && item.claimEpoch > 0 && item.consumerId)
        const initialResult = pending.some((item) => !handled(item))
        pending = pending.filter(handled)
        const ownsWake = (item) =>
          item.taskId &&
          !['cancelled', 'disconnected'].includes(item.feedbackObservation?.state) &&
          !state.feedback.some((row) => row.workId === item.workId && handled(row))
        const awaitingResult = ready.some(ownsWake)
        ready = ready.filter((item) => !ownsWake(item))
        if (!ready.length && !pending.length && (initialResult || awaitingResult))
          return none('task-feedback-owns-wake')
      }
      if (!ready.length && !pending.length) return none('no_actionable_work')
      const prior = state.intents.filter(
        (intent) =>
          intent.authorityEpoch === state.authorityEpoch &&
          intent.progressRevision === state.progressRevision,
      )
      if (prior.some((intent) => intent.status !== 'cancelled'))
        return none('intent_already_reserved')
      if (prior.length >= state.budgets.maxNoProgress) return none('no_progress_budget')
      if (state.intents.length >= state.budgets.maxIntents) return none('intent_budget')
      if (input.via === 'stop' && input.stopHookActive && prior.length)
        return none('no_progress_budget')
      const intent = {
        intentId: `coord-${digest({ projectId, authorityEpoch: state.authorityEpoch, progressRevision: state.progressRevision })}`,
        threadId: state.threadId,
        cwd: state.cwd,
        authorityEpoch: state.authorityEpoch,
        progressRevision: state.progressRevision,
        baselineRevision: state.revision,
        via: input.via,
        status: 'reserved',
        reason:
          state.runtime.status === 'failed' || state.runtime.recovery === true
            ? 'recovery_audit'
            : pending.length
              ? 'review_due'
              : 'work_ready',
        workIds: ready.map((item) => item.workId),
        deliveryIds: pending.map((item) => item.deliveryId),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: this.now(),
      }
      state.intents.push(intent)
      state.revision++
      state.updatedAt = this.now()
      validateState(state)
      await atomicWrite(path, state)
      return {
        action: input.via === 'stop' ? 'continue' : 'queue',
        reason: intent.reason,
        intent,
        state,
      }
    })
  }
}
