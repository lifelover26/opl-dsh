/** Lifecycle and exact history behavior for the official MCode npm overlay. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import {
  createAcpOverlay,
  jsonLines,
  usageNotification,
} from '../scripts/mcode-candidate/overlay/acp.mjs'
import { bindNativeShell } from '../scripts/mcode-candidate/overlay/shell.mjs'
import { controlledLogin } from '../scripts/mcode-candidate/overlay/auth.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const baseRuntime = () => ({
  async *sendMessage() {},
  listSessionInputSummaries: async () => [
    { userMessageId: 'u1', timestamp: 1, fileChangeCount: 0 },
  ],
  rewindSession: async () => ({ rewound: true, deletedMessageIds: ['u1', 'a1'] }),
})
function harness(runtime = baseRuntime(), verify = async () => {}) {
  const messages = [],
    forwarded = []
  const output = new Writable({
    write(chunk, _encoding, done) {
      messages.push(JSON.parse(chunk))
      done()
    },
  })
  const bridge = createAcpOverlay({
    runtime,
    shell: { verify, advertisement: { version: 1, type: 'bash' } },
    output,
  })
  bridge.input.pipe(jsonLines((line) => forwarded.push(JSON.parse(line))))
  const send = (id, method, params = {}) =>
    bridge.incoming.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  const reply = (id, result) =>
    bridge.output.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  send(1, 'session/new')
  reply(1, { sessionId: 's1' })
  return { bridge, messages, forwarded, send, reply }
}

test('history owns the session throughout native storage awaits; no concurrent prompt is forwarded', async () => {
  const barrier = deferred()
  const h = harness({ ...baseRuntime(), listSessionInputSummaries: () => barrier.promise })
  h.send(2, 'opl/session/history/list', { sessionId: 's1' })
  await tick()
  h.send(3, 'session/prompt', { sessionId: 's1' })
  assert.match(h.messages.at(-1).error.message, /busy/)
  assert.equal(
    h.forwarded.some((x) => x.method === 'session/prompt'),
    false,
  )
  barrier.resolve([])
  await tick()
  assert.deepEqual(h.messages.at(-1).result.entries, [])
  h.bridge.close()
})

test('cancel does not release prompt ownership until the official prompt result arrives', async () => {
  const h = harness()
  h.send(2, 'session/prompt', { sessionId: 's1' })
  await tick()
  h.bridge.incoming.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } }) +
      '\n',
  )
  h.send(3, 'opl/session/history/rewind', {
    sessionId: 's1',
    userMessageId: 'u1',
    clientRequestId: 'edit',
  })
  await tick()
  assert.match(h.messages.at(-1).error.message, /busy/)
  assert.equal(h.forwarded.at(-1).method, 'session/cancel')
  h.reply(2, { stopReason: 'cancelled' })
  h.send(4, 'opl/session/history/list', { sessionId: 's1' })
  await tick()
  assert.equal(h.messages.at(-1).result.entries[0].userMessageId, 'u1')
  h.bridge.close()
})

test('a cancellation acknowledgement cannot release a still-running prompt', async () => {
  const h = harness()
  h.send(2, 'session/prompt', { sessionId: 's1' })
  await tick()
  h.send(3, 'session/cancel', { sessionId: 's1' })
  h.reply(3, {})
  h.send(4, 'opl/session/history/list', { sessionId: 's1' })
  await tick()
  assert.match(h.messages.at(-1).error.message, /busy/)
  h.reply(2, { stopReason: 'cancelled' })
  h.send(5, 'opl/session/history/list', { sessionId: 's1' })
  await tick()
  assert.ok(h.messages.at(-1).result.entries)
  h.bridge.close()
})

test('official session extensions cannot mutate history during rewind', async () => {
  const barrier = deferred()
  const h = harness({ ...baseRuntime(), rewindSession: () => barrier.promise })
  h.send(2, 'opl/session/history/rewind', {
    sessionId: 's1',
    userMessageId: 'u1',
    clientRequestId: 'e1',
  })
  await tick()
  h.send(3, 'mcode/session/queue', { sessionId: 's1', text: 'late' })
  assert.match(h.messages.at(-1).error.message, /busy/)
  assert.equal(
    h.forwarded.some((x) => x.method === 'mcode/session/queue'),
    false,
  )
  barrier.resolve({ rewound: true, deletedMessageIds: ['u1'] })
  await tick()
  h.bridge.close()
})

test('disconnect while checking a persisted shell cannot forward a late prompt', async () => {
  const barrier = deferred()
  const h = harness(baseRuntime(), () => barrier.promise)
  h.send(2, 'session/prompt', { sessionId: 's1' })
  h.bridge.incoming.end()
  await tick()
  barrier.resolve()
  await tick()
  assert.equal(
    h.forwarded.some((x) => x.method === 'session/prompt'),
    false,
  )
  h.bridge.close()
})

test('rewind uses native identity, never restores files, and returns the callers operation id', async () => {
  const calls = []
  const h = harness({
    ...baseRuntime(),
    rewindSession: async (request) => {
      calls.push(request)
      return { rewound: true, deletedMessageIds: ['u1'] }
    },
  })
  for (const bad of [{ rewindTurnDiff: true }, { restoreFiles: true }]) {
    h.send('bad' + JSON.stringify(bad), 'opl/session/history/rewind', {
      sessionId: 's1',
      userMessageId: 'u1',
      clientRequestId: 'e1',
      ...bad,
    })
    await tick()
    assert.ok(h.messages.at(-1).error)
  }
  assert.equal(calls.length, 0)
  h.send(4, 'opl/session/history/rewind', {
    sessionId: 's1',
    userMessageId: 'u1',
    clientRequestId: 'e1',
    rewindTurnDiff: false,
  })
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].rewindTurnDiff, false)
  assert.match(calls[0].clientRequestId, /^oplsh1-[0-9a-f]{32}$/)
  assert.equal(h.messages.at(-1).result.clientRequestId, 'e1')
  h.bridge.close()
})

test('a native failure does not leak diagnostics or claim an edit succeeded', async () => {
  const h = harness({
    ...baseRuntime(),
    rewindSession: async () => {
      throw Error('PRIVATE_SYNTHETIC_CANARY')
    },
  })
  h.send(2, 'opl/session/history/rewind', {
    sessionId: 's1',
    userMessageId: 'u1',
    clientRequestId: 'e1',
  })
  await tick()
  assert.ok(h.messages.at(-1).error)
  assert.equal(JSON.stringify(h.messages).includes('PRIVATE_SYNTHETIC_CANARY'), false)
  h.bridge.close()
})

test('only the original committed user message binds an operation; continuations cannot replace it', async () => {
  const runtime = {
    ...baseRuntime(),
    async *sendMessage() {
      for (const m of [
        { role: 'user', id: 'injected', turnId: 'other' },
        { role: 'assistant', id: 'a1', turnId: 't1' },
        { role: 'user', id: 'u1', turnId: 't1' },
        { role: 'user', id: 'u2', turnId: 't1' },
      ])
        yield { type: 'message', message: m }
    },
  }
  const h = harness(runtime)
  h.send(2, 'initialize', {
    clientCapabilities: {
      _meta: { 'minimax-code/extensions': { version: 1, notifications: true } },
    },
  })
  h.reply(2, {})
  h.send(3, 'session/prompt', { sessionId: 's1', _meta: { 'opl/clientRequestId': 'p1' } })
  await tick()
  for await (const _event of runtime.sendMessage({ id: 's1', turnId: 't1' })) {
    /* consume native stream */
  }
  const boundaries = h.messages.filter((x) => x.method === 'opl/session/history/boundary')
  assert.equal(boundaries.length, 1)
  assert.equal(boundaries[0].params.userMessageId, 'u1')
  h.bridge.close()
})

