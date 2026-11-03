/**
 * Adapter surface for the official Pi Coding Agent: which pairings exist, which protocols
 * can really be driven, which permissions can honestly be advertised, and what the adapter
 * refuses. These are the declarations other shared code reads, so they are asserted directly
 * rather than inferred from a run.
 */
import { describe, expect, it } from 'vitest'
import {
  PI_CODE_MODELS,
  PI_HARNESS,
  PI_MODEL_INKLING,
  PI_MODEL_INKLING_FULL,
  PI_MODEL_GEMMA,
  PI_MODEL_LFM,
  PI_MODEL_NEMOTRON,
  PI_PERMISSIONS,
  PI_PROVIDER,
  PI_PROTOCOLS,
  isPiCodeModel,
  isPiProtocol,
  piApiForProtocol,
  piCodeModels,
  piConfigOption,
  piLane,
  piLaneProtocol,
  piLaneReasoning,
  piThinkingValue,
  buildPiModelsConfig,
} from '../../../src/execution/host/adapters/pi/index.ts'
import { createPiAdapter } from '../../../src/execution/host/adapters/pi/index.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'

const ref = (model: string, provider = PI_PROVIDER): ModelRef => ({ provider, model })

describe('Pi adapter capabilities', () => {
  const adapter = createPiAdapter('bridge.mjs')

  it('advertises only what the official product can actually do', () => {
    expect(adapter.id).toBe(PI_HARNESS)
    expect(adapter.transport).toBe('acp')
    expect(adapter.capabilities.transport).toBe('official-sdk')
    // The documented machine interface really is driven, so these are true claims.
    expect(adapter.capabilities.sessionLoad).toBe(true)
    expect(adapter.capabilities.cancel).toBe(true)
    expect(adapter.capabilities.customEndpoint).toBe(true)
    // Pi has no review command of any kind, so Auto Review is refused rather than faked.
    expect(adapter.capabilities.autoReview).toBe('unsupported')
    // Pi has no approval gate and no filesystem boundary: only full access is honest.
    expect(adapter.capabilities.permissions).toEqual(['full-access'])
    expect(PI_PERMISSIONS).toEqual(['full-access'])
  })

  it('matches the exact named lanes under this provider', () => {
    expect(adapter.matches(ref(PI_MODEL_NEMOTRON))).toBe(true)
    expect(adapter.matches(ref(PI_MODEL_LFM))).toBe(true)
    expect(adapter.matches(ref(PI_MODEL_INKLING))).toBe(true)
    expect(adapter.matches(ref('thinkingmachines/inkling:free'))).toBe(true)
    expect(adapter.matches(ref('google/gemma-4-31b-it:free'))).toBe(true)
    // Excluded from this run's adaptation scope, and never deleted from the plugin catalog.
    expect(adapter.matches(ref('openai/gpt-oss-20b'))).toBe(false)
    expect(adapter.matches(ref('jev-1.13-free'))).toBe(false)
    expect(adapter.matches(ref('nvidia/nemotron-3.5-content-safety:free'))).toBe(false)
    // A Pi-shaped id from another owner is not absorbed.
    expect(adapter.matches(ref(PI_MODEL_NEMOTRON, 'somebody-else'))).toBe(false)
    expect(PI_CODE_MODELS).toEqual([
      PI_MODEL_NEMOTRON,
      PI_MODEL_LFM,
      'thinkingmachines/inkling-small:free',
      'thinkingmachines/inkling:free',
      'google/gemma-4-31b-it:free',
    ])
    expect(piCodeModels()).toEqual(PI_CODE_MODELS.map((model) => ref(model)))
  })

  it('keeps every lane separate, with its own provider key', () => {
    const providers = PI_CODE_MODELS.map((model) => piLane(ref(model))!.provider)
    expect(new Set(providers).size).toBe(PI_CODE_MODELS.length)
    expect(isPiCodeModel(ref(PI_MODEL_NEMOTRON))).toBe(true)
    // An unknown id resolves to no lane at all.
    expect(piLane(ref('nvidia/nemotron-3-nano-omni-30b-a3b:free'))).toBeUndefined()
    expect(piLane(ref(PI_MODEL_INKLING))?.provider).toBe('opl-pi-inkling-lane')
    expect(piLane(ref(PI_MODEL_INKLING_FULL))?.provider).toBe('opl-pi-inkling-full-lane')
    expect(piLane(ref(PI_MODEL_GEMMA))?.provider).toBe('opl-pi-gemma-lane')
    for (const model of [
      'thinkingmachines/inkling',
      'google/gemma-4-31b-it',
      'gemma-4-31b-it:free',
    ])
      expect(piLane(ref(model))).toBeUndefined()
  })

  it('pins each lane to a declared protocol and maps it to a real Pi provider api', () => {
    for (const model of PI_CODE_MODELS) {
      const protocol = piLaneProtocol(ref(model))
      expect(protocol).toBe('chat')
      expect(isPiProtocol(protocol)).toBe(true)
      expect(piApiForProtocol(protocol!)).toBe('openai-completions')
    }
    // A channel-qualified reference still resolves to the exact lane, not a merged id.
    expect(piLane(ref(`some-channel::${PI_MODEL_LFM}`))?.model).toBe(PI_MODEL_LFM)
    expect(piLaneProtocol(ref(`some-channel::${PI_MODEL_LFM}`))).toBe('chat')
    expect(piLane(ref(`kilo::${PI_MODEL_INKLING_FULL}`))?.model).toBe(
      'thinkingmachines/inkling:free',
    )
    expect(piLane(ref(`kilo::${PI_MODEL_GEMMA}`))?.model).toBe('google/gemma-4-31b-it:free')
  })

  it('refuses a protocol the official CLI has no provider api for', () => {
    expect(piApiForProtocol('chat')).toBe('openai-completions')
    expect(piApiForProtocol('responses')).toBe('openai-responses')
    expect(piApiForProtocol('messages')).toBe('anthropic-messages')
    // Never rounded to the nearest one, which would run a different route.
    expect(() => piApiForProtocol('grpc')).toThrow(/官方 Pi 不支持该协议/)
    expect(PI_PROTOCOLS).toEqual(['chat', 'responses', 'messages'])
  })

  it('declares reasoning per lane, which decides what the CLI advertises', () => {
    expect(piLaneReasoning(ref(PI_MODEL_NEMOTRON))).toBe(true)
    // Declaring reasoning where a model has none would advertise tiers it cannot serve.
    expect(piLaneReasoning(ref(PI_MODEL_LFM))).toBe(false)
    expect(piLaneReasoning(ref(PI_MODEL_INKLING))).toBe(false)
    expect(piLaneReasoning(ref(PI_MODEL_INKLING_FULL))).toBe(true)
    expect(piLaneReasoning(ref(PI_MODEL_GEMMA))).toBe(false)
    expect(piLaneReasoning(ref('unknown:free'))).toBeUndefined()
  })

  it('preserves upstream thinking for Gemma without an effort declaration', () => {
    expect(piLane(ref(PI_MODEL_GEMMA))?.thinking).toBe('upstream-default')
    expect(piLane(ref(PI_MODEL_GEMMA))?.thinkingLevelMap).toBeUndefined()
    for (const model of [PI_MODEL_NEMOTRON, PI_MODEL_LFM, PI_MODEL_INKLING])
      expect(piLane(ref(model))?.thinking).toBe('cli-advertised')
  })

  it('never invents a reasoning tier the caller did not ask for', () => {
    expect(piThinkingValue(undefined)).toBeUndefined()
    expect(piThinkingValue('')).toBeUndefined()
    expect(piThinkingValue('   ')).toBeUndefined()
    expect(piThinkingValue('high')).toBe('high')
  })
})

