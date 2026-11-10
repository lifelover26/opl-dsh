import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type GenerateOptions,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { HarnessSessionStore } from '../../src/execution/host/session-store.ts'
import {
  HarnessService,
  GROK_COMBINATION,
  grokConfiguration,
} from '../../src/execution/host/harness.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { codexSandboxMode } from '../../src/execution/host/adapters/native-bash.ts'
import { harnessPermissionPreset } from '../../src/execution/host/permissions.ts'
import { commandLaunch } from '../../src/execution/host/harness-registry.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import { resolveGatewayExecution } from '../../src/gateway/host/execution-access.ts'
import { GROK_API_KEY_REF } from '../../src/gateway/host/config.ts'
import { testPeerConnection } from '../test-peer.ts'
import { AcpProcess, HarnessConfigurationError } from '../../src/execution/host/acp.ts'
import { createGrokMessageEditDriver } from '../../src/execution/host/message-edit-grok.ts'
import type {
  ExternalEditContext,
  ExternalEditHistory,
  ExternalMessageEditDriver,
} from '../../src/execution/host/message-edit-driver.ts'
import type { ExternalMessageEditTransactions } from '../../src/execution/host/message-edit-external.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import { HARNESS_INPUT_MAX_LENGTH } from '../../src/execution/host/harness-input.ts'
import { HISTORY_NOTICE } from '../../src/execution/host/multimodal-prompt.ts'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

/**
 * Run the generic ACP transport and lifecycle cases against a Node fixture agent.
 *
 * Every case in this file drives the harness' own persistence, approvals, deduplication,
 * concurrency, resume, cancellation and conversation streaming against
 * `tests/fixtures/acp-agent.mjs`. None of them is a test of an official CLI's OS sandbox.
 *
 * Production Grok deliberately refuses restricted tiers on Windows, because its official
 * sandbox has no backend on this platform. That refusal is correct, and it is verified
 * separately against the real adapter in the Grok suite. To keep this file about the harness,
 * the adapter's `prepare` step is replaced for exactly this Node fixture:
 *
 * - only the adapter's launch step is replaced; the `HarnessService` under test stays real;
 * - the configuration file and gateway-key handling stay real, reusing the production helpers;
 * - no production module gains a test hook, no platform is faked, and no lifecycle, approval,
 *   permission or deduplication assertion is removed or weakened.
 *
 * A passing case here therefore says nothing about whether an official CLI's sandbox works.
 * @returns nothing; installs the fixture-only adapter preparation.
 */
function useNodeAcpFixtureAgent() {
  const adapter = adapterFor('grok-build', {
    provider: 'opl-gateway',
    model: 'grok::grok-4.7',
  })
  if (!adapter) throw Error('fixture seam requires the Grok adapter entry')
  vi.spyOn(adapter, 'prepare').mockImplementation(async (ctx, record, options) => {
    if (
      options.prefix?.length !== 1 ||
      options.prefix[0] !== resolve('tests/fixtures/acp-agent.mjs')
    )
      throw Error('The fixture adapter only launches the Node ACP fixture')
    const route = await resolveGatewayExecution(ctx, record.modelRef, options.resolveKey)
    const home = join(options.home, 'harnesses', 'grok-build')
    await mkdir(home, { recursive: true, mode: 0o700 })
    // The real configuration layout is still written, so the credential assertions below
    // still hold.
    const config = join(home, 'config.toml'),
      bytes = grokConfiguration(route.baseURL)
    const current = await readFile(config, 'utf8').catch(() => undefined)
    if (current === undefined) await writeFile(config, bytes, { mode: 0o600, flag: 'wx' })
    else if (current !== bytes) await writeFile(config, bytes, { mode: 0o600 })
    // A Node fixture agent has no OS sandbox, so it takes neutral fixture flags. These say
    // nothing about the official Grok tiers.
    const launch = commandLaunch(process.execPath, [
      ...(options.prefix ?? []),
      '--cwd',
      record.cwd,
      '--model',
      'grok-4.7',
      '--sandbox',
      record.sandbox === 'read-only' ? 'read-only' : 'workspace-write',
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ])
    return {
      home,
      ...launch,
      env: {
        ...systemEnvironment(),
        GROK_HOME: home,
        [GROK_API_KEY_REF]: route.apiKey,
        GROK_DEFAULT_SELECTED_PERMISSION: 'allow_once',
      },
    }
  })
}

async function setup() {
  useNodeAcpFixtureAgent()
  const root = await mkdtemp(join(tmpdir(), 'opl-acp-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const options = {
    home: join(root, 'state'),
    command: process.execPath,
    prefix: [resolve('tests/fixtures/acp-agent.mjs')],
    resolveKey: async () => 'test-grok-key',
  }
  const ctx = {
    connection: testPeerConnection,
    get: () => undefined,
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [] },
    waterfall: async (_event, _request, next) => next(),
  } as unknown as Context
  const service = new HarnessService(ctx, options)
  cleanups.push(() => service.dispose())
  return { root, options, ctx, service }
}
const start = (s: HarnessService, cwd: string, taskId = 'task') =>
  s.start({
    combination: GROK_COMBINATION,
    cwd,
    taskId,
    origin: { kind: 'codex', sessionId: 'parent' },
  })
const wait = (s: HarnessService, id: string) => s.wait({ sessionId: id }, AbortSignal.timeout(8000))

it('shares concurrent execution catalog reads', async () => {
  const { service } = await setup()
  const resolver = (service as unknown as { modelResolver: { resolve: () => Promise<unknown> } })
    .modelResolver
  const resolve = vi.spyOn(resolver, 'resolve')
  const [first, second, third] = await Promise.all([
    service.executionCatalog(),
    service.executionCatalog(),
    service.executionCatalog(),
  ])
  expect(resolve).toHaveBeenCalledTimes(1)
  expect(second).toBe(first)
  expect(third).toBe(first)
})

it('shares overlapping availability probes but refreshes completed and changed results', async () => {
  const { service } = await nativeSetup([{ id: 'deepseek-flash', name: 'DeepSeek' }])
  const snapshot = await service.executionCatalog()
  vi.spyOn(service, 'executionCatalog').mockResolvedValue(snapshot)
  const adapter = adapterFor('dsh', { provider: 'opl-gateway', model: 'deepseek-flash' })!
  const available = vi.spyOn(adapter, 'available').mockResolvedValue({ available: true })
  const [first, second] = await Promise.all([service.combinations(), service.combinations()])
  expect(first).toEqual(second)
  expect(available).toHaveBeenCalledTimes(1)
  available.mockResolvedValue({ available: false, reason: 'removed' })
  const next = await service.combinations()
  expect(available).toHaveBeenCalledTimes(2)
  expect(next.find((row) => row.modelId === 'deepseek-flash')?.available).toBe(false)
  available.mockRejectedValueOnce(Error('probe unavailable'))
  await expect(service.combinations()).rejects.toThrow('probe unavailable')
  available.mockResolvedValue({ available: true })
  expect(
    (await service.combinations()).find((row) => row.modelId === 'deepseek-flash')?.available,
  ).toBe(true)
  expect(available).toHaveBeenCalledTimes(4)
})

it('starts execution catalog while the official model catalog is still pending', async () => {
  const { service, ctx, session } = await nativeSetup()
  const entered = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<unknown>()
  Object.assign(ctx, {
    typertGateway: {
      invoke: async () => {
        entered.resolve()
        return answer.promise
      },
    },
  })
  const catalog = vi.spyOn(service, 'executionCatalog')
  const read = service.modelSelection(session.id)
  await entered.promise
  try {
    expect(catalog).toHaveBeenCalledTimes(1)
  } finally {
    answer.resolve({ default: { provider: 'opl-gateway', model: 'deepseek-flash' }, groups: [] })
    await read
  }
})

describe('external completion observations', () => {
  it('does not let an old history observation close a replacement connection', async () => {
    const { service, root } = await setup()
    const session = await start(service, root)
    const owner = service as unknown as {
      records: Map<string, HarnessSession>
      active: Map<string, { acp: AcpProcess }>
      externalContext(record: HarnessSession, signal: AbortSignal): ExternalEditContext
    }
    const original = owner.active.get(session.id)!
    const observation = owner.externalContext(
      owner.records.get(session.id)!,
      new AbortController().signal,
    )
    const dispose = vi.fn(async () => {})
    owner.active.set(session.id, { ...original, acp: { dispose } as unknown as AcpProcess })
    try {
      await expect(observation.disconnect()).rejects.toThrow('连接已变化')
      expect(dispose).not.toHaveBeenCalled()
    } finally {
      owner.active.set(session.id, original)
    }
  })

  it.each(['opencode', 'kilo'])(
    'persists %s result input identity even when final history is unavailable',
    async (harness) => {
      const { service, root, options } = await setup()
      const session = await start(service, root)
      const owner = service as unknown as {
        records: Map<string, HarnessSession>
        active: Map<string, { acp: AcpProcess }>
        pinSession(): Promise<void>
        observeEditHistory(): Promise<ExternalEditHistory | undefined>
        connectAdmitted(): Promise<void>
      }
      owner.records.get(session.id)!.harnessRef = harness
      vi.spyOn(owner, 'pinSession').mockResolvedValue()
      vi.spyOn(owner, 'observeEditHistory').mockResolvedValue(undefined)
      vi.spyOn(owner, 'connectAdmitted').mockResolvedValue()
      const acp = owner.active.get(session.id)!.acp
      const request = acp.request.bind(acp)
      vi.spyOn(acp, 'request').mockImplementation((method, ...args) =>
        method === 'session/prompt'
          ? Promise.resolve({ stopReason: 'refusal', userMessageId: 'exact-provider-input' })
          : request(method, ...args),
      )
      await service.prompt({ sessionId: session.id, text: 'one', operationId: 'one' })
      const settled = await wait(service, session.id)
      expect(settled.turns[0]?.native?.userMessageId).toBe('exact-provider-input')
      await service.dispose()
      const stored = await new HarnessSessionStore(options.home).load()
      expect(stored.find((row) => row.id === session.id)?.turns[0]?.native?.userMessageId).toBe(
        'exact-provider-input',
      )
    },
  )

  it.each([false, true])(
    'finishes history reconnection before completion (history read fails=%s)',
    async (fails) => {
      const { service, root } = await setup()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let historyComplete = false
      let reads = 0
      const owner = service as unknown as {
        observeEditHistory(
          record: Parameters<ExternalMessageEditDriver['read']>[0]['record'],
        ): Promise<ExternalEditHistory>
        externalContext(
          record: Parameters<ExternalMessageEditDriver['read']>[0]['record'],
          signal: AbortSignal,
        ): ExternalEditContext
      }
      vi.spyOn(owner, 'observeEditHistory').mockImplementation(async (record) => {
        if (++reads === 1) {
          const context = owner.externalContext(record, new AbortController().signal)
          await context.disconnect()
          await context.reconnect(record.acpSessionId)
          entered.resolve()
          await release.promise
          historyComplete = true
          if (fails) throw Error('history unavailable after reconnect')
        }
        return {
          sessionId: record.acpSessionId,
          token: 'fixture-history',
          boundaries: record.turns.map((turn) => ({ id: turn.operationId })),
        }
      })
      const session = await start(service, root)
      await service.prompt({ sessionId: session.id, text: 'first-once', operationId: 'first' })
      const completed = wait(service, session.id).then((snapshot) => ({
        snapshot,
        historyCompleteAtCompletion: historyComplete,
      }))
      try {
        await entered.promise
      } finally {
        release.resolve()
      }
      const first = await completed
      expect(first.historyCompleteAtCompletion).toBe(true)
      expect(first.snapshot.state).toBe('completed')
      await service.prompt({ sessionId: session.id, text: 'second-once', operationId: 'second' })
      expect((await wait(service, session.id)).turns.map((turn) => turn.state)).toEqual([
        'completed',
        'completed',
      ])
      const calls = await readFile(join(root, 'calls.txt'), 'utf8')
      expect(calls.match(/first-once/g)).toHaveLength(1)
      expect(calls.match(/second-once/g)).toHaveLength(1)
    },
    15_000,
  )

  it('holds an immediate follow-up until the preceding history connection is released', async () => {
    const { service, root } = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let historyComplete = false
    let reads = 0
    const owner = service as unknown as {
      observeEditHistory(
        record: Parameters<ExternalMessageEditDriver['read']>[0]['record'],
      ): Promise<ExternalEditHistory>
      externalContext(
        record: Parameters<ExternalMessageEditDriver['read']>[0]['record'],
        signal: AbortSignal,
      ): ExternalEditContext
      ensureConversation(
        record: Parameters<ExternalMessageEditDriver['read']>[0]['record'],
      ): Promise<void>
      connect(record: Parameters<ExternalMessageEditDriver['read']>[0]['record']): Promise<void>
    }
    vi.spyOn(owner, 'observeEditHistory').mockImplementation(async (record) => {
      if (++reads === 1) {
        const context = owner.externalContext(record, new AbortController().signal)
        await context.disconnect()
        await context.reconnect(record.acpSessionId)
        entered.resolve()
        await release.promise
        historyComplete = true
      }
      return {
        sessionId: record.acpSessionId,
        token: 'history',
        boundaries: record.turns.map((turn) => ({ id: turn.operationId })),
      }
    })
    const session = await start(service, root)
    await service.prompt({ sessionId: session.id, text: 'first-once', operationId: 'first' })
    await entered.promise
    const admission = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const ensure = owner.ensureConversation.bind(owner)
    vi.spyOn(owner, 'ensureConversation').mockImplementation(async (record) => {
      await ensure(record)
      admission.resolve()
      await proceed.promise
    })
    const connect = owner.connect.bind(owner)
    const readsAtConnection: boolean[] = []
    vi.spyOn(owner, 'connect').mockImplementation(async (record) => {
      readsAtConnection.push(historyComplete)
      return connect(record)
    })
    const next = service.prompt({
      sessionId: session.id,
      text: 'second-once',
      operationId: 'second',
    })
    try {
      await admission.promise
      proceed.resolve()
      // The admission barrier has no I/O before connection selection; give its
      // continuation one event-loop turn while the vendor read stays blocked.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      proceed.resolve()
      release.resolve()
    }
    await next
    expect((await wait(service, session.id)).state).toBe('completed')
    expect(readsAtConnection).toEqual([true])
    const calls = await readFile(join(root, 'calls.txt'), 'utf8')
    expect(calls.match(/second-once/g)).toHaveLength(1)
  }, 15_000)

  it('preserves cancellation when the CLI answers end_turn after a stop', async () => {
    const { service, root, options } = await setup()
    const session = await start(service, root)
    await service.prompt({
      sessionId: session.id,
      text: 'wait-end-on-cancel',
      operationId: 'cancel-race',
    })
    await vi.waitFor(
      async () => {
        expect((await service.snapshot({ sessionId: session.id })).turns[0]?.text).toBe(
          'partial answer',
        )
      },
      { timeout: 5000 },
    )
    const snapshot = await service.cancel({ sessionId: session.id })
    expect(snapshot.state).toBe('cancelled')
    expect(snapshot.turns[0]).toMatchObject({ state: 'cancelled', stopReason: 'end_turn' })
    await service.dispose()
    const stored = await new HarnessSessionStore(options.home).load()
    expect(stored.find((record) => record.id === session.id)?.turns[0]?.state).toBe('cancelled')
  })

  it('records a stop before waiting for settings persistence', async () => {
    const { service, root } = await setup()
    const session = await start(service, root)
    const response = Promise.withResolvers<unknown>()
    const prompted = Promise.withResolvers<void>()
    const request = AcpProcess.prototype.request
    vi.spyOn(AcpProcess.prototype, 'request').mockImplementation(function (method, ...args) {
      if (method !== 'session/prompt') return request.call(this, method, ...args)
      prompted.resolve()
      return response.promise
    })
    await service.prompt({ sessionId: session.id, text: 'race', operationId: 'persist-race' })
    await prompted.promise
    const storage = service as unknown as { save: (record: unknown) => Promise<void> }
    const save = storage.save.bind(service)
    const saving = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(storage, 'save').mockImplementationOnce(async (record) => {
      saving.resolve()
      await release.promise
      await save(record)
    })
    const cancelled = service.cancel({ sessionId: session.id })
    await saving.promise
    try {
      response.resolve({ stopReason: 'end_turn' })
      expect((await wait(service, session.id)).state).toBe('cancelled')
    } finally {
      release.resolve()
      await cancelled
    }
  })

  it.each(['empty-turn', 'thought-only', 'blank-answer', 'tool-only-failed', 'tool-only-pending'])(
    'refuses %s before persisting completion',
    async (prompt) => {
      const { service, root, options } = await setup()
      const session = await start(service, root)
      await service.prompt({ sessionId: session.id, text: prompt, operationId: 'result-check' })
      const snapshot = await wait(service, session.id)
      expect(snapshot.state).toBe('failed')
      expect(snapshot.turns[0]?.error).toContain('没有正文或完成的工具结果')
      await service.dispose()
      const stored = await new HarnessSessionStore(options.home).load()
      expect(stored.find((record) => record.id === session.id)?.turns[0]?.state).toBe('failed')
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe(prompt + '\n')
    },
  )
  it('accepts a completed tool without prose', async () => {
    const { service, root } = await setup()
    const session = await start(service, root)
    await service.prompt({
      sessionId: session.id,
      text: 'tool-only-completed',
      operationId: 'tool',
    })
    expect((await wait(service, session.id)).state).toBe('completed')
  })
})

