import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { HarnessService } from '../../src/execution/host/harness.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { startControlBridge } from '../../src/shared/host/control-bridge.ts'
import { HarnessConfigurationError, HarnessRequestError } from '../../src/execution/host/acp.ts'
import {
  MINIMAX_EDIT_ERRORS,
  MinimaxEditError,
} from '../../src/execution/host/message-edit-minimax.ts'
import type { HarnessAdapter } from '../../src/execution/host/adapters/types.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { ExternalEditHistory } from '../../src/execution/host/message-edit-driver.ts'
import { externalEditRecordFingerprint } from '../../src/execution/host/message-edit-external.ts'
import { testPeerConnection } from '../test-peer.ts'

interface FixtureAcp {
  closed: boolean
  dispose(): Promise<void>
  exit(): void
}
const fixture = vi.hoisted(() => ({ instances: [] as FixtureAcp[] }))

vi.mock('../../src/shared/host/control-bridge.ts', () => ({ startControlBridge: vi.fn() }))
vi.mock('../../src/execution/host/adapters/index.ts', async (original) => ({
  ...(await original<typeof import('../../src/execution/host/adapters/index.ts')>()),
  adapterFor: vi.fn(),
}))
vi.mock('../../src/execution/host/acp.ts', async (original) => {
  const actual = await original<typeof import('../../src/execution/host/acp.ts')>()
  return {
    ...actual,
    AcpProcess: class implements FixtureAcp {
      closed = false
      private readonly onExit: () => void
      constructor(...args: unknown[]) {
        this.onExit = args[6] as () => void
        fixture.instances.push(this)
      }
      async request(method: string, params: { sessionId?: string }) {
        if (method === 'initialize')
          return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
        return { sessionId: params.sessionId }
      }
      exit() {
        if (this.closed) return
        this.closed = true
        this.onExit()
      }
      async dispose() {
        this.exit()
      }
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(startControlBridge).mockReset()
  fixture.instances.length = 0
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

interface FixtureActive {
  acp: FixtureAcp
  bridgeStop(): Promise<void>
}
interface Owner {
  openConnection(record: HarnessSession): Promise<void>
  disconnectForEdit(record: HarnessSession, expected: FixtureActive): Promise<void>
  externalHistory(record: HarnessSession): Promise<ExternalEditHistory>
  active: Map<string, FixtureActive>
}

const record = (): HarnessSession => ({
  id: 'owned-cleanup',
  harnessRef: 'minimax-code',
  combination: 'fixture',
  modelRef: { provider: 'fixture', model: 'model' },
  cwd: 'C:/test/owned-cleanup',
  acpSessionId: 'same-acp-session',
  nativeSessionId: 'owned-official-session',
  origin: { kind: 'desktop', sessionId: 'owned-official-session' },
  title: 'Owned cleanup fixture',
  sandbox: 'full-access',
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
  turns: [],
})

function lifecycleOwner() {
  const adapter: HarnessAdapter = {
    id: 'fixture',
    transport: 'acp',
    capabilities: {
      transport: 'acp',
      authentication: 'official-account',
      protocols: [],
      customEndpoint: false,
      permissions: ['full-access'],
      sessionLoad: true,
      cancel: true,
      reasoning: 'none',
      autoReview: 'unsupported',
    },
    matches: () => true,
    available: async () => ({ available: true }),
    prepare: async () => ({ home: 'C:/test', command: 'not-executed', args: [], env: {} }),
  }
  vi.mocked(adapterFor).mockReturnValue(adapter)
  const active = new Map<string, FixtureActive>()
  const service = Object.assign(Object.create(HarnessService.prototype) as HarnessService, {
    ctx: { connection: testPeerConnection },
    active,
    records: new Map(),
    connecting: new Map(),
    connectionGeneration: 0,
    catalogStore: { get: async () => ({ harnesses: [] }) },
    adapterOptions: () => ({}),
    changed: vi.fn(),
  })
  return service as unknown as Owner
}

describe('owned bridge cleanup', () => {
  it('keeps disconnect pending until cleanup started by the ACP exit callback finishes', async () => {
    const gate = deferred()
    const cleanup = vi.fn(() => gate.promise)
    vi.mocked(startControlBridge).mockResolvedValue(cleanup)
    const owner = lifecycleOwner()
    const session = record()
    await owner.openConnection(session)
    const active = owner.active.get(session.id)!
    fixture.instances[0]!.exit()
    const first = active.bridgeStop()
    const disconnect = owner.disconnectForEdit(session, active)
    let disconnected = false
    void disconnect.then(() => {
      disconnected = true
    })
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(disconnected).toBe(false)
      expect(owner.active.get(session.id)).toBe(active)
      expect(active.bridgeStop()).toBe(first)
      expect(cleanup).toHaveBeenCalledTimes(1)
    } finally {
      gate.resolve()
      await disconnect
    }
    expect(owner.active.has(session.id)).toBe(false)
  })

  it('retains the original cleanup rejection for disconnect and later callers', async () => {
    const gate = deferred()
    const cleanup = vi.fn(() => gate.promise)
    vi.mocked(startControlBridge).mockResolvedValue(cleanup)
    const owner = lifecycleOwner()
    const session = record()
    await owner.openConnection(session)
    const active = owner.active.get(session.id)!
    const first = active.bridgeStop()
    void first.catch(() => undefined)
    fixture.instances[0]!.exit()
    const disconnect = owner.disconnectForEdit(session, active)
    const failure = new Error('owned cleanup failed')
    const failed = expect(disconnect).rejects.toBe(failure)
    gate.reject(failure)
    await failed
    expect(active.bridgeStop()).toBe(first)
    await expect(active.bridgeStop()).rejects.toBe(failure)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(owner.active.get(session.id)).toBe(active)
  })
})

describe('message edit history diagnostics', () => {
  it.each<[Error, string]>([
    [
      new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain),
      MINIMAX_EDIT_ERRORS.vendorUncertain,
    ],
    [new HarnessConfigurationError('PRIVATE_PROVIDER_TEXT'), 'configuration'],
    [new HarnessRequestError('PRIVATE_PROVIDER_TEXT', 'session/new', -32603), 'acp-request'],
    [
      Object.assign(new Error('PRIVATE_PROVIDER_TEXT'), { code: 'PRIVATE_PROVIDER_CODE' }),
      'unclassified',
    ],
  ])('logs the local phase and known local error category only (%s)', async (error, code) => {
    const session = Session.create(SessionId('owned-official-session'))
    const warn = vi.fn()
    const saved = record()
    const service: HarnessService = Object.assign(
      Object.create(HarnessService.prototype) as HarnessService,
      {
        ready: Promise.resolve(),
        ctx: {
          sessions: { get: () => session },
          agents: { get: () => undefined },
          logger: { warn },
        },
        active: new Map(),
        finalizing: new Map(),
        externalEditing: new Set(),
        stopEditTarget: () => ({ record: saved, harness: 'minimax-code' }),
        externalDriver: () => ({}),
        externalMessageEdits: { pending: () => true, intent: () => ({ phase: 'prompting' }) },
        messageEdits: { pending: () => false },
        externalRecoveryHistory: async () => {
          throw error
        },
      },
    )
    expect(await service.messageEditState({ sessionId: session.id })).toMatchObject({
      pending: true,
      choices: [],
      unavailable: { reason: 'history-unavailable', retryable: true },
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(`phase=history-read code=${code}`)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_PROVIDER')
  })
})

function historyOwner() {
  const session = record()
  session.turns = [
    {
      operationId: 'cold-edit-input',
      fingerprint: 'original-input',
      prompt: 'original input',
      text: '',
      tools: [],
      state: 'failed',
      native: { userMessageId: 'exact-input', officialSeq: 1 },
    },
  ]
  const history: ExternalEditHistory = {
    sessionId: session.acpSessionId,
    token: 'current-history',
    boundaries: [{ id: 'exact-input' }],
  }
  const cache = new Map<string, { fingerprint: string; history: ExternalEditHistory }>()
  const connect = vi.fn(async () => {
    session.turns[0]!.contextUsage = { used: 1234, size: 512000 }
  })
  const read = vi.fn(async () => history)
  const owner = Object.assign(Object.create(HarnessService.prototype) as HarnessService, {
    externalHistories: cache,
    active: new Map(),
    connectAdmitted: connect,
    externalDriver: () => ({ read }),
    externalMessageEdits: { intent: () => undefined },
    externalContext: () => ({ record: session, signal: new AbortController().signal }),
  }) as unknown as Owner
  return { owner, session, history, cache, read, connect }
}

describe('edit history after cold load', () => {
  it('accepts unchanged history when loading fills missing context usage', async () => {
    const f = historyOwner()
    await expect(f.owner.externalHistory(f.session)).resolves.toEqual(f.history)
    expect(f.session.turns[0]!.contextUsage).toEqual({ used: 1234, size: 512000 })
    expect(f.cache.get(f.session.id)?.fingerprint).toBe(externalEditRecordFingerprint(f.session))
  })

  it('checks the cached binding after the load observations have settled', async () => {
    const f = historyOwner()
    f.cache.set(f.session.id, {
      fingerprint: externalEditRecordFingerprint(f.session),
      history: { ...f.history, token: 'cached-before-load' },
    })
    await expect(f.owner.externalHistory(f.session)).resolves.toEqual(f.history)
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('still rejects a message identity change during history reading', async () => {
    const f = historyOwner()
    f.read.mockImplementationOnce(async () => {
      f.session.turns[0]!.native!.userMessageId = 'different-input'
      return f.history
    })
    await expect(f.owner.externalHistory(f.session)).rejects.toThrow('编辑历史已变化')
    expect(f.cache.has(f.session.id)).toBe(false)
  })
})
