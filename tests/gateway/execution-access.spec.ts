import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveGatewayExecution } from '../../src/gateway/host/execution-access.ts'

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
