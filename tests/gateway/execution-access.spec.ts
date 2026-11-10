import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  resolveGatewayExecution,
  resolveGatewayGeminiExecution,
} from '../../src/gateway/host/execution-access.ts'

function fixture(models: unknown[] = [{ id: 'custom' }]) {
  const profile = {
    api: 'anthropic-messages',
    baseURL: 'https://tenant.invalid',
    apiKeyEnv: 'CUSTOM_REF',
    models,
  }
  const resolve = vi.fn(async (ref: string) =>
    ref === 'CUSTOM_REF' ? { value: 'fixture-key' } : undefined,
  )
  const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text', 'image'] }))
  const llm = { listProviders: () => [{ id: 'opl-gateway-aws' }], resolveModelInfo }
  const settings = {
    describe: () => [
      { ns: 'opl-suite', value: {} },
      { ns: 'llm-pi-ai', value: { providers: { 'opl-gateway-aws': profile } } },
    ],
  }
  const ctx = {
    get: (name: string) => (name === 'settings' ? settings : name === 'llm' ? llm : undefined),
    credentials: { resolve },
  } as unknown as Context
  return { ctx, profile, resolve, resolveModelInfo, llm }
}

describe('Gateway route metadata for external engines', () => {
  it('uses the Gemini group credential and its declared native endpoint independently of Chat', async () => {
    const resolve = vi.fn(async () => ({ value: 'native-fixture-key' }))
    const ctx = { get: () => undefined, credentials: { resolve } } as unknown as Context
    const ref = { provider: 'opl-gateway', model: 'gemini::gemini-4-argon' }
    expect(await resolveGatewayGeminiExecution(ctx, ref)).toMatchObject({
      baseURL: 'https://gateway.medopl.com',
      api: 'gemini-native',
      model: 'gemini-4-argon',
      credential: 'OPL_GATEWAY_GEMINI_API_KEY',
      apiKey: 'native-fixture-key',
    })
    expect(resolve).toHaveBeenCalledExactlyOnceWith('OPL_GATEWAY_GEMINI_API_KEY')
    expect((await resolveGatewayExecution(ctx, ref)).api).toBe('openai-completions')
  })

  it('refuses unknown native routes and custom Chat addresses without rewriting them', async () => {
    const f = fixture()
    await expect(
      resolveGatewayGeminiExecution(f.ctx, {
        provider: 'opl-gateway',
        model: 'gemini::gemini-3.1-pro',
      }),
    ).rejects.toThrow('尚未适配')
    const ctx = {
      get: (name: string) =>
        name === 'settings'
          ? {
              describe: () => [
                {
                  ns: 'llm-pi-ai',
                  value: {
                    providers: {
                      'opl-gateway-gemini': {
                        api: 'openai-completions',
                        baseURL: 'https://custom.invalid/v1',
                      },
                    },
                  },
                },
              ],
            }
          : undefined,
      credentials: { resolve: vi.fn(async () => ({ value: 'synthetic' })) },
    } as unknown as Context
    await expect(
      resolveGatewayGeminiExecution(ctx, {
        provider: 'opl-gateway',
        model: 'gemini::gemini-4-argon',
      }),
    ).rejects.toThrow('自定义 Gemini 地址')
  })

  it('passes only the exact source model capacity to external accounting', async () => {
    const f = fixture([{ id: 'custom', input: ['text'], contextWindow: 1_000_000 }])
    expect(
      await resolveGatewayExecution(f.ctx, { provider: 'opl-gateway', model: 'aws::custom' }),
    ).toMatchObject({ contextWindow: 1_000_000 })
    f.profile.models = [{ id: 'custom', input: ['text'], contextWindow: -1 }]
    expect(
      (await resolveGatewayExecution(f.ctx, { provider: 'opl-gateway', model: 'aws::custom' }))
        .contextWindow,
    ).toBeUndefined()
  })

  it('uses the configured endpoint and credential and preserves an explicit text-only choice', async () => {
    const f = fixture([{ id: 'custom', input: ['text'] }])
    Object.assign(f.profile, { defaultInput: ['text', 'image'] })
    expect(
      await resolveGatewayExecution(f.ctx, { provider: 'opl-gateway', model: 'aws::custom' }),
    ).toEqual({
      baseURL: 'https://tenant.invalid',
      model: 'custom',
      apiKey: 'fixture-key',
      credential: 'CUSTOM_REF',
      api: 'anthropic-messages',
      imageInput: false,
    })
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith('CUSTOM_REF')
    expect(f.resolveModelInfo).not.toHaveBeenCalled()
  })

  it('propagates an explicit model image declaration or exact registered model capability', async () => {
    const explicit = fixture([{ id: 'custom', input: ['text', 'image'] }])
    expect(
      (
        await resolveGatewayExecution(explicit.ctx, {
          provider: 'opl-gateway',
          model: 'aws::custom',
        })
      ).imageInput,
    ).toBe(true)
    expect(explicit.resolveModelInfo).not.toHaveBeenCalled()
    const inherited = fixture()
    expect(
      (
        await resolveGatewayExecution(inherited.ctx, {
          provider: 'opl-gateway',
          model: 'aws::custom',
        })
      ).imageInput,
    ).toBe(true)
    expect(inherited.resolveModelInfo).toHaveBeenCalledExactlyOnceWith('opl-gateway-aws', 'custom')
  })

  it('resolves an empty model input through the registered adapter', async () => {
    const f = fixture([{ id: 'custom', input: [] }])
    expect(
      (await resolveGatewayExecution(f.ctx, { provider: 'opl-gateway', model: 'aws::custom' }))
        .imageInput,
    ).toBe(true)
    expect(f.resolveModelInfo).toHaveBeenCalledExactlyOnceWith('opl-gateway-aws', 'custom')
  })

  it('refuses execution when undeclared input metadata cannot be resolved', async () => {
    const f = fixture([{ id: 'custom', input: [] }])
    const failure = Error('Model metadata unavailable')
    f.resolveModelInfo.mockRejectedValue(failure)
    await expect(
      resolveGatewayExecution(f.ctx, { provider: 'opl-gateway', model: 'aws::custom' }),
    ).rejects.toBe(failure)
    expect(f.resolveModelInfo).toHaveBeenCalledExactlyOnceWith('opl-gateway-aws', 'custom')
  })

  it.each([undefined, []])(
    'does not infer vision for an unregistered custom model with undeclared inputs: %j',
    async (input) => {
      const f = fixture([{ id: 'custom', ...(input === undefined ? {} : { input }) }])
      f.llm.listProviders = () => []
      expect(
        (await resolveGatewayExecution(f.ctx, { provider: 'opl-gateway', model: 'aws::custom' }))
          .imageInput,
      ).toBe(false)
      expect(f.resolveModelInfo).not.toHaveBeenCalled()
    },
  )
})
