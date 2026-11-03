/** Exact EAC channel routing through the OFM owner's public connection recipe. */
import type { Context } from '@deepseek-ai/cordis'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import { adapterFor, automaticHarness } from '../../../src/execution/host/adapters/index.ts'
import {
  openCodeAdapter,
  openCodeWireModel,
} from '../../../src/execution/host/adapters/opencode/index.ts'
import type { AcpSessionSnapshot } from '../../../src/execution/host/adapters/types.ts'
import {
  ExternalModelSources,
  type ExternalWireProtocol,
} from '../../../src/execution/host/model-sources.ts'
import {
  createOfmApiConnection,
  type OfmApiCaller,
} from '../../../src/execution/host/ofm-source/connection.ts'
import { OFM_PROVIDER } from '../../../src/execution/host/ofm-source/provider.ts'
import { officialOpenCodeModel } from '../../../src/execution/host/ofm-source/selection-policy.ts'
import { createOfmModelSource } from '../../../src/execution/host/ofm-source/source.ts'
import { readHarnessReasoning } from '../../../src/execution/host/reasoning-preflight.ts'

vi.mock(
  '../../../src/execution/host/adapters/opencode/opencode-shell.ts',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../src/execution/host/adapters/opencode/opencode-shell.ts')
    >()),
    openCodeShellBinding: async (env: NodeJS.ProcessEnv) => ({ config: {}, env }),
  }),
)

const MODELS = [
  'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3.5-super-vl-free',
  'opencode/flint-40b-free',
] as const
const OWNER_ORIGIN = 'http://127.0.0.1:32124'
const FORWARD_ORIGIN = 'http://127.0.0.1:32123'
const FIXTURE_KEY = 'fixture-only-eac-opencode'
const releases: (() => void)[] = []

afterEach(() => {
  for (const release of releases.splice(0)) release()
})

function fixture(model: string, protocol?: ExternalWireProtocol) {
  const bare = model.slice('opencode/'.length)
  const state = {
    catalog: [model, bare],
    clients: [model, bare],
    running: true,
    status: 200,
    identityProvider: OFM_PROVIDER,
    identityModel: model,
  }
  const metadata = vi.fn(async (_provider: string, _model: string) => ({
    provider: state.identityProvider,
    id: state.identityModel,
  }))
  const ctx = {
    effect: (effect: () => () => void) => effect(),
    llm: {
      listProviders: () => [{ id: OFM_PROVIDER }],
      listModels: async () => state.catalog.map((id) => ({ id })),
      resolveModelInfo: metadata,
    },
  } as unknown as Context
  const caller = vi.fn<OfmApiCaller>(async () => ({
    status: state.status,
    body: {
      running: state.running,
      baseUrl: FORWARD_ORIGIN,
      key: FIXTURE_KEY,
      models: state.clients,
    },
  }))
  const connection = vi.fn(createOfmApiConnection(caller, OWNER_ORIGIN))
  const sources = new ExternalModelSources(ctx)
  const release = sources.register(
    ctx,
    createOfmModelSource(ctx, {
      connection,
      ...(protocol === undefined ? {} : { protocols: { opencode: protocol } }),
    }),
  )
  releases.push(release)
  const resolve = vi.spyOn(sources, 'resolve')
  const options = {
    home: join(tmpdir(), 'opl-eac-opencode-home'),
    command: process.execPath,
    modelSources: sources,
    grokCommand: 'grok',
    nativeBridgePath: 'bridge.js',
  }
  return { ctx, state, sources, resolve, connection, caller, metadata, options, release }
}

function record(model: string): HarnessSession {
  return {
    id: 'eac-opencode',
    combination: `opencode/${model}`,
    harnessRef: 'opencode',
    modelRef: { provider: OFM_PROVIDER, model },
    cwd: process.cwd(),
    acpSessionId: '',
    origin: { kind: 'harness', sessionId: 'eac-opencode' },
    title: 'EAC OpenCode',
    sandbox: 'full-access',
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    turns: [],
  }
}