describe('Pi generated config for added lanes', () => {
  it.each([
    {
      model: 'thinkingmachines/inkling:free',
      provider: 'opl-pi-inkling-full-lane',
      reasoning: true,
      row: {
        id: 'thinkingmachines/inkling:free',
        name: 'thinkingmachines/inkling:free',
        reasoning: true,
        thinkingLevelMap: { off: 'none', max: 'max' },
      },
    },
    {
      model: 'google/gemma-4-31b-it:free',
      provider: 'opl-pi-gemma-lane',
      reasoning: false,
      row: { id: 'google/gemma-4-31b-it:free', name: 'google/gemma-4-31b-it:free' },
    },
  ])(
    'writes one exact $model row under its isolated provider',
    ({ model, provider, reasoning, row }) => {
      const lane = piLane(ref(model))!
      const api = piApiForProtocol(piLaneProtocol(ref(model))!)
      expect(lane.provider).toBe(provider)
      expect(
        buildPiModelsConfig({
          provider: lane.provider,
          model: lane.model,
          baseURL: 'http://127.0.0.1:32123/v1',
          api,
          reasoning,
        }),
      ).toEqual({
        providers: {
          [provider]: {
            baseUrl: 'http://127.0.0.1:32123/v1',
            api: 'openai-completions',
            apiKey: '$OPL_PI_CREDENTIAL',
            models: [row],
          },
        },
      })
    },
  )
})

describe('Pi config option reading', () => {
  const advertisement = [
    { id: 'model', currentValue: PI_MODEL_NEMOTRON, options: [{ value: PI_MODEL_NEMOTRON }] },
    { id: 'thinking', currentValue: 'high', options: [{ value: 'off' }, { value: 'high' }] },
  ]

  it('reads a pinned value out of an advertisement', () => {
    expect(piConfigOption(advertisement, 'model')).toEqual({
      currentValue: PI_MODEL_NEMOTRON,
      values: [PI_MODEL_NEMOTRON],
    })
    expect(piConfigOption(advertisement, 'thinking')?.values).toEqual(['off', 'high'])
  })

  it('treats a malformed advertisement as absent so pinning fails instead of passing', () => {
    expect(piConfigOption(undefined, 'model')).toBeUndefined()
    expect(piConfigOption('not-an-array', 'model')).toBeUndefined()
    expect(piConfigOption([null, 3, { id: 'other' }], 'model')).toBeUndefined()
    // An option with no usable values still counts as advertised, with an empty set.
    expect(piConfigOption([{ id: 'model' }], 'model')).toEqual({ currentValue: '', values: [] })
  })
})

