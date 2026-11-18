/** Runtime tests join real persistent state, metadata parsing and feedback projection. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Coordinator } from '../installer/skill/coordinator/runtime.mjs'
import { projectFeedback } from '../installer/skill/coordinator/feedback.mjs'

const record = (payload, type = 'event_msg') => JSON.stringify({ type, payload }) + '\n'
const header = (backendVersion = '0.167.0') =>
  record({ id: 'thread-a', session_id: 'thread-a', cli_version: backendVersion }, 'session_meta')
const row = (type, turn_id = 'turn-a', extra = {}) => record({ type, turn_id, ...extra })
const empty = { status: 'available', observations: [], events: [], pending: [], consumed: [] }
const owner = {
  status: 'known',
  runId: 'backend-a',
  pid: process.pid,
  processBirth: 'fixture-birth-a',
  backendVersion: '0.167.0',
}

async function fixture(
  t,
  { task = false, history = '', feedback, queue, inspect, send, backendVersion = '0.167.0' } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'opl-coordinator-runtime-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const codexHome = join(root, 'codex'),
    cwd = join(root, 'workspace')
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  await mkdir(cwd)
  const transcript = join(codexHome, 'sessions', 'rollout.jsonl')
  await writeFile(transcript, header(backendVersion) + history)
  const sent = []
  const runtime = new Coordinator({
    root: join(root, 'coordinator'),
    codexHome,
    controlPath: join(root, 'control.mjs'),
    queue: queue ?? { transport: 'codex-queue' },
    owner: async () => ({ ...owner, backendVersion }),
    inspect: inspect ?? (async () => ({ status: 'alive' })),
    waitExit: async ({ signal }) => {
      if (signal.aborted) return { status: 'unknown' }
      await new Promise((done) => signal.addEventListener('abort', done, { once: true }))
      return { status: 'unknown' }
    },
    feedback: feedback ?? (async () => empty),
    send:
      send ??
      (async ({ intent }) => {
        sent.push(intent)
        return { status: 'accepted' }
      }),
  })
  await runtime.init({
    projectId: 'project-a',
    threadId: 'thread-a',
    cwd,
    authorization: 'synthetic user request',
    workItems: [
      {
        workId: 'work-a',
        acceptance: 'artifact plus behavior evidence',
        status: task ? 'running' : 'ready',
        ...(task ? { taskId: 'task-a', operationId: 'operation-a' } : {}),
      },
    ],
  })
  const hook = (event, extra = {}) =>
    runtime.hook({
      event,
      sessionId: 'thread-a',
      agentId: null,
      cwd,
      transcriptPath: transcript,
      turnId: event === 'SessionStart' ? null : 'turn-a',
      stopHookActive: false,
      ...extra,
    })
  const append = (type, turn = 'turn-a', extra = {}) =>
    appendFile(transcript, row(type, turn, extra))
  const start = async () => {
    await hook('SessionStart')
    await append('task_started')
    await hook('UserPromptSubmit')
  }
  return { root, runtime, codexHome, cwd, transcript, hook, append, start, sent }
}

function feedbackSnapshot(state, at, { delivery = true, consumed = false } = {}) {
  const task = {
    taskId: 'task-a',
    target: { kind: 'codex-thread', threadId: 'thread-a' },
    execution: {
      kind: 'harness-session',
      operationId: 'operation-a',
      taskId: 'label-a',
      harnessSessionId: 'session-a',
    },
    state,
    updatedAt: at,
  }
  return {
    tasks: [task],
    outbox: delivery
      ? [
          {
            deliveryId: 'delivery-a',
            taskId: task.taskId,
            target: task.target,
            stage: 'delivered',
            retired: false,
            updatedAt: at,
            payload: { taskId: task.taskId, execution: task.execution, state },
          },
        ]
      : [],
    receipts: consumed
      ? [
          {
            deliveryId: 'delivery-a',
            taskId: 'task-a',
            status: 'consumed',
            ownerId: 'reviewer-a',
            claimEpoch: 1,
            leaseExpiresAt: null,
            updatedAt: at,
          },
        ]
      : [],
  }
}

test('unregistered chats do no process, feedback or transport work', async (t) => {
  const f = await fixture(t)
  const before = await readFile(f.runtime.store.paths('project-a').file, 'utf8')
  f.runtime.owner = () => {
    throw new Error('unregistered called process inspection')
  }
  f.runtime.feedback = () => {
    throw new Error('unregistered called feedback')
  }
  f.runtime.send = () => {
    throw new Error('unregistered called transport')
  }
  for (const event of [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'Stop',
    'Interrupt',
    'PreModelRequest',
    'PostModelRequest',
    'SubagentStart',
    'SubagentStop',
  ]) {
    assert.equal((await f.hook(event, { sessionId: 'other' })).reason, 'unregistered-thread')
    assert.equal((await f.hook(event, { agentId: 'ordinary-child' })).reason, 'unregistered-thread')
  }
  assert.equal(await readFile(f.runtime.store.paths('project-a').file, 'utf8'), before)
  assert.equal(f.sent.length, 0)
})

test('cold activation skips old interruption and anchors only the current Hook turn', async (t) => {
  const f = await fixture(t, {
    history: row('task_started', 'old') + row('turn_aborted', 'old', { reason: 'interrupted' }),
  })
  await f.hook('UserPromptSubmit')
  await f.append('task_started')
  assert.equal((await f.hook('Stop')).status, 'continue')
  const state = await f.runtime.status('project-a')
  assert.equal(state.mode, 'active')
  assert.equal(state.intents.length, 1)
})

test('Stop continuation and queue share one intent, and a matching next request acknowledges it', async (t) => {
  const f = await fixture(t)
  await f.start()
  assert.equal((await f.hook('Stop')).output.decision, 'block')
  assert.equal((await f.hook('PreModelRequest')).status, 'observed')
  assert.equal((await f.runtime.status('project-a')).intents[0].status, 'received')
  await f.append('task_complete')
  await f.runtime.reconcile('project-a')
  assert.equal(f.sent.length, 0)
  assert.equal((await f.runtime.status('project-a')).intents.length, 1)
})

test('0.169.0 Stop continuation is acknowledged by its next request without a duplicate queue wake', async (t) => {
  const f = await fixture(t, { backendVersion: '0.169.0' })
  await f.start()
  const stop = await f.hook('Stop')
  assert.equal(stop.status, 'continue')
  assert.equal(stop.output.decision, 'block')
  assert.equal((await f.hook('PreModelRequest')).status, 'observed')
  await f.append('task_complete')
  await f.runtime.reconcile('project-a')
  const state = await f.runtime.status('project-a')
  assert.equal(state.runtime.backendVersion, '0.169.0')
  assert.equal(state.intents.length, 1)
  assert.equal(state.intents[0].status, 'received')
  assert.equal(f.sent.length, 0)
})

test('unknown backend cannot bind a runtime or request Stop continuation', async (t) => {
  const f = await fixture(t, { backendVersion: '0.170.0' })
  assert.equal((await f.hook('SessionStart')).status, 'idle')
  assert.equal((await f.hook('Stop')).status, 'idle')
  const state = await f.runtime.status('project-a')
  assert.equal(state.runtime.status, 'unknown')
  assert.equal(state.runtime.runId, undefined)
  assert.equal(state.intents.length, 0)
  assert.equal(f.sent.length, 0)
})

test('a real terminal failure gets one recovery audit; a request retry failure gets none', async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.hook('PostModelRequest', { requestStatus: 'failed' })
  assert.equal((await f.runtime.reconcile('project-a')).reason, 'runtime-not-terminal')
  await f.append('task_complete', 'turn-a', { error: { message: 'private provider detail' } })
  assert.equal((await f.runtime.reconcile('project-a')).status, 'accepted')
  assert.equal(f.sent[0].reason, 'recovery_audit')
  assert.equal((await f.runtime.reconcile('project-a')).status, 'attention')
  assert.equal(f.sent.length, 1)
  assert.ok(
    !JSON.stringify(await f.runtime.status('project-a')).includes('private provider detail'),
  )
})

test('registered Interrupt persists pause even when process inspection fails', async (t) => {
  const f = await fixture(t)
  await f.start()
  f.runtime.owner = async () => ({ status: 'unknown', reason: 'process-query-failed' })
  await f.hook('Interrupt')
  assert.equal((await f.runtime.status('project-a')).mode, 'paused_by_user')
  await f.append('turn_aborted', 'turn-a', { reason: 'interrupted' })
  await f.runtime.reconcile('project-a')
  assert.equal(f.sent.length, 0)
})

test('late cancellation cannot undo an explicit newer resume', async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.hook('Interrupt')
  await f.runtime.resume('project-a')
  await f.append('turn_aborted', 'turn-a', { reason: 'interrupted' })
  await f.runtime.reconcile('project-a')
  assert.equal((await f.runtime.status('project-a')).mode, 'active')
  assert.equal(f.sent.length, 1)
})

test('queue envelope acknowledgement deduplicates repeated delivery and blocks paused/completed targets', async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.append('task_complete')
  await f.runtime.reconcile('project-a')
  const continuation = { projectId: 'project-a', intentId: f.sent[0].intentId, authorityEpoch: 1 }
  await f.append('task_started', 'turn-b')
  assert.equal(
    (await f.hook('UserPromptSubmit', { turnId: 'turn-b', continuation })).status,
    'observed',
  )
  assert.equal(
    (await f.hook('UserPromptSubmit', { turnId: 'turn-c', continuation })).output.decision,
    'block',
  )
  await f.runtime.pause('project-a')
  assert.equal((await f.hook('UserPromptSubmit', { continuation })).output.decision, 'block')
})

test('a pause between envelope screening and acknowledgement returns an explicit blocking output', async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.append('task_complete')
  await f.runtime.reconcile('project-a')
  const continuation = { projectId: 'project-a', intentId: f.sent[0].intentId, authorityEpoch: 1 }
  const acknowledge = f.runtime.acknowledge.bind(f.runtime)
  f.runtime.acknowledge = async (...args) => {
    await f.runtime.pause('project-a')
    return acknowledge(...args)
  }
  const result = await f.hook('UserPromptSubmit', { turnId: 'turn-b', continuation })
  assert.equal(result.output.decision, 'block')
  assert.equal((await f.runtime.status('project-a')).mode, 'paused_by_user')
  assert.equal((await f.runtime.status('project-a')).intents[0].status, 'cancelled')
})

test('unavailable state during queued envelope ingress returns block without exposing the error', async (t) => {
  const f = await fixture(t)
  f.runtime.uniqueProject = async () => {
    throw new Error('private state diagnostic')
  }
  const result = await f.hook('UserPromptSubmit', {
    continuation: { projectId: 'project-a', intentId: 'intent-a', authorityEpoch: 1 },
  })
  assert.equal(result.output.decision, 'block')
  assert.ok(!JSON.stringify(result).includes('private state diagnostic'))
})

test('uncertain acceptance is visible and never sends another id after new progress', async (t) => {
  let calls = 0
  const f = await fixture(t, {
    send: async () => {
      calls++
      return { status: 'uncertain' }
    },
  })
  await f.start()
  await f.append('task_complete')
  assert.equal((await f.runtime.reconcile('project-a')).status, 'uncertain')
  await f.runtime.event('project-a', 'work.update', {
    workId: 'work-a',
    status: 'review_due',
    evidence: 'new artifact',
  })
  const second = await f.runtime.reconcile('project-a')
  assert.equal(second.status, 'attention')
  assert.equal(second.deliveryStatus, 'uncertain')
  assert.equal(calls, 1)
})

test('old and new turn in one read remain ordered, and fresh rollout history is not replayed', async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.append('task_complete')
  await f.append('task_started', 'turn-b')
  assert.equal((await f.hook('UserPromptSubmit', { turnId: 'turn-b' })).status, 'observed')
  assert.equal((await f.runtime.status('project-a')).runtime.turnId, 'turn-b')
  await f.append('task_complete', 'turn-b')
  await f.runtime.reconcile('project-a')
  const next = join(f.codexHome, 'sessions', 'resumed.jsonl')
  await writeFile(
    next,
    header() +
      row('task_started', 'historical') +
      row('turn_aborted', 'historical', { reason: 'interrupted' }),
  )
  assert.equal((await f.hook('SessionStart', { transcriptPath: next })).status, 'observed')
  assert.equal((await f.runtime.status('project-a')).mode, 'active')
})

test('unknown appended format blocks advancement without classifying file silence as a crash', async (t) => {
  const f = await fixture(t)
  await f.start()
  await appendFile(f.transcript, record({ type: 'unsupported-event', turn_id: 'turn-a' }))
  assert.equal((await f.runtime.reconcile('project-a')).reason, 'unknown-lifecycle-event')
  assert.equal(f.sent.length, 0)
})

test('only exact process exit permits an unfinished turn recovery audit', async (t) => {
  const f = await fixture(t, { inspect: async () => ({ status: 'unknown' }) })
  await f.start()
  assert.equal((await f.runtime.reconcile('project-a')).reason, 'runtime-not-terminal')
  f.runtime.inspect = async () => ({ status: 'exited', reason: 'pid-reused' })
  assert.equal((await f.runtime.reconcile('project-a')).status, 'accepted')
  assert.equal(f.sent.length, 1)
})

test('feedback null claims and object evidence integrate with state; stale snapshots cannot lift human wait', async (t) => {
  let snapshot = feedbackSnapshot('waiting_input', '2026-11-15T12:00:00Z')
  const f = await fixture(t, {
    task: true,
    feedback: async ({ project }) => projectFeedback(project, snapshot),
  })
  await f.start()
  await f.append('task_complete')
  await f.runtime.reconcile('project-a')
  assert.equal((await f.runtime.status('project-a')).workItems[0].status, 'waiting_human')
  snapshot = feedbackSnapshot('completed', '2026-11-15T11:00:00Z')
  await f.runtime.reconcile('project-a')
  assert.equal((await f.runtime.status('project-a')).workItems[0].status, 'waiting_human')
  assert.equal(f.sent.length, 0)
})

test('first observation of consumed receipt does not falsely accept work or abort reconciliation', async (t) => {
  const f = await fixture(t, {
    task: true,
    feedback: async ({ project }) =>
      projectFeedback(
        project,
        feedbackSnapshot('completed', '2026-11-15T12:00:00Z', { consumed: true }),
      ),
  })
  await f.start()
  await f.append('task_complete')
  await f.runtime.reconcile('project-a')
  const state = await f.runtime.status('project-a')
  assert.equal(state.workItems[0].status, 'review_due')
  assert.equal(state.feedback.length, 1)
  assert.equal(state.feedback[0].status, 'consumed')
  assert.equal(f.sent.length, 1)
})

test('disconnected worker without an outbox wakes one chief audit without restarting that worker', async (t) => {
  const f = await fixture(t, {
    task: true,
    feedback: async ({ project }) =>
      projectFeedback(
        project,
        feedbackSnapshot('disconnected', '2026-11-15T12:00:00Z', { delivery: false }),
      ),
  })
  await f.start()
  await f.append('task_complete')
  await f.runtime.reconcile('project-a')
  assert.equal(f.sent.length, 1)
  assert.equal((await f.runtime.status('project-a')).workItems[0].status, 'review_due')
})

test('filesystem event wakes an idle chief and watcher shuts down all owned handles', async (t) => {
  const f = await fixture(t)
  await f.start()
  const signal = new AbortController()
  const running = f.runtime.watch({ signal: signal.signal })
  t.after(async () => {
    signal.abort()
    await running
  })
  await delay(100)
  await f.append('task_complete')
  const deadline = Date.now() + 3500
  while (!f.sent.length && Date.now() < deadline) await delay(40)
  assert.equal(f.sent.length, 1)
  await delay(400)
  assert.equal(f.sent.length, 1)
  signal.abort()
  assert.equal((await running).status, 'stopped')
  assert.equal(
    JSON.parse(await readFile(f.runtime.store.paths('project-a').file, 'utf8')).runtime.status,
    'idle',
  )
})

test('new user ingress suppresses queue before slow owner inspection and concurrent feedback', async (t) => {
  const f = await fixture(t)
  await f.start()
  await f.append('task_complete')
  await f.runtime.observe('project-a', (await f.runtime.status('project-a')).runtime.binding)
  let release
  f.runtime.owner = () =>
    new Promise((done) => {
      release = () => done(owner)
    })
  const entering = f.hook('UserPromptSubmit', { turnId: 'turn-b' })
  const deadline = Date.now() + 2000
  while (!release && Date.now() < deadline) await delay(10)
  assert.ok(release)
  assert.equal((await f.runtime.reconcile('project-a')).reason, 'runtime_entering')
  assert.equal(f.sent.length, 0)
  release()
  await entering
})

test('initial watcher failure disposes file handles and its process waiter', async (t) => {
  const f = await fixture(t)
  await f.start()
  let aborted = false
  f.runtime.waitExit = async ({ signal }) => {
    await new Promise((done) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          done()
        },
        { once: true },
      ),
    )
    return { status: 'unknown' }
  }
  f.runtime.reconcile = async () => {
    throw new Error('synthetic-initial-failure')
  }
  await assert.rejects(f.runtime.watch(), /synthetic-initial-failure/)
  assert.equal(aborted, true)
  await appendFile(f.transcript, row('task_complete'))
})

async function liveReview(t) {
  let consumed = false
  const f = await fixture(t, {
    task: true,
    feedback: async ({ project }) => {
      const snapshot = feedbackSnapshot('completed', '2026-11-15T12:00:00Z', { consumed })
      if (!consumed)
        snapshot.receipts = [
          {
            deliveryId: 'delivery-a',
            taskId: 'task-a',
            status: 'received',
            ownerId: 'reviewer-a',
            claimEpoch: 1,
            leaseExpiresAt: '2026-11-15T13:00:00Z',
            updatedAt: '2026-11-15T12:00:00Z',
          },
        ]
      return projectFeedback(project, snapshot)
    },
  })
  await f.start()
  await f.runtime.syncFeedback('project-a')
  await f.runtime.event('project-a', 'review.started', {
    reviewRunId: 'review-a',
    consumerId: 'reviewer-a',
    claimEpoch: 1,
    deliveryId: 'delivery-a',
    runId: owner.runId,
  })
  const noteFile = join(f.cwd, 'review.md')
  await writeFile(noteFile, 'Synthetic independent acceptance evidence.\n')
  const request = {
    kind: 'review',
    reviewRunId: 'review-a',
    consumerId: 'reviewer-a',
    claimEpoch: 1,
    authorityEpoch: 1,
    decision: 'accepted',
    noteFile,
  }
  const calls = []
  f.runtime.callerThreadId = 'thread-a'
  f.runtime.runControl = async (exe, args) => {
    calls.push({ exe, args })
    return { outcome: 'exited', code: 0 }
  }
  return {
    ...f,
    request,
    calls,
    setConsumed: () => {
      consumed = true
    },
  }
}

test('review write and consume use current owner fencing and stable business effect ids', async (t) => {
  const f = await liveReview(t)
  assert.equal((await f.runtime.reviewAction('project-a', f.request)).status, 'accepted')
  assert.equal(
    (await f.runtime.reviewAction('project-a', { ...f.request, actionId: 'caller-cannot-replay' }))
      .replayed,
    true,
  )
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].args.includes('session-a'))
  await f.runtime.event('project-a', 'review.finished', {
    reviewRunId: 'review-a',
    consumerId: 'reviewer-a',
    claimEpoch: 1,
    workId: 'work-a',
    status: 'accepted',
    evidence: 'real fixture checks passed',
  })
  assert.equal(
    (await f.runtime.reviewAction('project-a', { ...f.request, kind: 'consume' })).status,
    'accepted',
  )
  assert.equal(f.calls.length, 2)
  f.setConsumed()
  assert.equal(
    (await f.runtime.reviewAction('project-a', { ...f.request, kind: 'consume' })).alreadyConsumed,
    true,
  )
  assert.equal(f.calls.length, 2)
  assert.equal((await f.runtime.status('project-a')).workItems[0].status, 'accepted')
})

test('stale review ownership, another chat, and a note outside the project never invoke Host writes', async (t) => {
  const f = await liveReview(t)
  await assert.rejects(
    f.runtime.reviewAction('project-a', { ...f.request, authorityEpoch: 2 }),
    /review-runtime-changed/,
  )
  await assert.rejects(
    f.runtime.reviewAction('project-a', { ...f.request, claimEpoch: 2 }),
    /review-runtime-changed/,
  )
  f.runtime.callerThreadId = 'other-chat'
  await assert.rejects(f.runtime.reviewAction('project-a', f.request), /review-runtime-changed/)
  f.runtime.callerThreadId = 'thread-a'
  await assert.rejects(
    f.runtime.reviewAction('project-a', {
      ...f.request,
      noteFile: join(f.cwd + '-other', 'review.md'),
    }),
    /review-note-outside-project/,
  )
  assert.equal(f.calls.length, 0)
})

test('review notes resolving through a workspace link to an outside file never invoke Host writes', async (t) => {
  const f = await liveReview(t)
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'review.md'), 'Outside private file.\n')
  const link = join(f.cwd, 'outside-link')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(
    f.runtime.reviewAction('project-a', { ...f.request, noteFile: join(link, 'review.md') }),
    /review-note-outside-project/,
  )
  assert.equal(f.calls.length, 0)
})

test('receipt consumption requires a finished review and also closes changes-requested notifications', async (t) => {
  const f = await liveReview(t)
  await assert.rejects(f.runtime.reviewAction('project-a', { ...f.request, kind: 'consume' }), {
    code: 'STALE_REVIEW',
  })
  assert.equal(f.calls.length, 0)
  await f.runtime.reviewAction('project-a', { ...f.request, decision: 'changes_requested' })
  await f.runtime.event('project-a', 'review.finished', {
    reviewRunId: 'review-a',
    consumerId: 'reviewer-a',
    claimEpoch: 1,
    workId: 'work-a',
    status: 'changes_requested',
    evidence: 'independent checks found a required correction',
  })
  const consumed = await f.runtime.reviewAction('project-a', { ...f.request, kind: 'consume' })
  assert.equal(consumed.status, 'accepted')
  assert.equal(f.calls.length, 2)
  assert.equal((await f.runtime.status('project-a')).workItems[0].status, 'ready')
})

test('Interrupt persists before a pending Host action finishes and its late success grants no authority', async (t) => {
  const f = await liveReview(t)
  let signalEntered, releaseEffect
  const entered = new Promise((resolve) => {
    signalEntered = resolve
  })
  const release = new Promise((resolve) => {
    releaseEffect = resolve
  })
  f.runtime.runControl = async () => {
    signalEntered()
    await release
    return { outcome: 'exited', code: 0 }
  }
  const action = f.runtime.reviewAction('project-a', f.request)
  await entered
  const interrupt = f.hook('Interrupt')
  let pause
  try {
    pause = await Promise.race([interrupt, delay(2000).then(() => null)])
  } finally {
    releaseEffect()
  }
  const result = await action
  await interrupt
  assert.ok(pause, 'Interrupt waited for the external Host call')
  assert.equal(result.status, 'uncertain')
  const state = await f.runtime.status('project-a')
  assert.equal(state.mode, 'paused_by_user')
  assert.equal(state.authorityEpoch, 2)
  assert.equal(state.reviews[0].status, 'fenced')
  assert.equal(state.reviews[0].actions[0].status, 'uncertain')
  assert.equal(state.workItems[0].status, 'review_due')
})

test('taskFeedback owns an initial completion wake and a received unfinished review may continue once', async (t) => {
  let snapshot = feedbackSnapshot('completed', '2026-11-16T01:00:00Z')
  const f = await fixture(t, {
    task: true,
    feedback: async ({ project }) => projectFeedback(project, snapshot),
  })
  await f.start()
  await f.append('task_complete')
  assert.equal((await f.runtime.reconcile('project-a')).reason, 'task-feedback-owns-wake')
  assert.equal(f.sent.length, 0)
  const unclaimed = await f.runtime.status('project-a')
  assert.equal(unclaimed.intents.length, 0)
  snapshot = {
    ...snapshot,
    receipts: [
      {
        deliveryId: 'delivery-a',
        taskId: 'task-a',
        status: 'received',
        ownerId: 'reviewer-a',
        claimEpoch: 1,
        leaseExpiresAt: '2026-11-16T01:05:00Z',
        updatedAt: '2026-11-16T01:01:00Z',
      },
    ],
  }
  assert.equal((await f.runtime.reconcile('project-a')).status, 'accepted')
  await f.runtime.reconcile('project-a')
  assert.equal(f.sent.length, 1)
})

test('runtime resolves current shared queue settings only when it has terminal actionable work', async (t) => {
  const f = await fixture(t)
  f.runtime.queue = undefined
  let calls = 0,
    current = { transport: 'unconnected' }
  f.runtime.queueSettings = async () => {
    calls++
    return { status: 'available', queue: current }
  }
  await f.start()
  assert.equal((await f.runtime.reconcile('project-a')).reason, 'runtime-not-terminal')
  assert.equal(calls, 0)
  await f.append('task_complete')
  assert.equal((await f.runtime.reconcile('project-a')).reason, 'queue-unconnected')
  assert.equal(f.sent.length, 0)
  current = { transport: 'codex-queue', executable: 'synthetic-queue' }
  assert.equal((await f.runtime.reconcile('project-a')).status, 'accepted')
  assert.equal(calls, 2)
})

test('concurrent registrations in the same chief reserve one project identity', async (t) => {
  const f = await fixture(t)
  const runtime = new Coordinator({
    root: join(f.root, 'registration-race'),
    codexHome: f.codexHome,
    controlPath: join(f.root, 'control.mjs'),
  })
  const spec = {
    projectId: 'race-a',
    cwd: f.cwd,
    threadId: 'thread-a',
    authorization: 'same chief',
    workItems: [{ workId: 'next', acceptance: 'verify' }],
  }
  const results = await Promise.allSettled([
    runtime.init(spec),
    runtime.init({ ...spec, projectId: 'race-b' }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.message,
    'thread-already-registered',
  )
  assert.equal((await runtime.status()).length, 1)
})
