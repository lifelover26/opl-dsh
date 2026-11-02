import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { automaticHarness, adapterFor } from '../../src/execution/host/adapters/index.ts'
import { ofmHarnessPinsModel } from '../../src/execution/host/ofm-source/provider.ts'
import { createOfmModelSource } from '../../src/execution/host/ofm-source/source.ts'
import { officialOpenCodeModel } from '../../src/execution/host/ofm-source/selection-policy.ts'
import { ExternalModelSources } from '../../src/execution/host/model-sources.ts'
import { displayModelName } from '../../src/shared/models.ts'
import { stepLane, stepLaneReasoning } from '../../src/execution/host/adapters/step/step-models.ts'
import { stepCodeAdapter } from '../../src/execution/host/adapters/step/step.ts'
import { buildOpenCodeRouteConfig } from '../../src/execution/host/adapters/opencode/opencode-route.ts'
import { buildKiloRouteConfig } from '../../src/execution/host/adapters/kilo/kilo-route.ts'
import {
  vibeAdapter,
  vibeConfig,
  VIBE_MODEL,
  VIBE_ALIAS,
} from '../../src/execution/host/adapters/vibe.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { AcpSessionSnapshot, AdapterOptions } from '../../src/execution/host/adapters/types.ts'

const lanes = [
  ['minimaxai/minimax-m3.1-flash', 'opencode', 'EAC MiniMax M3.1 Flash'],
  ['stepfun-ai/step-5-preview', 'step-code', 'EAC Step 5 Preview'],
  [VIBE_MODEL, 'vibe', 'EAC Mistral Large 4'],
  ['inclusionai/ling-3.1-flash-1019-free', 'kilo', 'Kilo Ling 3.1 Flash 1019'],
] as const
const ref = (model: string) => ({ provider: 'our-free-model', model })
const record = { modelRef: ref(VIBE_MODEL), sandbox: 'full-access' } as HarnessSession
const config = (model = VIBE_ALIAS, mode = 'auto-approve') => [
  {
    id: 'model',
    type: 'select',
    currentValue: model,
    options: [{ value: VIBE_ALIAS, description: VIBE_MODEL }],
  },
  { id: 'mode', type: 'select', currentValue: mode, options: [{ value: 'auto-approve' }] },
]
const snapshot = (options = config()): AcpSessionSnapshot => ({
  agent: {},
  session: { sessionId: 'owned', modes: { currentModeId: 'auto-approve' } },
  configOptions: options,
})

