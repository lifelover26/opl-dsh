import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  qwenCodeAdapter,
  assertQwenRoute,
  assertQwenSession,
} from '../../../src/execution/host/adapters/qwen/qwen.ts'
import {
  QWEN_ACP_MODEL,
  QWEN_MODEL,
  isQwenModel,
} from '../../../src/execution/host/adapters/qwen/models.ts'
import type { HarnessSession } from '../../../src/execution/contracts/sessions.ts'
import type {
  AdapterLaunch,
  AdapterOptions,
  AcpSessionSnapshot,
} from '../../../src/execution/host/adapters/types.ts'
const mocks = vi.hoisted(() => ({ executablePath: vi.fn(async () => process.execPath) }))
vi.mock('../../../src/execution/host/harness-registry.ts', () => ({
  executablePath: mocks.executablePath,
  commandLaunch: (command: string, args: string[]) => ({ command, args }),
}))
vi.mock('../../../src/execution/host/adapters/qwen/shell.ts', () => ({
  qwenShellEnvironment: vi.fn(async (env: NodeJS.ProcessEnv) => ({ ...env, MSYSTEM: 'MINGW64' })),
}))
const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
function record(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'qwen-test',
    combination: 'ofm-qwen',
    harnessRef: 'qwen-code',
    modelRef: { provider: 'our-free-model', model: QWEN_MODEL },
    acpSessionId: '',
    cwd: '.',
    title: 'Qwen',
    sandbox: 'full-access',
    origin: { kind: 'harness', sessionId: 'qwen-test' },
    turns: [],
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z',
    ...overrides,
  }
}
function snapshot(): AcpSessionSnapshot {
  return {
    agent: {},
    session: {
      models: {
        currentModelId: QWEN_ACP_MODEL,
        availableModels: [
          {
            modelId: QWEN_ACP_MODEL,
            _meta: {
              baseModelId: QWEN_MODEL,
              authType: 'openai',
              envKey: 'OPENAI_API_KEY',
              baseUrl: 'http://127.0.0.1:8181/v1',
            },
          },
        ],
      },
      modes: { currentModeId: 'yolo' },
    },
    configOptions: [
      { id: 'model', type: 'select', currentValue: QWEN_ACP_MODEL },
      { id: 'mode', type: 'select', currentValue: 'yolo' },
      { id: 'reasoning_effort', type: 'select', currentValue: 'default' },
    ],
  }
}
const launch = {
  home: '.',
  command: 'qwen',
  args: [],
  env: { OPENAI_BASE_URL: 'http://127.0.0.1:8181/v1' },
} satisfies AdapterLaunch

