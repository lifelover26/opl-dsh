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

const route: ExternalModelRoute = {
  baseURL: 'https://gateway.example.test/v1',
  model: 'gemini-4-argon',
  apiKey: 'secret-must-not-leak-to-errors',
  protocol: 'chat',
}

describe('OpenCode OPL Gateway Gemini pairing', () => {
  it('matches only the two supported Gateway Gemini model references', () => {
    const supported: ModelRef[] = [
      { provider: 'opl-gateway', model: 'gemini::gemini-4-argon' },
      { provider: 'opl-gateway', model: 'gemini::gemini-3.8-flash' },
    ]
    for (const ref of supported) {
      expect(isOpenCodeGatewayGeminiModel(ref)).toBe(true)
      expect(adapterFor(OPENCODE_HARNESS, ref)?.id).toBe(OPENCODE_HARNESS)
      expect(defaultHarness(ref)).toBe('antigravity')
    }
    expect(
      isOpenCodeGatewayGeminiModel({ provider: 'opl-gateway', model: 'gemini::gemini-3.1-pro' }),
    ).toBe(false)
    expect(
      adapterFor(OPENCODE_HARNESS, { provider: 'opl-gateway', model: 'gemini::gemini-3.1-pro' }),
    ).toBeUndefined()
    expect(
      isOpenCodeGatewayGeminiModel({ provider: 'opl-gateway', model: 'gemini::gemini-3.7-flash' }),
    ).toBe(false)
    expect(
      adapterFor(OPENCODE_HARNESS, { provider: 'opl-gateway', model: 'gemini::gemini-3.7-flash' }),
    ).toBeUndefined()
  })

  it('strips the Gateway group prefix only at the OpenCode wire boundary', () => {
    const ref = { provider: 'opl-gateway', model: 'gemini::gemini-4-argon' }
    expect(openCodeWireModel(ref)).toBe('gemini-4-argon')
    const config = buildOpenCodeRouteConfig(route, openCodeWireModel(ref)!)
    const parsed = JSON.parse(config.content) as {
      provider: Record<
        string,
        { options: { baseURL: string; apiKey: string }; models: Record<string, unknown> }
      >
    }
    expect(config.modelValue).toBe(openCodeModelValue('gemini-4-argon'))
    expect(parsed.provider.oplopencode.options.baseURL).toBe(route.baseURL)
    expect(parsed.provider.oplopencode.options.apiKey).toBe(route.apiKey)
    expect(parsed.provider.oplopencode.models).toEqual({
      'gemini-4-argon': { name: 'gemini-4-argon' },
    })
  })

  it('refuses a Gateway route whose resolved model differs', () => {
    expect(() =>
      buildOpenCodeRouteConfig({ ...route, model: 'gemini-3.1-pro' }, route.model),
    ).toThrow(/模型来源返回的模型/)
  })

  it('prepares an OPL Gateway route without registering an OFM source', async () => {
    const resolve = vi.fn(async () => route)
    const launch = await adapterFor(OPENCODE_HARNESS, {
      provider: 'opl-gateway',
      model: 'gemini::gemini-4-argon',
    })!.prepare!(
      {} as never,
      {
        id: 'gemini-opencode',
        combination: 'opencode/gemini::gemini-4-argon',
        harnessRef: OPENCODE_HARNESS,
        modelRef: { provider: 'opl-gateway', model: 'gemini::gemini-4-argon' },
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
    expect(resolve).toHaveBeenCalledWith(
      OPENCODE_HARNESS,
      { provider: 'opl-gateway', model: 'gemini::gemini-4-argon' },
      'chat',
    )
    const content = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT!) as {
      provider: { oplopencode: { models: Record<string, unknown> } }
    }
    expect(content.provider.oplopencode.models).toEqual({
      'gemini-4-argon': { name: 'gemini-4-argon' },
    })
  })
})
