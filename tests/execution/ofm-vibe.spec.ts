import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessConfigurationError } from '../../src/execution/host/acp.ts'
import { ExternalModelSources } from '../../src/execution/host/model-sources.ts'
import type { ExternalModelRoute } from '../../src/execution/host/model-sources.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { AcpSessionSnapshot, AdapterOptions } from '../../src/execution/host/adapters/types.ts'
import type { OpenCodeShellBinding } from '../../src/execution/host/adapters/opencode/opencode-shell.ts'
import {
  vibeAdapter,
  VIBE_MODEL,
  VIBE_ALIAS,
  VIBE_CREDENTIAL,
} from '../../src/execution/host/adapters/vibe.ts'

const preflight = vi.hoisted(() => ({
  version: vi.fn(),
  executable: vi.fn(),
  shell: vi.fn(),
  afterWrite: undefined as (() => void) | undefined,
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  // Version qualification uses no process or inherited host credentials in these tests.
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: preflight.version,
  }),
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const result = await actual.writeFile(...args)
      preflight.afterWrite?.()
      return result
    },
  }
})
vi.mock('../../src/execution/host/harness-registry.ts', async (original) => ({
  ...(await original<typeof import('../../src/execution/host/harness-registry.ts')>()),
  executablePath: preflight.executable,
}))
vi.mock('../../src/execution/host/adapters/environment.ts', () => ({
  systemEnvironment: () => ({ PATH: '/fixture/system-bin', HOME: '/fixture/user-home' }),
}))
vi.mock('../../src/execution/host/adapters/opencode/opencode-shell.ts', () => ({
  openCodeShellBinding: preflight.shell,
}))

const ctx = { effect: (effect: () => () => void) => effect() } as unknown as Context
const ref = { provider: 'our-free-model', model: VIBE_MODEL }
const record = {
  modelRef: ref,
  sandbox: 'full-access',
  acpSessionId: 'persisted-session',
} as HarnessSession
const route: ExternalModelRoute = {
  baseURL: 'https://relay.example.test/v1',
  model: VIBE_MODEL,
  apiKey: 'vibe-fixture-credential-only',
  protocol: 'chat',
}
const shell = resolve('fixture/Git with spaces/bin/bash.exe')
const executable = resolve('fixture/Vibe with spaces/vibe-acp.exe')
const binding = (env: NodeJS.ProcessEnv): OpenCodeShellBinding => ({
  config: { shell },
  env: { ...env, SHELL: shell },
  uname: 'MINGW64_NT-10.0',
})
const roots: string[] = []

function sourceFixture(answer = route) {
  let supported = true
  const sources = new ExternalModelSources(ctx)
  const source = {
    provider: ref.provider,
    supports: (harness: string, candidate: typeof ref) =>
      supported &&
      harness === 'vibe' &&
      candidate.provider === ref.provider &&
      candidate.model === ref.model,
    resolve: vi.fn(async () => answer),
  }
  const remove = sources.register(ctx, source)
  return {
    sources,
    source,
    remove,
    withdraw: () => {
      supported = false
    },
  }
}

async function options(modelSources: ExternalModelSources): Promise<AdapterOptions> {
  const home = await mkdtemp(join(tmpdir(), 'opl-vibe-review-'))
  roots.push(home)
  return {
    home,
    command: executable,
    prefix: [],
    grokCommand: '',
    nativeBridgePath: '',
    modelSources,
  }
}

function config(model = VIBE_ALIAS, mode = 'auto-approve', thinking = 'off') {
  return [
    {
      id: 'model',
      type: 'select',
      currentValue: model,
      options: [{ value: VIBE_ALIAS, description: VIBE_MODEL }],
    },
    { id: 'mode', type: 'select', currentValue: mode, options: [{ value: 'auto-approve' }] },
    { id: 'thinking', type: 'select', currentValue: thinking, options: [{ value: 'off' }] },
  ]
}
const snapshot = (configOptions: unknown = config()): AcpSessionSnapshot => ({
  agent: { agentInfo: { name: '@mistralai/mistral-vibe', version: '3.0.4' } },
  session: { sessionId: 'owned', modes: { currentModeId: 'auto-approve' } },
  configOptions,
})

