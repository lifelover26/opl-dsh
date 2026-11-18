import { describe, expect, it, vi } from 'vitest'
import { adapterFor, defaultHarness } from '../../../src/execution/host/adapters/index.ts'
import {
  isOpenCodeGatewayGeminiModel,
  openCodeModelValue,
  openCodeWireModel,
  OPENCODE_HARNESS,
} from '../../../src/execution/host/adapters/opencode/index.ts'
import { buildOpenCodeRouteConfig } from '../../../src/execution/host/adapters/opencode/opencode-route.ts'
import type { ModelRef } from '../../../src/contracts/catalog.ts'
import type { ExternalModelRoute } from '../../../src/execution/host/model-sources.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'

const fourGeminiModels = [
  'gemini-4-carbon',
  'gemini-4-hydrogen',
  'gemini-4-argon',
  'gemini-3.8-flash',
]

const route: ExternalModelRoute = {
  baseURL: 'https://gateway.example.test/v1',
  model: 'gemini-4-carbon',
  apiKey: 'secret-must-not-leak-to-errors',
  protocol: 'chat',
}

describe('OpenCode OPL Gateway Gemini pairing', () => {
  it('matches only the four supported Gateway Gemini model references', () => {
    const supported: ModelRef[] = fourGeminiModels.map((model) => ({
      provider: 'opl-gateway',
      model: `gemini::${model}`,
    }))
    for (const ref of supported) {
      expect(isOpenCodeGatewayGeminiModel(ref)).toBe(true)
      expect(adapterFor(OPENCODE_HARNESS, ref)?.id).toBe(OPENCODE_HARNESS)
      expect(defaultHarness(ref)).toBe('antigravity')
    }
    for (const retired of ['gemini-3.1-pro', 'gemini-3.7-flash']) {
      expect(
        isOpenCodeGatewayGeminiModel({ provider: 'opl-gateway', model: `gemini::${retired}` }),
      ).toBe(false)
      expect(
        adapterFor(OPENCODE_HARNESS, { provider: 'opl-gateway', model: `gemini::${retired}` }),
      ).toBeUndefined()
    }
  })

  it('strips the Gateway group prefix only at the OpenCode wire boundary', () => {
    const ref = { provider: 'opl-gateway', model: 'gemini::gemini-4-carbon' }
    expect(openCodeWireModel(ref)).toBe('gemini-4-carbon')
    const config = buildOpenCodeRouteConfig(route, openCodeWireModel(ref)!)
    const parsed = JSON.parse(config.content) as {
      provider: Record<
        string,
        { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }
      >
    }
    expect(config.modelValue).toBe(openCodeModelValue('gemini-4-carbon'))
    expect(parsed.provider.oplopencode.options.baseURL).toBe(route.baseURL)
    expect(parsed.provider.oplopencode.options.apiKey).toBe(route.apiKey)
    expect(parsed.provider.oplopencode.models).toEqual({
      'gemini-4-carbon': { name: 'gemini-4-carbon' },
    })
  })

  it('refuses a Gateway route whose resolved model differs', () => {
    expect(() =>
      buildOpenCodeRouteConfig({ ...route, model: 'gemini-3.1-pro' }, route.model),
    ).toThrow(/模型来源返回的模型/)
  })

  it.each(fourGeminiModels)('prepares the exact Gateway Chat route for %s', async (model) => {
    const modelRef = { provider: 'opl-gateway', model: `gemini::${model}` }
    const resolve = vi.fn(async () => ({ ...route, model }))
    const launch = await adapterFor(OPENCODE_HARNESS, modelRef)!.prepare!(
      {} as never,
      {
        id: 'gemini-opencode',
        combination: `opencode/${modelRef.model}`,
        harnessRef: OPENCODE_HARNESS,
        modelRef,
        cwd: process.cwd(),
        acpSessionId: '',
        origin: { kind: 'harness', sessionId: 'gemini-opencode' },
        title: 'Gemini',
        sandbox: 'full-access',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        turns: [],
      } as HarnessSession,
      {
        home: process.cwd(),
        command: process.execPath,
        modelSources: { resolve } as never,
        grokCommand: process.execPath,
        nativeBridgePath: 'bridge.js',
      },
    )
    expect(resolve).toHaveBeenCalledWith(OPENCODE_HARNESS, modelRef, 'chat')
    const content = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!) as {
      provider: { oplopencode: { models: Record<string, unknown> } }
    }
    expect(content.provider.oplopencode.models).toEqual({
      [model]: { name: model },
    })
  })
})