describe('ACP model namespaces', () => {
  it.each(['grok-4.7', 'wrong-model'])(
    'checks the model confirmed after configuration: %s',
    async (confirmed) => {
      const { service, root } = await setup()
      const adapter = adapterFor('grok-build', {
        provider: 'opl-gateway',
        model: 'grok::grok-4.7',
      })!
      const prepare = vi.mocked(adapter.prepare!).getMockImplementation()!
      vi.mocked(adapter.prepare!).mockImplementation(async (...args) => {
        const launch = await prepare(...args)
        return { ...launch, env: { ...launch.env, OPL_FIXTURE_MODEL: 'vendor-default-model' } }
      })
      vi.spyOn(adapter, 'configureSession').mockResolvedValue({ modelId: confirmed })
      if (confirmed === 'grok-4.7')
        await expect(start(service, root)).resolves.toHaveProperty('acpSessionId')
      else await expect(start(service, root)).rejects.toThrow('不同的模型')
      await expect(access(join(root, 'calls.txt'))).rejects.toThrow()
    },
  )

  it('keeps the actual new and loaded session observations through pre-prompt verification', async () => {
    const { service, root, ctx, options } = await setup()
    const adapter = adapterFor('grok-build', { provider: 'opl-gateway', model: 'grok::grok-4.7' })!
    const observations: string[] = []
    vi.spyOn(adapter, 'configureSession').mockImplementation(async (_acp, _record, snapshot) => {
      expect(snapshot.session.sessionId).toBe('test-native')
      expect(snapshot.session.models?.currentModelId).toBe('grok-4.7')
      observations.push(snapshot.session.sessionId)
    })
    const session = await start(service, root)
    await service.prompt({ sessionId: session.id, text: 'first-observed', operationId: 'first' })
    expect((await wait(service, session.id)).state).toBe('completed')
    await service.dispose()
    const resumed = new HarnessService(ctx, options)
    cleanups.push(() => resumed.dispose())
    await resumed.prompt({ sessionId: session.id, text: 'loaded-observed', operationId: 'loaded' })
    expect((await wait(resumed, session.id)).state).toBe('completed')
    expect(observations).toHaveLength(4)
    expect(await readFile(join(root, 'connections.txt'), 'utf8')).toBe(
      'session/new\nsession/load\n',
    )
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe(
      'first-observed\nloaded-observed\n',
    )
  })

  it.each([
    ['owned/grok-4.7', true],
    ['other/grok-4.7', false],
  ])('checks the CLI model ID %s before accepting the session', async (model, accepted) => {
    const { service, root } = await setup()
    const adapter = adapterFor('grok-build', { provider: 'opl-gateway', model: 'grok::grok-4.7' })!
    Object.defineProperty(adapter, 'acpModelId', {
      configurable: true,
      value: () => 'owned/grok-4.7',
    })
    cleanups.push(async () => {
      Reflect.deleteProperty(adapter, 'acpModelId')
    })
    const prepare = vi.mocked(adapter.prepare!).getMockImplementation()!
    vi.mocked(adapter.prepare!).mockImplementation(async (...args) => {
      const launch = await prepare(...args)
      return { ...launch, env: { ...launch.env, OPL_FIXTURE_MODEL: model } }
    })
    if (accepted) await expect(start(service, root)).resolves.toHaveProperty('acpSessionId')
    else await expect(start(service, root)).rejects.toThrow('不同的模型')
    await expect(access(join(root, 'calls.txt'))).rejects.toThrow()
  })
})

async function nativeSetup(
  models = [
    { id: 'codex::gpt-test-model', name: 'Test Model' },
    { id: 'deepseek-flash', name: 'DeepSeek' },
  ],
  providers = [{ id: 'opl-gateway', name: 'OPL Gateway' }],
  initialPermission: 'read-only' | 'workspace-write' | 'danger-full-access' = 'danger-full-access',
) {
  const { root, options, service: initial } = await setup()
  await initial.executionCatalog()
  await initial.dispose()
  let current = { provider: 'opl-gateway', model: 'codex::gpt-test-model' }
  let permission = initialPermission
  const session = {
    id: 'native-session',
    header: { cwd: root },
    append: vi.fn(),
    snapshotEvents: () => [{ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } }],
  }
  const ctx = {
    connection: testPeerConnection,
    get: () => undefined,
    agents: { get: () => undefined, list: () => [] },
    waterfall: async (_event, _request, next) => next(),
    sessions: { list: () => [], get: () => session },
    permissionPresets: { current: () => permission },
    llm: {
      listProviders: () => providers,
      listConfigurableProviders: () => [],
      listModels: async () => models,
    },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: current } } }) },
    typertGateway: {
      invoke: async ({ method, args }: any) => {
        if (method === 'modelCatalog') return { default: current, groups: [] }
        if (method === 'selectModel') {
          const { provider, model } = args.request
          current = { provider, model }
        }
      },
    },
  } as unknown as Context
  const service = new HarnessService(ctx, options)
  cleanups.push(() => service.dispose())
  return {
    root,
    options,
    ctx,
    service,
    session,
    changeModel: () => {
      current = { provider: 'opl-gateway', model: 'deepseek-flash' }
    },
    setPermission: (next: 'read-only' | 'workspace-write' | 'danger-full-access') => {
      permission = next
    },
  }
}

describe('external input rejection and replay', () => {
  const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
  const user = (text: string) =>
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const native = vi.fn(async function* () {
    throw Error('external input must not fall through to the native provider')
  })

  it('uses the latest ordinary user message when an earlier RPC message has an id', async () => {
    const { service, root, session } = await nativeSetup([{ id: ref.model, name: 'Grok' }])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    const earlier = createUserMessage({
      source: { kind: 'user', rpcId: 'historical-rpc' },
      content: [{ type: 'text', text: 'earlier-rpc-input' }],
    })
    const current = user('current-ordinary-input')
    const context = createUserMessage({
      source: { kind: 'working-directory' },
      content: [{ type: 'text', text: 'injected-context' }],
    })
    const request = {
      ...ref,
      sessionId: session.id,
      messages: [earlier, current, context],
    } as GenerateOptions
    await Array.fromAsync(service.conversationStream(request, native))
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toMatch(
      /当前用户请求：\nuser: current-ordinary-input\n$/,
    )
    const record = (await service.list()).sessions[0]!
    const before = await service.snapshot({ sessionId: record.id })
    expect(before.title).toBe('current-ordinary-input')
    expect(before.turns[0]?.operationId).toBe('conversation:' + hash(current))
    for (const [value, reason] of [
      [' ', 'blank'],
      [42, 'type'],
    ] as const) {
      const latest = structuredClone(user('placeholder'))
      ;(latest.content[0] as { text: unknown }).text = value
      await expect(
        Array.fromAsync(
          service.conversationStream(
            { ...request, messages: [...request.messages, latest] },
            native,
          ),
        ),
      ).rejects.toMatchObject({
        code: 'HARNESS_INPUT',
        message: expect.stringContaining(`stage=conversation-current; reason=${reason}`),
      })
    }
    expect(await service.snapshot({ sessionId: record.id })).toEqual(before)
  })

  it('reports short current text and oversized first-binding history before launching, then admits an explicit retry once', async () => {
    const { service, root, session } = await nativeSetup([{ id: ref.model, name: 'Grok' }])
    const owner = service as unknown as { selections: Record<string, string> }
    const selections = { ...owner.selections }
    const current = user('运行')
    const oldText = 'history-only-marker-' + 'a'.repeat(HARNESS_INPUT_MAX_LENGTH)
    const previous = createAssistantMessage({
      source: ref,
      content: [{ type: 'text', text: oldText }],
    })
    const request = {
      ...ref,
      sessionId: session.id,
      messages: [previous, current],
    } as GenerateOptions
    const projected =
      HISTORY_NOTICE + '\n\nassistant: ' + oldText + '\n\n当前用户请求：\nuser: 运行'
    const prepare = vi.mocked(adapterFor('grok-build', ref)!.prepare!)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        Array.fromAsync(service.conversationStream(request, native)),
      ).rejects.toMatchObject({
        code: 'HARNESS_INPUT',
        message: expect.stringContaining(
          `stage=conversation-first-binding; reason=too-long; currentTextLength=2; promptTextLength=${projected.length}`,
        ),
      })
    }
    await expect(Array.fromAsync(service.conversationStream(request, native))).rejects.not.toThrow(
      'history-only-marker',
    )
    expect(prepare).not.toHaveBeenCalled()
    expect(owner.selections).toEqual(selections)
    expect(native).not.toHaveBeenCalled()
    await expect(access(join(root, 'connections.txt'))).rejects.toThrow()
    expect((await service.list()).sessions).toEqual([])
    const retry = { ...request, messages: [current] }
    await Array.fromAsync(service.conversationStream(retry, native))
    const record = (await service.list()).sessions[0]!
    const saved = await service.snapshot({ sessionId: record.id })
    expect(saved.turns).toHaveLength(1)
    expect(saved.turns[0]).toMatchObject({
      state: 'completed',
      operationId: 'conversation:' + hash(current),
      fingerprint: hash([record.id, 'user: 运行']),
      prompt: 'user: 运行',
    })
    await Array.fromAsync(service.conversationStream(request, native))
    expect(await service.snapshot({ sessionId: record.id })).toEqual(saved)
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('user: 运行\n')
  })

  it('rejects invalid current input on a cold bound conversation without changing its successful turn, then sends only the followup', async () => {
    const { service, root, session, ctx, options } = await nativeSetup([
      { id: ref.model, name: 'Grok' },
    ])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    const first = user('first-success')
    const request = { ...ref, sessionId: session.id, messages: [first] } as GenerateOptions
    await Array.fromAsync(service.conversationStream(request, native))
    const record = (await service.list()).sessions[0]!
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    const before = await restored.snapshot({ sessionId: record.id })
    const filename = new HarnessSessionStore(options.home).filename(record.id)
    const bytes = await readFile(filename, 'utf8')
    const prepare = vi.mocked(adapterFor('grok-build', ref)!.prepare!).mockClear()
    for (const [value, reason] of [
      [42, 'type'],
      [' \n\t', 'blank'],
      ['z'.repeat(HARNESS_INPUT_MAX_LENGTH + 1), 'too-long'],
    ] as const) {
      const malformed = structuredClone(user('placeholder'))
      ;(malformed.content[0] as { text: unknown }).text = value
      await expect(
        Array.fromAsync(
          restored.conversationStream({ ...request, messages: [first, malformed] }, native),
        ),
      ).rejects.toMatchObject({
        code: 'HARNESS_INPUT',
        message: expect.stringContaining(`stage=conversation-current; reason=${reason}`),
      })
    }
    expect(prepare).not.toHaveBeenCalled()
    expect(await restored.snapshot({ sessionId: record.id })).toEqual(before)
    expect(await readFile(filename, 'utf8')).toBe(bytes)
    expect(await readFile(join(root, 'connections.txt'), 'utf8')).toBe('session/new\n')
    const old = createAssistantMessage({
      source: ref,
      content: [{ type: 'text', text: 'h'.repeat(HARNESS_INPUT_MAX_LENGTH + 1) }],
    })
    await Array.fromAsync(
      restored.conversationStream({ ...request, messages: [first, old, user('只回复ok')] }, native),
    )
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe(
      'user: first-success\nuser: 只回复ok\n',
    )
    const continued = await restored.snapshot({ sessionId: record.id })
    expect(continued.turns[0]).toEqual(before.turns[0])
    expect(continued.turns[1]?.prompt).toBe('user: 只回复ok')
  })

  it.each([
    { name: 'blank', prompt: ' \n ', reason: 'blank' },
    { name: 'oversized', prompt: 'x'.repeat(HARNESS_INPUT_MAX_LENGTH + 1), reason: 'too-long' },
  ])(
    'refuses a $name saved prompt during replay without loading or rewriting the old session',
    async ({ prompt, reason }) => {
      const { service, root, session, ctx, options } = await nativeSetup([
        { id: ref.model, name: 'Grok' },
      ])
      await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
      const request = { ...ref, sessionId: session.id, messages: [user('运行')] } as GenerateOptions
      await Array.fromAsync(service.conversationStream(request, native))
      const record = (await service.list()).sessions[0]!
      await service.dispose()
      const filename = new HarnessSessionStore(options.home).filename(record.id)
      const raw = JSON.parse(await readFile(filename, 'utf8')) as HarnessSession
      raw.turns[0]!.prompt = prompt
      await writeFile(filename, JSON.stringify(raw) + '\n')
      const restored = new HarnessService(ctx, options)
      cleanups.push(() => restored.dispose())
      const before = await restored.snapshot({ sessionId: record.id })
      const bytes = await readFile(filename, 'utf8')
      const prepare = vi.mocked(adapterFor('grok-build', ref)!.prepare!).mockClear()
      await expect(
        Array.fromAsync(restored.conversationStream(request, native)),
      ).rejects.toMatchObject({
        code: 'HARNESS_INPUT',
        message: expect.stringContaining(
          `stage=conversation-replay; reason=${reason}; currentTextLength=2; promptTextLength=${prompt.length}`,
        ),
      })
      expect(prepare).not.toHaveBeenCalled()
      expect(await restored.snapshot({ sessionId: record.id })).toEqual(before)
      expect(await readFile(filename, 'utf8')).toBe(bytes)
      expect(await readFile(join(root, 'connections.txt'), 'utf8')).toBe('session/new\n')
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('user: 运行\n')
    },
  )

  it('keeps direct request fingerprints and operation retries after typed input refusals', async () => {
    const { service, root, ctx, options } = await setup()
    const session = await start(service, root)
    await service.prompt({ sessionId: session.id, text: 'original', operationId: 'one' })
    const first = await wait(service, session.id)
    expect(first.turns[0]?.fingerprint).toBe(hash([session.id, 'original']))
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    const before = await restored.snapshot({ sessionId: session.id })
    const prepare = vi.mocked(adapterFor('grok-build', ref)!.prepare!).mockClear()
    for (const [value, reason] of [
      [42, 'type'],
      ['', 'blank'],
      ['x'.repeat(HARNESS_INPUT_MAX_LENGTH + 1), 'too-long'],
    ] as const) {
      await expect(
        restored.prompt({ sessionId: session.id, text: value as string, operationId: 'two' }),
      ).rejects.toMatchObject({
        code: 'HARNESS_INPUT',
        message: expect.stringContaining(`stage=request; reason=${reason}`),
      })
    }
    expect(prepare).not.toHaveBeenCalled()
    expect(await restored.snapshot({ sessionId: session.id })).toEqual(before)
    const retry = { sessionId: session.id, text: 'retry-once', operationId: 'two' }
    await restored.prompt(retry)
    await wait(restored, session.id)
    await restored.prompt(retry)
    await expect(restored.prompt({ ...retry, text: 'changed' })).rejects.toThrow('operation')
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('original\nretry-once\n')
    expect((await restored.snapshot({ sessionId: session.id })).turns[0]).toEqual(first.turns[0])
    const failedRequest = { sessionId: session.id, text: 'fail-turn', operationId: 'three' }
    await restored.prompt(failedRequest)
    const failed = await wait(restored, session.id)
    expect(failed.state).toBe('failed')
    expect(await restored.prompt(failedRequest)).toEqual(failed)
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe(
      'original\nretry-once\nfail-turn\n',
    )
  })

  it('rejects malformed external message replacements before edit recovery or fork admission', async () => {
    const { service, session } = await nativeSetup([{ id: ref.model, name: 'Grok' }])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    await Array.fromAsync(
      service.conversationStream(
        { ...ref, sessionId: session.id, messages: [user('original')] } as GenerateOptions,
        native,
      ),
    )
    const record = (await service.list()).sessions[0]!
    const before = await service.snapshot({ sessionId: record.id })
    const state = vi.spyOn(service, 'messageEditState')
    for (const [value, reason] of [
      [42, 'type'],
      [' \n', 'blank'],
      ['x'.repeat(HARNESS_INPUT_MAX_LENGTH), 'too-long'],
    ] as const) {
      await expect(
        service.messageEditSend({
          prompt: {
            sessionId: session.id,
            requestId: 'same-edit-retry',
            mode: 'queue',
            content: [{ type: 'text', text: value as string }],
          },
          targetSeq: 0,
          head: 1,
        }),
      ).rejects.toMatchObject({
        code: 'HARNESS_INPUT',
        message: expect.stringContaining(`stage=edit-request; reason=${reason}`),
      })
    }
    expect(state).not.toHaveBeenCalled()
    expect(await service.snapshot({ sessionId: record.id })).toEqual(before)
  })
})

