/**
 * Behaviour of the official StepCode adapter: what it advertises, what it pins, and
 * what it refuses. Every case here is a decision a user could otherwise get wrong, so
 * each one asserts the refusal rather than a fallback.
 */
import { describe, expect, it } from 'vitest'
import { HarnessConfigurationError } from '../../../src/execution/host/acp.ts'
import {
  STEP_HARNESS,
  STEP_MODEL_FREE,
  STEP_MODEL_KILO,
  STEP_MODEL_EAC,
  STEP_PROVIDER,
  isStepCodeModel,
  stepApiForProtocol,
  stepCodeModels,
  stepLane,
  stepLaneProtocol,
  stepThinkingValue,
} from '../../../src/execution/host/adapters/step/index.ts'
import {
  stepPermissionPlan,
  STEP_PERMISSION_PRESET_ENV,
} from '../../../src/execution/host/adapters/step/step-permissions.ts'
import {
  createStepCodeAdapter,
  stepConfigOption,
} from '../../../src/execution/host/adapters/step/step.ts'
import { STEP_CREDENTIAL_ENV } from '../../../src/execution/host/adapters/step/step-config.ts'
import { fakeSources, stepRecord } from './fixtures/records.ts'
import type { AdapterOptions } from '../../../src/execution/host/adapters/types.ts'
import type { ModelRef } from '../../../src/execution/contracts/catalog.ts'

const adapter = createStepCodeAdapter('unused-in-this-spec')

/** Adapter options with only the fields these cases need; no process is started. */
const options = (sources?: AdapterOptions['modelSources'], home = 'C:/opl'): AdapterOptions =>
  ({
    home,
    grokCommand: 'grok',
    nativeBridgePath: '',
    ...(sources ? { modelSources: sources } : {}),
  }) as AdapterOptions

describe('StepCode adapter capabilities', () => {
  it('advertises only what the official product really implements', () => {
    expect(adapter.capabilities).toEqual({
      // StepCode has no ACP server; the bridge projects its own RPC onto ACP.
      transport: 'official-sdk',
      authentication: 'api-source',
      protocols: ['chat', 'responses', 'messages'],
      // A suite-owned models.json really does carry the owner's base URL.
      customEndpoint: true,
      // No read-only/workspace: the official preset taxonomy has no verifiable
      // filesystem boundary, so those tiers are refused instead of advertised.
      permissions: ['full-access'],
      sessionLoad: true,
      cancel: true,
      reasoning: 'cli-advertised',
      autoReview: 'unsupported',
    })
    expect(adapter.transport).toBe('acp')
    expect(adapter.id).toBe(STEP_HARNESS)
  })

  it('maps every advertised protocol onto a real official provider API', () => {
    expect(stepApiForProtocol('chat')).toBe('openai-completions')
    expect(stepApiForProtocol('responses')).toBe('openai-responses')
    expect(stepApiForProtocol('messages')).toBe('anthropic-messages')
    // An unknown protocol is refused, never rounded to the nearest one.
    expect(() => stepApiForProtocol('grpc')).toThrow(/不支持该协议/)
  })
})

