/** EAC AMD Pi routes preserve source identity and retain upstream thinking defaults. */
import { describe, expect, it, vi } from 'vitest'
import {
  PI_AMD_MODELS,
  PI_CODE_MODELS,
  PI_HARNESS,
  PI_MODEL_AMD_GEMMA4_31B_IT,
  PI_MODEL_AMD_MINICPM5_2B,
  PI_MODEL_AMD_MINICPM_V_1B,
  PI_MODEL_AMD_MINICPM_V_35B_A3B,
  PI_MODEL_AMD_QWEN3_8_27B,
  PI_MODEL_GEMMA,
  PI_PROVIDER,
  isPiCodeModel,
  piApiForProtocol,
  piCodeModels,
  piLane,
  piLaneProtocol,
  piLaneReasoning,
  piThinkingValue,
} from '../../../src/execution/host/adapters/pi/pi-models.ts'
import { buildPiModelsConfig } from '../../../src/execution/host/adapters/pi/pi-config.ts'
import { createPiAdapter } from '../../../src/execution/host/adapters/pi/pi.ts'
import {
  createPiSource,
  type PiSourceAnswer,
} from '../../../src/execution/host/adapters/pi/pi-source.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'

const ref = (model: string, provider: string = PI_PROVIDER): ModelRef => ({ provider, model })

/** The five AMD ids, with the provider key this adapter gives each one. */
const AMD_LANES = [
  { model: PI_MODEL_AMD_QWEN3_8_27B, provider: 'opl-pi-amd-qwen3-8-27b-lane' },
  { model: PI_MODEL_AMD_MINICPM_V_35B_A3B, provider: 'opl-pi-amd-minicpm-v-4-7-35b-a3b-lane' },
  { model: PI_MODEL_AMD_MINICPM5_2B, provider: 'opl-pi-amd-minicpm5-2b-lane' },
  { model: PI_MODEL_AMD_GEMMA4_31B_IT, provider: 'opl-pi-amd-gemma-4-31b-lane' },
  { model: PI_MODEL_AMD_MINICPM_V_1B, provider: 'opl-pi-amd-minicpm-v-4-7-1b-lane' },
] as const