it('reads saved edit choices while the original model is absent without launching a CLI', async () => {
  const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
  const f = await nativeSetup([])
  const real = Session.create(SessionId('saved-edit-session'))
  real.append(
    'user/message',
    createUserMessage({
      source: { kind: 'user', rpcId: 'original' },
      content: [{ type: 'text', text: 'saved input' }],
    }),
    { surfaceOp: 'append' },
  )
  const record = {
    id: 'saved-pi-record',
    nativeSessionId: real.id,
    acpSessionId: 'vendor-exact',
    harnessRef: 'pi',
    turns: [{ operationId: 'original', native: { userMessageId: 'vendor-input', officialSeq: 0 } }],
  } as HarnessSession
  const owner = f.service as unknown as {
    stopEditTarget(): { record: HarnessSession; harness: string }
    connectAdmitted(): Promise<void>
  }
  Object.assign(f.ctx, { sessions: { get: () => real }, agents: { get: () => undefined } })
  vi.spyOn(owner, 'stopEditTarget').mockReturnValue({ record, harness: 'pi' })
  const connect = vi.spyOn(owner, 'connectAdmitted').mockRejectedValue(Error('catalog removed'))
  expect(await f.service.messageEditState({ sessionId: real.id })).toMatchObject({
    supported: true,
    busy: false,
    pending: false,
    choices: [{ seq: 0, text: 'saved input' }],
  })
  expect(connect).not.toHaveBeenCalled()
})
describe('native conversation combinations', () => {
  it('leaves new internal DSH delegation to official tools before creating an OPL task', async () => {
    const { service, root } = await nativeSetup()
    const combination = (await service.executionCatalog()).combinations.find(
      (item) => item.harnessRef === 'dsh',
    )!
    expect(combination).toBeDefined()
    const start = vi.spyOn(service, 'start')
    const origin = { kind: 'dsh', sessionId: 'native-session' } as const
    await expect(
      service.delegateFrom(origin, {
        combination: combination.id,
        task: '检查项目',
        taskId: 'official-native-task',
        operationId: 'initial',
        acceptance: '核对实际结果',
      }),
    ).rejects.toThrow('官方智能体团队')
    expect(start).not.toHaveBeenCalled()
    expect(await service.tasksFor(origin)).toEqual([])
    start.mockRejectedValueOnce(Error('external-parent-reached-start'))
    await expect(
      service.delegateFrom(
        { kind: 'codex', sessionId: 'parent' },
        {
          combination: combination.id,
          cwd: root,
          task: '从外部 Harness 委派给 DSH',
          taskId: 'cross-harness-task',
          operationId: 'initial',
        },
      ),
    ).rejects.toThrow('external-parent-reached-start')
  })
  it('reads a cold Session from official projections instead of the profile default without activating an Agent', async () => {
    const { service, ctx, session } = await nativeSetup()
    vi.spyOn(ctx.sessions, 'get').mockReturnValue(undefined)
    const original = ctx.typertGateway.invoke.bind(ctx.typertGateway)
    const invoke = vi.spyOn(ctx.typertGateway, 'invoke').mockImplementation(async (request) => {
      if (request.namespace === 'session' && request.method === 'projections')
        return {
          kind: 'sequenced',
          asOfSeq: 7,
          values: {
            modelSelection: {
              next: { provider: 'opl-gateway', model: 'deepseek-flash' },
              lastUsed: null,
            },
          },
        }
      return original(request)
    })
    expect(await service.modelSelection(session.id)).toMatchObject({
      current: { provider: 'opl-gateway', model: 'deepseek-flash' },
      combination: 'dsh/deepseek-flash',
    })
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'session',
        method: 'projections',
        args: { request: { sessionId: session.id } },
      }),
    )
    expect(
      invoke.mock.calls.some(([request]) => ['create', 'prompt'].includes(request.method)),
    ).toBe(false)
  })

  it.each([
    ['codex', 'codex::gpt-test-model', 'gpt-test-model'],
    ['claude', 'aws::claude-opus-5-5', 'claude-opus-5-5'],
  ])('carries provider effort into ordinary %s turns', async (harness, model, wire) => {
    const ref = { provider: 'opl-gateway', model }
    const { service, root, session } = await nativeSetup([{ id: model, name: model }])
    const adapter = adapterFor(harness!, ref)!
    vi.spyOn(adapter, 'available').mockResolvedValue({ available: true })
    vi.spyOn(adapter, 'prepare').mockResolvedValue({
      home: root,
      command: process.execPath,
      args: [resolve('tests/fixtures/acp-agent.mjs')],
      env: { ...systemEnvironment(), OPL_FIXTURE_MODEL: wire },
    })
    for (const effort of ['high', 'max']) {
      await Array.fromAsync(
        service.conversationStream(
          {
            ...ref,
            sessionId: session.id,
            reasoningEffort: effort,
            messages: [
              createUserMessage({
                source: { kind: 'user' },
                content: [{ type: 'text', text: 'effort-' + effort }],
              }),
            ],
          } as GenerateOptions,
          async function* () {
            throw Error('wrong native route')
          },
        ),
      )
    }
    const store = new HarnessSessionStore(service.directory)
    cleanups.push(() => store.dispose())
    const record = (await store.load()).find((row) => row.nativeSessionId === session.id)
    expect(record?.turns.map((turn) => turn.reasoningEffort)).toEqual(['high', 'max'])
  })
  it('omits provider reasoning controls when the selected CLI has no effort interface', async () => {
    const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
    const { service, ctx, session } = await nativeSetup([{ id: ref.model, name: 'Grok' }])
    const adapter = adapterFor('grok-build', ref)!
    const original = adapter.capabilities.reasoning
    adapter.capabilities.reasoning = 'none'
    cleanups.push(async () => {
      adapter.capabilities.reasoning = original
    })
    const groups = [
      {
        id: ref.provider,
        name: 'Gateway',
        models: [
          {
            id: ref.model,
            name: 'Grok',
            reasoning: {
              efforts: [{ id: 'balanced', name: 'Balanced' }],
              defaultEffort: 'balanced',
            },
          },
        ],
      },
    ]
    Object.assign(ctx, {
      sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: ref } } }) },
      typertGateway: { invoke: async () => ({ default: ref, groups }) },
    })
    const selected = await service.modelSelection(session.id)
    expect(selected.groups[0]!.models[0]).not.toHaveProperty('reasoning')
    expect(groups[0]!.models[0]!.reasoning.defaultEffort).toBe('balanced')
  })

  it.each(['aws', 'kiro'])(
    'routes the first ordinary %s request through Claude without a picker binding',
    async (channel) => {
      const ref = { provider: 'opl-gateway', model: channel + '::claude-opus-5-5' }
      const { service, ctx, root, session } = await nativeSetup([{ id: ref.model, name: 'Claude' }])
      const settings = {
        describe: () => [{ ns: 'opl-suite', value: { gatewayGroups: { kiro: true } } }],
      }
      Object.assign(ctx, {
        settings,
        get: (name: string) => (name === 'settings' ? settings : undefined),
      })
      const adapter = adapterFor('claude', ref)!
      vi.spyOn(adapter, 'prepare').mockImplementation(async () => ({
        home: root,
        command: process.execPath,
        args: [resolve('tests/fixtures/acp-agent.mjs')],
        env: { ...systemEnvironment(), OPL_FIXTURE_MODEL: 'claude-opus-5-5' },
      }))
      const next = vi.fn(async function* () {
        throw Error('unexpected direct Gateway request')
      })
      const options = {
        ...ref,
        sessionId: session.id,
        messages: [
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'first-' + channel }],
          }),
        ],
      } as GenerateOptions
      const chunks = await Array.fromAsync(service.conversationStream(options, next))
      expect(next).not.toHaveBeenCalled()
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain('first-' + channel)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const record = (await service.list()).sessions.find(
        (item) => item.origin.kind === 'dsh' && item.origin.sessionId === session.id,
      )!
      expect(record).toMatchObject({ harnessRef: 'claude', modelRef: ref })
    },
  )

  it('routes a default external model on first send without selecting its combination', async () => {
    const { service, root, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    const next = vi.fn(async function* () {
      throw Error('direct provider must not receive this model')
    })
    const options = {
      sessionId: session.id,
      provider: 'opl-gateway',
      model: 'grok::grok-4.7',
      messages: [
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'first-send' }],
        }),
      ],
    } as GenerateOptions
    const chunks = await Array.fromAsync(service.conversationStream(options, next))
    expect(next).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain('first-send')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('projects explicitly per-prompt ACP usage and context capacity', async () => {
    const { service, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    const chunks = await Array.fromAsync(
      service.conversationStream(
        {
          sessionId: session.id,
          provider: 'opl-gateway',
          model: 'grok::grok-4.7',
          messages: [
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'usage-stats' }],
            }),
          ],
        } as GenerateOptions,
        async function* () {
          throw Error('external route must own this request')
        },
      ),
    )
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { totalTokens: 42, inputTokens: 40, outputTokens: 2 },
    })
    expect(session.append).toHaveBeenCalledWith('request/context', {
      provider: 'opl-gateway',
      model: 'grok::grok-4.7',
      contextWindow: 100,
    })
    const record = (await service.list()).sessions.find(
      (item) => item.nativeSessionId === session.id,
    )!
    expect(record.turns.at(-1)).toMatchObject({
      usage: { totalTokens: 42, inputTokens: 40, outputTokens: 2 },
      contextUsage: { used: 42, size: 100 },
    })
  })

  it('projects an owned bridge aggregate with disjoint cache buckets', async () => {
    const { service, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    const chunks = await Array.fromAsync(
      service.conversationStream(
        {
          sessionId: session.id,
          provider: 'opl-gateway',
          model: 'grok::grok-4.7',
          messages: [
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'owned-usage' }],
            }),
          ],
        } as GenerateOptions,
        async function* () {
          throw Error('external route must own this request')
        },
      ),
    )
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 30,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        outputTokens: 4,
        reasoningTokens: 2,
        totalTokens: 49,
      },
    })
    const record = (await service.list()).sessions.find(
      (item) => item.nativeSessionId === session.id,
    )!
    expect(record.turns.at(-1)).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 4, cacheReadTokens: 10, cacheWriteTokens: 5 },
      contextUsage: { used: 49, size: 100, estimated: true },
    })
  })

  it('withholds ambiguous cumulative ACP usage while retaining context occupancy', async () => {
    const { service, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    const request = (text: string) =>
      Array.fromAsync(
        service.conversationStream(
          {
            sessionId: session.id,
            provider: 'opl-gateway',
            model: 'grok::grok-4.7',
            messages: [
              createUserMessage({
                source: { kind: 'user' },
                content: [{ type: 'text', text }],
              }),
            ],
          } as GenerateOptions,
          async function* () {
            throw Error('external route must own this request')
          },
        ),
      )
    const first = await request('usage-cumulative')
    const second = await request('second usage-cumulative')
    expect([...first, ...second].some((chunk) => chunk.type === 'usage')).toBe(false)
    const record = (await service.list()).sessions.find(
      (item) => item.nativeSessionId === session.id,
    )!
    expect(record.turns.at(-1)).toMatchObject({ contextUsage: { used: 84, size: 100 } })
    expect(record.turns.at(-1)).not.toHaveProperty('usage')
    expect(session.append.mock.calls.filter(([type]) => type === 'request/context')).toHaveLength(1)
  })

  it.each([
    'unique',
    'external-default',
    'native-default',
    'ambiguous',
    'disabled',
    'foreign-source',
  ] as const)('uses the same route for display and first send: %s', async (mode) => {
    const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
    const { service, ctx, session, root } = await nativeSetup([{ id: ref.model, name: 'Grok' }])
    ctx.sessionProjections.snapshot = (() => ({
      values: { modelSelection: { next: ref, lastUsed: null } },
    })) as typeof ctx.sessionProjections.snapshot
    const catalog = await service.executionCatalog()
    const original = catalog.combinations.find((x) => x.id === GROK_COMBINATION)!
    const external = {
      ...original,
      id: 'external',
      isDefault: mode === 'external-default',
      enabled: mode !== 'disabled',
    }
    const native = {
      ...original,
      id: 'native',
      harnessRef: 'dsh',
      isDefault: mode === 'native-default',
    }
    const combinations =
      mode === 'unique' || mode === 'disabled'
        ? [external]
        : mode === 'foreign-source'
          ? [{ ...external, modelRef: { ...ref, provider: 'different-source' } }]
          : [native, external]
    vi.spyOn(service, 'executionCatalog').mockResolvedValue({ ...catalog, combinations })
    const selected = await service.modelSelection(session.id)
    const next = vi.fn(async function* () {})
    const request = {
      ...ref,
      sessionId: session.id,
      messages: [
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'unique-first-send' }],
        }),
      ],
    } as GenerateOptions
    if (mode === 'ambiguous' || mode === 'disabled') {
      expect(selected.combination).toBeUndefined()
      await expect(
        Array.fromAsync(service.conversationStream(request, next)),
      ).rejects.toMatchObject({ code: 'HARNESS_BINDING' })
      expect(next).not.toHaveBeenCalled()
      expect((await service.list()).sessions).toHaveLength(0)
    } else {
      const externalRoute = mode === 'unique' || mode === 'external-default'
      expect(selected.combination).toBe(
        externalRoute ? 'external' : mode === 'native-default' ? 'native' : undefined,
      )
      await Array.fromAsync(service.conversationStream(request, next))
      expect(next).toHaveBeenCalledTimes(externalRoute ? 0 : 1)
      if (externalRoute) {
        const records = (await service.list()).sessions
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({ combination: 'external', harnessRef: 'grok-build' })
        expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain('unique-first-send')
        vi.mocked(service.executionCatalog).mockResolvedValue({
          ...catalog,
          combinations: [{ ...native, isDefault: true }, external],
        })
        expect((await service.modelSelection(session.id)).combination).toBe('external')
      }
    }
  })

  it('resumes a uniquely replaced route across restart without replaying history or widening permission', async () => {
    const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
    const { service, session, root, ctx, options, setPermission } = await nativeSetup([
      { id: ref.model, name: 'Grok' },
    ])
    vi.spyOn(adapterFor('grok-build', ref)!, 'available').mockResolvedValue({ available: true })
    const request = (text: string) =>
      ({
        ...ref,
        sessionId: session.id,
        messages: [
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
        ],
      }) as GenerateOptions
    const native = vi.fn(async function* () {})
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    await service.invoke('select-effort', { ...ref, sessionId: session.id, reasoningEffort: 'low' })
    await Array.fromAsync(service.conversationStream(request('original-once'), native))
    const before = (await service.list()).sessions[0]!
    const catalog = await service.executionCatalog()
    const original = catalog.combinations.find((item) => item.id === GROK_COMBINATION)!
    const changed = {
      ...catalog,
      combinations: [
        ...catalog.combinations.filter((item) => item.id !== GROK_COMBINATION),
        { ...original, id: 'replacement', isDefault: false },
      ],
    }
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    const resolveCatalog = vi.spyOn(restored, 'executionCatalog')
    for (const invalid of [
      { ...original, modelRef: { ...ref, provider: 'other-source' } },
      { ...original, modelRef: { ...ref, model: 'other-model' } },
      { ...original, harnessRef: 'codex' },
      { ...original, enabled: false },
    ]) {
      resolveCatalog.mockResolvedValue({
        ...catalog,
        combinations: [{ ...invalid, id: 'replacement' }],
      })
      await expect(
        Array.fromAsync(restored.conversationStream(request('must-not-send'), native)),
      ).rejects.toMatchObject({ code: 'HARNESS_BINDING' })
    }
    resolveCatalog.mockResolvedValue(changed)
    expect(await restored.modelSelection(session.id)).toMatchObject({
      combination: 'replacement',
      current: { reasoningEffort: 'low' },
    })
    setPermission('read-only')
    await expect(
      Array.fromAsync(restored.conversationStream(request('must-not-send'), native)),
    ).rejects.toMatchObject({ code: 'HARNESS_PERMISSION' })
    setPermission('danger-full-access')
    await Array.fromAsync(restored.conversationStream(request('follow-up-once'), native))
    const after = (await restored.list()).sessions
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: before.id,
      acpSessionId: before.acpSessionId,
      combination: before.combination,
      sandbox: before.sandbox,
    })
    expect(after[0]!.turns).toHaveLength(2)
    expect(after[0]!.turns[1]!.reasoningEffort).toBe('low')
    await restored.invoke('select-effort', { ...ref, sessionId: session.id })
    expect((await restored.modelSelection(session.id)).current.reasoningEffort).toBeUndefined()
    const calls = await readFile(join(root, 'calls.txt'), 'utf8')
    expect(calls.match(/original-once/g)).toHaveLength(1)
    expect(calls.match(/follow-up-once/g)).toHaveLength(1)
    expect(calls).not.toContain('must-not-send')
    expect(await readFile(join(root, 'connections.txt'), 'utf8')).toContain('session/load')
    expect(native).not.toHaveBeenCalled()
  }, 15_000)

  it.each(['removed', 'disabled'] as const)(
    'refuses an ambiguous or %s historical binding instead of changing Harness',
    async (state) => {
      const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
      const { service, session, changeModel } = await nativeSetup([{ id: ref.model, name: 'Grok' }])
      vi.spyOn(adapterFor('grok-build', ref)!, 'available').mockResolvedValue({ available: true })
      await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
      const request = {
        ...ref,
        sessionId: session.id,
        messages: [
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'binding-original' }],
          }),
        ],
      } as GenerateOptions
      await Array.fromAsync(
        service.conversationStream(request, async function* () {
          throw Error('unexpected native request')
        }),
      )
      const catalog = await service.executionCatalog()
      const original = catalog.combinations.find((item) => item.id === GROK_COMBINATION)!
      const changed = {
        ...catalog,
        combinations: [
          ...catalog.combinations.filter((item) => item.id !== GROK_COMBINATION),
          ...(state === 'disabled'
            ? [{ ...original, enabled: false }]
            : [{ ...original, id: 'second-replacement', isDefault: false }]),
          { ...original, id: 'replacement', isDefault: true },
        ],
      }
      vi.spyOn(service, 'executionCatalog').mockResolvedValue(changed)
      const native = vi.fn(async function* () {})
      await expect(
        Array.fromAsync(service.conversationStream(request, native)),
      ).rejects.toMatchObject({
        code: 'HARNESS_BINDING',
      })
      expect(native).not.toHaveBeenCalled()
      expect((await service.list()).sessions).toHaveLength(1)
      await service.selectCombination({ sessionId: session.id, combination: 'replacement' })
      expect((await service.modelSelection(session.id)).combination).toBe('replacement')
      const chunks = await Array.fromAsync(service.conversationStream(request, native))
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(native).not.toHaveBeenCalled()
      changeModel()
      await Array.fromAsync(
        service.conversationStream(
          { ...request, provider: 'opl-gateway', model: 'deepseek-flash' },
          native,
        ),
      )
      expect(native).toHaveBeenCalledOnce()
    },
  )

  it('uses the permission selected before the first external prompt', async () => {
    const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
    const { service, root, session, setPermission } = await nativeSetup(
      [{ id: ref.model, name: 'Grok' }],
      [{ id: ref.provider, name: 'OPL Gateway' }],
      'workspace-write',
    )
    const adapter = adapterFor('grok-build', ref)!
    vi.spyOn(adapter, 'available').mockResolvedValue({ available: true })
    const catalog = await service.executionCatalog()
    const combination = catalog.combinations.find(
      (item) => item.harnessRef === 'grok-build' && item.modelRef.model === ref.model,
    )!
    await service.selectCombination({ sessionId: session.id, combination: combination.id })
    setPermission('danger-full-access')
    const chunks = await Array.fromAsync(
      service.conversationStream(
        {
          ...ref,
          sessionId: session.id,
          messages: [
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'permission-before-first-send' }],
            }),
          ],
        } as GenerateOptions,
        async function* () {
          throw Error('direct provider must not receive this model')
        },
      ),
    )
    const record = (await service.list()).sessions.find(
      (item) => item.origin.kind === 'dsh' && item.origin.sessionId === session.id,
    )!
    expect(record.sandbox).toBe('full-access')
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain(
      'permission-before-first-send',
    )
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  }, 10_000)

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
    'a saved read-only combination cannot override the conversation preset %s',
    async (preset) => {
      const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
      const { service, root, session } = await nativeSetup(
        [{ id: ref.model, name: 'Grok' }],
        [{ id: ref.provider, name: 'OPL Gateway' }],
        preset,
      )
      const adapter = adapterFor('grok-build', ref)!
      vi.spyOn(adapter, 'available').mockResolvedValue({ available: true })
      const catalog = await service.executionCatalog()
      await service.saveExecutionCatalog({
        ...catalog,
        combinations: [
          ...catalog.combinations,
          {
            id: 'saved-workspace-combination',
            name: 'Saved Grok',
            modelRef: ref,
            harnessRef: 'grok-build',
            permissionPolicy: 'read-only',
            enabled: true,
            isDefault: false,
          },
        ],
      })
      await service.selectCombination({
        sessionId: session.id,
        combination: 'saved-workspace-combination',
      })
      const chunks = await Array.fromAsync(
        service.conversationStream(
          {
            ...ref,
            sessionId: session.id,
            messages: [
              createUserMessage({
                source: { kind: 'user' },
                content: [{ type: 'text', text: 'saved-permission' }],
              }),
            ],
          } as GenerateOptions,
          async function* () {
            throw Error('direct provider must not receive this model')
          },
        ),
      )
      const record = (await service.list()).sessions.find(
        (item) => item.nativeSessionId === session.id,
      )!
      expect(record.sandbox).toBe(
        preset === 'danger-full-access'
          ? 'full-access'
          : preset === 'workspace-write'
            ? 'workspace'
            : 'read-only',
      )
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain('saved-permission')
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    },
  )

  it('hands off tool history through the official conversation stream and sends only new input on continuation', async () => {
    const { service, root, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    const callId = 'read-1' as ToolCallId
    const messages = [
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'read README' }],
      }),
      createAssistantMessage({
        source: { provider: 'opl-gateway', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: 'private-reasoning' },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"README.md"}' },
        ],
      }),
      createToolResultMessage({
        callId,
        isError: false,
        content: [{ type: 'text', text: 'cedar-271' }],
      }),
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'continue-here' }],
      }),
    ]
    const options = {
      sessionId: session.id,
      provider: 'opl-gateway',
      model: 'grok::grok-4.7',
      messages,
    } as GenerateOptions
    const next = vi.fn(async function* () {})
    const chunks = await Array.fromAsync(service.conversationStream(options, next))
    const prompt = await readFile(join(root, 'calls.txt'), 'utf8')
    expect(next).not.toHaveBeenCalled()
    expect(prompt).toContain('历史工具调用 read (read-1): {"path":"README.md"}')
    expect(prompt).toContain('tool (read-1): cedar-271')
    expect(prompt).toContain('不要重新执行历史任务或工具调用')
    expect(prompt).toContain('当前用户请求：\nuser: continue-here')
    expect(prompt).not.toContain('private-reasoning')
    expect((await service.list()).sessions.find((item) => item.origin.kind === 'dsh')?.title).toBe(
      'continue-here',
    )
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const followup = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'next-turn' }],
    })
    await Array.fromAsync(
      service.conversationStream({ ...options, messages: [...messages, followup] }, next),
    )
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe(prompt + 'user: next-turn\n')
  }, 10_000)
  it('keeps injected runtime context separate from historical user requests', async () => {
    const { service, root, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    const user = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'perform-current-task' }],
    })
    await Array.fromAsync(
      service.conversationStream(
        {
          sessionId: session.id,
          provider: 'opl-gateway',
          model: 'grok::grok-4.7',
          messages: [
            createUserMessage({
              source: { kind: 'runtime-context' } as never,
              content: [{ type: 'text', text: 'current-runtime-policy' }],
            }),
            user,
            createUserMessage({
              source: { kind: 'time-context' } as never,
              content: [{ type: 'text', text: 'current-clock' }],
            }),
          ],
        } as GenerateOptions,
        async function* () {},
      ),
    )
    const prompt = await readFile(join(root, 'calls.txt'), 'utf8')
    expect(prompt).toContain('current-runtime-policy')
    expect(prompt).toContain('current-clock')
    expect(prompt).not.toContain('先前会话记录')
    expect(prompt).toMatch(/当前用户请求：\nuser: perform-current-task\n$/)
  })
  it('rejects real attachments without dispatching a prompt', async () => {
    const { service, root, session } = await nativeSetup([{ id: 'grok::grok-4.7', name: 'Grok' }])
    await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
    const messages = [
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: {} as never }],
      }),
    ]
    await expect(
      Array.fromAsync(
        service.conversationStream(
          {
            sessionId: session.id,
            provider: 'opl-gateway',
            model: 'grok::grok-4.7',
            messages,
          } as GenerateOptions,
          async function* () {},
        ),
      ),
    ).rejects.toMatchObject({ code: 'HARNESS_INPUT' })
    await expect(access(join(root, 'calls.txt'))).rejects.toThrow()
  })
  it.each([
    {
      name: 'advertised image capability',
      image: true,
      grokVersion: undefined,
      sourceEnabled: true,
      accepted: true,
    },
    {
      name: 'Grok Build 1.0.46 false image advertisement',
      image: false,
      grokVersion: '1.0.46',
      sourceEnabled: true,
      accepted: true,
    },
    {
      name: 'unknown Grok Build version',
      image: false,
      grokVersion: '1.0.47',
      sourceEnabled: true,
      accepted: false,
    },
    {
      name: 'false image advertisement without Grok metadata',
      image: false,
      grokVersion: undefined,
      sourceEnabled: true,
      accepted: false,
    },
    {
      name: 'model source without image support',
      image: false,
      grokVersion: '1.0.46',
      sourceEnabled: false,
      accepted: false,
    },
  ])(
    'admits ordered images through the shared conversation runtime: $name',
    async ({ image, grokVersion, sourceEnabled, accepted }) => {
      const { service, root, session, ctx, options } = await nativeSetup([
        { id: 'grok::grok-4.7', name: 'Grok' },
      ])
      const adapter = adapterFor('grok-build', {
        provider: 'opl-gateway',
        model: 'grok::grok-4.7',
      })!
      vi.mocked(adapter.prepare!).mockImplementation(async () => {
        // This case exercises shared transport without an official CLI or API.
        const home = join(root, 'fixture-images')
        return {
          home,
          command: process.execPath,
          args: [resolve('tests/fixtures/acp-agent.mjs')],
          env: {
            ...systemEnvironment(),
            OPL_FIXTURE_IMAGES: '1',
            OPL_FIXTURE_IMAGE_CAPABILITY: String(image),
            ...(grokVersion ? { OPL_FIXTURE_GROK_VERSION: grokVersion } : {}),
          },
          promptImageSupport: sourceEnabled,
        }
      })
      const attachment = {
        attachmentId: '1'.repeat(64),
        mediaType: 'image/png' as const,
        bytes: 3,
        width: 1,
        height: 1,
        name: 'original.png',
      }
      const readImage = vi.fn(async (ref) => ({ ref, data: Buffer.from('png') }))
      Object.assign(ctx, {
        get: (name: string) => (name === 'attachments' ? { readImage } : undefined),
      })
      await service.selectCombination({ sessionId: session.id, combination: GROK_COMBINATION })
      const user = createUserMessage({
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'before' },
          { type: 'image', attachment: attachment as never },
          { type: 'text', text: 'after' },
        ],
      })
      const response = Array.fromAsync(
        service.conversationStream(
          {
            sessionId: session.id,
            provider: 'opl-gateway',
            model: 'grok::grok-4.7',
            messages: [user],
          } as GenerateOptions,
          async function* () {},
        ),
      )
      if (!accepted) {
        await expect(response).rejects.toMatchObject({ code: 'HARNESS_INPUT' })
        expect(readImage).not.toHaveBeenCalled()
        await expect(access(join(root, 'calls.txt'))).rejects.toThrow()
        await expect(access(join(root, 'image-calls.jsonl'))).rejects.toThrow()
        return
      }
      const chunks = await response
      expect(chunks.at(-1)?.type).toBe('finish')
      expect(readImage).toHaveBeenCalledExactlyOnceWith(attachment, undefined)
      const calls = (await readFile(join(root, 'image-calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(calls).toEqual([
        [
          { type: 'text', text: 'user: before\n' },
          { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: '\nafter' },
        ],
      ])
      const records = await new HarnessSessionStore(options.home).load()
      const turn = records.find((record) => record.nativeSessionId === session.id)!.turns[0]!
      expect(turn.promptContent?.[1]).toEqual({ type: 'image', attachment })
      expect(JSON.stringify(turn)).not.toContain('"data"')
    },
  )
  it('defaults Claude delegation to Kiro while preserving an explicit AWS combination', async () => {
    const { service, root } = await nativeSetup([
      { id: 'aws::claude-opus-5-5', name: 'Claude' },
      { id: 'kiro::claude-opus-5-5', name: 'Claude' },
    ])
    const catalog = await service.executionCatalog()
    const kiro = catalog.combinations.find(
      (item) => item.modelRef.model === 'kiro::claude-opus-5-5',
    )!
    const aws = catalog.combinations.find((item) => item.modelRef.model === 'aws::claude-opus-5-5')!
    const statuses = vi
      .spyOn(service, 'combinations')
      .mockResolvedValue([{ id: kiro.id, available: true }] as never)
    const start = vi.spyOn(service, 'start').mockRejectedValue(Error('selected'))
    const input = {
      model: 'claude-opus-5-5',
      cwd: root,
      task: 'test',
      taskId: 'test',
      operationId: 'initial',
    }
    const origin = { kind: 'codex', sessionId: 'parent' } as const
    try {
      await expect(service.delegateFrom(origin, input)).rejects.toThrow('selected')
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ combination: kiro.id }))
      await expect(service.delegateFrom(origin, { ...input, combination: aws.id })).rejects.toThrow(
        'selected',
      )
      expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ combination: aws.id }))
    } finally {
      statuses.mockRestore()
      start.mockRestore()
    }
  })
  it('honours an explicitly stated permission for a generated combination in every origin', async () => {
    const { service, root } = await nativeSetup()
    const automatic = (await service.executionCatalog()).combinations.find(
      (item) => item.generated && item.modelRef.model === 'codex::gpt-test-model',
    )!
    // `generated` is the default the catalog generator picked, so an origin is irrelevant: both the
    // DSH conversation path and the CLI dispatch path keep the permission the caller stated.
    for (const origin of [
      { kind: 'dsh', sessionId: 'native-session' },
      { kind: 'codex', sessionId: 'parent' },
    ] as const) {
      const session = await service.start(
        {
          combination: automatic.id,
          cwd: root,
          taskId: `generated-${origin.kind}`,
          origin,
          sandbox: 'workspace',
        },
        true,
      )
      expect(session.sandbox).toBe('workspace')
    }
  })
  it('retries a failed final session write on graceful shutdown', async () => {
    const { service, root, options } = await setup()
    const session = await start(service, root)
    const original = HarnessSessionStore.prototype.saveChanged
    let failed = false
    const spy = vi
      .spyOn(HarnessSessionStore.prototype, 'saveChanged')
      .mockImplementation(function (records) {
        const values = [...records]
        if (!failed && values.some((record) => record.turns.at(-1)?.state === 'completed')) {
          failed = true
          return Promise.reject(Error('temporary disk failure'))
        }
        return original.call(this, values)
      })
    try {
      await service.prompt({ sessionId: session.id, text: 'persist', operationId: 'one' })
      await vi.waitFor(async () => {
        expect((await service.snapshot({ sessionId: session.id })).turns.at(-1)?.error).toContain(
          '结果未能持久保存',
        )
      })
      await service.dispose()
      const records = await new HarnessSessionStore(options.home).load()
      expect(records.find((record) => record.id === session.id)?.turns.at(-1)).toMatchObject({
        state: 'failed',
        error: '结果未能持久保存，请检查磁盘后重试读取',
      })
    } finally {
      spy.mockRestore()
    }
  })
  it('filters retired provider models and combinations from the live catalog', async () => {
    const { service } = await nativeSetup([
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'codex::gpt-5', name: 'GPT-5' },
      { id: 'codex::gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'deepseek-flash', name: 'DeepSeek' },
    ])
    const catalog = await service.executionCatalog()
    expect(catalog.models.map((item) => item.ref.model)).not.toEqual(
      expect.arrayContaining(['deepseek-v4-pro', 'codex::gpt-5', 'codex::gpt-5-mini']),
    )
    expect(catalog.combinations.map((item) => item.modelRef.model)).not.toEqual(
      expect.arrayContaining(['deepseek-v4-pro', 'codex::gpt-5', 'codex::gpt-5-mini']),
    )
  })
  it('hides OFM decision and moderation models from the conversation picker', async () => {
    const { service } = await nativeSetup(
      [
        { id: 'jev-1.13-free', name: 'Jev 1.13' },
        { id: 'nvidia/nemotron-3.5-content-safety:free', name: 'Nemotron Content Safety' },
        { id: 'kilo-auto/free', name: 'Kilo Auto' },
      ],
      [{ id: 'our-free-model', name: 'Our Free Model' }],
    )
    const catalog = await service.executionCatalog()
    expect(catalog.models.map((item) => item.ref.model)).not.toEqual(
      expect.arrayContaining(['jev-1.13-free', 'nvidia/nemotron-3.5-content-safety:free']),
    )
    expect(catalog.combinations.map((item) => item.modelRef.model)).not.toEqual(
      expect.arrayContaining(['jev-1.13-free', 'nvidia/nemotron-3.5-content-safety:free']),
    )
    expect(catalog.models.map((item) => item.ref.model)).toContain('kilo-auto/free')
  })
  it('does not expose the built-in DeepSeek catalog without its own credential', async () => {
    const { service } = await nativeSetup(
      [
        { id: 'deepseek-flash', name: 'DeepSeek' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
      [{ id: 'deepseek-official', name: 'DeepSeek 官方' }],
    )
    const catalog = await service.executionCatalog()
    expect(
      catalog.models.filter((item) => item.ref.provider === 'deepseek-official'),
    ).toMatchObject([{ available: false, reason: '凭据未配置' }])
    expect(
      catalog.combinations.filter((item) => item.modelRef.provider === 'deepseek-official'),
    ).toEqual([])
  })
  it.each(['signed-out', 'credential-stored'])(
    'only discovers account models after login: %s',
    async (status) => {
      const { service, ctx } = await nativeSetup(
        [{ id: 'deepseek-flash', name: 'DeepSeek' }],
        [{ id: 'deepseek-account', name: 'DeepSeek account' }],
      )
      vi.spyOn(ctx.typertGateway, 'invoke').mockResolvedValue({ status } as never)
      const discover = vi.spyOn(ctx.llm, 'listModels')
      const catalog = await service.executionCatalog()
      const accountModels = catalog.models.filter(
        (item) => item.ref.provider === 'deepseek-account',
      )
      if (status === 'signed-out') {
        expect(discover).not.toHaveBeenCalled()
        expect(accountModels).toEqual([])
      } else {
        expect(discover).toHaveBeenCalledWith('deepseek-account')
        expect(accountModels).toMatchObject([{ available: true }])
      }
    },
  )
  it('keeps a DeepSeek OpenAI-protocol channel manual instead of treating it as Codex', async () => {
    // This assertion lists every available model, so the machine's own official CLIs
    // must not leak into it: an installed MiniMax Code would legitimately add its own
    // account models and make the expected list environment-dependent.
    vi.stubEnv('USERPROFILE', join(tmpdir(), 'opl-absent-cli'))
    vi.stubEnv('HOME', join(tmpdir(), 'opl-absent-cli'))
    vi.stubEnv('MINIMAX_DATA_DIR', join(tmpdir(), 'opl-absent-cli'))
    vi.stubEnv('PATH', '')
    const { service } = await nativeSetup([
      { id: 'deepseek-flash', name: 'DeepSeek' },
      { id: 'codex::deepseek-flash', name: 'DeepSeek' },
    ])
    const catalog = await service.executionCatalog()
    expect(
      catalog.combinations.filter(
        (item) => item.harnessRef === 'dsh' && item.modelRef.model.includes('deepseek-flash'),
      ),
    ).toHaveLength(1)
    expect(
      catalog.combinations.some(
        (item) => item.modelRef.model === 'codex::deepseek-flash' && item.harnessRef === 'codex',
      ),
    ).toBe(false)
    expect(catalog.models.filter((item) => item.available).map((item) => item.source)).toEqual([
      'OPL Gateway',
      'OPL Gateway',
    ])
  })
  it('defaults the two native Gateway Gemini models to Antigravity and keeps OpenCode compatible', async () => {
    vi.stubEnv('USERPROFILE', join(tmpdir(), 'opl-gemini-opencode-absent-cli'))
    vi.stubEnv('HOME', join(tmpdir(), 'opl-gemini-opencode-absent-cli'))
    vi.stubEnv('PATH', '')
    const { service } = await nativeSetup([
      { id: 'gemini::gemini-4-argon', name: 'Gemini 4 Argon' },
      { id: 'gemini::gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini::gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
      { id: 'gemini::gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    ])
    const catalog = await service.executionCatalog()
    expect(
      catalog.combinations.filter((item) => item.modelRef.model.startsWith('gemini::')),
    ).toMatchObject([
      { modelRef: { model: 'gemini::gemini-4-argon' }, harnessRef: 'antigravity', isDefault: true },
      {
        modelRef: { model: 'gemini::gemini-3.8-flash' },
        harnessRef: 'antigravity',
        isDefault: true,
      },
    ])
    expect(
      catalog.recommendations
        ?.filter((item) => item.modelRef.model.startsWith('gemini::'))
        .map((item) => item.harnessRef),
    ).toEqual(['opencode', 'opencode'])
    for (const model of ['gemini-4-argon', 'gemini-3.8-flash'])
      expect(catalog.supportedPairings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            modelRef: { provider: 'opl-gateway', model: `gemini::${model}` },
            harnessRefs: expect.arrayContaining(['antigravity', 'opencode']),
          }),
        ]),
      )
    expect(catalog.models.map((item) => item.ref.model)).toEqual(
      expect.arrayContaining([
        'gemini::gemini-4-argon',
        'gemini::gemini-3.8-flash',
        'gemini::gemini-3.1-pro',
        'gemini::gemini-3.7-flash',
      ]),
    )
  })
  it('marks a ready OPL Gateway Gemini group available for its official Antigravity defaults', async () => {
    const { service, ctx } = await nativeSetup([])
    const settings = {
      describe: () => [
        { ns: 'opl-suite', value: { gatewayGroups: { gemini: true } }, revision: 1 },
        {
          ns: 'llm-pi-ai',
          value: {
            providers: {
              'opl-gateway-gemini': {
                models: [
                  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
                  { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
                ],
              },
            },
          },
          revision: 1,
        },
      ],
    }
    ctx.get = ((name: string) => {
      if (name === 'settings') return settings
      if (name === 'oplGatewayAccount')
        return { status: async () => ({ groups: [{ id: 'gemini', state: 'ready' }] }) }
      return undefined
    }) as typeof ctx.get
    const catalog = await service.executionCatalog()
    for (const model of ['gemini::gemini-3.8-flash', 'gemini::gemini-4-argon']) {
      expect(catalog.models).toContainEqual(
        expect.objectContaining({
          ref: { provider: 'opl-gateway', model },
          available: true,
        }),
      )
      expect(catalog.combinations).toContainEqual(
        expect.objectContaining({
          modelRef: { provider: 'opl-gateway', model },
          harnessRef: 'antigravity',
          isDefault: true,
          enabled: true,
        }),
      )
    }
  })
  it('retains a user-selected OpenCode default for a newly supported Antigravity model', async () => {
    const { service } = await nativeSetup([
      { id: 'gemini::gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ])
    const catalog = await service.executionCatalog()
    const modelRef = { provider: 'opl-gateway', model: 'gemini::gemini-3.8-flash' }
    await service.saveExecutionCatalog({
      ...catalog,
      combinations: [
        ...catalog.combinations.filter((item) => item.modelRef.model !== modelRef.model),
        {
          id: 'user-open-code',
          name: 'Gemini backup',
          modelRef,
          harnessRef: 'opencode',
          permissionPolicy: 'full-access',
          enabled: true,
          isDefault: true,
        },
      ],
    })
    const updated = await service.executionCatalog()
    expect(
      updated.combinations.filter(
        (item) => item.enabled && item.isDefault && item.modelRef.model === modelRef.model,
      ),
    ).toMatchObject([{ id: 'user-open-code', harnessRef: 'opencode' }])
  })
  it('adds the official Antigravity default beside an OpenCode alternative', async () => {
    const { service } = await nativeSetup([
      { id: 'gemini::gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ])
    const catalog = await service.executionCatalog()
    const modelRef = { provider: 'opl-gateway', model: 'gemini::gemini-3.8-flash' }
    await service.saveExecutionCatalog({
      ...catalog,
      combinations: [
        ...catalog.combinations.filter((item) => item.modelRef.model !== modelRef.model),
        {
          id: 'user-open-code-alternative',
          name: 'Gemini backup',
          modelRef,
          harnessRef: 'opencode',
          permissionPolicy: 'read-only',
          enabled: true,
          isDefault: false,
          autoEnabled: false,
          autoEnabledDisabled: true,
        },
      ],
    })
    const updated = await service.executionCatalog()
    expect(updated.combinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'auto:["opl-gateway","gemini::gemini-3.8-flash"]',
          harnessRef: 'antigravity',
          isDefault: true,
          enabled: true,
        }),
        expect.objectContaining({
          id: 'user-open-code-alternative',
          harnessRef: 'opencode',
          isDefault: false,
          enabled: true,
        }),
      ]),
    )
  })
  it('restores the chosen combination among bindings to the same model without elevating permissions', async () => {
    const { service, ctx, options, session, changeModel } = await nativeSetup()
    const setPermission = vi.fn()
    ctx.get = ((name: string) =>
      name === 'permissionPresets' ? { set: setPermission } : undefined) as typeof ctx.get
    const catalog = await service.executionCatalog()
    const modelRef = { provider: 'opl-gateway', model: 'codex::gpt-test-model' }
    catalog.combinations.push(
      {
        id: 'review',
        name: 'Review',
        modelRef,
        harnessRef: 'dsh',
        permissionPolicy: 'read-only',
        isDefault: false,
        enabled: true,
      },
      {
        id: 'work',
        name: 'Work',
        modelRef,
        harnessRef: 'dsh',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
    )
    await service.saveExecutionCatalog(catalog)
    await service.selectCombination({ sessionId: session.id, combination: 'review' })
    expect(setPermission).not.toHaveBeenCalled()
    expect(session.append).not.toHaveBeenCalled()
    await service.selectCombination({ sessionId: session.id, combination: 'work' })
    expect(setPermission).not.toHaveBeenCalled()
    expect(session.append).not.toHaveBeenCalled()
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.modelSelection(session.id)).combination).toBe('work')
    changeModel()
    expect((await restored.modelSelection(session.id)).combination).toBe('dsh/deepseek-flash')
  })
  it.each(['read-only', 'workspace-write', 'danger-full-access'])(
    'preserves the selected %s preset when switching to the Grok official combination',
    async (mode) => {
      const { service, ctx, session, options } = await nativeSetup([
        { id: 'deepseek-flash', name: 'DeepSeek' },
        { id: 'grok::grok-4.7', name: 'Grok 4.7' },
      ])
      useNodeAcpFixtureAgent()
      const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
      vi.spyOn(adapterFor('grok-build', ref)!, 'available').mockResolvedValue({ available: true })
      const setPermission = vi.fn()
      ctx.get = ((name: string) =>
        name === 'permissionPresets' ? { set: setPermission } : undefined) as typeof ctx.get
      ctx.agents.get = (() => ({
        status: 'idle',
        ctx: { get: () => ({ resolve: () => ({ mode }) }) },
      })) as typeof ctx.agents.get
      const catalog = await service.executionCatalog()
      const combination = catalog.combinations.find((item) => item.id === GROK_COMBINATION)!
      expect(combination.permissionPolicy).toBe('workspace')
      await service.selectCombination({ sessionId: session.id, combination: combination.id })
      expect(setPermission).not.toHaveBeenCalled()
      expect(session.append).not.toHaveBeenCalled()
      await service.dispose()
      const restored = new HarnessService(ctx, options)
      cleanups.push(() => restored.dispose())
      expect((await restored.modelSelection(session.id)).combination).toBe(combination.id)
      expect(setPermission).not.toHaveBeenCalled()
      expect(session.append).not.toHaveBeenCalled()
    },
  )
  it('projects adapter compatibility and refuses unsupported new pairings before saving', async () => {
    const { service } = await nativeSetup()
    const catalog = await service.executionCatalog()
    const ref = { provider: 'opl-gateway', model: 'codex::gpt-test-model' }
    const supported = catalog.supportedPairings!.find((item) => item.modelRef.model === ref.model)!
    expect(supported.harnessRefs).toContain('codex')
    expect(supported.harnessRefs).not.toContain('minimax-code')
    await expect(
      service.saveExecutionCatalog({
        ...catalog,
        combinations: [
          ...catalog.combinations,
          {
            id: 'unsupported-new',
            name: 'Unsupported',
            modelRef: ref,
            harnessRef: 'minimax-code',
            permissionPolicy: 'read-only',
            enabled: true,
            isDefault: false,
          },
        ],
      }),
    ).rejects.toThrow('尚无兼容适配器')
    expect(
      (await service.executionCatalog()).combinations.some((item) => item.id === 'unsupported-new'),
    ).toBe(false)
  })
  it('preserves a disabled automatic combination instead of generating a duplicate', async () => {
    const { service } = await nativeSetup(),
      catalog = await service.executionCatalog()
    const automatic = catalog.combinations.find(
      (item) => item.generated && item.modelRef.model === 'codex::gpt-test-model',
    )!
    automatic.generated = false
    automatic.enabled = false
    const saved = await service.saveExecutionCatalog(catalog)
    expect(saved.combinations.filter((item) => item.id === automatic.id)).toHaveLength(1)
    expect(saved.combinations.find((item) => item.id === automatic.id)?.enabled).toBe(false)
  })
  it('does not mark an external combination ready when its model is absent', async () => {
    const { service } = await nativeSetup()
    expect(
      (await service.list()).combinations.find((item) => item.id === GROK_COMBINATION),
    ).toMatchObject({ available: false, reason: '模型未配置或分组未授权' })
  })
})
describe('external Harness production transport', () => {
  it('parses ACP envelopes, deduplicates task/operation, preserves results and restores native sessions', async () => {
    const { root, service, ctx, options } = await setup()
    const [a, b] = await Promise.all([start(service, root), start(service, root)])
    expect(a.id).toBe(b.id)
    await service.prompt({ sessionId: a.id, text: 'remember-721', operationId: 'one' })
    const first = await wait(service, a.id)
    expect(first.turns[0]).toMatchObject({ state: 'completed', text: 'result:remember-721' })
    expect(first.turns[0]?.tools).toHaveLength(1)
    await service.prompt({ sessionId: a.id, text: 'remember-721', operationId: 'one' })
    await expect(
      service.prompt({ sessionId: a.id, text: 'changed', operationId: 'one' }),
    ).rejects.toThrow('operation')
    expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toHaveLength(1)
    await service.dispose()
    const resumed = new HarnessService(ctx, options)
    cleanups.push(() => resumed.dispose())
    await resumed.start({ combination: GROK_COMBINATION, cwd: root, existingSessionId: a.id })
    await resumed.prompt({ sessionId: a.id, text: 'recall', operationId: 'two' })
    expect((await wait(resumed, a.id)).turns[1]?.text).toBe('remember-721')
    const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8'))
    expect(launch).toMatchObject({ envKey: true, hasCodex: false })
    expect(
      await readFile(join(options.home, 'harnesses/grok-build/config.toml'), 'utf8'),
    ).not.toContain('test-grok-key')
  })
  it('holds permission until explicit choice and denies without file writes', async () => {
    const { root, service } = await setup()
    const a = await start(service, root)
    await service.prompt({ sessionId: a.id, text: 'deny-write', operationId: 'deny' })
    const pending = await wait(service, a.id)
    expect(pending.state).toBe('waiting_approval')
    expect(
      await access(join(root, 'controlled.txt')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    const ask = pending.approvals[0]!
    expect(ask.command).toBe('printf approved > controlled.txt')
    await expect(
      service.answer({ sessionId: a.id, approvalId: ask.id, optionId: 'invalid' }),
    ).rejects.toThrow()
    await service.answer({ sessionId: a.id, approvalId: ask.id, optionId: 'no' })
    expect((await wait(service, a.id)).turns[0]?.text).toBe('denied')
    expect(
      await access(join(root, 'controlled.txt')).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await service.prompt({ sessionId: a.id, text: 'allow-write', operationId: 'allow' })
    const approval = (await wait(service, a.id)).approvals[0]!
    await service.answer({ sessionId: a.id, approvalId: approval.id, optionId: 'yes' })
    await wait(service, a.id)
    expect(await readFile(join(root, 'controlled.txt'), 'utf8')).toBe('approved')
  })
  it('cancels with a notification and rejects parallel prompts and mismatched resumes', async () => {
    const { root, service } = await setup()
    const a = await start(service, root)
    await service.prompt({ sessionId: a.id, text: 'wait', operationId: 'one' })
    await expect(
      service.prompt({ sessionId: a.id, text: 'again', operationId: 'two' }),
    ).rejects.toThrow('执行')
    expect((await service.cancel({ sessionId: a.id })).state).toBe('cancelled')
    await expect(service.start({ combination: 'fake', cwd: root })).rejects.toThrow()
    await expect(
      service.start({ combination: GROK_COMBINATION, cwd: root, existingSessionId: 'missing' }),
    ).rejects.toThrow('不存在')
    await expect(
      service.start({ combination: GROK_COMBINATION, cwd: tmpdir(), existingSessionId: a.id }),
    ).rejects.toThrow('不一致')
  })
  it('fails closed without a Grok key and never falls back to machine credentials', async () => {
    const { root, ctx, options, service: initial } = await setup()
    await initial.executionCatalog()
    await initial.dispose()
    const service = new HarnessService(ctx, { ...options, resolveKey: async () => undefined })
    cleanups.push(() => service.dispose())
    await expect(start(service, root)).rejects.toThrow('渠道凭据')
    expect(grokConfiguration()).toContain('env_key = "OPL_GATEWAY_GROK_API_KEY"')
  })
  it('shares one cold connection across concurrent retries after restart', async () => {
    const { root, service, ctx, options } = await setup()
    const a = await start(service, root)
    await service.dispose()
    const resumed = new HarnessService(ctx, options)
    cleanups.push(() => resumed.dispose())
    const request = { sessionId: a.id, text: 'wait', operationId: 'retry' }
    await Promise.all([resumed.prompt(request), resumed.prompt(request)])
    expect((await readFile(join(root, 'connections.txt'), 'utf8')).trim().split('\n')).toEqual([
      'session/new',
      'session/load',
    ])
    // prompt() resolves once the turn is admitted and the request has been written to the
    // child's stdin; the child appends to calls.txt only after it handles session/prompt.
    // Wait for that child-side evidence, never for admission alone, and give the wait a
    // real bound instead of a fixed sleep.
    await vi.waitFor(
      async () =>
        expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toEqual([
          'wait',
        ]),
      { timeout: 5000 },
    )
    expect((await resumed.snapshot({ sessionId: a.id })).turns).toHaveLength(1)
    expect((await resumed.cancel({ sessionId: a.id })).state).toBe('cancelled')
  })
  it('inherits project permissions and cancels child work with its parent', async () => {
    const { root, service } = await setup()
    const a = await start(service, root)
    const narrow = await service.start({
      combination: GROK_COMBINATION,
      cwd: root,
      origin: { kind: 'harness', sessionId: a.id },
      sandbox: 'read-only',
    })
    expect(narrow.sandbox).toBe('read-only')
    await expect(
      service.start({
        combination: GROK_COMBINATION,
        cwd: root,
        origin: { kind: 'harness', sessionId: narrow.id },
        sandbox: 'workspace',
      }),
    ).rejects.toThrow('权限边界')
    const child = await service.start({
      combination: GROK_COMBINATION,
      cwd: root,
      origin: { kind: 'harness', sessionId: a.id },
    })
    await service.prompt({ sessionId: a.id, text: 'wait', operationId: 'parent' })
    await service.prompt({ sessionId: child.id, text: 'wait', operationId: 'child' })
    await service.cancel({ sessionId: a.id })
    expect((await service.snapshot({ sessionId: child.id })).state).toBe('cancelled')
  })
})

describe('shared collaboration owner', () => {
  it('separates delivery from acceptance, binds the parent and continues the same task', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent')
    const origin = { kind: 'harness' as const, sessionId: parent.id }
    const input = {
      combination: GROK_COMBINATION,
      task: 'deliver-one',
      taskId: 'child',
      operationId: 'one',
    }
    const first = await service.delegateFrom(origin, input)
    expect(first.turns[0]).toMatchObject({
      state: 'completed',
      review: { decision: 'pending' },
      delivery: { state: 'delivered' },
    })
    expect((await service.delegateFrom(origin, input)).id).toBe(first.id)
    expect(await service.tasksFor(origin)).toHaveLength(1)
    await expect(
      service.reviewTask(
        { kind: 'codex', sessionId: 'other' },
        { sessionId: first.id, operationId: 'one', decision: 'accepted', note: 'fake' },
      ),
    ).rejects.toThrow('当前对话')
    await service.reviewTask(origin, {
      sessionId: first.id,
      operationId: 'one',
      decision: 'changes_requested',
      note: '需要补充',
    })
    const second = await service.delegateFrom(origin, {
      ...input,
      sessionId: first.id,
      task: 'deliver-two',
      operationId: 'two',
    })
    expect(second.id).toBe(first.id)
    expect(second.assignment?.revisions).toBe(1)
    await expect(
      service.reviewTask(origin, {
        sessionId: first.id,
        operationId: 'one',
        decision: 'accepted',
        note: 'stale',
      }),
    ).rejects.toThrow('已变化')
    const accepted = await service.reviewTask(origin, {
      sessionId: first.id,
      operationId: 'two',
      decision: 'accepted',
      note: '已核对',
    })
    expect(accepted.turns.at(-1)?.review?.decision).toBe('accepted')
    expect(
      (
        await service.reviewTask(origin, {
          sessionId: first.id,
          operationId: 'two',
          decision: 'accepted',
          note: '已核对',
        })
      ).turns,
    ).toHaveLength(2)
  })
  it('queues writers and cancels queued descendants without executing them', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent')
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'hold' })
    const child = await service.delegateFrom(
      { kind: 'harness', sessionId: parent.id },
      {
        combination: GROK_COMBINATION,
        task: 'must-not-execute',
        taskId: 'child',
        operationId: 'one',
        wait: false,
      },
    )
    expect(child.state).toBe('queued')
    await service.cancel({ sessionId: parent.id })
    expect((await service.snapshot({ sessionId: child.id })).state).toBe('cancelled')
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).not.toContain('must-not-execute')
  })
  it('releases a waiting parent, reports approval and resumes without redispatch', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent'),
      origin = { kind: 'harness' as const, sessionId: parent.id }
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'hold' })
    const child = await service.delegateFrom(origin, {
      combination: GROK_COMBINATION,
      task: 'deny-write',
      taskId: 'permission',
      operationId: 'one',
    })
    expect(child.state).toBe('waiting_approval')
    const ask = child.approvals[0]!
    await service.answer({ sessionId: child.id, approvalId: ask.id, optionId: 'no' })
    const result = await service.resultFor(origin, { sessionId: child.id, wait: true })
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]?.text).toBe('denied')
    await service.cancel({ sessionId: parent.id })
  })
  it('freezes the model binding across configuration edits and restart', async () => {
    const { root, service, ctx, options } = await setup(),
      parent = await start(service, root, 'parent'),
      origin = { kind: 'harness' as const, sessionId: parent.id }
    const child = await service.delegateFrom(origin, {
      combination: GROK_COMBINATION,
      task: 'first',
      taskId: 'child',
      operationId: 'one',
    })
    const catalog = await service.executionCatalog()
    catalog.combinations = catalog.combinations.filter((c) => c.id !== GROK_COMBINATION)
    await service.saveExecutionCatalog(catalog)
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    const continued = await restored.delegateFrom(origin, {
      sessionId: child.id,
      task: 'second',
      taskId: 'child',
      operationId: 'two',
    })
    expect(continued.modelRef).toEqual(child.modelRef)
    expect(continued.turns).toHaveLength(2)
  })
})