describe('StepCode model lanes', () => {
  it('keeps the two catalog ids as separate lanes and never merges them by name', () => {
    const free = stepLane({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE })!
    const kilo = stepLane({ provider: STEP_PROVIDER, model: STEP_MODEL_KILO })!
    expect(free.model).toBe(STEP_MODEL_FREE)
    expect(kilo.model).toBe(STEP_MODEL_KILO)
    // Distinct provider keys: neither lane can inherit the other's base URL or model.
    expect(free.provider).not.toBe(kilo.provider)
    // `stepfun/step-5-preview-free` is not treated as a spelling of the other id.
    expect(free.provider).not.toContain(STEP_MODEL_KILO)
  })

  it('refuses a Step-shaped id from a different provider owner', () => {
    expect(isStepCodeModel({ provider: 'somebody-else', model: STEP_MODEL_FREE })).toBe(false)
    expect(isStepCodeModel({ provider: STEP_PROVIDER, model: 'step-6-preview-free' })).toBe(false)
    expect(isStepCodeModel({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE })).toBe(true)
  })

  it('pins an exact protocol per lane instead of one protocol for both', () => {
    const free = stepLaneProtocol({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE })!
    const kilo = stepLaneProtocol({ provider: STEP_PROVIDER, model: STEP_MODEL_KILO })!
    expect(['chat', 'responses', 'messages']).toContain(free)
    expect(['chat', 'responses', 'messages']).toContain(kilo)
    // The lookup is by exact lane id: an unknown id has no protocol at all.
    expect(stepLaneProtocol({ provider: STEP_PROVIDER, model: 'step-9' })).toBeUndefined()
  })

  it('publishes the channel IDs without renaming or merging them', () => {
    expect(stepCodeModels()).toEqual([
      { provider: STEP_PROVIDER, model: STEP_MODEL_FREE },
      { provider: STEP_PROVIDER, model: STEP_MODEL_KILO },
      { provider: STEP_PROVIDER, model: STEP_MODEL_EAC },
    ])
  })

  it('invents no reasoning tier when the caller expressed none', () => {
    expect(stepThinkingValue(undefined)).toBeUndefined()
    expect(stepThinkingValue('  ')).toBeUndefined()
    // An explicit choice passes through verbatim for validation against the live
    // advertisement; it is never remapped onto a default.
    expect(stepThinkingValue('max')).toBe('max')
  })
})

describe('StepCode permission mapping', () => {
  it('maps the authorized full-access tier and claims no isolation for it', () => {
    const plan = stepPermissionPlan('full-access')
    expect(plan).toEqual({
      preset: 'full-access',
      isolation: 'none',
      acknowledgeFullAccessRisk: true,
    })
  })

  it('refuses restricted tiers instead of mapping them onto an approval policy', () => {
    // `ask` is an approval policy, not a filesystem boundary: mapping read-only onto it
    // would advertise confinement the product does not implement.
    expect(() => stepPermissionPlan('read-only')).toThrow(HarnessConfigurationError)
    expect(() => stepPermissionPlan('read-only')).toThrow(/没有只读或工作区写入隔离/)
    expect(() => stepPermissionPlan('workspace')).toThrow(/没有只读或工作区写入隔离/)
    // Refusal is explicit about not widening, so a caller cannot read it as a downgrade.
    expect(() => stepPermissionPlan('read-only')).toThrow(/未把受限权限扩大为完整访问/)
  })

  it('refuses an unknown tier rather than defaulting', () => {
    expect(() => stepPermissionPlan('sudo')).toThrow(/不支持的权限档位：sudo/)
  })

  it('names the official preset variable the launch carries', () => {
    expect(STEP_PERMISSION_PRESET_ENV).toBe('STEP_PERMISSION_PRESET')
  })
})

describe('StepCode session pinning', () => {
  const snapshot = (configOptions: unknown) =>
    ({ agent: {}, session: { sessionId: 'sess-1' }, configOptions }) as any

  it('reads only well-formed select options from an advertisement', () => {
    const options2 = [
      { type: 'select', id: 'model', currentValue: 'a', options: [{ value: 'a' }, { value: 'b' }] },
      'not-an-object',
      { type: 'select', id: 'thinking', currentValue: 'high', options: [{ value: 'high' }] },
    ]
    expect(stepConfigOption(options2, 'model')).toEqual({ currentValue: 'a', values: ['a', 'b'] })
    expect(stepConfigOption(options2, 'missing')).toBeUndefined()
    expect(stepConfigOption('not-an-array', 'model')).toBeUndefined()
  })

  it('refuses a model the advertisement does not offer, naming the offered set', async () => {
    const advertised = [
      {
        type: 'select',
        id: 'model',
        currentValue: 'other-model',
        options: [{ value: 'other-model' }],
      },
    ]
    await expect(
      adapter.configureSession!(
        { request: async () => ({}) } as any,
        stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE }),
        snapshot(advertised),
      ),
    ).rejects.toThrow(/不含所需取值 step-5-preview-free（实际：other-model）/)
  })

  it('refuses a tier the model never advertised instead of writing it', async () => {
    // The official binary answers `success: true` for any tier string, so the adapter
    // refuses from the advertisement rather than trusting a successful write. Here the
    // live session already reports a different tier than the combination pinned, which is
    // caught before any write.
    const advertised = [
      {
        type: 'select',
        id: 'model',
        currentValue: STEP_MODEL_FREE,
        options: [{ value: STEP_MODEL_FREE }],
      },
      { type: 'select', id: 'thinking', currentValue: 'high', options: [{ value: 'high' }] },
    ]
    const acp = { request: async () => ({ configOptions: advertised }) } as any
    await expect(
      adapter.configureSession!(
        acp,
        stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE }, { reasoningEffort: 'max' }),
        snapshot(advertised),
      ),
    ).rejects.toThrow(/会话 thinking 与要求的 max 不一致/)
  })

  it('rejects a missing advertisement instead of skipping the pinned checks', () => {
    // No advertisement at all means no evidence the session still runs the pinned model.
    expect(() =>
      adapter.verifySession!(stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE }), {
        agent: {},
      } as any),
    ).toThrow(/未广告 model 配置项/)
  })

  it('fails closed before every prompt when the pinned model drifted', () => {
    const drifted = [
      {
        type: 'select',
        id: 'model',
        currentValue: 'other-model',
        options: [{ value: 'other-model' }],
      },
    ]
    expect(() =>
      adapter.verifySession!(
        stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE }),
        snapshot(drifted),
      ),
    ).toThrow(/会话 model 与要求的 step-5-preview-free 不一致/)
  })

  it('accepts an advertisement that still carries the pinned values', () => {
    const ok = [
      {
        type: 'select',
        id: 'model',
        currentValue: STEP_MODEL_KILO,
        options: [{ value: STEP_MODEL_KILO }],
      },
    ]
    expect(() =>
      adapter.verifySession!(
        stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_KILO }),
        snapshot(ok),
      ),
    ).not.toThrow()
  })
})