test('an old or different shell binding rejects before the prompt reaches the native ACP server', async () => {
  const h = harness(baseRuntime(), async () => {
    throw Error('wrong shell')
  })
  h.send(2, 'session/prompt', { sessionId: 's1' })
  await tick()
  assert.ok(h.messages.at(-1).error)
  assert.equal(
    h.forwarded.some((x) => x.method === 'session/prompt'),
    false,
  )
  h.bridge.close()
})

test('completed native streams publish only token rows from the bound turn before the ACP result', async () => {
  const calls = []
  const runtime = {
    ...baseRuntime(),
    async *sendMessage() {
      yield { type: 'message', message: { role: 'user', id: 'u1', turnId: 't1' } }
    },
    async getSessionUsage(id) {
      calls.push(id)
      return {
        summary: { costUsd: 'PRIVATE_SYNTHETIC_CANARY' },
        rows: [
          { turnId: 'previous', inputTokens: 99999 },
          {
            id: 1,
            turnId: 't1',
            model: 'minimax/MiniMax-M3.1-Flash',
            inputTokens: 10,
            outputTokens: 3,
            cacheReadTokens: 20,
            cacheWriteTokens: 0,
            reasoningTokens: 1,
            costUsd: 'PRIVATE_SYNTHETIC_CANARY',
            rawJson: 'PRIVATE_SYNTHETIC_CANARY',
          },
        ],
      }
    },
  }
  const h = harness(runtime)
  h.send(2, 'initialize', { clientCapabilities: { _meta: { 'minimax-code/extensions': true } } })
  h.reply(2, {})
  h.send(3, 'session/prompt', { sessionId: 's1', _meta: { 'opl/clientRequestId': 'p1' } })
  await tick()
  const stream = runtime.sendMessage({ id: 's1', turnId: 't1' })
  await stream.next()
  assert.equal(calls.length, 0)
  await stream.next()
  const notification = h.messages.find((m) => m.method === usageNotification)
  assert.deepEqual(notification.params, {
    version: 1,
    sessionId: 's1',
    operationId: 'p1',
    turnId: 't1',
    rows: [
      {
        id: 1,
        turnId: 't1',
        model: 'minimax/MiniMax-M3.1-Flash',
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
      },
    ],
  })
  assert.deepEqual(calls, ['s1'])
  assert.equal(JSON.stringify(h.messages).includes('PRIVATE_SYNTHETIC_CANARY'), false)
  h.reply(3, { stopReason: 'end_turn' })
  assert.equal(h.messages.at(-1).id, 3)
  h.bridge.close()
})