describe('durable collaboration delivery', () => {
  it('delivers an asynchronous result once and preserves the receipt after restart', async () => {
    const { root, service, ctx, options } = await setup(),
      parent = await start(service, root, 'parent'),
      origin = { kind: 'harness' as const, sessionId: parent.id }
    const child = await service.delegateFrom(origin, {
      combination: GROK_COMBINATION,
      task: 'async-result',
      taskId: 'async',
      operationId: 'one',
      wait: false,
    })
    await vi.waitFor(async () =>
      expect((await service.snapshot({ sessionId: parent.id })).turns).toHaveLength(1),
    )
    await wait(service, parent.id)
    expect((await service.snapshot({ sessionId: child.id })).turns[0]?.delivery?.state).toBe(
      'delivered',
    )
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.snapshot({ sessionId: parent.id })).turns).toHaveLength(1)
    expect((await restored.snapshot({ sessionId: child.id })).turns[0]?.delivery?.state).toBe(
      'delivered',
    )
  })
  it('does not serialize independent read-only work behind a writer', async () => {
    const { root, service } = await setup(),
      writer = await start(service, root, 'writer')
    await service.prompt({ sessionId: writer.id, text: 'wait', operationId: 'hold' })
    const reader = await service.start({
      combination: GROK_COMBINATION,
      cwd: root,
      taskId: 'reader',
      sandbox: 'read-only',
    })
    await service.prompt({ sessionId: reader.id, text: 'read-result', operationId: 'one' })
    expect((await wait(service, reader.id)).state).toBe('completed')
    await service.cancel({ sessionId: writer.id })
  })
  it('runs declared disjoint writers concurrently while overlapping and undeclared writers wait', async () => {
    const { root, service } = await setup()
    const a = await start(service, root, 'scoped-a'),
      b = await start(service, root, 'scoped-b')
    const overlap = await start(service, root, 'scoped-overlap'),
      legacy = await start(service, root, 'unscoped')
    const request = {
      sessionId: a.id,
      text: 'wait',
      operationId: 'hold',
      writeScope: ['src/client'],
    }
    await service.prompt(request)
    await service.prompt({
      sessionId: b.id,
      text: 'wait',
      operationId: 'hold',
      writeScope: ['src/host'],
    })
    await vi.waitFor(async () => {
      const lines = (await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')
      expect(lines).toEqual(['wait', 'wait'])
    })
    expect((await service.snapshot({ sessionId: a.id })).state).toBe('running')
    expect((await service.snapshot({ sessionId: b.id })).state).toBe('running')
    await service.prompt({
      sessionId: overlap.id,
      text: 'overlap',
      operationId: 'one',
      writeScope: ['src/client/a.ts'],
    })
    await service.prompt({ sessionId: legacy.id, text: 'legacy', operationId: 'one' })
    expect((await service.snapshot({ sessionId: overlap.id })).state).toBe('queued')
    expect((await service.snapshot({ sessionId: legacy.id })).state).toBe('queued')
    await service.prompt(request)
    await expect(service.prompt({ ...request, writeScope: ['src/different'] })).rejects.toThrow(
      'operation',
    )
    await service.cancel({ sessionId: a.id })
    expect((await wait(service, overlap.id)).state).toBe('completed')
    expect((await service.snapshot({ sessionId: legacy.id })).state).toBe('queued')
    await service.cancel({ sessionId: b.id })
    expect((await wait(service, legacy.id)).state).toBe('completed')
    const lines = (await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')
    expect(lines).toEqual(['wait', 'wait', 'overlap', 'legacy'])
  })
  it('persists operation ownership and restores cancellation without replay', async () => {
    const { root, service, ctx, options } = await setup()
    const a = await start(service, root, 'restored-scope')
    const request = {
      sessionId: a.id,
      text: 'wait',
      operationId: 'one',
      writeScope: ['src/file.ts'],
    }
    await service.prompt(request)
    await vi.waitFor(async () =>
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n'),
    )
    await service.cancel({ sessionId: a.id })
    await service.dispose()
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.snapshot({ sessionId: a.id })).turns[0]?.writeScope).toHaveLength(1)
    await restored.prompt(request)
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n')
    await restored.prompt({ ...request, operationId: 'two', text: 'next' })
    expect((await wait(restored, a.id)).state).toBe('completed')
  })
  it('does not cancel or launch another scoped writer when a queued writer is cancelled', async () => {
    const { root, service } = await setup()
    const a = await start(service, root, 'lock-holder'),
      b = await start(service, root, 'cancel-pending')
    await service.prompt({ sessionId: a.id, text: 'wait', operationId: 'one', writeScope: ['src'] })
    await vi.waitFor(async () =>
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n'),
    )
    await service.prompt({
      sessionId: b.id,
      text: 'never-executed',
      operationId: 'one',
      writeScope: ['src/a.ts'],
    })
    await service.cancel({ sessionId: b.id })
    expect((await service.snapshot({ sessionId: b.id })).state).toBe('cancelled')
    expect((await service.snapshot({ sessionId: a.id })).state).toBe('running')
    await service.cancel({ sessionId: a.id })
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n')
  })
})

