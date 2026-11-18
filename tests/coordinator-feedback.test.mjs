/** Metadata projection and queue acceptance tests use synthetic feedback and an injected transport. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  projectFeedback,
  readFeedback,
  resolveQueueConfig,
  runProcess,
  sendQueueIntent,
} from '../installer/skill/coordinator/feedback.mjs'

const at = '2026-11-15T09:00:00.000Z'
const later = '2026-11-15T10:00:00.000Z'
const secret = 'private-prompt-summary-questions-acceptance'
const project = {
  projectId: 'project-a',
  threadId: 'coordinator-a',
  authorityEpoch: 3,
  workItems: [{ workId: 'work-a', taskId: 'opaque#feedback@task', operationId: 'operation-a' }],
}
const task = (extra = {}) => ({
  taskId: project.workItems[0].taskId,
  target: { kind: 'codex-thread', threadId: project.threadId },
  execution: { kind: 'harness-session', operationId: 'operation-a', taskId: 'dispatcher-label' },
  state: 'completed',
  updatedAt: at,
  summary: secret,
  acceptance: secret,
  prompt: secret,
  ...extra,
})
const delivery = (extra = {}) => ({
  deliveryId: 'opaque@delivery',
  taskId: project.workItems[0].taskId,
  target: { kind: 'codex-thread', threadId: project.threadId },
  stage: 'delivered',
  retired: false,
  acknowledged: false,
  updatedAt: at,
  payload: {
    taskId: project.workItems[0].taskId,
    execution: task().execution,
    state: 'completed',
    summary: secret,
    acceptance: secret,
    needsInput: { questions: [{ question: secret }] },
  },
  ...extra,
})
const receipt = (extra = {}) => ({
  deliveryId: 'opaque@delivery',
  taskId: project.workItems[0].taskId,
  status: 'received',
  ownerId: 'reviewer-a',
  claimEpoch: 4,
  leaseExpiresAt: '2000-01-01T00:00:00.000Z',
  updatedAt: at,
  ...extra,
})
const snapshot = (extra = {}) => ({ tasks: [task()], outbox: [delivery()], receipts: [], ...extra })

test('feedback uses exact registered target, task and operation and returns metadata only', () => {
  const data = snapshot({
    tasks: [
      task(),
      task({ taskId: 'unregistered', summary: secret }),
      task({ taskId: 'wrong-thread', target: { kind: 'codex-thread', threadId: 'other' } }),
    ],
    outbox: [
      delivery(),
      delivery({ deliveryId: 'unregistered-delivery', taskId: 'unregistered' }),
      delivery({ deliveryId: 'wrong-target', target: { kind: 'codex-thread', threadId: 'other' } }),
    ],
  })
  const result = projectFeedback(project, data)
  assert.equal(result.status, 'available')
  assert.equal(result.pending.length, 1)
  assert.equal(result.observations.length, 1)
  assert.equal(result.pending[0].operationId, 'operation-a')
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(result.events[0].authorityEpoch, 3)
  assert.equal(result.events[0].type, 'feedback.pending')
  assert.equal(
    projectFeedback(
      project,
      snapshot({
        tasks: [
          task({
            execution: {
              kind: 'harness-session',
              operationId: 'old-operation',
              taskId: 'dispatcher-label',
            },
          }),
        ],
      }),
    ).pending.length,
    0,
  )
  const wrongScope = structuredClone(project)
  wrongScope.threadId = 'other-coordinator'
  assert.equal(projectFeedback(wrongScope, snapshot()).pending.length, 0)
  wrongScope.threadId = project.threadId
  wrongScope.workItems[0].taskId = 'same-prefix-but-different-task'
  assert.equal(projectFeedback(wrongScope, snapshot()).observations.length, 0)
})

test('native tasks retain the registered operation without parsing opaque feedback IDs', () => {
  const result = projectFeedback(
    project,
    snapshot({
      tasks: [task({ execution: { kind: 'dsh-session' } })],
      outbox: [
        delivery({ payload: { ...delivery().payload, execution: { kind: 'dsh-session' } } }),
      ],
    }),
  )
  assert.equal(result.pending[0].taskId, 'opaque#feedback@task')
  assert.equal(result.pending[0].operationId, 'operation-a')
})

test('consumed receipt closes received outbox without declaring work accepted', () => {
  const result = projectFeedback(
    project,
    snapshot({
      outbox: [delivery({ stage: 'received' })],
      receipts: [receipt({ status: 'consumed' })],
    }),
  )
  assert.equal(result.pending.length, 0)
  assert.equal(result.consumed.length, 1)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].type, 'feedback.consumed')
  assert.equal(
    result.events.some((event) => event.type === 'work.update'),
    false,
  )
})

test('unclaimed, claimed and review-started deliveries remain pending even when acknowledged', () => {
  for (const status of [null, 'received', 'review-started']) {
    const result = projectFeedback(
      project,
      snapshot({
        outbox: [delivery({ stage: 'received', acknowledged: true })],
        receipts: status ? [receipt({ status })] : [],
      }),
    )
    assert.equal(result.pending.length, 1)
    assert.equal(result.pending[0].receiptStatus, status)
    assert.equal(result.pending[0].claimEpoch, status ? 4 : null)
    assert.equal(
      result.events.some((event) => event.type === 'work.update'),
      false,
    )
  }
})

test('duplicate and reversed snapshots preserve consumed and stable event IDs', () => {
  const oldTask = task({ state: 'running' })
  const currentTask = task({ updatedAt: later })
  const received = receipt({ status: 'received', updatedAt: later, claimEpoch: 5 })
  const consumed = receipt({ status: 'consumed', updatedAt: at })
  const input = snapshot({
    tasks: [oldTask, currentTask, currentTask],
    outbox: [delivery(), delivery()],
    receipts: [received, consumed, consumed],
  })
  const forward = projectFeedback(project, input)
  const reverse = projectFeedback(
    project,
    Object.fromEntries(Object.entries(input).map(([key, rows]) => [key, [...rows].reverse()])),
  )
  assert.equal(forward.status, 'available')
  assert.deepEqual(forward, reverse)
  assert.equal(forward.pending.length, 0)
  assert.equal(forward.observations[0].state, 'completed')
  assert.equal(forward.events.length, 1)
})

test('renewed or expired leases grant no worker retry and do not create another wake event', () => {
  const first = projectFeedback(project, snapshot({ receipts: [receipt()] }))
  const renewed = projectFeedback(
    project,
    snapshot({
      receipts: [
        receipt({
          leaseExpiresAt: '2099-01-01T00:00:00.000Z',
          updatedAt: later,
        }),
      ],
    }),
  )
  assert.deepEqual(first.events, renewed.events)
  assert.equal(
    first.events.some((event) => event.type === 'work.update'),
    false,
  )
  assert.equal(first.pending[0].consumerId, 'reviewer-a')
  assert.equal(first.pending[0].claimEpoch, 4)
})

test('actual human waiting, cancellation and disconnection emit idempotent observations without deliveries', () => {
  for (const state of ['waiting_input', 'waiting_approval', 'cancelled', 'disconnected']) {
    const result = projectFeedback(project, snapshot({ tasks: [task({ state })], outbox: [] }))
    assert.equal(result.events.length, 1)
    assert.deepEqual(
      result.events,
      projectFeedback(project, snapshot({ tasks: [task({ state }), task({ state })], outbox: [] }))
        .events,
    )
    assert.equal(result.events[0].type, 'work.update')
    assert.equal(result.events[0].operationId, 'operation-a')
    assert.equal(
      result.events[0].status,
      state.startsWith('waiting_') ? 'waiting_human' : 'blocked',
    )
    assert.equal(result.events[0].evidence.state, state)
    assert.equal(result.pending.length, 0)
  }
})

test('a historical delivered human pause does not report current waiting after completion', () => {
  const result = projectFeedback(
    project,
    snapshot({
      outbox: [delivery({ payload: { ...delivery().payload, state: 'waiting_input' } })],
    }),
  )
  assert.equal(result.pending.length, 1)
  assert.equal(result.pending[0].state, 'completed')
  assert.equal(result.pending[0].deliveryState, 'waiting_input')
  assert.equal(result.pending[0].stale, true)
  assert.equal(
    result.events.some((event) => event.status === 'waiting_human'),
    false,
  )
  assert.equal(
    projectFeedback(project, snapshot({ outbox: [delivery({ retired: true })] })).pending.length,
    0,
  )
})

test('unknown or conflicting registered metadata fails closed without returning child data', () => {
  for (const input of [
    { tasks: [] },
    snapshot({ tasks: [task({ state: 'new-state' })] }),
    snapshot({ tasks: [task(), task({ state: 'failed' })] }),
    snapshot({ receipts: [receipt({ status: 'unknown' })] }),
    snapshot({ receipts: [receipt({ claimEpoch: -1 })] }),
    snapshot({ receipts: [receipt({ leaseExpiresAt: { summary: secret } })] }),
    snapshot({
      outbox: [
        delivery({ payload: { ...delivery().payload, execution: { kind: 'dsh-session' } } }),
      ],
    }),
    snapshot({ outbox: [delivery({ payload: { ...delivery().payload, taskId: 'other' } })] }),
  ]) {
    const result = projectFeedback(project, input)
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.events, [])
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
  assert.throws(
    () =>
      projectFeedback(
        { ...project, workItems: [project.workItems[0], project.workItems[0]] },
        snapshot(),
      ),
    /exactly once/,
  )
})

test('public helper reads only tasks/outbox/receipts with no-autostart and hides transport failures', async () => {
  const calls = []
  const controlPath = join(tmpdir(), 'installed skill', 'control.mjs')
  const result = await readFeedback({
    controlPath,
    project,
    run: async (command, args, options) => {
      calls.push({ command, args, options })
      return { outcome: 'exited', code: 0, stdout: JSON.stringify(snapshot()[args[1]]) }
    },
  })
  assert.equal(result.status, 'available')
  assert.deepEqual(
    calls.map((call) => call.args),
    ['tasks', 'outbox', 'receipts'].map((name) => [controlPath, name, '--no-autostart']),
  )
  assert.ok(calls.every((call) => call.command === process.execPath))
  for (const run of [
    async () => ({ outcome: 'exited', code: 1, stdout: secret }),
    async () => {
      throw new Error(secret)
    },
    async () => ({ outcome: 'exited', code: 0, stdout: 'invalid:' + secret }),
  ]) {
    const failed = await readFeedback({ controlPath, project, run })
    assert.equal(failed.status, 'unavailable')
    assert.equal(JSON.stringify(failed).includes(secret), false)
  }
})

test('missing DSH returns unavailable using the real shipped helper without launching it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opl-coordinator-feedback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(new URL('../installer/skill/control.mjs', import.meta.url), join(root, 'control.mjs'))
  await cp(
    new URL('../installer/windows-lifecycle.mjs', import.meta.url),
    join(root, 'windows-lifecycle.mjs'),
  )
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      home: root,
      autoStart: true,
      launcher: join(root, 'must-not-launch'),
      executable: join(root, 'must-not-launch'),
    }),
  )
  const result = await readFeedback({ controlPath: join(root, 'control.mjs'), project })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'dsh-unavailable')
  assert.equal(
    await readFile(join(root, 'config.json'), 'utf8')
      .then(JSON.parse)
      .then((config) => config.autoStart),
    true,
  )
})

const config = resolveQueueConfig({
  wakeTransport: 'codex-queue',
  wakeExecution: 'native',
  wakeExecutable: join(tmpdir(), 'configured codex', 'codex.exe'),
  timeoutMs: 9000,
})
const intent = {
  intentId: 'stable-intent-a',
  threadId: project.threadId,
  projectId: project.projectId,
  authorityEpoch: project.authorityEpoch,
  prompt: secret,
}

test('native queue uses the configured executable and argument array with stable metadata and no resume', async () => {
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    return { outcome: 'exited', code: 0, stdout: secret }
  }
  const result = await sendQueueIntent({ config, intent, run })
  assert.deepEqual(result, { intentId: intent.intentId, status: 'accepted', retryable: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, config.executable)
  assert.deepEqual(calls[0].args.slice(0, 4), ['queue', '--thread', project.threadId, '--message'])
  const message = JSON.parse(calls[0].args[4])
  assert.equal(message.intentId, intent.intentId)
  assert.equal(message.authorityEpoch, 3)
  assert.equal(calls[0].options.timeoutMs, 9000)
  assert.equal(JSON.stringify(calls).includes(secret), false)
  assert.equal(calls[0].args.includes('--resume'), false)
})

test('WSL queue preserves distro, executable and metacharacters as unquoted argv', async () => {
  const wsl = resolveQueueConfig({
    wakeTransport: 'codex-queue',
    wakeExecution: 'wsl',
    wakeExecutable: '/opt/codex bin/codex',
    wakeDistro: 'Ubuntu Test',
  })
  const calls = []
  const special = { ...intent, intentId: 'intent-$(touch fake);`whoami`' }
  await sendQueueIntent({
    config: wsl,
    intent: special,
    run: async (command, args) => {
      calls.push([command, args])
      return { outcome: 'exited', code: 0 }
    },
  })
  assert.equal(calls[0][0], 'wsl')
  assert.deepEqual(calls[0][1].slice(0, 7), [
    '-d',
    'Ubuntu Test',
    '--',
    '/opt/codex bin/codex',
    'queue',
    '--thread',
    project.threadId,
  ])
  assert.equal(JSON.parse(calls[0][1][8]).intentId, special.intentId)
})

test('timeout, nonzero exit, thrown or unknown acceptance returns uncertain and never retries', async () => {
  for (const outcome of [
    { outcome: 'timed-out', code: null },
    { outcome: 'exited', code: 1 },
    { outcome: 'unknown', code: null },
    { accepted: true },
    undefined,
    new Error(secret),
  ]) {
    let calls = 0
    const result = await sendQueueIntent({
      config,
      intent,
      run: async () => {
        calls++
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    })
    assert.equal(calls, 1)
    assert.deepEqual(result, { intentId: intent.intentId, status: 'uncertain', retryable: false })
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
})

test('unconnected and failed-before-start transports refuse without retry or discovery', async () => {
  let calls = 0
  assert.equal(
    (
      await sendQueueIntent({
        config: resolveQueueConfig(),
        intent,
        run: async () => {
          calls++
        },
      })
    ).status,
    'refused',
  )
  assert.equal(calls, 0)
  const result = await sendQueueIntent({
    config,
    intent,
    run: async () => {
      calls++
      return { outcome: 'not-started', code: null }
    },
  })
  assert.deepEqual(result, { intentId: intent.intentId, status: 'refused', retryable: false })
  assert.equal(calls, 1)
})

test('queue rejects implicit executable discovery, relative paths and invalid registration', async () => {
  for (const settings of [
    { executable: config.executable },
    { wakeTransport: 'codex-queue', wakeExecution: 'native', wakeExecutable: 'codex' },
    {
      wakeTransport: 'codex-queue',
      wakeExecution: 'native',
      wakeExecutable: config.executable,
      wakeDistro: 'unused',
    },
    {
      wakeTransport: 'codex-queue',
      wakeExecution: 'wsl',
      wakeExecutable: '/bin/codex',
      wakeDistro: '-bad',
    },
    {
      wakeTransport: 'codex-queue',
      wakeExecution: 'native',
      wakeExecutable: config.executable,
      timeoutMs: 0,
    },
  ])
    assert.throws(() => resolveQueueConfig(settings), /configuration/)
  await assert.rejects(
    sendQueueIntent({ config, intent: { ...intent, threadId: 'manual' } }),
    /intent/,
  )
  await assert.rejects(readFeedback({ project, controlPath: 'control.mjs' }), /absolute/)
})

test('default process adapter reports absent executable without shell evaluation', async () => {
  assert.deepEqual(
    await runProcess(join(tmpdir(), 'missing-opl-directory', 'codex.exe'), ['queue']),
    { outcome: 'not-started', code: null, stdout: '' },
  )
})

test('queue settings follow the public DSH status on every read without caching credentials', async () => {
  const { readWakeSettings } = await import('../installer/skill/coordinator/feedback.mjs')
  const calls = []
  let current = {
    wakeTransport: 'codex-queue',
    wakeExecution: 'native',
    wakeExecutable: join(tmpdir(), 'codex.exe'),
    wakeDistro: '',
  }
  const run = async (command, args) => {
    calls.push({ command, args })
    return { outcome: 'exited', code: 0, stdout: JSON.stringify({ ...current, token: secret }) }
  }
  const controlPath = join(tmpdir(), 'skill', 'control.mjs')
  const connected = await readWakeSettings({ controlPath, run })
  assert.equal(connected.queue.executable, current.wakeExecutable)
  assert.equal(JSON.stringify(connected).includes(secret), false)
  current = { wakeTransport: 'unconnected' }
  assert.deepEqual((await readWakeSettings({ controlPath, run })).queue, {
    transport: 'unconnected',
  })
  assert.deepEqual(calls[0].args, [controlPath, 'coordination-status', '--no-autostart'])
  assert.equal(calls[0].command, process.execPath)
  const unavailable = await readWakeSettings({
    controlPath,
    run: async () => ({ outcome: 'exited', code: 1, stdout: secret }),
  })
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(JSON.stringify(unavailable).includes(secret), false)
})
