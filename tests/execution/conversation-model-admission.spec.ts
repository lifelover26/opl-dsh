import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  AgentModel,
  installModelSelection,
  modelSelectionProjectionDefinition,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { defaultExecutionCatalog, ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'
import { installConversationRequest } from '../../src/execution/host/conversation-request.ts'
import { assertOfmModelAvailable } from '../../src/execution/host/model-admission.ts'
import { testPeerConnection } from '../test-peer.ts'

const provider = 'our-free-model'
const ling = 'inclusionai/ling-3.1-flash-1019-free'
const fullInkling = 'thinkingmachines/inkling:free'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function fixture(
  model = ling,
  harnessRef = 'kilo',
  nativeFirst = false,
  manual = true,
  options: {
    initialEffort?: string | null
    initialize?: boolean
    recordInitialSelection?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'opl-request-admission-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const state = { listed: true, advertised: true, readFailed: false, enabled: true, forward: true }
  const reasoning = {
    efforts: ['low', 'medium', 'high'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
    defaultEffort: ReasoningEffortId('high'),
  }
  const metadata = vi.fn(async (ownedProvider: string, id: string) => ({
    provider: ownedProvider,
    id,
    name: id,
    ...(state.advertised ? { reasoning } : {}),
  }))
  class Source extends LlmAdapter {
    override listModels(ownedProvider: string): Promise<readonly LlmModelInfo[]> {
      return Promise.resolve(
        state.advertised ? [{ provider: ownedProvider, id: model, name: model }] : [],
      )
    }
    override resolveModel = metadata
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      throw Error('No model request is allowed in this test')
    }
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new Source()
  const registration = ctx.llm.registerAdapter([provider, 'other-channel'], adapter)
  cleanups.push(() => ctx.fiber.dispose())
  const session = Session.create(SessionId('admission-session'))
  const choice: ModelSelection = {
    provider,
    model,
    ...(options.initialEffort === null
      ? {}
      : { reasoningEffort: ReasoningEffortId(options.initialEffort ?? 'high') }),
  }
  if (options.recordInitialSelection !== false) session.append('model/selection', choice)
  const defaults = { ...choice }
  const agentModel = new AgentModel(
    () => {
      let state = modelSelectionProjectionDefinition.init(
        session.header,
        session.inheritedEventCount,
      )
      for (const event of session.snapshotEvents())
        state = modelSelectionProjectionDefinition.apply(state, event)
      return state
    },
    session,
    defaults,
  )
  const selection = {
    get current(): ModelSelection {
      return { ...agentModel.current()! }
    },
    set current(value: ModelSelection) {
      agentModel.select(value)
    },
    assembled: Object.freeze({ ...choice }) as LlmCallConfig,
  }
  const agent = {
    id: session.id,
    session,
    model: agentModel,
    options: { provider, model },
    ctx,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
  }
  ctx.provide('sessions', { get: () => session, flush: vi.fn(async () => true) } as never)
  ctx.provide('agents', { get: () => agent, list: () => [] } as never)
  ctx.provide('sessionProjections', {
    snapshot: () => ({ values: { modelSelection: { next: selection.current, lastUsed: null } } }),
  } as never)
  const catalog = defaultExecutionCatalog()
  if (manual)
    catalog.combinations.push({
      id: 'owned-route',
      name: 'Owned route',
      modelRef: { provider, model },
      harnessRef,
      permissionPolicy: 'full-access',
      isDefault: true,
      enabled: true,
    })
  const store = new ExecutionCatalogStore(root)
  await store.set(catalog)
  await store.dispose()
  const read = vi.fn(async () => {
    if (state.readFailed) throw Error('private upstream response must not enter the diagnosis')
    return {
      catalog: state.listed ? [{ id: model, route: provider }] : [],
      settings: {
        enabled: state.enabled,
        forward: { enabled: state.forward, running: state.forward },
      },
    }
  })
  const service = new HarnessService(ctx, { home: root, readOfm: read })
  cleanups.push(() => service.dispose())
  const commit = vi.spyOn(service, 'commitMessageEdit')
  const wire = vi.spyOn(adapter, 'stream')
  if (nativeFirst) installModelSelection(ctx)
  installConversationRequest(ctx, service)
  if (!nativeFirst) installModelSelection(ctx)
  const signal = new AbortController()
  const initialize = async () => {
    await ctx.serial('agent/created', {
      agent: agent as never,
      source: 'startup',
      signal: signal.signal,
    })
    selection.assembled = Object.freeze({ ...selection.current })
  }
  if (options.initialize !== false) await initialize()
  read.mockClear()
  const request = () =>
    ctx.waterfall(
      'agent/request',
      {
        agent: agent as never,
        turn: 1,
        step: 1,
        signal: signal.signal,
      },
      async () => selection.assembled,
    )
  return {
    ctx,
    service,
    state,
    metadata,
    selection,
    session,
    request,
    commit,
    wire,
    read,
    signal,
    registration,
    initialize,
    defaults,
  }
}

function nativeSelection(f: Awaited<ReturnType<typeof fixture>>) {
  const select = vi.fn(async (request: ModelSelection & { sessionId: string }) => {
    const { sessionId: _, ...selected } = request
    f.selection.current = selected
    return { selected }
  })
  f.ctx.provide('connection', testPeerConnection)
  f.ctx.provide('typertGateway', {
    invoke: async ({
      method,
      args,
    }: {
      method: string
      args: { request: ModelSelection & { sessionId: string } }
    }) => {
      if (method !== 'selectModel') throw Error(`Unexpected method: ${method}`)
      return select(args.request)
    },
  } as never)
  vi.spyOn(f.service, 'modelSelection').mockImplementation(async () => ({
    current: f.selection.current,
    groups: [],
    combination: 'owned-route',
  }))
  return select
}

it('distinguishes missing metadata from unsupported effort before native preparation', async () => {
  const f = await fixture()
  f.state.listed = false
  f.state.advertised = false
  await expect(
    f.ctx.llm.prepareCall({ ...f.selection.assembled, reasoningEffort: ReasoningEffortId('high') }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_REASONING_EFFORT',
  })
  f.metadata.mockClear()
  await expect(f.request()).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  expect(f.metadata).not.toHaveBeenCalled()
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.wire).not.toHaveBeenCalled()
})

it.each([false, true])(
  'records CLI effort omission before the frozen step with nativeFirst=%s',
  async (first) => {
    const f = await fixture(ling, 'kilo', first)
    const config = await f.request()
    expect(config).toEqual({ provider, model: ling })
    expect(config).toBe(f.selection.assembled)
    const prepared = await f.ctx.llm.prepareCall(config)
    expect(prepared.config).toMatchObject({ provider, model: ling })
    expect(f.selection.current.reasoningEffort).toBeUndefined()
    expect(f.session.snapshotEvents().filter((event) => event.type === 'model/selection')).toEqual([
      expect.objectContaining({ data: { provider, model: ling, reasoningEffort: 'high' } }),
      expect.objectContaining({ data: { provider, model: ling } }),
    ])
    expect(f.commit).toHaveBeenCalledTimes(1)
    expect(f.wire).not.toHaveBeenCalled()
  },
)

it('normalizes generated combinations that are absent from the persisted catalog', async () => {
  const model = 'moonshotai/kimi-k3'
  const f = await fixture(model, 'kimi-code', false, false)
  const catalog = await f.service.executionCatalog()
  expect(catalog.combinations).toContainEqual(
    expect.objectContaining({
      generated: true,
      harnessRef: 'kimi-code',
      modelRef: { provider, model },
    }),
  )
  expect(await f.request()).toEqual({ provider, model })
})

it.each([
  ['opencode/nemotron-3.5-lightning-free', 'opencode'],
  ['opencode/nemotron-3.5-super-vl-free', 'opencode'],
  ['opencode/flint-40b-free', 'opencode'],
  [fullInkling, 'pi'],
  ['google/gemma-4-31b-it:free', 'pi'],
])('separates source effort from the %s CLI control', async (model, harness) => {
  const f = await fixture(model, harness)
  const input = { ...f.selection.current, temperature: 0.4, maxTokens: 128 }
  const config = await f.service.prepareConversationRequest(f.session.id, input)
  expect(config).toEqual({ provider, model, temperature: 0.4, maxTokens: 128 })
  expect(config).toBe(input)
  expect(f.selection.current.reasoningEffort).toBeUndefined()
  expect(f.wire).not.toHaveBeenCalled()
})

it('keeps source-declared reasoning for the native DSH route', async () => {
  const f = await fixture('deepseek-ai/deepseek-v4.1-flash', 'dsh')
  const config = await f.request()
  expect(config.reasoningEffort).toBe('high')
  expect((await f.ctx.llm.prepareCall(config)).config.reasoningEffort).toBe('high')
})

it('keeps an actual unsupported native effort as a validation failure', async () => {
  const f = await fixture('deepseek-ai/deepseek-v4.1-flash', 'dsh')
  f.selection.current = {
    ...f.selection.current,
    reasoningEffort: ReasoningEffortId('balanced'),
  }
  f.selection.assembled = Object.freeze({ ...f.selection.current })
  const config = await f.request()
  await expect(f.ctx.llm.prepareCall(config)).rejects.toMatchObject({
    code: 'UNSUPPORTED_REASONING_EFFORT',
  })
  expect(f.wire).not.toHaveBeenCalled()
})

it.each([
  ['deepseek-flash', 'high'],
  ['gpt-5.5', 'medium'],
  ['openai::gpt-5.5', 'medium'],
])('records the %s default before the step captures its selection', async (model, effort) => {
  const f = await fixture(model, 'dsh', false, true, { initialEffort: null })
  expect(f.selection.current).toEqual({ provider, model, reasoningEffort: effort })
  const before = f.session.snapshotEvents()
  const config = await f.request()
  expect(config).toBe(f.selection.assembled)
  expect(config).toEqual({ provider, model, reasoningEffort: effort })
  expect(f.session.snapshotEvents()).toEqual(before)
  expect((await f.ctx.llm.prepareCall(config)).config.reasoningEffort).toBe(effort)
  expect(f.commit).toHaveBeenCalledTimes(1)
  expect(f.wire).not.toHaveBeenCalled()
})

it('preserves an explicit native effort through initialization and request admission', async () => {
  const f = await fixture('gpt-5.5', 'dsh', false, true, { initialEffort: 'low' })
  expect(f.selection.current.reasoningEffort).toBe('low')
  const before = f.session.snapshotEvents()
  await f.initialize()
  expect(await f.request()).toBe(f.selection.assembled)
  expect(f.selection.assembled.reasoningEffort).toBe('low')
  expect(f.session.snapshotEvents()).toEqual(before)
})

it('freezes a new Session default before another Session saves the global default', async () => {
  const f = await fixture('gpt-5.5', 'dsh', false, true, {
    initialEffort: null,
    initialize: false,
    recordInitialSelection: false,
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.metadata.mockImplementationOnce(async (ownedProvider, id) => {
    entered.resolve()
    await release.promise
    return {
      provider: ownedProvider,
      id,
      name: id,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }],
        defaultEffort: ReasoningEffortId('medium'),
      },
    }
  })
  const initialized = f.initialize()
  const accepted = expect(initialized).resolves.toBeUndefined()
  await entered.promise
  f.defaults.model = 'different-session-default'
  release.resolve()
  await accepted
  expect(f.selection.current).toEqual({ provider, model: 'gpt-5.5', reasoningEffort: 'medium' })
  expect(f.defaults.model).toBe('different-session-default')
  expect(await f.request()).toBe(f.selection.assembled)
  expect(f.wire).not.toHaveBeenCalled()
})

it('records the native picker default before the following step is frozen', async () => {
  const f = await fixture('gpt-5.5', 'dsh', false, true, { initialEffort: 'low' })
  const select = nativeSelection(f)
  await f.service.invoke('select-effort', {
    sessionId: f.session.id,
    provider,
    model: 'gpt-5.5',
  })
  expect(select).toHaveBeenCalledExactlyOnceWith({
    sessionId: f.session.id,
    provider,
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
  })
  f.selection.assembled = Object.freeze({ ...f.selection.current })
  expect(await f.request()).toBe(f.selection.assembled)
  expect(f.selection.assembled.reasoningEffort).toBe('medium')
  expect(f.wire).not.toHaveBeenCalled()
})

it('does not add a native default after the step selection has been frozen', async () => {
  const f = await fixture('gpt-5.5', 'dsh', false, true, {
    initialEffort: null,
    initialize: false,
  })
  expect(await f.request()).toBe(f.selection.assembled)
  expect(f.selection.assembled.reasoningEffort).toBeUndefined()
  expect(f.metadata).not.toHaveBeenCalled()
})

it.each(['kilo', 'pi'])('does not clear an already frozen %s request effort', async (harness) => {
  const f = await fixture(harness === 'pi' ? fullInkling : ling, harness)
  const input = Object.freeze({
    ...f.selection.current,
    reasoningEffort: ReasoningEffortId('high'),
  })
  expect(await f.service.prepareConversationRequest(f.session.id, input)).toBe(input)
  expect(input.reasoningEffort).toBe('high')
  expect(f.wire).not.toHaveBeenCalled()
})

it.each(['model', 'reasoningEffort'] as const)(
  'does not overwrite a %s change during initialization metadata lookup',
  async (field) => {
    const f = await fixture('gpt-5.5', 'dsh', false, true, {
      initialEffort: null,
      initialize: false,
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.metadata.mockImplementationOnce(async (ownedProvider, id) => {
      entered.resolve()
      await release.promise
      return {
        provider: ownedProvider,
        id,
        name: id,
        reasoning: {
          efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }],
          defaultEffort: ReasoningEffortId('medium'),
        },
      }
    })
    const initialized = f.initialize()
    const rejected = expect(initialized).rejects.toMatchObject({ code: 'HARNESS_BINDING' })
    await entered.promise
    f.selection.current = {
      ...f.selection.current,
      ...(field === 'model'
        ? { model: 'different-current-model' }
        : { reasoningEffort: ReasoningEffortId('low') }),
    }
    const selected = f.selection.current
    const before = f.session.snapshotEvents()
    release.resolve()
    await rejected
    expect(f.selection.current).toEqual(selected)
    expect(f.session.snapshotEvents()).toEqual(before)
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.wire).not.toHaveBeenCalled()
  },
)

