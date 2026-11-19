/**
 * Behavioural evidence for the Our Free Model external-execution source.
 *
 * Every case drives the real `ExternalModelSources` registry, so assertions
 * cover the production path an adapter takes. Synchronisation is deterministic:
 * explicit deferred promises, never sleeps, so a late revocation is observed in
 * the state it was actually created in.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../../src/execution/host/model-sources.ts'
import { adapterFor } from '../../../src/execution/host/adapters/index.ts'
import {
  OFM_PROVIDER,
  OFM_PROVIDERS,
  OFM_REGION_PROVIDER,
  applyOfmModelSource,
  createOfmModelSource,
} from '../../../src/execution/host/ofm-source/index.ts'

interface CatalogState {
  providers: string[]
  models: Record<string, string[]>
  withdrawn?: Set<string>
}

function fakeLlm(state: CatalogState) {
  return {
    listProviders: () => state.providers.map((id) => ({ id, name: id })),
    listModels: async (provider: string) =>
      (state.models[provider] ?? []).map((id) => ({ provider, id, name: id })),
    // Upstream synthesizes metadata for unknown ids, so this answers anything.
    resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
  }
}

function harness(state: CatalogState, connection?: Parameters<typeof createOfmModelSource>[1]) {
  const ctx = {
    llm: fakeLlm(state),
    effect: (e: () => () => void) => e(),
  } as unknown as Context
  ctx.oplExternalModelSources = new ExternalModelSources(ctx)
  const owner = {
    effect: (e: () => () => void) => e(),
    oplExternalModelSources: ctx.oplExternalModelSources,
  } as unknown as Context
  const source = createOfmModelSource(ctx, connection)
  const remove = ctx.oplExternalModelSources.register(owner, source)
  return { ctx, sources: ctx.oplExternalModelSources, source, remove }
}

const loaded: CatalogState = {
  providers: [OFM_PROVIDER, OFM_REGION_PROVIDER],
  models: {
    [OFM_PROVIDER]: [
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k3.1-pro',
      'mimo-v2.6-flash-free',
      'poolside/laguna-s-2.1:free',
      'openai/gpt-oss-20b',
      'reflection/beam-free',
      'xingchen-agi/xing4.0-29b-a4b:free',
      'opencode/glm-5.3-flash-free',
      'opencode/deepseek-v4.1-flash-free',
    ],
    [OFM_REGION_PROVIDER]: ['muse-spark-1.2-contributor-free'],
  },
}

const ref = { provider: OFM_PROVIDER, model: 'moonshotai/kimi-k3' }
const facts = { baseURL: 'http://127.0.0.1:32123', apiKey: 'ofm-fixture-only' }

function gatedReader() {
  let release!: (value: typeof facts) => void
  const gate = new Promise<typeof facts>((done) => {
    release = done
  })
  return { release, reader: vi.fn(async () => gate) }
}

describe('OFM source pairing', () => {
  it('pairs the harnesses this run named, with each one declaring a protocol', () => {
    const { source } = harness(loaded)
    for (const [harness, model] of [
      ['kimi', 'moonshotai/kimi-k3'],
      ['kimi-code', 'moonshotai/kimi-k3.1-pro'],
      ['mimo', 'mimo-v2.6-flash-free'],
      ['pool', 'poolside/laguna-s-2.1:free'],
      ['codex', 'openai/gpt-oss-20b'],
      ['kilo', 'reflection/beam-free'],
      ['kilo', 'xingchen-agi/xing4.0-29b-a4b:free'],
    ] as const)
      expect(source.supports(harness, { provider: OFM_PROVIDER, model })).toBe(true)
    // An alias for a CLI id reaches the same pinning decision.
    expect(
      source.supports('mimo-code', { provider: OFM_PROVIDER, model: 'mimo-v2.6-flash-free' }),
    ).toBe(true)
  })

  it('refuses the explicitly excluded non-conversational models even when the live catalog lists them', async () => {
    const withExcluded: CatalogState = {
      ...loaded,
      models: {
        [OFM_PROVIDER]: [
          ...loaded.models[OFM_PROVIDER],
          'jev-1.13-free',
          'nvidia/nemotron-3.5-content-safety:free',
        ],
      },
    }
    const { source } = harness(withExcluded, { connection: async () => facts })
    for (const model of ['jev-1.13-free', 'nvidia/nemotron-3.5-content-safety:free'])
      expect(source.supports('codex', { provider: OFM_PROVIDER, model })).toBe(false)
    await expect(
      source.resolve('codex', { provider: OFM_PROVIDER, model: 'jev-1.13-free' }),
    ).rejects.toThrow('未纳入本次适配范围')
  })

  it('assigns GPT-OSS 20B to Codex and keeps other pinned harnesses out', async () => {
    const state: CatalogState = {
      ...loaded,
      models: {
        ...loaded.models,
        [OFM_PROVIDER]: [...loaded.models[OFM_PROVIDER], 'openai/gpt-oss-20b'],
      },
    }
    const { source } = harness(state, { connection: async () => facts })
    const ref = { provider: OFM_PROVIDER, model: 'openai/gpt-oss-20b' }
    expect(source.supports('codex', ref)).toBe(true)
    expect(source.supports('kimi', ref)).toBe(false)
    await expect(source.resolve('codex', ref, 'responses')).resolves.toMatchObject({
      model: ref.model,
      protocol: 'responses',
    })
  })

  it('refuses a model this run did not assign to that harness', () => {
    const { source } = harness(loaded)
    expect(source.supports('mimo', { provider: OFM_PROVIDER, model: 'moonshotai/kimi-k3' })).toBe(
      false,
    )
    expect(source.supports('pool', { provider: OFM_PROVIDER, model: 'mimo-v2.6-flash-free' })).toBe(
      false,
    )
  })

  it('refuses a provider route the plugin has not registered', () => {
    const { source } = harness({ providers: [OFM_REGION_PROVIDER], models: {} })
    expect(source.supports('kimi', ref)).toBe(false)
  })

  it('refuses a model absent from a registered route catalog', () => {
    const { source } = harness({ providers: [OFM_REGION_PROVIDER], models: {} })
    expect(source.supports('claude', { provider: OFM_REGION_PROVIDER, model: 'kimi-k3' })).toBe(
      false,
    )
  })

  it('refuses a harness with no declared protocol', () => {
    const { source } = harness(loaded)
    for (const harness of ['dsh', 'grok', 'zcode', 'minimax-code', 'unknown-cli'])
      expect(source.supports(harness, ref)).toBe(false)
  })

  it('accepts a protocol declared for a harness added after the table was written', () => {
    const { source } = harness(loaded, { protocols: { 'future-cli': 'chat' } })
    expect(source.supports('future-cli', ref)).toBe(true)
    const { sources } = harness(loaded, { protocols: { 'future-cli': 'chat' } })
    void sources
  })

  it('registers every provider route the source claims', () => {
    const ctx = {
      llm: fakeLlm(loaded),
      effect: (e: () => () => void) => e(),
    } as unknown as Context
    const sources = new ExternalModelSources(ctx)
    ctx.oplExternalModelSources = sources
    expect(adapterFor('kimi', ref, sources)).toBeUndefined()
    applyOfmModelSource(ctx, { providers: OFM_PROVIDERS, connection: async () => facts })
    expect(sources.supports('claude', { provider: OFM_REGION_PROVIDER, model: 'kimi-k3' })).toBe(
      false,
    )
    // Adapter selection needs an adapter registered for the harness id. `kimi`'s
    // adapter is owned by its own task and is not mounted yet, so the pairing is
    // proven through the registry that mounts it; `codex` is mounted today.
    expect(sources.supports('kimi', ref)).toBe(true)
    const codexRef = { provider: OFM_PROVIDER, model: 'openai/gpt-oss-20b' }
    expect(adapterFor('codex', codexRef, sources)?.id).toBe('codex')
  })

  it('does not advertise Claude Code for OFM models based on Messages protocol support', async () => {
    const connection = vi.fn(async () => facts)
    const ctx = {
      llm: fakeLlm(loaded),
      effect: (e: () => () => void) => e(),
    } as unknown as Context
    const sources = new ExternalModelSources(ctx)
    ctx.oplExternalModelSources = sources
    applyOfmModelSource(ctx, { providers: OFM_PROVIDERS, connection })
    for (const provider of OFM_PROVIDERS) {
      for (const model of ['moonshotai/kimi-k3', 'mimo-v2.6-flash-free', 'openai/gpt-oss-20b']) {
        const ref = { provider, model }
        expect(adapterFor('claude', ref, sources)).toBeUndefined()
        await expect(sources.resolve('claude', ref, 'messages')).rejects.toThrow(
          '尚未适配此 Harness',
        )
      }
    }
    expect(connection).not.toHaveBeenCalled()
    for (const channel of ['aws', 'kiro'])
      expect(
        adapterFor(
          'claude',
          { provider: 'opl-gateway', model: `${channel}::claude-opus-5-5` },
          sources,
        )?.id,
      ).toBe('claude')
  })

  it('withdraws every pair when the owner unloads', () => {
    const { sources, remove } = harness(loaded)
    expect(sources.supports('kimi', ref)).toBe(true)
    remove()
    expect(sources.supports('kimi', ref)).toBe(false)
  })
})

describe('OFM source resolution', () => {
  it.each(['opencode/glm-5.3-flash-free', 'opencode/deepseek-v4.1-flash-free'])(
    'resolves EAC %s through the owner endpoint without removing its prefix',
    async (model) => {
      const { sources } = harness(loaded, { connection: async () => facts })
      const ref = { provider: OFM_PROVIDER, model }
      expect(adapterFor('opencode', ref, sources)?.id).toBe('opencode')
      await expect(sources.resolve('opencode', ref, 'chat')).resolves.toEqual({
        ...facts,
        model: ref.model,
        protocol: 'chat',
      })
    },
  )

  it('resolves the exact live model with the harness protocol', async () => {
    const { sources } = harness(loaded, { connection: async () => facts })
    await expect(sources.resolve('kimi', ref, 'messages')).resolves.toEqual({
      ...facts,
      model: ref.model,
      protocol: 'messages',
    })
  })

  it('treats resolveModelInfo answering an unknown id as not-catalogued', async () => {
    // The fake registry synthesizes metadata for anything, so only the live
    // catalog can refuse this model.
    const { source } = harness(loaded, {
      connection: async () => facts,
      protocols: { 'future-cli': 'chat' },
    })
    await expect(
      source.resolve('future-cli', { provider: OFM_PROVIDER, model: 'not/in-any-catalog' }),
    ).rejects.toThrow('当前目录未提供模型')
  })

  it('rejects a model withdrawn while the connection read waits', async () => {
    const state: CatalogState = { ...loaded, models: { ...loaded.models } }
    const reader = gatedReader()
    const { sources } = harness(state, { connection: reader.reader })
    const pending = sources.resolve('kimi', ref, 'messages')
    // The plugin drops the model from its catalog while the read is unresolved.
    state.models[OFM_PROVIDER] = state.models[OFM_PROVIDER].filter((m) => m !== ref.model)
    reader.release(facts)
    await expect(pending).rejects.toThrow('已移除模型')
  })

  it('rejects a provider route unregistered while the connection read waits', async () => {
    const state: CatalogState = { ...loaded, models: { ...loaded.models } }
    const reader = gatedReader()
    const { sources } = harness(state, { connection: reader.reader })
    const pending = sources.resolve('kimi', ref, 'messages')
    state.providers = [OFM_REGION_PROVIDER]
    reader.release(facts)
    await expect(pending).rejects.toThrow('已卸载该渠道')
  })

  it('pairs an owner-gated model but refuses to launch it before the lane opens', async () => {
    // The owner holds this model behind its own channel gate, so it is absent from
    // a cold catalog. Pairing is unaffected; resolution fails closed instead of
    // launching a model the owner is not currently serving.
    const gated: CatalogState = {
      ...loaded,
      models: {
        ...loaded.models,
        [OFM_PROVIDER]: loaded.models[OFM_PROVIDER].filter((m) => m !== ref.model),
      },
    }
    const { source, sources } = harness(gated, { connection: async () => facts })
    expect(source.supports('kimi', ref)).toBe(true)
    await expect(source.resolve('kimi', ref)).rejects.toThrow('当前目录未提供模型')
    await expect(sources.resolve('kimi', ref, 'messages')).rejects.toThrow('当前目录未提供模型')
  })

  it('refuses a runtime whose live catalog is unavailable, not falling back to metadata', async () => {
    // Upstream answers `resolveModelInfo` for ids outside its catalog, so a runtime
    // without `listModels` cannot prove the model exists and must fail closed.
    const reader = vi.fn(async () => facts)
    const { source } = harness(loaded, { connection: reader })
    expect(source.supports('kimi', ref)).toBe(true)
    const degraded = {
      llm: {
        listProviders: () => loaded.providers.map((id) => ({ id, name: id })),
        resolveModelInfo: async () => ({ provider: OFM_PROVIDER, id: ref.model }),
      },
    } as unknown as Context
    const failing = createOfmModelSource(degraded, { connection: reader })
    await expect(failing.resolve('kimi', ref)).rejects.toThrow('当前目录未提供模型')
    // Never reaches the connection read, so no key is requested or held.
    expect(reader).not.toHaveBeenCalled()
  })

  it('rejects a model withdrawn during the final metadata await', async () => {
    const state: CatalogState = {
      ...loaded,
      models: { ...loaded.models, [OFM_PROVIDER]: [...loaded.models[OFM_PROVIDER]] },
    }
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((done) => {
      entered = done
    })
    const blocked = new Promise<void>((done) => {
      release = done
    })
    const ctx = { llm: fakeLlm(state), effect: (e: () => () => void) => e() } as unknown as Context
    const realInfo = ctx.llm.resolveModelInfo
    ctx.llm.resolveModelInfo = async (provider: string, id: string) => {
      entered()
      await blocked
      return realInfo(provider, id)
    }
    const source = createOfmModelSource(ctx, { connection: async () => facts })
    const pending = source.resolve('kimi', ref)
    await started
    // The catalog drops the model while the metadata read is still suspended.
    state.models[OFM_PROVIDER] = state.models[OFM_PROVIDER].filter((m) => m !== ref.model)
    release()
    await expect(pending).rejects.toThrow('已移除模型')
  })

  it('rejects when the provider route is unregistered during the final metadata await', async () => {
    const state: CatalogState = { ...loaded, providers: [...loaded.providers] }
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((done) => {
      entered = done
    })
    const blocked = new Promise<void>((done) => {
      release = done
    })
    const ctx = { llm: fakeLlm(state), effect: (e: () => () => void) => e() } as unknown as Context
    const realInfo = ctx.llm.resolveModelInfo
    ctx.llm.resolveModelInfo = async (provider: string, id: string) => {
      entered()
      await blocked
      return realInfo(provider, id)
    }
    const source = createOfmModelSource(ctx, { connection: async () => facts })
    const pending = source.resolve('kimi', ref)
    await started
    state.providers = []
    release()
    await expect(pending).rejects.toThrow('已卸载该渠道')
  })

  it('refuses rather than guessing an endpoint when no owner connection is wired', async () => {
    const { sources } = harness(loaded)
    await expect(sources.resolve('kimi', ref, 'messages')).rejects.toThrow(
      '尚未通过公开接口提供外部执行端点',
    )
  })

  it('propagates an owner refusal with no fallback to another channel or model', async () => {
    const reader = vi.fn(async () => undefined)
    const { sources } = harness(loaded, { connection: reader })
    await expect(sources.resolve('kimi', ref, 'messages')).rejects.toThrow(
      '未提供可用的外部执行端点',
    )
    expect(reader).toHaveBeenCalledTimes(1)
    expect(reader).toHaveBeenCalledWith('kimi', ref, 'messages')
  })

  it('refuses an endpoint that does not serve the harness protocol', async () => {
    const { source } = harness(loaded, {
      connection: async () => ({ ...facts, protocols: ['chat'] as const }),
    })
    await expect(source.resolve('kimi', ref)).rejects.toThrow('不支持该 Harness 的协议')
  })

  it('rejects owner connection facts that do not describe a launchable endpoint', async () => {
    for (const invalid of [
      { ...facts, baseURL: 'file:///etc/passwd' },
      { ...facts, baseURL: 'http://user:secret@127.0.0.1:1' },
      { ...facts, apiKey: '' },
    ]) {
      const { sources } = harness(loaded, { connection: async () => invalid })
      await expect(sources.resolve('kimi', ref, 'messages')).rejects.toThrow('执行参数')
    }
  })

  it('never leaks the issued key into a rejection', async () => {
    const { source } = harness(loaded, {
      connection: async () => ({ ...facts, protocols: ['chat'] as const }),
    })
    const error = await source.resolve('kimi', ref).catch((e: Error) => e)
    expect(String(error)).not.toContain(facts.apiKey)
  })
})
