import { PassThrough, Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import {
  MINIMAX_EDIT_ERRORS,
  minimaxMessageEditDriver,
} from '../../src/execution/host/message-edit-minimax.ts'
import type { ExternalEditContext } from '../../src/execution/host/message-edit-driver.ts'
import type { HarnessSession, HarnessTurn } from '../../src/execution/contracts/sessions.ts'

interface NativeEntry {
  userMessageId: string
  timestamp: number
  fileChangeCount: number
  contentHead: string
  assistantMessageId?: string
}
interface Frame {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message: string }
}
interface CandidateBridge {
  input: PassThrough
  incoming: Writable
  output: Writable
  close(): void
}
interface CandidateRuntime {
  sendMessage(): AsyncGenerator<never>
  listSessionInputSummaries(): Promise<NativeEntry[]>
  rewindSession(): Promise<{ rewound: boolean; deletedMessageIds: string[] }>
}
const {
  createAcpOverlay,
  jsonLines,
}: {
  createAcpOverlay(input: {
    runtime: CandidateRuntime
    shell: { verify(): Promise<void>; advertisement: { version: number; type: string } }
    output: Writable
  }): CandidateBridge
  jsonLines(receive: (line: string) => void): Writable
} = await import(new URL('../../scripts/mcode-candidate/overlay/acp.mjs', import.meta.url).href)

const sessionId = 'mvs_1a3c182718a44308ae0b75e82b3d5790'
const nativeSessionId = 'session-8fbe727e-9a35-4953-990e-eb8470c36b66'
const failedInputId = 'msg-user-v1-VnCSkwylwRWdce0OpvQ8DJVzjyY7Km6R4dOcbm01rPg'
const failedTurnId = '748fe811-9470-4005-a5af-c1c8b70d2e3c'
const previousInputIds = [
  'msg-user-v1-ElOT6PMULgY0diMlmnZ-nZhegqKD3f1HT9tp4-JjVSM',
  'msg-user-v1-d1VbKhavL64wbXIPI6MWbKpMipXQlzCTS25yesWJXb4',
  'msg-user-v1-4oZGMIJngCsPQPP6LWsj-HLysM0NdNqSYSHZiUMepZ8',
]

