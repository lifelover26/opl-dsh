import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { adapterFor, automaticHarness } from '../../src/execution/host/adapters/index.ts'
import { createOfmModelSource } from '../../src/execution/host/ofm-source/source.ts'
import { ofmHarnessPinsModel } from '../../src/execution/host/ofm-source/provider.ts'
import { ExternalModelSources } from '../../src/execution/host/model-sources.ts'
import { displayModelName } from '../../src/shared/models.ts'

const ref = (model: string) => ({ provider: 'our-free-model', model })
const lanes = [
  ['amd/DeepSeek-V4.1-Flash', 'dsh', 'DeepSeek V4.1 Flash'],
  ['amd/DeepSeek-V4-Flash', 'dsh', 'DeepSeek V4 Flash'],
  ['amd/MiMo-V2.6-Flash', 'mimo-code', 'MiMo V2.6 Flash'],
  ['amd/GLM-5.3-Flash', 'zcode', 'GLM 5.3 Flash'],
  ['amd/Qwen3.8-27B', 'pi', 'Qwen3.8 27B'],
  ['amd/MiniCPM-V-4.7-35B-A3B', 'pi', 'MiniCPM-V 4.7 35B-A3B'],
  ['amd/MiniCPM5-2B', 'pi', 'MiniCPM5 2B'],
  ['amd/Gemma-4-31B-IT', 'pi', 'Gemma 4 31B IT'],
  ['amd/MiniCPM-V-4.7-1B', 'pi', 'MiniCPM-V 4.7 1B'],
] as const

describe('EAC AMD route integration', () => {
  it.each(lanes)('recommends %s through %s with its AMD identity', (model, harness, name) => {
    expect(automaticHarness(ref(model))).toBe(harness)
    expect(adapterFor(harness, ref(model))?.matches(ref(model))).toBe(true)
    expect(displayModelName(ref(model))).toBe(`EAC ${name}（AMD）`)
    expect(automaticHarness({ provider: 'unrelated-owner', model })).toBeUndefined()
  })

  it.each(lanes.filter(([, harness]) => harness !== 'dsh'))(
    'resolves the exact %s model through its owner and refuses catalog withdrawal',
    async (model, harness) => {
      let listed = true
      const ctx = {
        effect: (effect: () => () => void) => effect(),
        llm: {
          listProviders: () => [{ id: 'our-free-model' }],
          listModels: async () => (listed ? [{ id: model }] : []),
          resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
        },
      } as unknown as Context
      const connection = vi.fn(async () => ({
        baseURL: 'https://owned-amd-relay.example.test/v1',
        apiKey: 'fixture-only',
        protocols: ['chat' as const],
      }))
      const sources = new ExternalModelSources(ctx)
      const dispose = sources.register(ctx, createOfmModelSource(ctx, { connection }))
      try {
        expect(ofmHarnessPinsModel(harness, model)).toBe(true)
        expect(await sources.resolve(harness, ref(model), 'chat')).toEqual({
          baseURL: 'https://owned-amd-relay.example.test/v1',
          apiKey: 'fixture-only',
          protocol: 'chat',
          model,
        })
        expect(connection).toHaveBeenCalledWith(harness, ref(model), 'chat')
        listed = false
        await expect(sources.resolve(harness, ref(model), 'chat')).rejects.toThrow('当前目录未提供')
      } finally {
        dispose()
      }
    },
  )

  it('keeps unknown AMD models manual', () => {
    expect(automaticHarness(ref('amd/future-model'))).toBeUndefined()
    for (const harness of ['pi', 'mimo-code', 'zcode'])
      expect(ofmHarnessPinsModel(harness, 'amd/future-model')).toBe(false)
  })
})
