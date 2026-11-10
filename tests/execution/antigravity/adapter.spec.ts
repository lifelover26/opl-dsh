import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { antigravityAdapter } from '../../../src/execution/host/adapters/antigravity/antigravity.ts'
import {
  antigravityConfigOption,
  antigravityWireModel,
} from '../../../src/execution/host/adapters/antigravity/models.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type { AcpSessionSnapshot } from '../../../src/execution/host/adapters/types.ts'

const launchMocks = vi.hoisted(() => ({
  executablePath: vi.fn(async () => 'C:/managed tools/agy.exe'),
  resolveNativeGitBash: vi.fn(() => 'C:/Program Files/Git/bin/bash.exe'),
}))
vi.mock('../../../src/execution/host/harness-registry.ts', () => ({
  executablePath: launchMocks.executablePath,
}))
vi.mock('../../../src/execution/host/adapters/native-bash.ts', () => ({
  resolveNativeGitBash: launchMocks.resolveNativeGitBash,
}))

function record(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'gemini-owned-session',
    combination: 'gateway/antigravity/argon',
    harnessRef: 'antigravity',
    modelRef: { provider: 'opl-gateway', model: 'gemini::gemini-4-argon' },
    reasoningEffort: 'high',
    cwd: 'C:/workspace with spaces',
    acpSessionId: 'vendor-session',
    title: 'Gemini',
    sandbox: 'full-access',
    origin: { kind: 'harness', sessionId: 'gemini-owned-session' },
    turns: [],
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...overrides,
  }
}

function options(model: string, thinking: string, offeredThinking = ['low', 'medium', 'high']) {
  return [
    {
      id: 'model',
      type: 'select',
      currentValue: model,
      options: ['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-4-argon'].map((value) => ({ value })),
    },
    {
      id: 'thought_level',
      type: 'select',
      currentValue: thinking,
      options: offeredThinking.map((value) => ({ value })),
    },
  ]
}

function snapshot(configOptions: unknown = options('gemini-3.1-pro', 'low', ['low', 'high'])) {
  return {
    agent: {
      agentInfo: { name: 'Antigravity', version: '1.5.3' },
      agentCapabilities: { promptCapabilities: { image: true } },
    },
    session: { sessionId: 'vendor-session', models: { currentModelId: 'gemini-3.1-pro-low' } },
    configOptions,
  } satisfies AcpSessionSnapshot
}

afterEach(() => vi.clearAllMocks())