const modelOptions = (currentValue: string, offered: string[]) => [
  {
    id: 'model',
    type: 'select',
    currentValue,
    options: offered.map((value) => ({ value })),
  },
  { id: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build' }] },
]

const snapshot = (currentValue: string, offered: string[]): AcpSessionSnapshot => ({
  agent: { agentInfo: { version: '1.19.0' } },
  session: { sessionId: 'owned-eac' },
  configOptions: modelOptions(currentValue, offered),
})

describe.each(MODELS)('OFM EAC %s', (model) => {
  const bare = model.slice('opencode/'.length)
  const expected = `oplopencode/${model}`

  it('resolves the exact OFM connection and pins the complete EAC model id', async () => {
    const test = fixture(model)
    const session = record(model)
    expect(automaticHarness(session.modelRef)).toBe('opencode')
    expect(adapterFor('opencode', session.modelRef, test.sources)).toBe(openCodeAdapter)
    expect(openCodeAdapter.matches(session.modelRef)).toBe(true)
    expect(openCodeWireModel(session.modelRef)).toBe(model)
    expect(officialOpenCodeModel(session.modelRef)).toBeUndefined()
    const launch = await openCodeAdapter.prepare!(test.ctx, session, test.options)
    expect(test.resolve).toHaveBeenCalledWith('opencode', session.modelRef, 'chat')
    expect(test.connection).toHaveBeenCalledWith('opencode', session.modelRef, 'chat')
    expect(test.caller).toHaveBeenCalledExactlyOnceWith({
      url: `${OWNER_ORIGIN}/api/our-free-model/clients`,
      method: 'GET',
    })
    expect(test.metadata).toHaveBeenCalledWith(OFM_PROVIDER, model)
    await expect(test.resolve.mock.results[0]!.value).resolves.toEqual({
      baseURL: `${FORWARD_ORIGIN}/v1`,
      apiKey: FIXTURE_KEY,
      model,
      protocol: 'chat',
    })
    expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      permission: 'allow',
      provider: {
        oplopencode: {
          npm: '@ai-sdk/openai-compatible',
          name: 'OPL Route',
          options: { baseURL: `${FORWARD_ORIGIN}/v1`, apiKey: FIXTURE_KEY },
          models: { [model]: { name: model } },
        },
      },
    })
    expect(launch.env.OPL_CHAT_CLI).toBe('opencode')

    const request = vi.fn().mockResolvedValue({ configOptions: modelOptions(expected, [expected]) })
    const configured = await openCodeAdapter.configureSession!(
      { request },
      session,
      snapshot(model, [model, expected]),
    )
    expect(request).toHaveBeenCalledExactlyOnceWith('session/set_config_option', {
      sessionId: 'owned-eac',
      configId: 'model',
      value: expected,
    })
    expect(() =>
      openCodeAdapter.verifySession!(session, {
        ...snapshot(expected, [expected]),
        ...configured,
      }),
    ).not.toThrow()
    expect(readHarnessReasoning(session, configured!.configOptions)).toEqual([])
    expect(session.modelRef).toEqual({ provider: 'our-free-model', model })
  })

  it('keeps the bare free lane on the built-in provider without resolving an EAC connection', async () => {
    const test = fixture(model)
    const session = record(bare)
    expect(officialOpenCodeModel(session.modelRef)).toBe(model)
    const launch = await openCodeAdapter.prepare!(test.ctx, session, test.options)
    expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: 'allow' })
    expect(test.resolve).not.toHaveBeenCalled()
    expect(test.connection).not.toHaveBeenCalled()
    expect(test.caller).not.toHaveBeenCalled()
    expect(launch.env.OPL_CHAT_CLI).toBeUndefined()
  })

  it.each(['owner-refused', 'stopped', 'bare-only'] as const)(
    'refuses %s connection data instead of using the bare free lane',
    async (condition) => {
      const test = fixture(model)
      if (condition === 'owner-refused') test.state.status = 403
      if (condition === 'stopped') test.state.running = false
      if (condition === 'bare-only') test.state.clients = [bare]
      await expect(openCodeAdapter.prepare!(test.ctx, record(model), test.options)).rejects.toThrow(
        'Our Free Model 未提供可用的外部执行端点',
      )
      expect(test.caller).toHaveBeenCalledTimes(1)
      expect(test.metadata).not.toHaveBeenCalled()
    },
  )

  it('refuses a missing qualified catalog entry even when its bare twin is available', async () => {
    const test = fixture(model)
    test.state.catalog = [bare]
    await expect(openCodeAdapter.prepare!(test.ctx, record(model), test.options)).rejects.toThrow(
      `当前目录未提供模型「${model}」`,
    )
    expect(test.connection).not.toHaveBeenCalled()
  })

  it('refuses owner metadata that substitutes the bare model or a different provider', async () => {
    const test = fixture(model)
    for (const identity of [
      { provider: OFM_PROVIDER, id: bare },
      { provider: 'other-owner', id: model },
    ]) {
      test.state.identityProvider = identity.provider
      test.state.identityModel = identity.id
      await expect(openCodeAdapter.prepare!(test.ctx, record(model), test.options)).rejects.toThrow(
        '模型身份与请求不一致',
      )
    }
  })

  it('refuses a launch after its registered OFM owner is removed', async () => {
    const test = fixture(model)
    test.release()
    await expect(openCodeAdapter.prepare!(test.ctx, record(model), test.options)).rejects.toThrow(
      '该模型来源尚未适配此 Harness',
    )
    expect(test.connection).not.toHaveBeenCalled()
  })

  it.each(['responses', 'messages'] as const)(
    'refuses an owner route using %s',
    async (protocol) => {
      const test = fixture(model, protocol)
      await expect(openCodeAdapter.prepare!(test.ctx, record(model), test.options)).rejects.toThrow(
        '模型来源未提供兼容的执行参数',
      )
      expect(test.connection).toHaveBeenCalledWith('opencode', record(model).modelRef, protocol)
    },
  )

  it('refuses unadvertised and substituted ACP model selections', async () => {
    const session = record(model)
    const request = vi.fn()
    await expect(
      openCodeAdapter.configureSession!({ request }, session, snapshot(model, [model])),
    ).rejects.toThrow('未广告要求的模型')
    expect(request).not.toHaveBeenCalled()
    for (const other of [model, `oplopencode/${bare}`]) {
      const drifted = snapshot(other, [expected, other])
      request.mockResolvedValue({ configOptions: drifted.configOptions })
      await expect(
        openCodeAdapter.configureSession!({ request }, session, snapshot(expected, [expected])),
      ).rejects.toThrow('会话当前模型与要求的')
      expect(() => openCodeAdapter.verifySession!(session, drifted)).toThrow('会话当前模型与要求的')
    }
  })

  it('offers no reasoning tiers and refuses every carried effort before resolving a connection', async () => {
    const test = fixture(model)
    expect(openCodeAdapter.capabilities.reasoning).toBe('none')
    for (const reasoningEffort of ['light', 'balanced', 'deep', 'high', 'max'])
      await expect(
        openCodeAdapter.prepare!(test.ctx, { ...record(model), reasoningEffort }, test.options),
      ).rejects.toThrow('未广告推理档位配置项')
    expect(test.resolve).not.toHaveBeenCalled()
    expect(test.connection).not.toHaveBeenCalled()
  })
})
