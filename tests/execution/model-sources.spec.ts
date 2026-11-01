import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalModelSources } from '../../src/execution/host/model-sources.ts'
import { adapterFor, harnessAdapters } from '../../src/execution/host/adapters/index.ts'
const ref = { provider: 'future-source', model: 'exact-model' }
const route = {
  baseURL: 'https://example.test/v1',
  model: 'upstream-model',
  apiKey: 'synthetic',
  protocol: 'responses' as const,
}
const owner = { effect: (effect: () => () => void) => effect() } as unknown as Context
const ctx = {
  credentials: { resolve: vi.fn(async () => ({ value: 'synthetic-gateway' })) },
  get: () => undefined,
} as unknown as Context

describe('external model-source ownership', () => {
  it('requires explicit registration, exact model support and effect cleanup', async () => {
    const sources = new ExternalModelSources(ctx)
    expect(adapterFor('codex', ref, sources)).toBeUndefined()
    const resolve = vi.fn(async () => route)
    const remove = sources.register(owner, {
      provider: ref.provider,
      supports: (harness, model) => harness === 'codex' && model.model === ref.model,
      resolve,
    })
    expect(adapterFor('codex', ref, sources)?.id).toBe('codex')
    expect(adapterFor('claude', ref, sources)).toBeUndefined()
    expect(adapterFor('codex', { ...ref, model: 'other' }, sources)).toBeUndefined()
    expect(await sources.resolve('codex', ref, 'responses')).toEqual(route)
    expect(resolve).toHaveBeenCalledWith('codex', ref)
    remove()
    await expect(sources.resolve('codex', ref, 'responses')).rejects.toThrow('尚未适配')
  })
  it('does not treat arbitrary OFM names or virtual routes as official account access', () => {
    const sources = new ExternalModelSources(ctx)
    for (const model of ['gpt-6', 'MiniMax-M3.1-Flash', 'combo:free'])
      expect(adapterFor('codex', { provider: 'our-free-model', model }, sources)).toBeUndefined()
  })
  it('rejects conflicting source ownership and reserved Gateway registration', () => {
    const sources = new ExternalModelSources(ctx)
    const entry = { provider: ref.provider, supports: () => true, resolve: async () => route }
    sources.register(owner, entry)
    expect(() => sources.register(owner, entry)).toThrow('已注册')
    expect(() => sources.register(owner, { ...entry, provider: 'opl-gateway' })).toThrow('已注册')
  })
  it('rejects a route returned after its owner has unloaded', async () => {
    const sources = new ExternalModelSources(ctx)
    let release!: (value: typeof route) => void
    const pending = new Promise<typeof route>((done) => {
      release = done
    })
    const remove = sources.register(owner, {
      provider: ref.provider,
      supports: () => true,
      resolve: () => pending,
    })
    const read = sources.resolve('codex', ref, 'responses')
    remove()
    release(route)
    await expect(read).rejects.toThrow('已变更')
  })
  it.each([
    { ...route, protocol: 'messages' as const },
    { ...route, baseURL: 'file:///private' },
    { ...route, baseURL: 'https://user:password@example.test' },
    { ...route, apiKey: '' },
  ])('refuses incompatible source wire parameters before launch', async (invalid) => {
    const sources = new ExternalModelSources(ctx)
    sources.register(owner, {
      provider: ref.provider,
      supports: () => true,
      resolve: async () => invalid,
    })
    await expect(sources.resolve('codex', ref, 'responses')).rejects.toThrow('执行参数')
  })
  it('uses the configured Gateway protocol rather than inferring it from a GPT name', async () => {
    const changed = {
      ...ctx,
      get: () => ({
        describe: () => [
          {
            ns: 'llm-pi-ai',
            value: {
              providers: { 'opl-gateway-openai': { api: 'openai-completions' } },
            },
          },
        ],
      }),
    } as unknown as Context
    await expect(
      new ExternalModelSources(changed).resolve(
        'codex',
        {
          provider: 'opl-gateway',
          model: 'codex::gpt-6',
        },
        'responses',
      ),
    ).rejects.toThrow('协议')
  })
  it('advertises only adapters present in the execution registry', () => {
    expect(
      harnessAdapters.find((adapter) => adapter.id === 'minimax-code')?.capabilities,
    ).toMatchObject({
      authentication: 'official-account',
      customEndpoint: false,
      permissions: ['full-access'],
    })
    expect(harnessAdapters.find((adapter) => adapter.id === 'codex')?.capabilities).toMatchObject({
      transport: 'app-server',
      protocols: ['responses'],
      sessionLoad: true,
      cancel: true,
    })
  })
})