describe('Antigravity model and thinking pinning', () => {
  it('selects only the advertised API-key authentication method', async () => {
    const request = vi.fn(async () => ({}))
    await antigravityAdapter.authenticate!({ request }, record(), {
      agentInfo: { version: '1.5.3' },
      authMethods: [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }],
    })
    expect(request).toHaveBeenCalledExactlyOnceWith('authenticate', { methodId: 'gemini-api-key' })
  })

  it('does not fall back to Google login or leak a failed authentication response', async () => {
    const request = vi.fn(async () => {
      throw Error('private-key')
    })
    await expect(
      antigravityAdapter.authenticate!({ request }, record(), {
        agentInfo: { version: '1.5.3' },
        authMethods: [{ id: 'oauth-personal' }],
      }),
    ).rejects.toThrow(/未广告 Gemini API Key 认证/)
    expect(request).not.toHaveBeenCalled()
    await expect(
      antigravityAdapter.authenticate!({ request }, record(), {
        agentInfo: { version: '1.5.3' },
        authMethods: [{ id: 'gemini-api-key' }],
      }),
    ).rejects.toThrow(
      'Antigravity（agy 1.5.3）Gemini API Key 认证失败，未登录 Google 账号，也未发送任务。',
    )
  })

  it('matches only native Gemini models in the OPL Gemini group', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-4-argon']) {
      const ref = { provider: 'opl-gateway', model: `gemini::${model}` }
      expect(antigravityAdapter.matches(ref)).toBe(true)
      expect(antigravityWireModel(ref)).toBe(model)
    }
    for (const ref of [
      { provider: 'our-free-model', model: 'gemini::gemini-4-argon' },
      { provider: 'opl-gateway', model: 'gemini-4-argon' },
      { provider: 'opl-gateway', model: 'codex::gemini-4-argon' },
      { provider: 'opl-gateway', model: 'gemini::gemini-3.1-pro' },
      { provider: 'opl-gateway', model: 'gemini::gemini-4-argon-high' },
    ])
      expect(antigravityAdapter.matches(ref)).toBe(false)
  })

  it.each(['gemini-3.8-flash', 'gemini-4-argon'])(
    'replaces the new/load default, then reads the new thinking advertisement for %s',
    async (model) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ configOptions: options(model, 'low') })
        .mockResolvedValueOnce({ configOptions: options(model, 'high') })
      const configured = await antigravityAdapter.configureSession!(
        { request },
        record({ modelRef: { provider: 'opl-gateway', model: `gemini::${model}` } }),
        snapshot(),
      )
      expect(request.mock.calls).toEqual([
        [
          'session/set_config_option',
          { sessionId: 'vendor-session', configId: 'model', value: model },
        ],
        [
          'session/set_config_option',
          { sessionId: 'vendor-session', configId: 'thought_level', value: 'high' },
        ],
      ])
      expect(configured).toEqual({ configOptions: options(model, 'high'), modelId: model })
    },
  )

  it('pins the explicit high default when no effort was selected', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ configOptions: options('gemini-4-argon', 'low') })
      .mockResolvedValueOnce({ configOptions: options('gemini-4-argon', 'high') })
    const selected = record()
    delete selected.reasoningEffort
    await antigravityAdapter.configureSession!({ request }, selected, snapshot())
    expect(request.mock.calls[1]?.[1]).toMatchObject({ configId: 'thought_level', value: 'high' })
  })

  it.each(['max', 'xhigh', '', 'HIGH'])(
    'refuses unsupported effort %j without writing config',
    async (effort) => {
      const request = vi.fn()
      await expect(
        antigravityAdapter.configureSession!(
          { request },
          record({ reasoningEffort: effort }),
          snapshot(),
        ),
      ).rejects.toThrow(/只支持 low、medium、high/)
      expect(request).not.toHaveBeenCalled()
    },
  )

  it('refuses an unoffered model before trying a config write', async () => {
    const request = vi.fn()
    const current = snapshot(
      options('gemini-3.1-pro', 'low').map((option) => ({
        ...option,
        options: option.id === 'model' ? [{ value: 'gemini-3.1-pro' }] : option.options,
      })),
    )
    await expect(
      antigravityAdapter.configureSession!({ request }, record(), current),
    ).rejects.toThrow(/agy 1.5.3.*未广告要求的 model=gemini-4-argon/)
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses the model setter returning a different model', async () => {
    const request = vi.fn(async () => ({ configOptions: options('gemini-3.8-flash', 'low') }))
    await expect(
      antigravityAdapter.configureSession!({ request }, record(), snapshot()),
    ).rejects.toThrow(/未确认所选的 model=gemini-4-argon/)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects model drift introduced by the thinking setter', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ configOptions: options('gemini-4-argon', 'low') })
      .mockResolvedValueOnce({ configOptions: options('gemini-3.8-flash', 'high') })
    await expect(
      antigravityAdapter.configureSession!({ request }, record(), snapshot()),
    ).rejects.toThrow(/未确认所选的 model=gemini-4-argon/)
  })

  it('does not expose vendor error text if applying a config fails', async () => {
    const request = vi.fn(async () => {
      throw Error('secret-token https://private.example.test')
    })
    await expect(
      antigravityAdapter.configureSession!({ request }, record(), snapshot()),
    ).rejects.toThrow('Antigravity（agy 1.5.3）拒绝应用 model=gemini-4-argon，已停止，未发送任务。')
  })

  it('rejects model and effort drift before a prompt', () => {
    expect(() =>
      antigravityAdapter.verifySession!(record(), snapshot(options('gemini-4-argon', 'high'))),
    ).not.toThrow()
    expect(() =>
      antigravityAdapter.verifySession!(record(), snapshot(options('gemini-3.8-flash', 'high'))),
    ).toThrow(/model=gemini-4-argon/)
    expect(() =>
      antigravityAdapter.verifySession!(record(), snapshot(options('gemini-4-argon', 'low'))),
    ).toThrow(/thought_level=high/)
  })

  it('rejects ambiguous or malformed advertisements', () => {
    const [model] = options('gemini-4-argon', 'high')
    for (const input of [
      undefined,
      [model, model],
      [{ ...model, type: 'text' }],
      [{ ...model, currentValue: 'missing' }],
      [{ ...model, options: [{ value: 'gemini-4-argon' }, { value: 'gemini-4-argon' }] }],
      [{ ...model, options: [null] }],
    ])
      expect(antigravityConfigOption(input, 'model')).toBeUndefined()
  })
})