it('rejects a picker change during asynchronous request validation before edit admission', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.read.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return { catalog: [{ id: ling }], settings: { forward: { enabled: true, running: true } } }
  })
  const request = f.request()
  const rejected = expect(request).rejects.toMatchObject({ code: 'HARNESS_BINDING' })
  await entered.promise
  f.selection.current = { ...f.selection.current, model: 'different-current-model' }
  release.resolve()
  await rejected
  expect(f.selection.assembled).toEqual({ provider, model: ling })
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.wire).not.toHaveBeenCalled()
})

it('does not apply an omitted-effort picker write after its selected model changes', async () => {
  const f = await fixture('gpt-5.5', 'dsh', false, true, { initialEffort: 'low' })
  const select = nativeSelection(f)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.metadata.mockImplementationOnce(async (ownedProvider, id) => {
    entered.resolve()
    await release.promise
    return {
      provider: ownedProvider,
      id,
      name: id,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('medium'), name: 'Medium' }],
        defaultEffort: ReasoningEffortId('medium'),
      },
    }
  })
  const choosing = f.service.invoke('select-effort', {
    sessionId: f.session.id,
    provider,
    model: 'gpt-5.5',
  })
  const rejected = expect(choosing).rejects.toThrow('模型选择已改变')
  await entered.promise
  f.selection.current = { ...f.selection.current, model: 'different-current-model' }
  release.resolve()
  await rejected
  expect(select).not.toHaveBeenCalled()
  expect(f.selection.current.model).toBe('different-current-model')
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.wire).not.toHaveBeenCalled()
})