test('incomplete, unnegotiated and disconnected native streams do not publish usage', async () => {
  for (const mode of ['incomplete', 'unnegotiated', 'disconnected', 'unbound']) {
    let queries = 0
    const runtime = {
      ...baseRuntime(),
      async *sendMessage() {
        yield {
          type: 'message',
          message: { role: 'user', id: 'u1', turnId: mode === 'unbound' ? 'old' : 't1' },
        }
      },
      async getSessionUsage() {
        queries++
        return { rows: [] }
      },
    }
    const h = harness(runtime)
    if (mode !== 'unnegotiated') {
      h.send(2, 'initialize', {
        clientCapabilities: { _meta: { 'minimax-code/extensions': true } },
      })
      h.reply(2, {})
    }
    h.send(3, 'session/prompt', { sessionId: 's1', _meta: { 'opl/clientRequestId': 'p1' } })
    await tick()
    const stream = runtime.sendMessage({ id: 's1', turnId: 't1' })
    await stream.next()
    if (mode === 'disconnected') h.bridge.close()
    if (mode === 'incomplete') await stream.return()
    else await stream.next()
    assert.equal(queries, 0)
    assert.equal(
      h.messages.some((m) => m.method === usageNotification),
      false,
    )
    h.bridge.close()
  }
})

test('a failed optional usage read preserves the completed native stream', async () => {
  const runtime = {
    ...baseRuntime(),
    async *sendMessage() {
      yield { type: 'message', message: { role: 'user', id: 'u1', turnId: 't1' } }
    },
    async getSessionUsage() {
      throw Error('PRIVATE_SYNTHETIC_CANARY')
    },
  }
  const h = harness(runtime)
  h.send(2, 'initialize', { clientCapabilities: { _meta: { 'minimax-code/extensions': true } } })
  h.reply(2, {})
  h.send(3, 'session/prompt', { sessionId: 's1', _meta: { 'opl/clientRequestId': 'p1' } })
  await tick()
  const events = []
  for await (const event of runtime.sendMessage({ id: 's1', turnId: 't1' })) events.push(event)
  assert.equal(events.length, 1)
  assert.equal(
    h.messages.some((m) => m.method === usageNotification),
    false,
  )
  h.reply(3, { stopReason: 'end_turn' })
  assert.equal(h.messages.at(-1).result.stopReason, 'end_turn')
  h.bridge.close()
})

