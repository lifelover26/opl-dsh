/** Exact EAC AMD routing, source identity and generated official CLI configuration. */
import { describe, expect, it } from 'vitest'
import { dshAdapter } from '../../../src/execution/host/adapters/dsh.ts'
import { automaticHarness } from '../../../src/execution/host/adapters/index.ts'
import { officialHarnessFor } from '../../../src/execution/contracts/official-harnesses.ts'
import {
  buildMimoRouteConfig,
  isMimoCodeModel,
  MIMO_AMD_MODEL,
  MIMO_CODE_HARNESS,
  MIMO_OFM_MODELS,
  MIMO_OFM_PROVIDER,
  MIMO_ROUTE_PROVIDER_ID,
  mimoCodeAdapter,
  mimoCodeModels,
  mimoModelValue,
} from '../../../src/execution/host/adapters/mimo/index.ts'
import {
  assertOfmRoute,
  buildOfmPersonalProviderConfig,
  isZcodeOfmModel,
  OFM_ZCODE_PROVIDER_ID,
  ZCODE_OFM_MODELS,
  ZCODE_OFM_PROVIDER_ID,
  ZCODE_OFM_REASONING_LEVELS,
  zcodeOfmReasoningLevel,
} from '../../../src/execution/host/adapters/zcode-ofm/zcode-ofm-models.ts'
import { zcodeOfmAdapter } from '../../../src/execution/host/adapters/zcode-ofm/zcode-ofm.ts'
import type { ExternalModelRoute } from '../../../src/execution/host/model-sources.ts'

const OFM = 'our-free-model'
const DEEPSEEK_41 = 'amd/DeepSeek-V4.1-Flash'
const DEEPSEEK_4 = 'amd/DeepSeek-V4-Flash'
const GLM_AMD = 'amd/GLM-5.3-Flash'
/** Never a real secret; these tests only prove where a credential can and cannot appear. */
const FAKE_KEY = 'opl-amd-vendor-test-key'

const mimoRoute = (model: string): ExternalModelRoute => ({
  baseURL: 'http://127.0.0.1:41234/v1',
  model,
  apiKey: FAKE_KEY,
  protocol: 'chat',
})

describe('EAC amd/ · DeepSeek 走原生 DSH', () => {
  it.each([DEEPSEEK_41, DEEPSEEK_4])('%s 由原生 DSH 承载', (model) => {
    // The native adapter owns the agent loop and selects the model from the Host's own
    // registry, so it claims the reference. No external adapter may claim it too.
    expect(dshAdapter.matches({ provider: OFM, model })).toBe(true)
    expect(automaticHarness({ provider: OFM, model })).toBe('dsh')
    // The external OFM adapters must refuse it rather than run a second, parallel route.
    expect(mimoCodeAdapter.matches({ provider: OFM, model })).toBe(false)
    expect(zcodeOfmAdapter.matches({ provider: OFM, model })).toBe(false)
  })

  it('不把同一台账上的别的模型顺带认领', () => {
    // A sibling lane on the same provider is a different route and stays unclaimed.
    expect(mimoCodeAdapter.matches({ provider: OFM, model: 'amd/DeepSeek-V4.1-Flash-free' })).toBe(
      false,
    )
    expect(zcodeOfmAdapter.matches({ provider: OFM, model: 'amd/GLM-5.3' })).toBe(false)
    // The region route is a different provider and is never claimed.
    expect(mimoCodeAdapter.matches({ provider: 'our-free-model-region', model: DEEPSEEK_41 })).toBe(
      false,
    )
  })
})

describe('EAC amd/ · MiMo Code 自定义 Chat 入口', () => {
  it('声明该通道的目录 id，前缀原样保留', () => {
    expect(MIMO_AMD_MODEL).toBe('amd/MiMo-V2.6-Flash')
    expect(MIMO_OFM_MODELS).toContain(MIMO_AMD_MODEL)
    expect(mimoCodeModels().map((item) => item.model)).toContain(MIMO_AMD_MODEL)
    expect(mimoCodeAdapter.matches({ provider: MIMO_OFM_PROVIDER, model: MIMO_AMD_MODEL })).toBe(
      true,
    )
    expect(isMimoCodeModel({ provider: MIMO_OFM_PROVIDER, model: MIMO_AMD_MODEL })).toBe(true)
  })

  it('构造的模型值只有一个 provider 段，其余原样交给上游', () => {
    // The provider segment is this suite's own namespace; everything after it is the
    // catalog id the owning plugin published, prefix included.
    expect(mimoModelValue(MIMO_AMD_MODEL)).toBe('oplmimo/amd/MiMo-V2.6-Flash')
    expect(mimoModelValue(MIMO_AMD_MODEL).split('/')).toHaveLength(3)
  })

  it('配置里的模型表以完整目录 id 为键，不缩短成别的通道的 id', () => {
    const config = JSON.parse(
      buildMimoRouteConfig(mimoRoute(MIMO_AMD_MODEL), MIMO_AMD_MODEL).content,
    )
    expect(config.model).toBe('oplmimo/amd/MiMo-V2.6-Flash')
    expect(Object.keys(config.provider[MIMO_ROUTE_PROVIDER_ID].models)).toEqual([MIMO_AMD_MODEL])
    // The shortened spelling is a different lane and must not appear anywhere.
    expect(config.content ?? JSON.stringify(config)).not.toContain('"MiMo-V2.6-Flash"')
    expect(config.provider[MIMO_ROUTE_PROVIDER_ID].only_configured_models).toBe(true)
  })

  it('来源返回另一个模型时拒绝启动，不静默替换', () => {
    expect(() =>
      buildMimoRouteConfig(mimoRoute('amd/DeepSeek-V4.1-Flash'), MIMO_AMD_MODEL),
    ).toThrow(/不一致/)
  })

  it('未知模型与别的 provider 一律拒绝', () => {
    for (const ref of [
      { provider: MIMO_OFM_PROVIDER, model: 'amd/MiMo-V2.6' },
      { provider: MIMO_OFM_PROVIDER, model: 'amd/future-model' },
      { provider: 'other-source', model: MIMO_AMD_MODEL },
    ])
      expect(mimoCodeAdapter.matches(ref)).toBe(false)
  })

  it('共享配对表决定它被路由到哪一个 harness', () => {
    // Which harness a model is routed through is the shared registry's decision, not
    // this adapter's. The mechanism it uses is the official pairing table: an id that
    // is registered there resolves to its owning harness. The free lane is registered
    // and resolves to this adapter's harness, and so does the AMD lane.
    expect(officialHarnessFor({ provider: OFM, model: 'mimo-v2.6-flash-free' })).toBe(
      MIMO_CODE_HARNESS,
    )
    expect(officialHarnessFor({ provider: OFM, model: MIMO_AMD_MODEL })).toBe(MIMO_CODE_HARNESS)
    expect(mimoCodeAdapter.matches({ provider: OFM, model: MIMO_AMD_MODEL })).toBe(true)
  })
})