beforeEach(() => {
  preflight.version.mockReset().mockResolvedValue({ stdout: 'vibe-acp.exe 3.0.4\n', stderr: '' })
  preflight.executable.mockReset().mockResolvedValue(executable)
  preflight.shell.mockReset().mockImplementation(async (env) => binding(env))
  preflight.afterWrite = undefined
})
afterEach(async () => {
  preflight.afterWrite = undefined
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
})

describe('Mistral Vibe launch preparation', () => {
  it('writes a credential reference and pins verified Bash ahead of inherited PATH', async () => {
    const fixture = sourceFixture()
    const settings = await options(fixture.sources)
    const launch = await vibeAdapter.prepare!(ctx, record, settings)
    const content = await readFile(join(launch.env.VIBE_HOME!, 'config.toml'), 'utf8')
    expect(fixture.source.resolve).toHaveBeenCalledWith('vibe', ref)
    expect(launch.command).toBe(executable)
    expect(launch.args).toEqual([])
    expect(launch.env.PATH?.split(delimiter)[0]).toBe(dirname(shell))
    expect(launch.env.HOME).toBe('/fixture/user-home')
    expect(launch.env[VIBE_CREDENTIAL]).toBe(route.apiKey)
    expect(launch.env.VIBE_HOME).toBe(join(settings.home, 'vibe'))
    expect(content).toContain(`api_key_env_var = "${VIBE_CREDENTIAL}"`)
    expect(content).toContain(`api_base = "${route.baseURL}"`)
    expect(content).toContain(`name = "${VIBE_MODEL}"`)
    expect(content).toContain(`allowed_models = ["${VIBE_MODEL}"]`)
    expect(content).toContain('api_retry_max_elapsed_time = 0')
    expect(content).not.toContain(route.apiKey)
    expect(JSON.stringify(launch.args)).not.toContain(route.apiKey)
    expect(content).not.toMatch(/^thinking\s*=/m)
    expect(content).not.toContain('api_key =')
  })

  it.each(['3.0.4\n', 'vibe-acp 3.0.4\n', 'vibe-acp.exe 3.0.4\r\n'])(
    'accepts the official version output %j',
    async (stdout) => {
      preflight.version.mockResolvedValue({ stdout, stderr: '' })
      const { sources } = sourceFixture()
      await expect(vibeAdapter.prepare!(ctx, record, await options(sources))).resolves.toBeDefined()
    },
  )

  it.each(['3.0.3', '3.0.40', 'unknown 3.0.4'])(
    'refuses an unqualified version %s before profile writes',
    async (stdout) => {
      preflight.version.mockResolvedValue({ stdout, stderr: '' })
      const { sources } = sourceFixture()
      const settings = await options(sources)
      await expect(vibeAdapter.prepare!(ctx, record, settings)).rejects.toThrow('3.0.4')
      await expect(access(join(settings.home, 'vibe', 'config.toml'))).rejects.toThrow()
      expect(preflight.shell).not.toHaveBeenCalled()
    },
  )

  it.each(['remove', 'replace', 'withdraw'] as const)(
    'refuses a source that is %s during Bash qualification',
    async (change) => {
      const fixture = sourceFixture()
      preflight.shell.mockImplementationOnce(async (env) => {
        if (change === 'withdraw') fixture.withdraw()
        else {
          fixture.remove()
          if (change === 'replace') fixture.sources.register(ctx, fixture.source)
        }
        return binding(env)
      })
      const settings = await options(fixture.sources)
      await expect(vibeAdapter.prepare!(ctx, record, settings)).rejects.toThrow('模型来源已变更')
      await expect(access(join(settings.home, 'vibe', 'config.toml'))).rejects.toThrow()
      if (change === 'replace') expect(fixture.sources.supports('vibe', ref)).toBe(true)
    },
  )

  it('refuses source disposal during the final profile write', async () => {
    const fixture = sourceFixture()
    const settings = await options(fixture.sources)
    preflight.afterWrite = fixture.remove
    await expect(vibeAdapter.prepare!(ctx, record, settings)).rejects.toThrow('模型来源已变更')
    const content = await readFile(join(settings.home, 'vibe', 'config.toml'), 'utf8')
    expect(content).not.toContain(route.apiKey)
  })

  it('refuses a different source model before resolving the executable or writing a profile', async () => {
    const { sources } = sourceFixture({ ...route, model: 'mistral-medium-3.5' })
    const settings = await options(sources)
    await expect(vibeAdapter.prepare!(ctx, record, settings)).rejects.toThrow('不同模型')
    expect(preflight.executable).not.toHaveBeenCalled()
    await expect(access(join(settings.home, 'vibe', 'config.toml'))).rejects.toThrow()
  })

  it('refuses unverified Bash without returning a launch', async () => {
    preflight.shell.mockRejectedValue(
      new HarnessConfigurationError('Git Bash qualification failed'),
    )
    const { sources } = sourceFixture()
    const settings = await options(sources)
    await expect(vibeAdapter.prepare!(ctx, record, settings)).rejects.toThrow(
      'Git Bash qualification failed',
    )
    await expect(access(join(settings.home, 'vibe', 'config.toml'))).rejects.toThrow()
  })
})