const capability = {
  _meta: {
    'opl/session-history': {
      version: 1,
      methods: ['opl/session/history/list', 'opl/session/history/rewind'],
      notifications: ['opl/session/history/boundary'],
    },
  },
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function failedTurn(id: string | undefined, index: number): HarnessTurn {
  return {
    operationId: index === 3 ? 'message-edit:6bfa68f0-2b00-437c-a9c7-7a66e9bd580e' : `op-${index}`,
    fingerprint: `fp-${index}`,
    prompt: `input-${index}`,
    text: '',
    state: index === 3 ? 'failed' : index === 1 ? 'failed' : 'completed',
    tools: [],
    native: {
      ...(id ? { userMessageId: id } : {}),
      ...(index === 3 ? { turnId: failedTurnId, officialSeq: 106 } : {}),
    },
  }
}

interface TestConnection {
  bridge: CandidateBridge
  incoming: Writable
  forwarded: Frame[]
  request(method: string, params: object): Promise<unknown>
  notify(method: string, params: Record<string, unknown>): void
  close(): void
}

function testConnection(
  runtime: CandidateRuntime,
  sessionForLoad: string,
  forwardedAll: Frame[],
  loadResponse: { sessionId?: string } = {},
): TestConnection {
  const replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const forwarded: Frame[] = []
  const output = new Writable({
    write(chunk, _encoding, done) {
      try {
        const frame = JSON.parse(String(chunk)) as Frame
        const pending = frame.id === undefined ? undefined : replies.get(frame.id)
        if (pending) {
          replies.delete(frame.id!)
          if (frame.error) pending.reject(new Error(frame.error.message))
          else pending.resolve(frame.result)
        }
        done()
      } catch (error) {
        done(error as Error)
      }
    },
  })
  const bridge = createAcpOverlay({
    runtime,
    shell: { verify: async () => undefined, advertisement: { version: 1, type: 'bash' } },
    output,
  })
  const incoming = bridge.incoming
  bridge.input.pipe(
    jsonLines((line: string) => {
      const frame = JSON.parse(line) as Frame
      forwarded.push(frame)
      forwardedAll.push(frame)
      if (frame.method === 'session/new' || frame.method === 'session/load') {
        const result = frame.method === 'session/new' ? { sessionId: sessionForLoad } : loadResponse
        queueMicrotask(() =>
          bridge.output.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n'),
        )
      }
    }),
  )

  let nextId = 0
  return {
    bridge,
    incoming,
    forwarded,
    request(method, params) {
      const id = ++nextId
      const result = new Promise((resolve, reject) => replies.set(id, { resolve, reject }))
      incoming.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return result
    },
    notify(method, params) {
      const id = ++nextId
      incoming.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    },
    close() {
      bridge.close()
    },
  }
}

function setup(options: { loadResponse?: { sessionId?: string } } = {}) {
  let summaries: NativeEntry[] = previousInputIds.map((userMessageId, index) => ({
    userMessageId,
    timestamp: index + 1,
    fileChangeCount: index,
    contentHead: `head-${index}`,
    assistantMessageId: `assistant-${index}`,
  }))
  summaries.push({
    userMessageId: failedInputId,
    timestamp: 106,
    fileChangeCount: 0,
    contentHead: 'failed-without-body',
  })
  const runtime = {
    async *sendMessage() {},
    listSessionInputSummaries: vi.fn(async () => summaries),
    rewindSession: vi.fn(async () => ({ rewound: true, deletedMessageIds: [] })),
  }
  const forwarded: Frame[] = []
  let connection = testConnection(runtime, sessionId, forwarded, options.loadResponse)
  const connected = connection
    .request('session/new', {})
    .then((result) => result as Record<string, unknown>)
  let activeSession: Record<string, unknown> = {}
  const record: HarnessSession = {
    id: 'harness-14ae11f6958197a7fb205597',
    acpSessionId: sessionId,
    nativeSessionId,
    combination: 'minimax/minimax-m2.5',
    harnessRef: 'minimax',
    modelRef: { provider: 'minimax', model: 'minimax-m2.5' },
    cwd: 'C:/test/minimax-recovery',
    origin: { kind: 'desktop', sessionId: nativeSessionId },
    title: 'Failed MiniMax edit',
    sandbox: 'workspace',
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    turns: [] as HarnessTurn[],
  }
  const disconnect = vi.fn(async () => {
    connection.close()
  })
  const reconnect = vi.fn(async (requestedSessionId: string) => {
    connection = testConnection(runtime, requestedSessionId, forwarded, options.loadResponse)
    const loaded = await connection.request('session/load', { sessionId: requestedSessionId })
    activeSession = loaded as Record<string, unknown>
  })
  const context: ExternalEditContext = {
    record,
    launch: { home: 'C:/test', command: 'test-only', args: [], env: {} },
    signal: new AbortController().signal,
    transport: () => ({ request: (method, params) => connection.request(method, params) }),
    snapshot: () => ({
      agent: capability,
      session: activeSession,
      configOptions: undefined,
    }),
    disconnect,
    reconnect,
  }
  return {
    context,
    record,
    disconnect,
    reconnect,
    runtime,
    forwarded,
    setTurns(ids: (string | undefined)[] = [...previousInputIds, failedInputId]) {
      record.turns = ids.map((id, index) => failedTurn(id, index))
    },
    changeSummaries(update: typeof summaries) {
      summaries = update
    },
    summaries() {
      return structuredClone(summaries)
    },
    async ready() {
      activeSession = await connected
    },
    current() {
      return connection
    },
  }
}

describe('MiniMax failed edit recovery against the candidate ACP overlay', () => {
  it.each([{}, { sessionId }])(
    'settles the exact input after stable full history with load response %j',
    async (loadResponse) => {
      const f = setup({ loadResponse })
      await f.ready()
      expect((await minimaxMessageEditDriver.read(f.context)).settledInputId).toBeUndefined()
      f.setTurns()

      const history = await minimaxMessageEditDriver.read(f.context)

      expect(history.sessionId).toBe(sessionId)
      expect(history.settledInputId).toBe(failedInputId)
      expect(history.boundaries.map((boundary) => boundary.id)).toEqual([
        ...previousInputIds,
        failedInputId,
      ])
      expect(f.disconnect).toHaveBeenCalledTimes(1)
      expect(f.reconnect).toHaveBeenCalledWith(sessionId)
      expect(f.runtime.listSessionInputSummaries).toHaveBeenCalledTimes(4)
      expect(f.runtime.rewindSession).not.toHaveBeenCalled()
      expect(f.forwarded.map((frame) => frame.method)).toEqual(['session/new', 'session/load'])
      f.current().close()
    },
  )

  it('does not settle while the candidate overlay still owns a prompt', async () => {
    const f = setup()
    await f.ready()
    f.setTurns()
    f.current().notify('session/prompt', { sessionId, prompt: [] })
    await tick()

    await expect(minimaxMessageEditDriver.read(f.context)).rejects.toMatchObject({
      code: MINIMAX_EDIT_ERRORS.vendorUncertain,
    })
    expect(f.disconnect).not.toHaveBeenCalled()
    expect(f.reconnect).not.toHaveBeenCalled()
    expect(f.runtime.listSessionInputSummaries).not.toHaveBeenCalled()
    expect(f.forwarded.filter((frame) => frame.method === 'session/prompt')).toHaveLength(1)
    f.current().close()
  })

  it.each([
    ['missing native id', [...previousInputIds, undefined]],
    ['active latest turn', [...previousInputIds, failedInputId]],
    ['active retained turn', [...previousInputIds, failedInputId]],
    ['completed latest turn', [...previousInputIds, failedInputId]],
    [
      'stored prefix mismatch',
      [previousInputIds[0], 'unmatched', previousInputIds[2], failedInputId],
    ],
  ])('does not reconnect or settle with %s', async (reason, ids) => {
    const f = setup()
    await f.ready()
    f.setTurns(ids)
    if (reason === 'active latest turn') f.record.turns.at(-1)!.state = 'running'
    if (reason === 'active retained turn') f.record.turns[0]!.state = 'running'
    if (reason === 'completed latest turn') f.record.turns.at(-1)!.state = 'completed'

    const history = await minimaxMessageEditDriver.read(f.context)

    expect(history.settledInputId).toBeUndefined()
    expect(f.disconnect).not.toHaveBeenCalled()
    expect(f.reconnect).not.toHaveBeenCalled()
    expect(f.runtime.listSessionInputSummaries).toHaveBeenCalledTimes(1)
    f.current().close()
  })

  it('does not settle when full official history changes across the owned reconnect', async () => {
    const f = setup()
    await f.ready()
    f.setTurns()
    f.disconnect.mockImplementationOnce(async () => {
      f.current().close()
      f.changeSummaries([
        ...previousInputIds.map((userMessageId, index) => ({
          userMessageId,
          timestamp: index + 1,
          fileChangeCount: index,
          contentHead: `head-${index}`,
          assistantMessageId: `assistant-${index}`,
        })),
        {
          userMessageId: failedInputId,
          timestamp: 107,
          fileChangeCount: 0,
          contentHead: 'failed-without-body',
        },
      ])
    })

    await expect(minimaxMessageEditDriver.read(f.context)).rejects.toMatchObject({
      code: MINIMAX_EDIT_ERRORS.historyChanged,
    })
    expect(f.reconnect).toHaveBeenCalledWith(sessionId)
    expect(f.runtime.listSessionInputSummaries).toHaveBeenCalledTimes(3)
    expect(f.runtime.rewindSession).not.toHaveBeenCalled()
    f.current().close()
  })

  it('keeps recovery uncertain when disconnect cleanup fails', async () => {
    const f = setup()
    await f.ready()
    f.setTurns()
    f.disconnect.mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(minimaxMessageEditDriver.read(f.context)).rejects.toMatchObject({
      code: MINIMAX_EDIT_ERRORS.vendorUncertain,
    })
    expect(f.reconnect).not.toHaveBeenCalled()
    expect(f.runtime.listSessionInputSummaries).toHaveBeenCalledTimes(1)
    f.current().close()
  })

  it('rejects changes between the two post-reconnect history lists', async () => {
    const f = setup()
    await f.ready()
    f.setTurns()
    const initial = f.summaries()
    const changed = f.summaries()
    changed[0]!.fileChangeCount += 1
    f.runtime.listSessionInputSummaries
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed)

    await expect(minimaxMessageEditDriver.read(f.context)).rejects.toMatchObject({
      code: MINIMAX_EDIT_ERRORS.historyChanged,
    })
    expect(f.runtime.listSessionInputSummaries).toHaveBeenCalledTimes(3)
    expect(f.runtime.rewindSession).not.toHaveBeenCalled()
    f.current().close()
  })

  it('keeps recovery uncertain when the same-session reconnect fails', async () => {
    const f = setup()
    await f.ready()
    f.setTurns()
    f.reconnect.mockRejectedValueOnce(new Error('load failed'))

    await expect(minimaxMessageEditDriver.read(f.context)).rejects.toMatchObject({
      code: MINIMAX_EDIT_ERRORS.vendorUncertain,
    })
    expect(f.runtime.listSessionInputSummaries).toHaveBeenCalledTimes(1)
    expect(f.runtime.rewindSession).not.toHaveBeenCalled()
    f.current().close()
  })

  it('rejects a load response that explicitly identifies a different session', async () => {
    const f = setup({ loadResponse: { sessionId: 'different-session' } })
    await f.ready()
    f.setTurns()

    await expect(minimaxMessageEditDriver.read(f.context)).rejects.toMatchObject({
      code: MINIMAX_EDIT_ERRORS.historyChanged,
    })
    expect(f.reconnect).toHaveBeenCalledWith(sessionId)
    expect(f.runtime.listSessionInputSummaries).toHaveBeenCalledTimes(1)
    expect(f.runtime.rewindSession).not.toHaveBeenCalled()
    f.current().close()
  })
})