describe('EAC amd/ · ZCode 个人 Provider 层', () => {
  it('声明该通道的目录 id，前缀原样保留', () => {
    expect(GLM_AMD).toBe('amd/GLM-5.3-Flash')
    expect(ZCODE_OFM_MODELS).toContain(GLM_AMD)
    expect(isZcodeOfmModel(GLM_AMD)).toBe(true)
    expect(zcodeOfmAdapter.matches({ provider: OFM, model: GLM_AMD })).toBe(true)
  })

  it('个人层里写的就是上游要收到的那一个 id', () => {
    const config = buildOfmPersonalProviderConfig({
      baseUrl: 'http://127.0.0.1:41234/v1',
      modelId: GLM_AMD,
      reasoningLevel: 'enabled',
    }) as any
    const rule = config.config.modelConfigRules.providerModelRules[0]
    expect(rule.modelId).toBe(GLM_AMD)
    expect(rule.config.enabled).toBe(true)
    expect(config.config.providerConfigRules.providerRules[0].config.personalModelIds).toEqual([
      GLM_AMD,
    ])
    expect(config.config.defaultModelSelection.modelId).toBe(GLM_AMD)
    expect(config.config.defaultModelSelection.providerId).toBe(OFM_ZCODE_PROVIDER_ID)
    // The shortened spelling is a different lane and must not appear anywhere.
    expect(JSON.stringify(config)).not.toContain('"GLM-5.3-Flash"')
  })

  it('推理档位只用本通道声明的两档，且不向请求体注入任何未验证的字段', () => {
    expect([...ZCODE_OFM_REASONING_LEVELS]).toEqual(['disabled', 'enabled'])
    expect(zcodeOfmReasoningLevel(undefined)).toBe('enabled')
    expect(zcodeOfmReasoningLevel('disabled')).toBe('disabled')
    // A level this route does not declare is refused, never clamped onto another one.
    expect(zcodeOfmReasoningLevel('max')).toBeUndefined()
    expect(zcodeOfmReasoningLevel('high')).toBeUndefined()
    const config = buildOfmPersonalProviderConfig({
      baseUrl: 'http://127.0.0.1:41234/v1',
      modelId: GLM_AMD,
      reasoningLevel: 'enabled',
    }) as any
    const specs = config.config.modelConfigRules.providerModelRules[0].config.optionSpecs
    expect(specs.reasoningLevel.values).toEqual(['disabled', 'enabled'])
    // `map: '{}'` is the official default: the level is advertised and pinned, but
    // nothing unverifiable is injected into the request body.
    expect(specs.reasoningLevel.map).toBe('{}')
  })

  it('来源返回另一个模型、非本机端点或空凭据时拒绝启动', () => {
    const route = mimoRoute(GLM_AMD)
    expect(() => assertOfmRoute(route, 'z-ai/glm-5.3-flash')).toThrow(/不一致/)
    expect(() => assertOfmRoute({ ...route, baseURL: 'https://example.test/v1' }, GLM_AMD)).toThrow(
      /本机转发通道/,
    )
    expect(() => assertOfmRoute({ ...route, apiKey: '' }, GLM_AMD)).toThrow(/凭据/)
    expect(() => assertOfmRoute({ ...route, protocol: 'messages' }, GLM_AMD)).toThrow(/协议/)
  })

  it('只认本 provider 与本通道的 id', () => {
    for (const ref of [
      { provider: ZCODE_OFM_PROVIDER_ID, model: 'amd/GLM-5.3' },
      { provider: ZCODE_OFM_PROVIDER_ID, model: 'amd/GLM-5.4-Flash' },
      { provider: 'our-free-model-region', model: GLM_AMD },
      { provider: 'huawei-maas', model: GLM_AMD },
    ])
      expect(zcodeOfmAdapter.matches(ref)).toBe(false)
  })
})

describe('EAC amd/ · 每个通道只认自己那一个 id', () => {
  it('四条路由互不串台', () => {
    expect(MIMO_CODE_HARNESS).toBe('mimo-code')
    expect(zcodeOfmAdapter.id).toBe('zcode')
    // MiMo never claims the GLM lane, and ZCode never claims the MiMo lane.
    expect(mimoCodeAdapter.matches({ provider: OFM, model: GLM_AMD })).toBe(false)
    expect(zcodeOfmAdapter.matches({ provider: OFM, model: MIMO_AMD_MODEL })).toBe(false)
  })
})