describe('restart and cancellation boundaries', () => {
  it('marks unfinished operations interrupted without issuing the task again', async () => {
    const { root, service, ctx, options } = await setup(),
      parent = await start(service, root, 'parent')
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'in-flight' })
    const filename = new HarnessSessionStore(options.home).filename(parent.id),
      before = await readFile(filename, 'utf8')
    await service.dispose()
    await writeFile(filename, before)
    const restored = new HarnessService(ctx, options)
    cleanups.push(() => restored.dispose())
    expect((await restored.snapshot({ sessionId: parent.id })).state).toBe('interrupted')
    expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toEqual(['wait'])
  })
  it('does not automatically wake a parent after the user cancels it', async () => {
    const { root, service } = await setup(),
      parent = await start(service, root, 'parent')
    await service.prompt({ sessionId: parent.id, text: 'wait', operationId: 'hold' })
    const child = await service.delegateFrom(
      { kind: 'harness', sessionId: parent.id },
      {
        combination: GROK_COMBINATION,
        task: 'queued',
        taskId: 'child',
        operationId: 'one',
        wait: false,
      },
    )
    await service.cancel({ sessionId: parent.id })
    await vi.waitFor(async () =>
      expect((await service.snapshot({ sessionId: child.id })).turns[0]?.delivery?.state).toBe(
        'blocked',
      ),
    )
    expect((await service.snapshot({ sessionId: parent.id })).turns).toHaveLength(1)
  })
})