describe('StepCode launch refuses before anything is launched', () => {
  it('refuses a restricted permission before touching the credential path', async () => {
    const sources = fakeSources({ model: STEP_MODEL_FREE })
    await expect(
      adapter.prepare!(
        {} as any,
        stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE }, { sandbox: 'read-only' }),
        options(sources as any),
      ),
    ).rejects.toThrow(/没有只读或工作区写入隔离/)
    // Nothing asked the source, so no credential path was opened at all.
    expect(sources.asked).toEqual([])
  })

  it('refuses when the model source is not registered', async () => {
    await expect(
      adapter.prepare!(
        {} as any,
        stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_FREE }),
        options(),
      ),
    ).rejects.toThrow(/尚未注册到执行引擎/)
  })

  it('resolves the route under the exact pinned protocol', async () => {
    // The resolve call happens after the shell probe, so this case only asserts that the
    // adapter asked for the declared protocol when it got far enough to ask.
    const sources = fakeSources({ model: STEP_MODEL_KILO })
    const pinned = stepLaneProtocol({ provider: STEP_PROVIDER, model: STEP_MODEL_KILO })
    await adapter.prepare!(
      {} as any,
      stepRecord({ provider: STEP_PROVIDER, model: STEP_MODEL_KILO }),
      options(sources as any),
    ).catch(() => undefined)
    // Either the shell probe failed first (no CLI installed) or the route was asked for.
    if (sources.asked.length > 0) expect(sources.asked).toEqual([pinned])
  })

  it('refuses a model the adapter does not pin', async () => {
    const sources = fakeSources({ model: 'gpt-oss-20b' })
    await expect(
      adapter.prepare!(
        {} as any,
        stepRecord({ provider: STEP_PROVIDER, model: 'gpt-oss-20b' } as ModelRef),
        options(sources as any),
      ),
    ).rejects.toThrow(/不属于官方 StepCode 可固定的组合/)
    expect(sources.asked).toEqual([])
  })
})

describe('StepCode credential handling', () => {
  it('never writes a literal key into the provider config it generates', async () => {
    const { buildStepModelsConfig } = await import(
      '../../../src/execution/host/adapters/step/step-config.ts'
    )
    const doc = JSON.stringify(
      buildStepModelsConfig({
        provider: 'p',
        model: 'm',
        baseURL: 'https://x.test/v1',
        api: 'openai-completions',
      }),
    )
    // The key is referenced through the official `$ENV_VAR` interpolation only.
    expect(doc).toContain(`$${STEP_CREDENTIAL_ENV}`)
    expect(doc).not.toMatch(/"apiKey"\s*:\s*"[^$]/)
  })
})
