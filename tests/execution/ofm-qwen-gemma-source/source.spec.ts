/** Source admission tests use public-response fixtures, without a network/model claim. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ExternalModelSources,
  type ExternalWireProtocol,
} from '../../../src/execution/host/model-sources.ts'
import {
  OFM_CLIENTS_ROUTE,
  OFM_SUMMARY_ROUTE,
  OFM_PROVIDER,
  OFM_REGION_PROVIDER,
  applyOfmModelSource,
  createOfmApiConnection,
  createOfmModelSource,
  type OfmApiCaller,
} from '../../../src/execution/host/ofm-source/index.ts'

const origin = 'http://127.0.0.1:32123'
const ownerBase = 'http://127.0.0.1:7777'
const pairs = [
  {
    harness: 'qwen-code',
    model: 'amd/Qwen3.8-27B',
    protocol: 'chat' as const,
    baseURL: origin + '/v1',
  },
]

interface PublicSummaryFixture {
  settings: { enabled: boolean; forward: { enabled: boolean; running: boolean } }
  catalog: { id: string; route?: string | null }[]
  membership?: Record<string, string[]>
}

function fixture(pair: (typeof pairs)[number]) {
  const ref = { provider: OFM_PROVIDER, model: pair.model }
  const state = {
    providers: [OFM_PROVIDER, OFM_REGION_PROVIDER],
    models: [pair.model],
    clients: {
      running: true,
      baseUrl: origin,
      key: 'fixture-only-forward-key',
      models: [pair.model],
    },
    summary: {
      settings: { enabled: true, forward: { enabled: true, running: true } },
      catalog: [{ id: pair.model, route: OFM_PROVIDER }],
    } as PublicSummaryFixture,
  }
  const caller = vi.fn<OfmApiCaller>(async ({ url }) => {
    if (url === ownerBase + OFM_CLIENTS_ROUTE) return { status: 200, body: state.clients }
    if (url === ownerBase + OFM_SUMMARY_ROUTE) return { status: 200, body: state.summary }
    throw Error('Unexpected owner route')
  })
  const ctx = {
    effect: (effect: () => () => void) => effect(),
    llm: {
      listProviders: () => state.providers.map((id) => ({ id })),
      listModels: vi.fn(async () => state.models.map((id) => ({ id }))),
      resolveModelInfo: vi.fn(async (provider: string, id: string) => ({ provider, id })),
    },
  } as unknown as Context
  ctx.oplExternalModelSources = new ExternalModelSources(ctx)
  const connection = createOfmApiConnection(caller, ownerBase)
  const unregister = applyOfmModelSource(ctx, { connection })
  const resolve = () => ctx.oplExternalModelSources.resolve(pair.harness, ref, pair.protocol)
  return { ctx, state, ref, caller, connection, resolve, unregister }
}

describe.each(pairs)('$harness exact OFM source', (pair) => {
  it('uses the owner listener with the pinned model and protocol', async () => {
    const f = fixture(pair)
    await expect(f.resolve()).resolves.toEqual({
      baseURL: pair.baseURL,
      apiKey: f.state.clients.key,
      model: pair.model,
      protocol: pair.protocol,
    })
    expect(f.caller.mock.calls.map(([request]) => request.url)).toEqual([
      ownerBase + OFM_CLIENTS_ROUTE,
      ownerBase + OFM_SUMMARY_ROUTE,
    ])
  })

  it('accepts optional membership only when it agrees with the public catalog route', async () => {
    const f = fixture(pair)
    f.state.summary.membership = { [OFM_PROVIDER]: [pair.model] }
    await expect(f.resolve()).resolves.toMatchObject({ model: pair.model, protocol: pair.protocol })
    f.state.summary.catalog[0]!.route = OFM_REGION_PROVIDER
    await expect(f.resolve()).rejects.toThrow(/未提供可用/)
  })

  it('refuses other providers and other model ids before requesting credentials', async () => {
    const f = fixture(pair)
    for (const provider of ['alibaba', 'google', OFM_REGION_PROVIDER]) {
      expect(f.ctx.oplExternalModelSources.supports(pair.harness, { ...f.ref, provider })).toBe(
        false,
      )
      await expect(
        f.ctx.oplExternalModelSources.resolve(pair.harness, { ...f.ref, provider }, pair.protocol),
      ).rejects.toThrow()
    }
    for (const model of ['other-model', 'amd/Gemma-4-31B-IT']) {
      expect(f.ctx.oplExternalModelSources.supports(pair.harness, { ...f.ref, model })).toBe(false)
      await expect(
        f.connection(pair.harness, { ...f.ref, model }, pair.protocol),
      ).resolves.toBeUndefined()
    }
    expect(f.caller).not.toHaveBeenCalled()
  })

  it.each([
    'missing-catalog',
    'missing-model',
    'disabled-service',
    'disabled-model',
    'disabled-forward',
    'stopped-forward',
    'region-only',
    'missing-route',
    'other-route',
    'contradictory-membership',
    'empty-membership',
    'missing-client-model',
    'stopped-client',
  ])('refuses %s from the live owner', async (kind) => {
    const f = fixture(pair)
    if (kind === 'missing-catalog') Object.assign(f.state.summary, { catalog: undefined })
    if (kind === 'missing-model') f.state.summary.catalog = []
    if (kind === 'disabled-service') f.state.summary.settings.enabled = false
    if (kind === 'disabled-model') f.state.summary.catalog[0]!.route = null
    if (kind === 'disabled-forward') f.state.summary.settings.forward.enabled = false
    if (kind === 'stopped-forward') f.state.summary.settings.forward.running = false
    if (kind === 'region-only') f.state.summary.catalog[0]!.route = OFM_REGION_PROVIDER
    if (kind === 'missing-route') delete f.state.summary.catalog[0]!.route
    if (kind === 'other-route') f.state.summary.catalog[0]!.route = 'other-provider'
    if (kind === 'contradictory-membership')
      f.state.summary.membership = { [OFM_PROVIDER]: [], [OFM_REGION_PROVIDER]: [pair.model] }
    if (kind === 'empty-membership') f.state.summary.membership = {}
    if (kind === 'missing-client-model') f.state.clients.models = []
    if (kind === 'stopped-client') f.state.clients.running = false
    await expect(f.resolve()).rejects.toThrow(/未提供可用/)
  })

  it('refuses catalog withdrawal or provider unload during connection resolution', async () => {
    for (const revoke of ['catalog', 'provider']) {
      const f = fixture(pair)
      const original = f.caller.getMockImplementation()!
      f.caller.mockImplementation(async (request) => {
        if (request.url === ownerBase + OFM_SUMMARY_ROUTE) {
          if (revoke === 'catalog') f.state.models = []
          else f.state.providers = []
        }
        return original(request)
      })
      await expect(f.resolve()).rejects.toThrow()
    }
  })

  it('rejects replacing the source while its owner read is pending', async () => {
    const f = fixture(pair)
    const original = f.caller.getMockImplementation()!
    let replace = true
    f.caller.mockImplementation(async (request) => {
      if (replace) {
        replace = false
        f.unregister()
        f.ctx.oplExternalModelSources.register(
          f.ctx,
          createOfmModelSource(f.ctx, { connection: f.connection }),
        )
      }
      return original(request)
    })
    await expect(f.resolve()).rejects.toThrow(/模型来源已变更/)
  })

  it('does not derive an origin from custom Chat endpoints or recipes', async () => {
    const f = fixture(pair)
    for (const invalid of [
      'https://custom.example/v1',
      origin + '/v1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:70000',
    ]) {
      f.state.clients.baseUrl = invalid
      await expect(f.resolve()).rejects.toThrow(/未提供可用/)
    }
  })

  it('refuses mismatched protocols and never logs the key', async () => {
    const f = fixture(pair)
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const wrong: ExternalWireProtocol = pair.protocol === 'chat' ? 'gemini-native' : 'chat'
      expect(await f.connection(pair.harness, f.ref, wrong)).toBeUndefined()
      await f.resolve()
      expect(JSON.stringify([logs.mock.calls, warnings.mock.calls])).not.toContain(
        f.state.clients.key,
      )
    } finally {
      logs.mockRestore()
      warnings.mockRestore()
    }
  })
})

it('sanitizes Qwen owner API transport failures without revealing credentials', async () => {
  const f = fixture(pairs[0]!)
  f.caller.mockRejectedValue(new Error(f.state.clients.key))
  await expect(f.resolve()).rejects.toThrow('Our Free Model 未提供可用的外部执行端点')
})

it('requires the requested protocol even if an injected source declares another', async () => {
  const f = fixture(pairs[0]!)
  f.unregister()
  applyOfmModelSource(f.ctx, { connection: f.connection, protocols: { 'qwen-code': 'responses' } })
  await expect(f.resolve()).rejects.toThrow('未提供可用')
  expect(f.caller).not.toHaveBeenCalled()
})