/** Generated catalog defaults preserve explicit authorization; declared restrictions stay binding. */
describe('generated combination permission policy', () => {
  const CODEX_REF = { provider: 'opl-gateway', model: 'codex::gpt-5-codex' },
    CODEX_MODELS = [
      { id: CODEX_REF.model, name: 'Codex' },
      { id: 'deepseek-flash', name: 'DeepSeek' },
    ],
    codexOrigin = { kind: 'codex', sessionId: 'parent' } as const

  /** Launch the Node ACP fixture for Codex and report the profile the service actually used. */
  async function useCodexFixture(root: string, reported: string[]) {
    const adapter = adapterFor('codex', CODEX_REF)
    if (!adapter) throw Error('fixture seam requires the Codex adapter entry')
    vi.spyOn(adapter, 'prepare').mockImplementation(async (_ctx, record) => {
      reported.push(record.sandbox)
      const home = join(root, 'harnesses', 'codex')
      await mkdir(home, { recursive: true, mode: 0o700 })
      return {
        home,
        command: process.execPath,
        args: [resolve('tests/fixtures/acp-agent.mjs')],
        env: { ...systemEnvironment(), OPL_FIXTURE_MODEL: CODEX_REF.model.split('::').at(-1) },
      }
    })
  }
  const generated = async (service: HarnessService) => {
    const automatic = (await service.executionCatalog()).combinations.find(
      (item) => item.generated && item.modelRef.model === CODEX_REF.model,
    )
    expect(automatic).toBeDefined()
    return automatic!
  }

  it('keeps an explicitly authorized full-access CLI task on a generated combination', async () => {
    const reported: string[] = []
    const { service, root } = await nativeSetup(CODEX_MODELS)
    await useCodexFixture(root, reported)
    const automatic = await generated(service)
    // The generator's conservative default is still there; it is simply not an authorization.
    expect(automatic.permissionPolicy).toBe('read-only')
    const session = await service.delegateFrom(codexOrigin, {
      combination: automatic.id,
      cwd: root,
      task: 'run the delegated task',
      taskId: 'delegated',
      operationId: 'one',
      sandbox: 'full-access',
      wait: false,
    })
    expect(session.sandbox).toBe('full-access')
    // The launched Harness received the granted profile, and the task actually ran under it.
    expect(reported).toEqual(['full-access'])
    expect((await wait(service, session.id)).state).toBe('completed')
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).toContain('run the delegated task')
  })

  it('maps that authorization onto the official Codex full-access preset', async () => {
    const { service, root, ctx } = await nativeSetup(CODEX_MODELS)
    Object.assign(ctx, { credentials: { resolve: async () => ({ value: 'test-codex-key' }) } })
    const automatic = await generated(service)
    const session = await service.start(
      {
        combination: automatic.id,
        cwd: root,
        taskId: 'preset',
        origin: codexOrigin,
        sandbox: 'full-access',
      },
      true,
    )
    expect(session.sandbox).toBe('full-access')
    // The real Codex launch step, so this asserts the environment a running bridge would read.
    const launch = await adapterFor('codex', CODEX_REF)!.prepare!(ctx, session, {
      home: join(root, 'state'),
      command: process.execPath,
      grokCommand: '',
      nativeBridgePath: '',
    })
    expect(launch.env.OPL_NATIVE_PERMISSION).toBe('full-access')
    // The bridge turns that profile into Codex's official app-server sandbox mode, and the same
    // three-way profile is the official permission preset used for native combination sessions.
    expect(codexSandboxMode(launch.env.OPL_NATIVE_PERMISSION as 'full-access')).toBe(
      'danger-full-access',
    )
    expect(harnessPermissionPreset('full-access')).toBe('danger-full-access')
  })

  it('still starts a generated combination read-only when the caller states no permission', async () => {
    const { service, root } = await nativeSetup(CODEX_MODELS)
    const automatic = await generated(service)
    const session = await service.start(
      { combination: automatic.id, cwd: root, taskId: 'unstated', origin: codexOrigin },
      true,
    )
    expect(session.sandbox).toBe('read-only')
  })

  it('keeps a declared read-only combination restricted for a CLI caller', async () => {
    const { service, root } = await nativeSetup(CODEX_MODELS),
      catalog = await service.executionCatalog()
    await service.saveExecutionCatalog({
      ...catalog,
      combinations: [
        ...catalog.combinations,
        {
          id: 'declared-read-only',
          name: 'Declared read-only',
          modelRef: CODEX_REF,
          harnessRef: 'codex',
          permissionPolicy: 'read-only',
          isDefault: false,
          enabled: true,
        },
      ],
    })
    // A policy a person declared keeps its boundary: the request cannot widen it.
    const session = await service.start(
      {
        combination: 'declared-read-only',
        cwd: root,
        taskId: 'declared',
        origin: codexOrigin,
        sandbox: 'full-access',
      },
      true,
    )
    expect(session.sandbox).toBe('read-only')
  })

  it('admits explicitly authorized native DSH full access without downgrading the request', async () => {
    const { service, root } = await nativeSetup(CODEX_MODELS),
      catalog = await service.executionCatalog()
    await service.saveExecutionCatalog({
      ...catalog,
      combinations: [
        ...catalog.combinations,
        {
          id: 'dsh-workspace',
          name: 'DSH workspace',
          modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
          harnessRef: 'dsh',
          permissionPolicy: 'workspace',
          isDefault: false,
          enabled: true,
        },
      ],
    })
    await expect(
      service.start(
        {
          combination: 'dsh-workspace',
          cwd: root,
          taskId: 'native-full-access',
          origin: codexOrigin,
          sandbox: 'full-access',
        },
        true,
      ),
    ).resolves.toMatchObject({ sandbox: 'full-access', harnessRef: 'dsh' })
  })

  it('does not upgrade a stored restricted session when it is continued', async () => {
    const first = await nativeSetup(CODEX_MODELS),
      automatic = await generated(first.service),
      created = await first.service.start(
        {
          combination: automatic.id,
          cwd: first.root,
          taskId: 'stored',
          origin: codexOrigin,
          sandbox: 'read-only',
        },
        true,
      )
    await first.service.dispose()
    // A stored record carries no `generated` flag, so its own profile is the declared one after a
    // restart: continuing it cannot reach a profile its record never held.
    const restored = new HarnessService(first.ctx, first.options)
    cleanups.push(() => restored.dispose())
    await expect(
      restored.start(
        {
          combination: automatic.id,
          cwd: first.root,
          taskId: 'stored',
          origin: codexOrigin,
          existingSessionId: created.id,
          sandbox: 'full-access',
        },
        true,
      ),
    ).rejects.toThrow('不能通过继续会话扩大权限')
    expect((await restored.snapshot({ sessionId: created.id })).sandbox).toBe('read-only')
  })
})