test('a blocked local usage read cannot keep a completed prompt running', async () => {
  const runtime = {
    ...baseRuntime(),
    async *sendMessage() {
      yield { type: 'message', message: { role: 'user', id: 'u1', turnId: 't1' } }
    },
    getSessionUsage: () => new Promise(() => {}),
  }
  const h = harness(runtime)
  h.send(2, 'initialize', {
    clientCapabilities: { _meta: { 'minimax-code/extensions': true } },
  })
  h.reply(2, {})
  h.send(3, 'session/prompt', { sessionId: 's1', _meta: { 'opl/clientRequestId': 'p1' } })
  await tick()
  // Keep the test process alive independently of the optional query's unref'ed timer.
  const deadline = setTimeout(() => assert.fail('Usage query blocked the completed turn.'), 5000)
  try {
    for await (const _event of runtime.sendMessage({ id: 's1', turnId: 't1' })) {
      /* consume completed stream */
    }
    h.reply(3, { stopReason: 'end_turn' })
    assert.equal(h.messages.at(-1).result.stopReason, 'end_turn')
    assert.equal(
      h.messages.some((m) => m.method === usageNotification),
      false,
    )
  } finally {
    clearTimeout(deadline)
    h.bridge.close()
  }
})

test('Git Bash selection stays process-local and verifies the persisted session binding', async () => {
  const changes = []
  const service = {
    options: {
      preferences: { get: () => 'pwsh', set: (key, value) => changes.push([key, value]) },
    },
    async status() {
      return {
        preference: await this.options.preferences.get('agent-command-shell-preference'),
        effective: { family: 'git-bash', executablePath: 'C:/Git/bin/bash.exe' },
      }
    },
    resolveForExecution: async () => ({
      family: 'git-bash',
      executablePath: 'C:/Git/bin/bash.exe',
    }),
  }
  const runtime = {
    host: { cliService: { options: { agentShell: service } } },
    adapter: { createSession: async () => ({ sessionId: 'new' }) },
  }
  const shell = await bindNativeShell(runtime, 'C:/Git/bin/bash.exe', 'win32')
  await runtime.adapter.createSession()
  assert.deepEqual(changes, [])
  service.resolveForExecution = async () => ({ family: 'pwsh', executablePath: 'C:/pwsh.exe' })
  await assert.rejects(shell.verify('new'), /different shell/)
  assert.deepEqual(changes, [])
})

test('server authorization expiry cancels the owned login without signing out', async () => {
  const input = new PassThrough(),
    waiting = deferred()
  let expire,
    cancelled = 0,
    signedOut = false
  const core = {
    async login({ onDeviceAuthorization }) {
      onDeviceAuthorization({ expiresInSec: 30 })
      await waiting.promise
      throw Error('cancelled')
    },
    cancelLogin() {
      cancelled++
      waiting.resolve()
    },
    logout() {
      signedOut = true
    },
  }
  const application = {
    options: { sharedAuthCore: core },
    async login(progress) {
      await core.login({ onDeviceAuthorization: progress })
    },
  }
  const output = new PassThrough()
  const frames = []
  output.on('data', (x) => frames.push(x.toString()))
  const result = controlledLogin({
    application,
    input,
    output,
    runLogin: ({ createApplication }) => createApplication().login(),
    timers: {
      clearTimeout() {},
      setTimeout(fn, ms) {
        assert.equal(ms, 30_000)
        expire = fn
        return 1
      },
    },
  })
  await tick()
  expire()
  await assert.rejects(result)
  assert.equal(cancelled, 1)
  assert.equal(signedOut, false)
  assert.ok(frames.includes('OPL_AUTH_EXPIRES_V1 30\n'))
  assert.equal(input.listenerCount('data'), 0)
})

test('cancelling while the official account-status read is pending never starts OAuth later', async () => {
  const input = new PassThrough(),
    status = deferred()
  let started = 0,
    cancelled = 0
  const core = {
    async login() {
      started++
    },
    cancelLogin() {
      cancelled++
    },
  }
  const application = {
    options: { sharedAuthCore: core },
    async login() {
      await status.promise
      await core.login()
    },
  }
  const result = controlledLogin({
    application,
    input,
    output: new PassThrough(),
    runLogin: ({ createApplication }) => createApplication().login(),
  })
  input.write('OPL_AUTH_CANCEL_V1\n')
  status.resolve()
  await assert.rejects(result, /cancel/)
  assert.equal(started, 0)
  assert.equal(cancelled, 0)
  assert.equal(input.listenerCount('end'), 0)
})

test('split Unicode pipe frames preserve the exact user text', async () => {
  const values = []
  const stream = jsonLines((line) => values.push(JSON.parse(line)))
  const bytes = Buffer.from(JSON.stringify({ text: '中文编辑' }) + '\n')
  for (const byte of bytes) stream.write(Buffer.from([byte]))
  stream.end()
  await tick()
  assert.deepEqual(values, [{ text: '中文编辑' }])
})