describe('Mistral Vibe restored session checks', () => {
  it('re-pins the persisted ID when session/load omits it', async () => {
    const restored = snapshot(config('mistral-medium-3.5'))
    delete restored.session.sessionId
    const request = vi.fn().mockResolvedValue({ configOptions: config() })
    const configured = await vibeAdapter.configureSession!({ request }, record, restored)
    expect(request).toHaveBeenCalledExactlyOnceWith('session/set_config_option', {
      sessionId: record.acpSessionId,
      configId: 'model',
      value: VIBE_ALIAS,
    })
    expect(() =>
      vibeAdapter.verifySession!(record, { ...restored, configOptions: configured?.configOptions }),
    ).not.toThrow()
  })

  it.each(['model', 'mode', 'thinking'] as const)(
    'refuses %s drift after an acknowledged model write',
    async (changed) => {
      const options = config()
      options.find((item) => item.id === changed)!.currentValue =
        changed === 'thinking' ? 'high' : 'other-value'
      const request = vi.fn().mockResolvedValue({ configOptions: options })
      await expect(vibeAdapter.configureSession!({ request }, record, snapshot())).rejects.toThrow(
        HarnessConfigurationError,
      )
    },
  )

  it.each(['model', 'mode', 'thinking'] as const)('refuses %s drift before a prompt', (changed) => {
    const options = config()
    options.find((item) => item.id === changed)!.currentValue =
      changed === 'thinking' ? 'high' : 'other-value'
    expect(() => vibeAdapter.verifySession!(record, snapshot(options))).toThrow(
      HarnessConfigurationError,
    )
  })

  it('refuses a restored thinking choice before any config write', async () => {
    const request = vi.fn()
    await expect(
      vibeAdapter.configureSession!(
        { request },
        record,
        snapshot(config(VIBE_ALIAS, 'auto-approve', 'high')),
      ),
    ).rejects.toThrow('推理档位')
    expect(request).not.toHaveBeenCalled()
  })

  it('requires both permission advertisements to agree on full access', async () => {
    const contradictory = snapshot()
    contradictory.session.modes.currentModeId = 'ask'
    const request = vi.fn()
    await expect(vibeAdapter.configureSession!({ request }, record, contradictory)).rejects.toThrow(
      '完全访问',
    )
    expect(() => vibeAdapter.verifySession!(record, contradictory)).toThrow('完全访问')
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a same-alias model with a different wire identity', async () => {
    const options = config()
    options[0]!.options[0]!.description = 'mistral-medium-3.5'
    const request = vi.fn()
    await expect(
      vibeAdapter.configureSession!({ request }, record, snapshot(options)),
    ).rejects.toThrow('未广告')
    expect(request).not.toHaveBeenCalled()
  })
})