it('does not report queue admission for an unrelated conversation', async () => {
  const { service } = await setup()
  expect(await service.queueStatus('not-associated')).toEqual({ queued: false })
})

describe('external execution progress deadlines', () => {
  it('persists a failed turn when a silent execution exceeds its deadline', async () => {
    const { service, root, options } = await setup()
    const session = await start(service, root)
    service.configureProgressLimits({ firstProgressMs: 1000, idleProgressMs: 1000 })
    await service.prompt({ sessionId: session.id, text: 'wait', operationId: 'silent-deadline' })
    const snapshot = await wait(service, session.id)
    expect(snapshot.state).toBe('failed')
    expect(snapshot.turns[0]?.error).toContain('等待期限')
    await service.dispose()
    const stored = await new HarnessSessionStore(options.home).load()
    expect(stored.find((record) => record.id === session.id)?.turns[0]).toMatchObject({
      state: 'failed',
      error: snapshot.turns[0]?.error,
    })
  })

  it('fails after useful output becomes silent', async () => {
    const { service, root } = await setup()
    const session = await start(service, root)
    service.configureProgressLimits({ firstProgressMs: 1000, idleProgressMs: 100 })
    await service.prompt({
      sessionId: session.id,
      text: 'partial-then-wait',
      operationId: 'idle-deadline',
    })
    const snapshot = await wait(service, session.id)
    expect(snapshot.state).toBe('failed')
    expect(snapshot.turns[0]?.text).toBe('partial answer')
    expect(snapshot.turns[0]?.error).toContain('等待期限')
  })

  it('does not start a deadline while queued behind another execution', async () => {
    const { service, root } = await setup()
    const holder = await start(service, root, 'deadline-holder')
    await service.prompt({ sessionId: holder.id, text: 'wait', operationId: 'hold' })
    const queued = await start(service, root, 'deadline-queued')
    service.configureProgressLimits({ firstProgressMs: 100, idleProgressMs: 100 })
    await service.prompt({ sessionId: queued.id, text: 'result', operationId: 'queued-result' })
    expect((await service.snapshot({ sessionId: queued.id })).state).toBe('queued')
    await service.cancel({ sessionId: holder.id })
    expect((await wait(service, queued.id)).state).toBe('completed')
  })

  it('pauses all deadlines while approval is waiting', async () => {
    const { service, root } = await setup()
    const session = await start(service, root)
    service.configureProgressLimits({ firstProgressMs: 100, idleProgressMs: 100 })
    await service.prompt({
      sessionId: session.id,
      text: 'allow-write',
      operationId: 'approval-pause',
    })
    const pending = await wait(service, session.id)
    expect(pending.state).toBe('waiting_approval')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect((await service.snapshot({ sessionId: session.id })).state).toBe('waiting_approval')
    await service.answer({
      sessionId: session.id,
      approvalId: pending.approvals[0]!.id,
      optionId: 'yes',
    })
    expect((await wait(service, session.id)).state).toBe('completed')
  })

  it('allows a quiet running tool past idle time until explicitly cancelled', async () => {
    const { service, root } = await setup()
    const session = await start(service, root)
    service.configureProgressLimits({ firstProgressMs: 1000, idleProgressMs: 1000 })
    await service.prompt({
      sessionId: session.id,
      text: 'tool-in-progress-wait',
      operationId: 'quiet-tool-running',
    })
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot({ sessionId: session.id })
      expect(snapshot.turns[0]?.tools).toEqual([
        expect.objectContaining({ id: 'quiet-tool', status: 'in_progress' }),
      ])
    })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const snapshot = await service.snapshot({ sessionId: session.id })
    expect(snapshot.state).toBe('running')
    expect(snapshot.turns[0]?.error).toBeUndefined()
    expect(snapshot.turns[0]?.tools[0]?.status).toBe('in_progress')
    expect((await service.cancel({ sessionId: session.id })).state).toBe('cancelled')
  })

  it('clears the active deadline on manual cancellation', async () => {
    const { service, root } = await setup()
    const session = await start(service, root)
    service.configureProgressLimits({ firstProgressMs: 5000, idleProgressMs: 5000 })
    await service.prompt({ sessionId: session.id, text: 'wait', operationId: 'manual-deadline' })
    await vi.waitFor(async () =>
      expect(await readFile(join(root, 'calls.txt'), 'utf8')).toBe('wait\n'),
    )
    const active = (
      service as unknown as {
        active: Map<string, { watchdog?: { dispose(): void } }>
      }
    ).active.get(session.id)
    expect(active?.watchdog).toBeDefined()
    const dispose = vi.spyOn(active!.watchdog!, 'dispose')
    const snapshot = await service.cancel({ sessionId: session.id })
    expect(dispose).toHaveBeenCalled()
    expect(snapshot.state).toBe('cancelled')
    expect(snapshot.turns[0]?.error).toBeUndefined()
  })
})