it('reports an owner-state read failure without declaring removal or leaking its body', async () => {
  const f = await fixture()
  f.state.readFailed = true
  await expect(f.request()).rejects.toMatchObject({
    code: 'MODEL_STATUS_UNCONFIRMED',
    message: expect.not.stringContaining('private upstream'),
  })
  expect(f.commit).not.toHaveBeenCalled()
})

it.each(['enabled', 'forward'] as const)(
  'rejects a disabled %s before edit commit',
  async (key) => {
    const f = await fixture()
    f.state[key] = false
    await expect(f.request()).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(f.commit).not.toHaveBeenCalled()
  },
)

it('checks the frozen assembled model before committing an edit even if the picker has changed', async () => {
  const f = await fixture()
  f.selection.current = { ...f.selection.current, model: 'different-current-model' }
  f.state.listed = false
  const before = f.session.snapshotEvents()
  await expect(f.request()).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.session.snapshotEvents()).toEqual(before)
})

it('refuses model disappearance during the inner request listener before committing an edit', async () => {
  const f = await fixture()
  f.ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    f.state.listed = false
    return config
  })
  await expect(f.request()).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  expect(f.commit).not.toHaveBeenCalled()
})

it('rejects edit resend before asking a vendor for editable history', async () => {
  const f = await fixture()
  f.state.listed = false
  const history = vi.spyOn(f.service, 'messageEditState')
  await expect(
    f.service.messageEditSend({
      targetSeq: 0,
      head: 0,
      prompt: {
        sessionId: f.session.id,
        requestId: 'owned-replacement' as never,
        mode: 'queue',
        content: [{ type: 'text', text: 'replacement' }],
      },
    }),
  ).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  expect(history).not.toHaveBeenCalled()
  expect(f.commit).not.toHaveBeenCalled()
})