describe('Pi session verification fails closed', () => {
  const adapter = createPiAdapter('bridge.mjs')
  const record = {
    id: 's1',
    combination: 'pi/nemotron',
    harnessRef: PI_HARNESS,
    modelRef: ref(PI_MODEL_NEMOTRON),
    cwd: process.cwd(),
    acpSessionId: '',
    origin: { kind: 'harness', sessionId: 's' },
    title: 't',
    sandbox: 'full-access',
    createdAt: '',
    updatedAt: '',
    turns: [],
  } as any

  it.each(['thinkingmachines/inkling:free', 'google/gemma-4-31b-it:free'])(
    'pins %s through the existing model option without choosing an effort',
    async (model) => {
      const writes: { method: string; params: object }[] = []
      const configOptions = [{ id: 'model', currentValue: model, options: [{ value: model }] }]
      const added = { ...record, modelRef: ref(model) }
      const snapshot = { agent: {}, session: { sessionId: 's1' }, configOptions }
      await expect(
        adapter.configureSession!(
          {
            async request(method, params) {
              writes.push({ method, params })
              return { configOptions }
            },
          },
          added,
          snapshot,
        ),
      ).resolves.toEqual({ configOptions })
      expect(writes).toEqual([
        {
          method: 'session/set_config_option',
          params: { sessionId: 's1', configId: 'model', value: model },
        },
      ])
      expect(() => adapter.verifySession!(added, snapshot)).not.toThrow()
      expect(() =>
        adapter.verifySession!(added, {
          ...snapshot,
          configOptions: [
            { id: 'model', currentValue: PI_MODEL_INKLING, options: [{ value: PI_MODEL_INKLING }] },
          ],
        }),
      ).toThrow(/与要求的 .* 不一致/)
    },
  )

  it('accepts an advertisement that reports the pinned model', () => {
    expect(() =>
      adapter.verifySession!(record, {
        agent: {},
        session: {},
        configOptions: [
          { id: 'model', currentValue: PI_MODEL_NEMOTRON, options: [{ value: PI_MODEL_NEMOTRON }] },
        ],
      }),
    ).not.toThrow()
  })

  it('refuses a session whose model drifted, before any prompt is sent', () => {
    expect(() =>
      adapter.verifySession!(record, {
        agent: {},
        session: {},
        configOptions: [
          { id: 'model', currentValue: PI_MODEL_LFM, options: [{ value: PI_MODEL_LFM }] },
        ],
      }),
    ).toThrow(/与要求的 .* 不一致/)
  })

  it('refuses a requested tier the advertisement does not offer', async () => {
    await expect(
      adapter.configureSession!(
        {
          async request() {
            return {
              configOptions: [
                {
                  id: 'model',
                  currentValue: PI_MODEL_NEMOTRON,
                  options: [{ value: PI_MODEL_NEMOTRON }],
                },
                {
                  id: 'thinking',
                  currentValue: 'high',
                  options: [{ value: 'off' }, { value: 'high' }],
                },
              ],
            }
          },
        },
        { ...record, reasoningEffort: 'max' },
        {
          agent: {},
          session: { sessionId: 's1' },
          configOptions: [
            {
              id: 'model',
              currentValue: PI_MODEL_NEMOTRON,
              options: [{ value: PI_MODEL_NEMOTRON }],
            },
            {
              id: 'thinking',
              currentValue: 'high',
              options: [{ value: 'off' }, { value: 'high' }],
            },
          ],
        },
      ),
    ).rejects.toThrow(/不含所选取值 max/)
  })

  it('refuses when the advertisement omits the pinned model entirely', async () => {
    // Checked before any write, so a session that cannot prove its model never proceeds to
    // the reasoning tier at all.
    await expect(
      adapter.configureSession!(
        {
          async request() {
            return { configOptions: [] }
          },
        },
        record,
        {
          agent: {},
          session: { sessionId: 's1' },
          configOptions: [{ id: 'thinking', currentValue: 'off', options: [{ value: 'off' }] }],
        },
      ),
    ).rejects.toThrow(/未广告 model 配置项/)
  })

  it('refuses an unknown model instead of pinning something else', () => {
    expect(() =>
      adapter.verifySession!(
        { ...record, modelRef: ref('openai/gpt-oss-20b') },
        {
          agent: {},
          session: {},
          configOptions: [],
        },
      ),
    ).toThrow(/不属于官方 Pi 可固定的组合/)
  })
})