it.each([
  false,
  true,
  'quota',
  'quota-restart',
  'cached-disconnected',
  'ready-restart',
  'legacy-ready-restart',
  'ephemeral-ready-restart',
  'unsent',
  'ephemeral-unsent',
  'legacy-unbound-first',
  'driver-disconnect',
] as const)(
  'edits an external conversation with recovery mode=%s',
  async (mode) => {
    const prepared =
      mode === 'ready-restart' ||
      mode === 'legacy-ready-restart' ||
      mode === 'ephemeral-ready-restart'
    const ephemeral =
      mode === true || mode === 'ephemeral-unsent' || mode === 'ephemeral-ready-restart'
    const quota = mode === 'quota' || mode === 'quota-restart'
    const rejected = quota || prepared || mode === 'unsent' || mode === 'ephemeral-unsent'
    const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
    const ref = { provider: 'opl-gateway', model: 'grok::grok-4.7' }
    const f = await nativeSetup([{ id: ref.model, name: 'Grok' }])
    const seed = Session.create(SessionId('native-session'))
    const real = Session.create(seed.id, undefined, { ...seed.header, cwd: f.root })
    const adapter = adapterFor('grok-build', ref)!
    vi.spyOn(adapter, 'available').mockResolvedValue({ available: true })
    vi.spyOn(adapter, 'prepare').mockResolvedValue({
      home: f.root,
      command: process.execPath,
      args: [resolve('tests/fixtures/acp-agent.mjs')],
      env: {
        ...systemEnvironment(),
        OPL_FIXTURE_EDIT: '1',
        OPL_FIXTURE_EDIT_PERSIST: '1',
        ...(['legacy-unbound-first', 'quota'].includes(String(mode))
          ? { OPL_FIXTURE_FRESH_EDIT: '1' }
          : {}),
        ...(quota
          ? { OPL_FIXTURE_EDIT_FAILURE: mode === 'quota-restart' ? 'quota-recorded' : 'quota' }
          : {}),
      },
    })
    const queued: ReturnType<typeof createUserMessage>[] = []
    const agent = {
      id: real.id,
      session: real,
      status: 'idle',
      ctx: { get: () => undefined },
      inbox: { nextTurn: queued, nextStep: [], remove: vi.fn() },
      runMaintenance: async (fn: (signal: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal),
    }
    let completion: Promise<unknown> = Promise.resolve()
    let number = 0
    const stream = (user: ReturnType<typeof createUserMessage>) =>
      Array.fromAsync(
        f.service.conversationStream(
          { ...ref, sessionId: real.id, messages: [user] } as GenerateOptions,
          async function* () {
            throw Error('wrong route')
          },
        ),
      )
    Object.assign(f.ctx, {
      sessions: { list: () => [], get: () => real, flush: async () => true },
      agents: { get: () => agent, list: () => [] },
      sessionController: {
        resolveAgent: async () => ({ agent }),
        prompt: async (request: {
          requestId: string
          content: { type: 'text'; text: string }[]
        }) => {
          const user = createUserMessage({
            source: { kind: 'user', rpcId: request.requestId },
            content: request.content,
          })
          queued.push(user)
          number++
          await f.service.claimMessageEdit(agent as never, queued, number, 1)
          real.append('turn/start', { turn: number })
          real.append('step/start', { turn: number, step: 1 })
          const edited = await f.service.commitMessageEdit(
            agent as never,
            number,
            1,
            new AbortController().signal,
          )
          await f.service.assertConversationEditable(real.id, edited)
          if (ephemeral) {
            const rows = (await f.service.list()).sessions
            const owner = f.service as unknown as {
              active: Map<string, { sessionInfo?: { sessionId?: string } }>
            }
            const row = rows.find((item) => item.nativeSessionId === real.id)!
            expect(owner.active.get(row.id)?.sessionInfo?.sessionId).toBe(row.acpSessionId)
          }
          real.append('user/message', user, { surfaceOp: 'append' })
          queued.length = 0
          completion = stream(user)
            .catch((error) => {
              if (!rejected) throw error
            })
            .then(() => {
              real.append('step/end', { turn: number, step: 1 })
              real.append('turn/end', { turn: number, reason: { kind: 'completed' } })
            })
          return { accepted: true as const }
        },
      },
    })
    await f.service.selectCombination({ sessionId: real.id, combination: GROK_COMBINATION })
    const initialRequests = mode === 'legacy-ready-restart' ? ['first'] : ['first', 'second']
    for (const requestId of initialRequests) {
      number++
      const user = createUserMessage({
        source: { kind: 'user', rpcId: requestId },
        content: [{ type: 'text', text: 'same' }],
      })
      real.append('turn/start', { turn: number })
      real.append('step/start', { turn: number, step: 1 })
      real.append('user/message', user, { surfaceOp: 'append' })
      await stream(user)
      real.append('step/end', { turn: number, step: 1 })
      real.append('turn/end', { turn: number, reason: { kind: 'completed' } })
    }
    const initialRecord = (await f.service.list()).sessions.find(
      (row) => row.nativeSessionId === real.id,
    )!
    const initialVendorId = initialRecord.acpSessionId
    let originalHistory: string | undefined
    if (mode === 'legacy-unbound-first') {
      originalHistory = await readFile(join(f.root, `edit-${initialVendorId}.json`), 'utf8')
      const owner = f.service as unknown as {
        records: Map<string, HarnessSession>
        save(record: HarnessSession): Promise<void>
      }
      const row = owner.records.get(initialRecord.id)!
      delete row.turns[0]!.native!.userMessageId
      await owner.save(row)
    }
    const before = await f.service.messageEditState({ sessionId: real.id })
    expect(before.choices.map((item) => item.text)).toEqual(
      mode === 'legacy-unbound-first' ? ['same'] : initialRequests.map(() => 'same'),
    )
    if (mode === 'legacy-unbound-first') {
      const activeUsers = real.snapshotEvents().filter((entry) => entry.type === 'user/message')
      await expect(
        f.service.messageEditSend({
          targetSeq: Number(activeUsers[1]!.seq),
          head: before.head,
          prompt: {
            sessionId: real.id,
            requestId: 'must-not-fork' as never,
            mode: 'queue',
            content: [{ type: 'text', text: 'rejected' }],
          },
        }),
      ).rejects.toThrow('消息已变化')
      const owner = f.service as unknown as {
        externalMessageEdits: ExternalMessageEditTransactions
      }
      expect(owner.externalMessageEdits.intent(real.id)).toBeUndefined()
      expect(await readFile(join(f.root, `edit-${initialVendorId}.json`), 'utf8')).toBe(
        originalHistory,
      )
    }
    if (mode === 'cached-disconnected') {
      const owner = f.service as unknown as {
        active: Map<string, { acp: AcpProcess; bridgeStop?: () => Promise<void> }>
      }
      for (const active of owner.active.values()) {
        await active.acp.dispose()
        await active.bridgeStop?.()
      }
      owner.active.clear()
    }
    // A completed external turn can append non-user observations after the state
    // read. The selected message identity remains the same and must stay editable.
    real.append('step/start', { turn: 99, step: 1 })
    real.append('step/end', { turn: 99, step: 1 })
    const input = {
      targetSeq: before.choices[0]!.seq,
      head: before.head,
      prompt: {
        sessionId: real.id,
        requestId: 'replacement' as never,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: 'replacement' }],
      },
    }
    if (ephemeral) {
      const driver = createGrokMessageEditDriver()
      const owner = f.service as unknown as { externalDriver(): ExternalMessageEditDriver }
      vi.spyOn(owner, 'externalDriver').mockReturnValue({
        read: driver.read,
        rewind: async (context, input) => {
          const result = await driver.rewind(context, input)
          await context.transport().request('session/new', { sessionId: 'ephemeral-fork' })
          return { ...result, sessionId: 'ephemeral-fork', ephemeral: true }
        },
      })
    }
    if (mode === 'driver-disconnect') {
      const driver = createGrokMessageEditDriver()
      const owner = f.service as unknown as { externalDriver(): ExternalMessageEditDriver }
      vi.spyOn(owner, 'externalDriver').mockReturnValue({
        read: driver.read,
        rewind: async (context, input) => {
          const result = await driver.rewind(context, input)
          await context.disconnect()
          return { ...result, sessionId: 'disconnected-fork' }
        },
      })
    }
    if (mode === 'unsent' || mode === 'ephemeral-unsent') {
      const owner = f.service as unknown as { pinSession(...args: unknown[]): Promise<void> }
      const pin = owner.pinSession.bind(owner)
      vi.spyOn(owner, 'pinSession')
        .mockImplementationOnce(async () => {
          throw new HarnessConfigurationError('fixed configuration refused before prompt')
        })
        .mockImplementation((...args) => pin(...args))
    }
    const quotaSettlement = Promise.withResolvers<void>()
    const releaseQuotaSettlement = Promise.withResolvers<void>()
    const owner = f.service as unknown as {
      externalMessageEdits: ExternalMessageEditTransactions
      externalEditJournal: {
        save(intent: ReturnType<ExternalMessageEditTransactions['intent']>): Promise<void>
      }
      records: Map<string, HarnessSession>
      save(record: HarnessSession): Promise<void>
      changed(record: HarnessSession): void
    }
    if (quota) {
      const settle = owner.externalMessageEdits.settle.bind(owner.externalMessageEdits)
      vi.spyOn(owner.externalMessageEdits, 'settle').mockImplementationOnce(async (...args) => {
        await settle(...args)
        quotaSettlement.resolve()
        await releaseQuotaSettlement.promise
      })
    }
    if (prepared) {
      const save = owner.save.bind(owner)
      vi.spyOn(owner, 'save').mockImplementation(async (row) => {
        await save(row)
        if (!row.turns.length && owner.externalMessageEdits.intent(real.id)?.phase === 'ready')
          throw Error('connection interrupted after binding was saved')
      })
      await expect(f.service.messageEditSend(input)).rejects.toThrow('connection interrupted')
      expect((await readFile(join(f.root, 'calls.txt'), 'utf8')).trim().split('\n')).toHaveLength(
        initialRequests.length,
      )
      if (mode === 'legacy-ready-restart') {
        const { targetSeq: _targetSeq, ...legacy } = owner.externalMessageEdits.intent(real.id)!
        await owner.externalEditJournal.save(legacy)
      }
      await f.service.dispose()
      f.service = new HarnessService(f.ctx, f.options)
      cleanups.push(() => f.service.dispose())
    } else expect(await f.service.messageEditSend(input)).toEqual({ accepted: true })
    if (quota) {
      await quotaSettlement.promise
      let streamCompleted = false
      const terminal = completion.then(() => {
        streamCompleted = true
      })
      let editStateRead = false
      const read = f.service.messageEditState({ sessionId: real.id }).then((state) => {
        editStateRead = true
        return state
      })
      try {
        // Metadata can wake subscribers while the terminal error's journal is
        // still settling. Neither completion nor edit eligibility may escape it.
        const record = [...owner.records.values()].find((row) => row.nativeSessionId === real.id)!
        owner.changed(record)
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(streamCompleted).toBe(false)
        expect(editStateRead).toBe(false)
      } finally {
        releaseQuotaSettlement.resolve()
      }
      await terminal
      expect((await read).choices.map((choice) => choice.text)).toEqual(['replacement'])
    }
    await completion
    if (rejected) {
      if (mode === 'quota-restart') {
        const row = [...owner.records.values()].find((item) => item.nativeSessionId === real.id)!
        expect(row.turns.at(-1)?.native?.userMessageId).toBeDefined()
        await f.service.dispose()
        f.service = new HarnessService(f.ctx, f.options)
        cleanups.push(() => f.service.dispose())
      }
      if (mode === 'ephemeral-unsent') {
        const owner = f.service as unknown as {
          active: Map<string, { acp: AcpProcess; bridgeStop?: () => Promise<void> }>
        }
        for (const active of owner.active.values()) {
          await active.acp.dispose()
          await active.bridgeStop?.()
        }
        owner.active.clear()
      }
      const state = await f.service.messageEditState({ sessionId: real.id })
      expect(state.pending).toBe(false)
      expect(state.choices.map((x) => x.text)).toEqual([prepared ? 'same' : 'replacement'])
      const editedAgain = {
        targetSeq: state.choices[0]!.seq,
        head: state.head,
        prompt: {
          ...input.prompt,
          requestId: 'replacement-again' as never,
          content: [{ type: 'text' as const, text: 'final' }],
        },
      }
      expect(await f.service.messageEditSend(editedAgain)).toEqual({ accepted: true })
      await completion
    }
    const rows = (await f.service.list()).sessions.filter(
      (item) => item.nativeSessionId === real.id,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.turns).toHaveLength(1)
    const finalText = rejected ? 'final' : 'replacement'
    expect(rows[0]!.turns[0]!.prompt).toBe('user: ' + finalText)
    if (mode === 'legacy-unbound-first') {
      expect(rows[0]!.acpSessionId).not.toBe(initialVendorId)
      expect(await readFile(join(f.root, `edit-${initialVendorId}.json`), 'utf8')).toBe(
        originalHistory,
      )
    } else if (mode === 'quota') expect(rows[0]!.acpSessionId).not.toBe(initialVendorId)
    else
      expect(rows[0]!.acpSessionId).toBe(
        mode === 'driver-disconnect'
          ? 'disconnected-fork'
          : mode === true
            ? 'ephemeral-fork'
            : 'test-native',
      )
    expect(
      real
        .deriveMessages()
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'text')
        .map((part) => part.text),
    ).toEqual([finalText])
    expect((await readFile(join(f.root, 'calls.txt'), 'utf8')).trim().split('\n')).toEqual([
      ...initialRequests.map(() => 'user: same'),
      ...(!prepared && mode !== 'unsent' && mode !== 'ephemeral-unsent'
        ? ['user: replacement']
        : []),
      ...(rejected ? ['user: final'] : []),
    ])
    expect((await f.service.messageEditState({ sessionId: real.id })).pending).toBe(false)
    if (mode === false) {
      const callsBefore = await readFile(join(f.root, 'calls.txt'), 'utf8')
      for (const restart of [false, true]) {
        if (restart) {
          await f.service.dispose()
          f.service = new HarnessService(f.ctx, f.options)
          cleanups.push(() => f.service.dispose())
        }
        number++
        const user = createUserMessage({
          source: { kind: 'user', rpcId: `after-edit-${restart}` },
          content: [{ type: 'text', text: `followup-${restart}` }],
        })
        real.append('turn/start', { turn: number })
        real.append('step/start', { turn: number, step: 1 })
        real.append('user/message', user, { surfaceOp: 'append' })
        await stream(user)
        real.append('step/end', { turn: number, step: 1 })
        real.append('turn/end', { turn: number, reason: { kind: 'completed' } })
        const record = (await f.service.list()).sessions.find(
          (item) => item.nativeSessionId === real.id,
        )!
        expect(record.turns.at(-1)).toMatchObject({
          state: 'completed',
          stopReason: 'end_turn',
          prompt: `user: followup-${restart}`,
        })
        expect(record.turns.at(-1)?.error).toBeUndefined()
        expect((await f.service.messageEditState({ sessionId: real.id })).pending).toBe(false)
      }
      expect(await readFile(join(f.root, 'calls.txt'), 'utf8')).toBe(
        callsBefore + 'user: followup-false\nuser: followup-true\n',
      )
    }
  },
  20_000,
)