describe('Antigravity launch and result handling', () => {
  function prepare(
    selected = record(),
    resolve = vi.fn(async () => ({
      baseURL: 'https://gateway.example.test',
      model: 'gemini-4-argon',
      apiKey: 'owned-key',
      protocol: 'gemini-native',
      imageInput: true,
    })),
  ) {
    return {
      resolve,
      started: antigravityAdapter.prepare!({} as never, selected, {
        home: 'C:/owned adapter data',
        command: 'C:/managed tools/agy.exe',
        prefix: ['--fixture-entry'],
        grokCommand: '',
        nativeBridgePath: 'C:/installed plugin/native-harness-bridge.mjs',
        modelSources: { resolve } as never,
      }),
    }
  }

  it('hands the native route only to the private bridge environment', async () => {
    const { resolve, started } = prepare()
    const launch = await started
    expect(resolve).toHaveBeenCalledWith('antigravity', record().modelRef, 'gemini-native')
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual([
      '--expose-internals',
      join('C:/installed plugin', 'antigravity-bridge.mjs'),
    ])
    expect(launch.args.join(' ')).not.toContain('owned-key')
    expect(launch.env.OPL_AGY_COMMAND).toBe('C:/managed tools/agy.exe')
    expect(launch.env.OPL_AGY_ARGS).toBe('["--fixture-entry"]')
    expect(JSON.parse(launch.env.OPL_AGY_ROUTE!)).toMatchObject({
      apiKey: 'owned-key',
      protocol: 'gemini-native',
    })
    expect(launch.env.OPL_AGY_PROFILE).toContain('antigravity')
    expect(launch.env.OPL_AGY_WORKSPACE).toBe(record().cwd)
    expect(launch.promptImageSupport).toBe(true)
  })

  it('rejects restricted permission before resolving a key or program', async () => {
    const { resolve, started } = prepare(record({ sandbox: 'workspace' }))
    await expect(started).rejects.toThrow(/只支持完全权限/)
    expect(resolve).not.toHaveBeenCalled()
    expect(launchMocks.executablePath).not.toHaveBeenCalled()
  })

  it('does not accept a resolver that substitutes a model', async () => {
    const resolve = vi.fn(async () => ({
      baseURL: 'https://gateway.example.test',
      model: 'gemini-3.1-pro',
      apiKey: 'owned-key',
      protocol: 'gemini-native',
      imageInput: true,
    }))
    await expect(prepare(record(), resolve).started).rejects.toThrow(/不同的 Gemini 模型或协议/)
    expect(launchMocks.executablePath).not.toHaveBeenCalled()
  })

  it('requires the actual ACP image capability', () => {
    const prompt = [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] as const
    expect(() => antigravityAdapter.verifyPrompt!(record(), snapshot(), prompt)).not.toThrow()
    const noImage = snapshot()
    noImage.agent.agentCapabilities.promptCapabilities.image = false
    expect(() => antigravityAdapter.verifyPrompt!(record(), noImage, prompt)).toThrow(
      /未声明图片输入/,
    )
  })

  it('treats the official terminal error marker as failed even with end_turn', () => {
    expect(
      antigravityAdapter.acceptResult!({
        stopReason: 'end_turn',
        text: '\n⚠ Agent execution terminated due to error.\n',
        tools: [{ status: 'completed' }],
      }),
    ).toMatchObject({ accepted: false })
    expect(
      antigravityAdapter.acceptResult!({
        stopReason: 'end_turn',
        text: 'The example error is handled by the test.',
        tools: [],
      }),
    ).toBeUndefined()
  })
})