describe('Pi AMD lanes', () => {
  it('pins exactly the five AMD ids the owning plugin publishes', () => {
    expect(PI_AMD_MODELS).toEqual([
      'amd/Qwen3.8-27B',
      'amd/MiniCPM-V-4.7-35B-A3B',
      'amd/MiniCPM5-2B',
      'amd/Gemma-4-31B-IT',
      'amd/MiniCPM-V-4.7-1B',
    ])
    // Every AMD id is part of the adapter's published surface, and nothing else is.
    for (const model of PI_AMD_MODELS) expect(PI_CODE_MODELS).toContain(model)
    expect(piCodeModels().filter((model) => model.model.startsWith('amd/'))).toEqual(
      PI_AMD_MODELS.map((model) => ref(model)),
    )
  })

  it.each(AMD_LANES)('routes $model through its own provider key', ({ model, provider }) => {
    const lane = piLane(ref(model))
    expect(lane).toBeDefined()
    expect(lane!.model).toBe(model)
    expect(lane!.provider).toBe(provider)
    expect(isPiCodeModel(ref(model))).toBe(true)
    // The channel's own wire is chat, which the official CLI maps onto this API.
    expect(piLaneProtocol(ref(model))).toBe('chat')
    expect(piApiForProtocol(piLaneProtocol(ref(model))!)).toBe('openai-completions')
  })

  it('keeps every lane separate, so no two ids can share one configuration', () => {
    const providers = PI_CODE_MODELS.map((model) => piLane(ref(model))!.provider)
    expect(new Set(providers).size).toBe(PI_CODE_MODELS.length)
    // The AMD rows never borrow a free lane's provider key.
    const freeLaneProviders = new Set(
      PI_CODE_MODELS.filter((model) => !model.startsWith('amd/')).map(
        (model) => piLane(ref(model))!.provider,
      ),
    )
    for (const { provider } of AMD_LANES) expect(freeLaneProviders.has(provider)).toBe(false)
  })

  it('never mixes the AMD Gemma row with the free-lane Gemma row', () => {
    // Same model family, different source, different channel, different lane.
    const amd = piLane(ref(PI_MODEL_AMD_GEMMA4_31B_IT))!
    const free = piLane(ref(PI_MODEL_GEMMA))!
    expect(amd.model).not.toBe(free.model)
    expect(amd.provider).not.toBe(free.provider)
    expect(amd.provider).toBe('opl-pi-amd-gemma-4-31b-lane')
    expect(free.provider).toBe('opl-pi-gemma-lane')
    // Neither row is written into the other's provider entry.
    expect(
      Object.keys(
        buildPiModelsConfig({
          provider: amd.provider,
          model: amd.model,
          baseURL: 'http://127.0.0.1:32123/v1',
          api: 'openai-completions',
          reasoning: false,
        }).providers as Record<string, { models: { id: string }[] }>,
      ),
    ).toEqual([amd.provider])
  })

  it.each([
    ['a stripped prefix', 'Qwen3.8-27B'],
    ['a different case', 'amd/qwen3.8-27b'],
    ['a trailing space', 'amd/Qwen3.8-27B '],
    ['a different size', 'amd/MiniCPM-V-4.7-35B'],
    ['a longer size', 'amd/MiniCPM-V-4.7-35B-A3B-extra'],
    ['another family', 'amd/MiniCPM4-2B'],
    ['an unknown AMD row', 'amd/future-model'],
  ])('refuses %s instead of pinning a different model', (_label, model) => {
    expect(piLane(ref(model))).toBeUndefined()
    expect(isPiCodeModel(ref(model))).toBe(false)
    expect(piLaneProtocol(ref(model))).toBeUndefined()
    expect(piLaneReasoning(ref(model))).toBeUndefined()
  })

  it('does not absorb an AMD-shaped id published by another owner', () => {
    for (const model of PI_AMD_MODELS) {
      expect(piLane(ref(model, 'somebody-else'))).toBeUndefined()
      expect(isPiCodeModel(ref(model, 'somebody-else'))).toBe(false)
    }
  })

  it('advertises no reasoning tier and sends no effort for these lanes', () => {
    for (const { model } of AMD_LANES) {
      expect(piLaneReasoning(ref(model))).toBe(false)
      expect(piLane(ref(model))!.thinking).toBe('upstream-default')
      expect(piLane(ref(model))!.thinkingLevelMap).toBeUndefined()
    }
    // The generated row carries no reasoning flag and no effort mapping, so the
    // official CLI advertises no thinking selector for these lanes.
    for (const { model, provider } of AMD_LANES) {
      expect(
        buildPiModelsConfig({
          provider,
          model,
          baseURL: 'http://127.0.0.1:32123/v1',
          api: 'openai-completions',
          reasoning: piLaneReasoning(ref(model)) === true,
        }),
      ).toEqual({
        providers: {
          [provider]: {
            baseUrl: 'http://127.0.0.1:32123/v1',
            api: 'openai-completions',
            apiKey: '$OPL_PI_CREDENTIAL',
            models: [{ id: model, name: model }],
          },
        },
      })
    }
  })

  it('refuses a requested effort instead of writing a thinking level', async () => {
    const adapter = createPiAdapter('bridge.mjs')
    const record = {
      id: 's1',
      combination: 'pi/amd',
      harnessRef: PI_HARNESS,
      modelRef: ref(PI_MODEL_AMD_QWEN3_8_27B),
      cwd: process.cwd(),
      acpSessionId: '',
      origin: { kind: 'harness', sessionId: 's' },
      title: 't',
      sandbox: 'full-access',
      createdAt: '',
      updatedAt: '',
      turns: [],
      reasoningEffort: 'high',
    } as unknown as HarnessSession
    const model = PI_MODEL_AMD_QWEN3_8_27B
    // These lanes advertise no thinking option, so a carried effort is refused rather
    // than mapped onto a level the source never declared.
    const configOptions = [{ id: 'model', currentValue: model, options: [{ value: model }] }]
    const writes: { method: string; params: object }[] = []
    await expect(
      adapter.configureSession!(
        {
          async request(method, params) {
            writes.push({ method, params })
            return { configOptions }
          },
        },
        record,
        { agent: {}, session: { sessionId: 's1' }, configOptions },
      ),
    ).rejects.toThrow(/未广告 thinking 配置项/)
    // The model is pinned, and no thinking level is ever written.
    expect(writes.map((write) => (write.params as { configId: string }).configId)).toEqual([
      'model',
    ])
  })

  it('pins the model through the existing model option without choosing an effort', async () => {
    const adapter = createPiAdapter('bridge.mjs')
    const model = PI_MODEL_AMD_MINICPM5_2B
    const writes: { method: string; params: object }[] = []
    const configOptions = [{ id: 'model', currentValue: model, options: [{ value: model }] }]
    const record = {
      id: 's1',
      combination: 'pi/amd',
      harnessRef: PI_HARNESS,
      modelRef: ref(model),
      cwd: process.cwd(),
      acpSessionId: '',
      origin: { kind: 'harness', sessionId: 's' },
      title: 't',
      sandbox: 'full-access',
      createdAt: '',
      updatedAt: '',
      turns: [],
    } as unknown as HarnessSession
    await expect(
      adapter.configureSession!(
        {
          async request(method, params) {
            writes.push({ method, params })
            return { configOptions }
          },
        },
        record,
        { agent: {}, session: { sessionId: 's1' }, configOptions },
      ),
    ).resolves.toEqual({ configOptions })
    expect(writes).toEqual([
      {
        method: 'session/set_config_option',
        params: { sessionId: 's1', configId: 'model', value: model },
      },
    ])
    expect(() =>
      adapter.verifySession!(record, { agent: {}, session: {}, configOptions }),
    ).not.toThrow()
  })

  it('keeps the thinking vocabulary untouched: no level is invented for an AMD lane', () => {
    expect(piThinkingValue(undefined)).toBeUndefined()
    expect(piThinkingValue('high')).toBe('high')
    // The AMD lanes never map a request onto a level of their own.
    for (const { model } of AMD_LANES) {
      const lane = piLane(ref(model))!
      expect(lane.thinkingLevelMap).toBeUndefined()
      expect(Object.keys(lane.thinkingLevelMap ?? {})).toHaveLength(0)
    }
  })
})