describe('new OFM channel pairings', () => {
  it.each(lanes)('routes %s through %s without changing the channel', (model, harness, label) => {
    expect(automaticHarness(ref(model))).toBe(harness)
    expect(adapterFor(harness, ref(model))?.matches(ref(model))).toBe(true)
    expect(ofmHarnessPinsModel(harness, model)).toBe(true)
    expect(automaticHarness({ provider: 'other-owner', model })).toBeUndefined()
    expect(adapterFor(harness, { provider: 'other-owner', model })).toBeUndefined()
    expect(officialOpenCodeModel(ref(model))).toBeUndefined()
    expect(displayModelName(ref(model))).toBe(label)
    for (const [, otherHarness] of lanes)
      if (otherHarness !== harness) expect(ofmHarnessPinsModel(otherHarness, model)).toBe(false)
  })
  it('keeps the EAC Step provider separate from the free lanes', () => {
    expect(stepLane(ref('stepfun-ai/step-5-preview'))?.provider).toBe('opl-step-eac-lane')
    expect(stepLane(ref('stepfun/step-5-preview-free'))?.provider).toBe('opl-step-kilo-lane')
    expect(stepLaneReasoning(ref('stepfun-ai/step-5-preview'))).toBe(false)
    expect(stepLaneReasoning(ref('stepfun/step-5-preview-free'))).toBe(true)
    expect(adapterFor('minimax-code', ref('minimaxai/minimax-m3.1-flash'))).toBeUndefined()
  })
  it.each(lanes)('resolves %s only through its exact registered source', async (model, harness) => {
    const ctx = {
      effect: (effect: () => () => void) => effect(),
      llm: {
        listProviders: () => [{ id: 'our-free-model' }],
        listModels: async () => lanes.map(([id]) => ({ id })),
        resolveModelInfo: async (provider: string, id: string) => ({ provider, id }),
      },
    } as unknown as Context
    const connection = vi.fn(async () => ({
      baseURL: 'https://owned-relay.example.test/v1',
      apiKey: 'fixture-only',
      protocols: ['chat' as const],
    }))
    const sources = new ExternalModelSources(ctx)
    const dispose = sources.register(ctx, createOfmModelSource(ctx, { connection }))
    try {
      expect(await sources.resolve(harness, ref(model), 'chat')).toEqual({
        baseURL: 'https://owned-relay.example.test/v1',
        apiKey: 'fixture-only',
        protocol: 'chat',
        model,
      })
      expect(connection).toHaveBeenCalledWith(harness, ref(model), 'chat')
    } finally {
      dispose()
    }
    await expect(sources.resolve(harness, ref(model), 'chat')).rejects.toThrow('尚未适配')
  })
  it('refuses an effort carried onto the EAC Step lane before writing configuration', async () => {
    const model = 'stepfun-ai/step-5-preview'
    const request = vi.fn()
    await expect(
      stepCodeAdapter.configureSession!(
        { request },
        { modelRef: ref(model), reasoningEffort: 'max' } as HarnessSession,
        {
          agent: {},
          session: { sessionId: 'owned' },
          configOptions: [
            { id: 'model', type: 'select', currentValue: model, options: [{ value: model }] },
            { id: 'thinking', type: 'select', currentValue: 'off', options: [{ value: 'off' }] },
          ],
        },
      ),
    ).rejects.toThrow('max')
    expect(request).not.toHaveBeenCalled()
  })
  it.each([
    ['minimaxai/minimax-m3.1-flash', buildOpenCodeRouteConfig, 'oplopencode'],
    ['inclusionai/ling-3.1-flash-1019-free', buildKiloRouteConfig, 'oplkilo'],
  ] as const)(
    'writes the exact %s model and its owning relay into CLI config',
    (model, build, provider) => {
      const result = build(
        {
          model,
          baseURL: 'https://owned-relay.example.test/v1',
          apiKey: 'fixture-only',
          protocol: 'chat',
        },
        model,
      )
      const config = JSON.parse(result.content)
      expect(result.modelValue).toBe(`${provider}/${model}`)
      expect(Object.keys(config.provider)).toEqual([provider])
      expect(config.provider[provider].options.baseURL).toBe('https://owned-relay.example.test/v1')
      expect(Object.keys(config.provider[provider].models)).toEqual([model])
    },
  )
})

describe('Mistral Vibe model and permission readback', () => {
  it('pins an offered model and verifies the returned selection', async () => {
    const request = vi.fn().mockResolvedValue({ configOptions: config() })
    await vibeAdapter.configureSession!({ request }, record, snapshot(config('mistral-medium-3.5')))
    expect(request).toHaveBeenCalledWith('session/set_config_option', {
      sessionId: 'owned',
      configId: 'model',
      value: VIBE_ALIAS,
    })
    expect(() => vibeAdapter.verifySession!(record, snapshot())).not.toThrow()
  })
  it('refuses a silent model substitution after an acknowledged write', async () => {
    const request = vi.fn().mockResolvedValue({ configOptions: config('mistral-medium-3.5') })
    await expect(vibeAdapter.configureSession!({ request }, record, snapshot())).rejects.toThrow(
      '模型已改变',
    )
  })
  it('refuses an unadvertised model before any write', async () => {
    const request = vi.fn()
    await expect(vibeAdapter.configureSession!({ request }, record, snapshot([]))).rejects.toThrow(
      '未广告',
    )
    expect(request).not.toHaveBeenCalled()
  })
  it('refuses permission drift before a prompt', () => {
    expect(() => vibeAdapter.verifySession!(record, snapshot(config(VIBE_ALIAS, 'ask')))).toThrow(
      '完全访问',
    )
  })
  it('refuses restricted launches and carried reasoning choices before resolving a credential', async () => {
    const options = {} as AdapterOptions
    for (const sandbox of ['workspace', 'read-only'] as const)
      await expect(
        vibeAdapter.prepare!({} as Context, { ...record, sandbox }, options),
      ).rejects.toThrow('full-access')
    await expect(
      vibeAdapter.prepare!({} as Context, { ...record, reasoningEffort: 'high' }, options),
    ).rejects.toThrow('推理档位')
  })
  it('stores only an environment credential reference and leaves effort unset', () => {
    const config = vibeConfig('https://relay.example.test/v1')
    expect(config).toContain('api_key_env_var = "OPL_VIBE_CREDENTIAL"')
    expect(config).toContain(VIBE_MODEL)
    expect(config).not.toMatch(/^thinking =/m)
    expect(config).not.toContain('api_key =')
    expect(config).not.toContain('enabled_tools')
  })
})