it('does not require advisory directory membership for other providers', async () => {
  const f = await fixture()
  await expect(
    assertOfmModelAvailable(
      f.ctx,
      { provider: 'other-channel', model: 'unlisted-custom-id' },
      f.read,
      true,
    ),
  ).resolves.toBeUndefined()
  expect(f.read).not.toHaveBeenCalled()
})

it('rejects an unloaded provider after its pending directory read returns stale models', async () => {
  const f = await fixture()
  vi.spyOn(f.ctx.llm, 'listModels').mockImplementationOnce(async () => {
    f.registration()
    return [{ provider, id: ling, name: ling }]
  })
  await expect(
    assertOfmModelAvailable(f.ctx, { provider, model: ling }, f.read, true),
  ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
})

it('refuses a hidden Kilo effort write without changing the native selection', async () => {
  const f = await fixture()
  vi.spyOn(f.service, 'modelSelection').mockResolvedValue({
    current: f.selection.current,
    groups: [],
    combination: 'owned-route',
    effortSource: 'harness',
  })
  const before = f.session.snapshotEvents()
  await expect(
    f.service.invoke('select-effort', {
      sessionId: f.session.id,
      provider,
      model: ling,
      reasoningEffort: 'high',
    }),
  ).rejects.toThrow('未提供推理档位')
  expect(f.session.snapshotEvents()).toEqual(before)
})

it('does not commit an edit after cancellation during the directory read', async () => {
  const f = await fixture()
  f.read.mockImplementationOnce(async () => {
    f.signal.abort()
    return { catalog: [{ id: ling }], settings: { forward: { enabled: true, running: true } } }
  })
  await expect(f.request()).rejects.toThrow()
  expect(f.commit).not.toHaveBeenCalled()
})