describe('Qwen Code exact source and model binding', () => {
  it('admits only the exact EAC provider and model', () => {
    expect(isQwenModel(record().modelRef)).toBe(true)
    for (const model of ['Qwen3.8-27B', 'amd/qwen3.8-27b', QWEN_MODEL + ' ', 'other/Qwen3.8-27B'])
      expect(isQwenModel({ provider: 'our-free-model', model })).toBe(false)
    expect(isQwenModel({ provider: 'opl-gateway', model: QWEN_MODEL })).toBe(false)
  })
  it('accepts the qualified ACP identity while retaining the exact wire model', async () => {
    const request = vi.fn()
    const result = await qwenCodeAdapter.configureSession!(
      { request },
      record(),
      snapshot(),
      launch,
    )
    expect(result).toEqual({ modelId: QWEN_ACP_MODEL, configOptions: snapshot().configOptions })
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['baseUrl', 'baseModelId', 'authType', 'envKey'])(
    'refuses a project overriding source %s',
    (field) => {
      const state = snapshot()
      state.session.models.availableModels[0]._meta[field] = 'different-source'
      expect(() => assertQwenRoute(state, launch)).toThrow(/来源接口/)
    },
  )
  it('requires actual launch data and a unique source advertisement', () => {
    expect(() => assertQwenRoute(snapshot(), undefined)).toThrow(/来源接口/)
    const state = snapshot()
    state.session.models.availableModels.push(state.session.models.availableModels[0])
    expect(() => assertQwenRoute(state, launch)).toThrow(/来源接口/)
  })
  it.each(['models', 'modes'])('refuses a changed %s readback', (field) => {
    const state = snapshot()
    if (field === 'models') state.session.models.currentModelId = 'other'
    else state.session.modes.currentModeId = 'default'
    expect(() => assertQwenSession(state)).toThrow(/未确认/)
  })
  it.each(['mode', 'model', 'reasoning_effort'])('refuses config drift for %s', (id) => {
    const state = snapshot()
    ;(state.configOptions as { id: string; currentValue: string }[]).find(
      (x) => x.id === id,
    )!.currentValue = 'other'
    expect(() => assertQwenSession(state)).toThrow(/已改变|默认推理/)
  })
  it.each([{ sandbox: 'workspace' }, { reasoningEffort: 'high' }, { externalAutoReview: true }])(
    'refuses unsupported runtime settings %j',
    async (overrides) => {
      await expect(
        qwenCodeAdapter.configureSession!(
          { request: vi.fn() },
          record(overrides as Partial<HarnessSession>),
          snapshot(),
          launch,
        ),
      ).rejects.toThrow(/未启动|未发送/)
    },
  )
  it('never falls back to OAuth and sanitizes authentication failure', async () => {
    const request = vi.fn(async () => {
      throw Error('test-secret')
    })
    await expect(
      qwenCodeAdapter.authenticate!({ request }, record(), { authMethods: [{ id: 'qwen-oauth' }] }),
    ).rejects.toThrow(/未广告/)
    expect(request).not.toHaveBeenCalled()
    await expect(
      qwenCodeAdapter.authenticate!({ request }, record(), { authMethods: [{ id: 'openai' }] }),
    ).rejects.toThrow('官方 Qwen Code：OpenAI 兼容接口认证失败，未发送任务。')
  })
  it('refuses images and an empty successful turn', () => {
    expect(() =>
      qwenCodeAdapter.verifyPrompt!(record(), snapshot(), [
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
      ]),
    ).toThrow(/图片/)
    expect(
      qwenCodeAdapter.acceptResult!({ stopReason: 'end_turn', text: '', tools: [] }),
    ).toMatchObject({ accepted: false })
  })
  it('writes a credential-free profile and keeps the source key only in process env', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qwen-adapter-'))
    roots.push(home)
    const route = {
      baseURL: 'http://127.0.0.1:8181/v1',
      apiKey: 'test-secret-key',
      model: QWEN_MODEL,
      protocol: 'chat',
      contextWindow: 128000,
    }
    const assertCurrent = vi.fn()
    const options = {
      home,
      command: process.execPath,
      prefix: [fileURLToPath(new URL('./version-fixture.mjs', import.meta.url))],
      modelSources: { lease: () => ({ assertCurrent }), resolve: async () => route },
    } as unknown as AdapterOptions
    const cwd = 'C:/Users/test/Qwen Workspace'
    const actual = await qwenCodeAdapter.prepare!({} as never, record({ cwd }), options)
    const file = await readFile(join(home, 'qwen/settings.json'), 'utf8')
    expect(file).not.toContain('test-secret-key')
    expect(actual.env.OPENAI_API_KEY).toBe('test-secret-key')
    expect(actual.env.OPENAI_BASE_URL).toBe(route.baseURL)
    expect(actual.args).toContain('--acp')
    expect(actual.args).toContain(QWEN_MODEL)
    expect(actual.promptImageSupport).toBe(false)
    expect(actual.acpCwd).toBe(process.platform === 'win32' ? win32.normalize(cwd) : cwd)
    expect(assertCurrent).toHaveBeenCalledTimes(2)
    expect(JSON.parse(file).modelProviders.openai[0].generationConfig.contextWindowSize).toBe(
      128000,
    )
  })
})