describe('Pi source refuses to redirect an AMD lane', () => {
  const answer = (over: Partial<PiSourceAnswer> = {}): PiSourceAnswer => ({
    baseURL: 'https://owned-amd-relay.example.test/v1',
    apiKey: 'fixture-only',
    model: PI_MODEL_AMD_QWEN3_8_27B,
    protocol: 'chat',
    ...over,
  })

  it('authorizes this harness and the exact AMD ids only', () => {
    const source = createPiSource(() => answer())
    for (const { model } of AMD_LANES) expect(source.supports(PI_HARNESS, ref(model))).toBe(true)
    expect(source.supports(PI_HARNESS, ref('amd/future-model'))).toBe(false)
    expect(source.supports(PI_HARNESS, ref(PI_MODEL_AMD_QWEN3_8_27B, 'somebody-else'))).toBe(false)
    expect(source.supports('another-harness', ref(PI_MODEL_AMD_QWEN3_8_27B))).toBe(false)
  })

  it('refuses an owner answer that names another model', async () => {
    const source = createPiSource(() => answer({ model: 'amd/MiniCPM5-2B' }))
    await expect(source.resolve(PI_HARNESS, ref(PI_MODEL_AMD_QWEN3_8_27B))).rejects.toThrow(
      /不一致/,
    )
  })

  it('refuses an owner answer that names another protocol', async () => {
    const source = createPiSource(() => answer({ protocol: 'responses' }))
    await expect(source.resolve(PI_HARNESS, ref(PI_MODEL_AMD_QWEN3_8_27B))).rejects.toThrow(
      /不一致/,
    )
  })

  it('resolves the exact AMD model when the owner agrees', async () => {
    const source = createPiSource(() => answer())
    expect(await source.resolve(PI_HARNESS, ref(PI_MODEL_AMD_QWEN3_8_27B))).toEqual({
      baseURL: 'https://owned-amd-relay.example.test/v1',
      model: PI_MODEL_AMD_QWEN3_8_27B,
      apiKey: 'fixture-only',
      protocol: 'chat',
    })
  })
})
