import * as harnessRegistry from '../../src/execution/host/harness-registry.ts'
import { beforeEach } from 'vitest'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { harnessAdapters } from '../../src/execution/host/adapters/index.ts'
import { commandLaunch } from '../../src/execution/host/harness-registry.ts'
import type { HarnessAdapter } from '../../src/execution/host/adapters/types.ts'
import { testPeerConnection } from '../test-peer.ts'
import {
  claudeGitBashProblem,
  codexAllowsGitBash,
  codexGitBashOptIn,
  codexGitBashProblem,
  codexSandboxMode,
  codexShellProbeCommand,
  gitBashCandidates,
  nativeGitBashEnv,
  readShellProbe,
  resolveNativeGitBash,
} from '../../src/execution/host/adapters/native-bash.ts'
import {
  resolveGitBashPath,
  gitBashCandidates as officialGitBashCandidates,
} from '../../src/shell/host/git-bash.ts'

const registeredAdapters: (() => void)[] = []
/**
 * Register a harness whose full-access capability is genuinely unknown.
 *
 * The rejection rule is about capability evidence, not about a particular CLI, so the cases
 * that must keep failing closed use a harness that can never have been verified. Pinning them
 * to a real CLI would silently change their meaning once that CLI is verified.
 * @returns the registered harness id.
 */
async function useUnknownCapabilityHarness(): Promise<string> {
  const id = 'acme-unknown-cli'
  const adapter: HarnessAdapter = {
    id,
    capabilities: {
      transport: 'acp',
      authentication: 'api-source',
      protocols: ['responses'],
      customEndpoint: false,
      permissions: ['read-only', 'workspace'],
      sessionLoad: true,
      cancel: true,
      reasoning: 'none',
      autoReview: 'unsupported',
    },
    transport: 'acp',
    matches: () => true,
    available: async () => ({ available: true }),
    prepare: async (_ctx, _record, options) => ({
      home: join(options.home, 'harnesses', id),
      ...commandLaunch(options.command ?? process.execPath, ['stdio']),
      env: {},
    }),
  }
  harnessAdapters.push(adapter)
  registeredAdapters.push(() => {
    const index = harnessAdapters.indexOf(adapter)
    if (index >= 0) harnessAdapters.splice(index, 1)
  })
  return id
}

const WINDOWS = process.platform === 'win32'
/** A Git for Windows layout on this machine, used for the real execution assertions. */
const realGitBash = WINDOWS ? resolveNativeGitBash() : undefined
const installedGit = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git')

describe('native Git Bash resolution', () => {
  it('leaves POSIX hosts untouched so macOS and Linux keep the official behaviour', () => {
    for (const kind of ['codex', 'claude'] as const)
      for (const permission of ['read-only', 'workspace', 'full-access'] as const)
        expect(nativeGitBashEnv(kind, permission, { platform: 'linux' })).toEqual({})
    expect(resolveNativeGitBash({ platform: 'darwin' })).toBeUndefined()
  })

  it('searches the same installation roots as the suite Git Bash provider', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    }
    // The native harnesses and the local shell must never disagree about which bash is used.
    expect(gitBashCandidates(env)).toEqual(officialGitBashCandidates(env))
    expect(gitBashCandidates(env)).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
      'C:\\Users\\test\\AppData\\Local\\Git\\bin\\bash.exe',
      'C:\\Users\\test\\AppData\\Local\\Git\\usr\\bin\\bash.exe',
    ])
  })

  it('agrees with the suite provider on this machine', { skip: !WINDOWS }, () => {
    // Both must name the same executable, otherwise the local shell and the native
    // harnesses would silently disagree about which bash is in use.
    expect(resolveNativeGitBash()).toBe(resolveGitBashPath())
  })

  it('rejects an explicit but unusable path instead of falling back', { skip: !WINDOWS }, () => {
    expect(() =>
      resolveNativeGitBash({
        platform: 'win32',
        env: { OPL_GIT_BASH_PATH: 'C:/not-installed/bash.exe' },
      }),
    ).toThrow(/no fallback/)
    expect(() =>
      nativeGitBashEnv('claude', 'workspace', {
        platform: 'win32',
        env: { OPL_GIT_BASH_PATH: 'C:/not-installed/bash.exe' },
      }),
    ).toThrow(/no fallback/)
  })

  it('returns no patch when no Git Bash is installed', () => {
    expect(
      nativeGitBashEnv('claude', 'workspace', {
        platform: 'win32',
        env: { PATH: '' },
        exists: () => false,
      }),
    ).toEqual({})
  })

  it('honours a path the Host already resolved', () => {
    expect(
      nativeGitBashEnv('claude', 'workspace', {
        platform: 'win32',
        bash: 'C:\\Program Files\\Git\\bin\\bash.exe',
        exists: () => true,
      }),
    ).toEqual({ CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' })
  })
})

describe('official harness shell variables', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const exists = (path: string) => path === bash || path.endsWith('cmd\\git.exe')
  const optIn = { OPL_NATIVE_CODEX_GIT_BASH: '1' }

  it('never assumes Git Bash for Codex, because upstream Codex has no such interface', () => {
    // The variable exists only in a local patch build, so it is never applied by default.
    expect(codexGitBashOptIn({})).toBe(false)
    expect(nativeGitBashEnv('codex', 'full-access', { platform: 'win32', bash, exists })).toEqual(
      {},
    )
    // Even a resolved Git Bash on this machine does not switch Codex on its own.
    expect(
      nativeGitBashEnv('codex', 'full-access', { platform: 'win32', bash, exists, env: {} }),
    ).toEqual({})
  })

  it('offers Git Bash to Codex only after an explicit opt-in and the profile it accepts', () => {
    expect(codexSandboxMode('read-only')).toBe('read-only')
    expect(codexSandboxMode('workspace')).toBe('workspace-write')
    expect(codexSandboxMode('full-access')).toBe('danger-full-access')
    // Codex refuses to start a session when the path is set under a restricted profile,
    // so the variable has to stay absent rather than be set and left to fail.
    expect(codexAllowsGitBash('read-only')).toBe(false)
    expect(codexAllowsGitBash('workspace')).toBe(false)
    expect(codexAllowsGitBash('full-access')).toBe(true)
    for (const permission of ['read-only', 'workspace'] as const)
      expect(() =>
        nativeGitBashEnv('codex', permission, { platform: 'win32', bash, exists, env: optIn }),
      ).toThrow(/不会为 Bash 扩大受限任务的权限/)
    expect(
      nativeGitBashEnv('codex', 'full-access', { platform: 'win32', bash, exists, env: optIn }),
    ).toEqual({
      CODEX_NATIVE_GIT_BASH_PATH: bash,
    })
  })

  it('does not escalate a restricted profile to reach Git Bash', () => {
    for (const permission of ['read-only', 'workspace'] as const) {
      // Without the opt-in nothing is requested, so the harness keeps its own shell.
      expect(
        nativeGitBashEnv('codex', permission, { platform: 'win32', bash, exists, env: {} }),
      ).toEqual({})
      // With the opt-in the request fails instead of quietly widening the task.
      expect(() =>
        nativeGitBashEnv('codex', permission, { platform: 'win32', bash, exists, env: optIn }),
      ).toThrow()
      expect(codexSandboxMode(permission)).not.toBe('danger-full-access')
    }
  })

  it('fails an explicit request instead of silently dropping it', () => {
    // Restricted permission plus an explicit Git Bash request.
    expect(() =>
      nativeGitBashEnv('codex', 'read-only', {
        platform: 'win32',
        env: { OPL_NATIVE_CODEX_GIT_BASH: '1' },
        exists: () => true,
      }),
    ).toThrow(/已显式请求 Codex 使用 Git Bash/)
    // No Git Bash installed at all, but the request was explicit.
    expect(() =>
      nativeGitBashEnv('codex', 'full-access', {
        platform: 'win32',
        env: { ...optIn, PATH: '' },
        exists: () => false,
      }),
    ).toThrow(/没有找到可用的 Git for Windows Bash/)
    // An explicit but unusable Claude path is likewise not silently replaced.
    expect(() =>
      nativeGitBashEnv('claude', 'workspace', {
        platform: 'win32',
        env: { OPL_GIT_BASH_PATH: 'C:/not-installed/bash.exe' },
      }),
    ).toThrow(/no fallback/)
    // Nothing requested and nothing installed stays a no-op.
    expect(
      nativeGitBashEnv('claude', 'workspace', {
        platform: 'win32',
        env: { PATH: '' },
        exists: () => false,
      }),
    ).toEqual({})
  })

  it('offers Git Bash to Claude for every profile Claude accepts', () => {
    for (const permission of ['read-only', 'workspace', 'full-access'] as const)
      expect(nativeGitBashEnv('claude', permission, { platform: 'win32', bash, exists })).toEqual({
        CLAUDE_CODE_GIT_BASH_PATH: bash,
      })
  })

  it('applies the harness rules before injecting, so a silent fallback cannot happen', () => {
    expect(codexGitBashProblem('C:\\Windows\\System32\\bash.exe', { exists: () => true })).toMatch(
      /WSL/,
    )
    expect(
      codexGitBashProblem('/c/Program Files/Git/bin/bash.exe', { exists: () => true }),
    ).toMatch(/绝对/)
    expect(
      codexGitBashProblem('C:\\Program Files\\Git\\bin\\sh.exe', { exists: () => true }),
    ).toMatch(/bash\.exe/)
    expect(codexGitBashProblem('C:\\nowhere\\bin\\bash.exe', { exists: () => false })).toMatch(
      /不存在/,
    )
    // Right name and present, but not a Git for Windows installation.
    expect(
      codexGitBashProblem('C:\\tools\\bin\\bash.exe', { exists: (p) => p.endsWith('bash.exe') }),
    ).toMatch(/Git for Windows/)
    expect(codexGitBashProblem(bash, { exists })).toBeUndefined()

    expect(claudeGitBashProblem('C:\\Windows\\System32\\cmd.exe', { exists: () => true })).toMatch(
      /bash\/sh/,
    )
    expect(claudeGitBashProblem(bash, { exists: () => false })).toMatch(/不存在/)
    expect(claudeGitBashProblem(bash, { exists })).toBeUndefined()
  })

  it('fails diagnosably when the harness would reject the resolved path', () => {
    expect(() =>
      nativeGitBashEnv('codex', 'full-access', {
        platform: 'win32',
        bash: 'C:\\Windows\\System32\\bash.exe',
        env: optIn,
        exists: () => true,
      }),
    ).toThrow(/WSL/)
    expect(() =>
      nativeGitBashEnv('claude', 'workspace', {
        platform: 'win32',
        bash: 'C:\\Windows\\System32\\cmd.exe',
        exists: () => true,
      }),
    ).toThrow(/bash\/sh/)
  })

  it('reads the model-free shell probe without mistaking PowerShell for Bash', () => {
    expect(codexShellProbeCommand()).toContain('OPL_SHELL_NAME')
    expect(
      readShellProbe('OPL_SHELL_NAME=/usr/bin/bash\nOPL_SHELL_BASH_VERSION=5.3.15(1)-release'),
    ).toEqual({
      name: '/usr/bin/bash',
      bashVersion: '5.3.15(1)-release',
    })
    // PowerShell expands `$0`/`${BASH_VERSION}` to nothing, which is what "not Bash" looks like.
    expect(readShellProbe('OPL_SHELL_NAME=pwsh\nOPL_SHELL_BASH_VERSION=none')).toEqual({
      name: 'pwsh',
      bashVersion: 'none',
    })
    expect(readShellProbe('')).toBeUndefined()
  })
})

describe('full-access authorization', () => {
  it('covers only the harnesses with a verified official full-access path', async () => {
    const { harnessAllowsFullAccess } = await import('../../src/execution/host/permissions.ts')
    for (const harness of ['dsh', 'codex', 'claude', 'minimax-code', 'grok-build'])
      expect(harnessAllowsFullAccess(harness)).toBe(true)
    for (const harness of ['antigravity', 'minimax', 'anything-else'])
      expect(harnessAllowsFullAccess(harness)).toBe(false)
  })
})

describe.skipIf(!WINDOWS || !realGitBash)('real Git Bash execution', () => {
  it('executes a command through the resolved absolute path that contains spaces', async () => {
    expect(realGitBash).toMatch(/ /)
    expect(existsSync(realGitBash!)).toBe(true)
    const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(realGitBash!, ['-lc', 'echo "OPL_BASH=$BASH_VERSION"; echo "OPL_0=$0"'], {
        windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, out }))
    })
    expect(result.code).toBe(0)
    // Real GNU Bash output, not an argv assertion.
    expect(result.out).toMatch(/OPL_BASH=5\.\d/)
    expect(result.out).toMatch(/OPL_0=\/usr\/bin\/bash/)
  })

  it('hands Codex a path its own validation accepts', () => {
    expect(codexGitBashProblem(realGitBash!)).toBeUndefined()
    expect(claudeGitBashProblem(realGitBash!)).toBeUndefined()
  })
})

/**
 * Drive the installed official Codex app-server and read back which shell it used.
 * `thread/shellCommand` is the official entry point that runs a command in the thread's
 * configured shell without any model call.
 */
async function codexShellRun(
  env: Record<string, string>,
  sandbox: string,
  command: string,
): Promise<{ command?: string; output: string; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), 'opl-codex-native-'))
  const childEnv = { ...process.env, CODEX_HOME: home }
  // This probe owns its Shell setting; a parent Codex override is not the
  // adapter's environment and would invalidate the restricted-profile case.
  delete childEnv.CODEX_NATIVE_GIT_BASH_PATH
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', '""codex" app-server --stdio"'],
    {
      cwd: home,
      env: { ...childEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
      windowsHide: true,
    },
  )
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  let seq = 0
  const pending = new Map<number, (m: any) => void>()
  const call = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const seen: any[] = []
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.id !== undefined && !m.method) pending.get(m.id)?.(m)
    else if (m.method) seen.push(m)
  })
  try {
    await call('initialize', {
      clientInfo: { name: 'opl-dsh-test', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
    const thread = await call('thread/start', {
      cwd: home,
      model: 'gpt-5',
      approvalPolicy: 'never',
      sandbox,
    })
    const threadId = thread?.result?.thread?.id
    if (!threadId) return { output: '', stderr }
    await call('thread/shellCommand', { threadId, command, timeoutMs: 30000 })
    await new Promise((r) => setTimeout(r, 5000))
    const started = seen.find((m) => m.method === 'item/started')?.params?.item
    const output = seen
      .filter((m) => m.method === 'item/commandExecution/outputDelta')
      .map((m) => m.params.delta)
      .join('')
    return { command: started?.command, output, stderr: stderr.replace(/\[[0-9;]*m/g, '') }
  } finally {
    child.kill()
    // Windows keeps the working directory locked until the app-server process is really gone.
    await new Promise<void>((done) => {
      const timer = setTimeout(() => done(), 10000)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
    })
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => {},
    )
  }
}

const codexInstalled =
  WINDOWS &&
  ['cmd', 'exe'].some((ext) => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    return existsSync(join(home, '.local', 'bin', `codex.${ext}`))
  })

describe.skipIf(process.env.OPL_TEST_REAL_CODEX !== '1' || !codexInstalled || !realGitBash)(
  'official Codex app-server',
  () => {
    it(
      'leaves Codex on the shell its own build chooses, without the opt-in',
      { timeout: 180000 },
      async () => {
        // No opt-in, so no Git Bash variable: the suite must never claim Codex runs under Bash.
        const patch = nativeGitBashEnv('codex', 'full-access', { bash: realGitBash })
        expect(patch).toEqual({})
        const result = await codexShellRun(
          patch,
          codexSandboxMode('full-access'),
          'echo "OPL_BASH=$BASH_VERSION"',
        )
        expect(result.command).not.toMatch(/bash\.exe/i)
        expect(result.output).not.toMatch(/OPL_BASH=5\.\d/)
      },
      180000,
    )

    it(
      'honours the Git Bash opt-in on a build that actually supports it',
      { timeout: 180000 },
      async () => {
        const patch = nativeGitBashEnv('codex', 'full-access', {
          bash: realGitBash,
          env: { OPL_NATIVE_CODEX_GIT_BASH: '1' },
        })
        expect(patch.CODEX_NATIVE_GIT_BASH_PATH).toBe(realGitBash)
        const result = await codexShellRun(
          patch,
          codexSandboxMode('full-access'),
          'echo "OPL_BASH=$BASH_VERSION"',
        )
        // Real Git Bash execution reported by the official app-server.
        expect(result.command).toMatch(/bash\.exe/i)
        expect(result.output).toMatch(/OPL_BASH=5\.\d/)
      },
      180000,
    )

    it(
      'keeps refusing Git Bash under the restricted profiles the bridge still sends',
      { timeout: 180000 },
      async () => {
        for (const permission of ['read-only', 'workspace'] as const) {
          // An explicit Git Bash request under a restricted profile fails before any model call,
          // instead of being dropped or quietly widening the task.
          expect(() =>
            nativeGitBashEnv('codex', permission, {
              bash: realGitBash,
              env: { OPL_NATIVE_CODEX_GIT_BASH: '1' },
            }),
          ).toThrow()
          // With nothing requested the variable is simply absent and Codex still starts.
          const patch = nativeGitBashEnv('codex', permission, { bash: realGitBash, env: {} })
          expect(patch).toEqual({})
          const result = await codexShellRun(
            patch,
            codexSandboxMode(permission),
            'echo "OPL_BASH=$BASH_VERSION"',
          )
          // Codex keeps its own shell and still starts: the bridge never sets the variable that
          // would abort session creation under a restricted profile.
          expect(result.stderr).not.toMatch(/CODEX_NATIVE_GIT_BASH_PATH/)
        }
      },
      300000,
    )
  },
)

/**
 * Behavior tests for the ordinary DSH conversation path.
 *
 * These call the real `selectCombination`, so the sandbox comes from the real catalog and the
 * real session policy resolution rather than from the helper's own constants. Only the
 * downstream launch is stubbed, which is the same seam the existing harness tests use.
 */
describe('ordinary conversation full-access binding', () => {
  const cleanups: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    while (registeredAdapters.length) registeredAdapters.pop()!()
    while (cleanups.length) await cleanups.pop()!()
  })

  async function setupConversation(mode: 'read-only' | 'workspace-write' | 'danger-full-access') {
    const unknownHarness = await useUnknownCapabilityHarness()
    const root = (await mkdtemp(join(tmpdir(), 'opl-conversation-'))).replace(/\\/g, '/')
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    let current = { provider: 'opl-gateway', model: 'codex::gpt-test' }
    const session = {
      id: 'dsh-session',
      header: { cwd: root },
      append: vi.fn(),
      snapshotEvents: () => [],
    }
    const ctx = {
      connection: testPeerConnection,
      waterfall: async (_name: unknown, _request: unknown, next: () => Promise<unknown[]>) =>
        next(),
      get: () => undefined,
      agents: {
        list: () => [],
        get: () => ({ status: 'idle', ctx: { get: () => ({ resolve: () => ({ mode }) }) } }),
      },
      sessions: { list: () => [], get: () => session },
      permissionPresets: { current: () => mode },
      llm: {
        listProviders: () => [{ id: 'opl-gateway', name: 'OPL Gateway' }],
        listConfigurableProviders: () => [],
        listModels: async () => [
          { id: 'codex::gpt-test', name: 'Codex Model', available: true },
          { id: 'kiro::claude-opus-5-5', name: 'Claude Model', available: true },
          { id: 'grok::grok-4.7', name: 'Grok Model', available: true },
          { id: 'unknown::test-model', name: 'Unknown Model', available: true },
        ],
      },
      sessionProjections: {
        snapshot: () => ({ values: { modelSelection: { next: current } } }),
      },
      typertGateway: {
        invoke: async ({ method, args }: { method: string; args?: any }) => {
          if (method === 'modelCatalog') return { default: current, groups: [] }
          if (method === 'selectModel') current = args.request
          return undefined
        },
      },
    } as unknown as Context
    const service = new HarnessService(ctx, {
      home: join(root, 'state'),
      command: process.execPath,
      prefix: [resolve('tests/fixtures/acp-agent.mjs')],
      resolveKey: async () => 'test-key',
    })
    cleanups.push(() => service.dispose())
    const catalog = await service.executionCatalog()
    // Point every harness at node so availability reflects an installed CLI.
    catalog.harnesses = [
      ...catalog.harnesses.map((item) => ({ ...item, command: process.execPath })),
      { id: unknownHarness, name: 'Unknown CLI', kind: 'acp', command: process.execPath },
    ] as typeof catalog.harnesses
    // Declare the harness combinations explicitly; the automatic ones pair a gateway route
    // with DSH itself, which would never reach the native adapters under test.
    catalog.combinations = [
      {
        id: 'grok/test',
        name: 'Grok Build',
        modelRef: { provider: 'opl-gateway', model: 'grok::grok-4.7' },
        harnessRef: 'grok-build',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
      {
        id: 'codex/test',
        name: 'Codex CLI',
        modelRef: { provider: 'opl-gateway', model: 'codex::gpt-test' },
        harnessRef: 'codex',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
      {
        id: 'claude/test',
        name: 'Claude Code',
        modelRef: { provider: 'opl-gateway', model: 'kiro::claude-opus-5-5' },
        harnessRef: 'claude',
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
      {
        id: 'unknown/test',
        name: 'Unknown CLI',
        modelRef: { provider: 'opl-gateway', model: 'unknown::test-model' },
        harnessRef: unknownHarness,
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
    ] as typeof catalog.combinations
    await service.saveExecutionCatalog(catalog)
    const find = async (model: string) =>
      (await service.executionCatalog()).combinations.find(
        (item) => item.enabled && item.modelRef.model === model,
      )!
    return {
      service,
      root,
      codex: await find('codex::gpt-test'),
      claude: await find('kiro::claude-opus-5-5'),
      grok: await find('grok::grok-4.7'),
      unknown: await find('unknown::test-model'),
    }
  }

  const launchedSandbox = async (
    service: HarnessService,
    combination: string,
    mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  ) => {
    const start = vi
      .spyOn(
        HarnessService.prototype as unknown as { startAdmitted: (...args: any[]) => Promise<any> },
        'startAdmitted',
      )
      .mockRejectedValue(new Error('captured first-send binding'))
    try {
      await service.selectCombination({ sessionId: 'dsh-session', combination })
      expect(start).not.toHaveBeenCalled()
      const definition = (await service.executionCatalog()).combinations.find(
        (item) => item.id === combination,
      )!
      const stream = service.conversationStream(
        {
          ...definition.modelRef,
          sessionId: 'dsh-session',
          messages: [
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'check authorized sandbox' }],
            }),
          ],
        },
        async function* () {},
      )
      await expect(stream.next()).rejects.toThrow('captured first-send binding')
      return start.mock.calls.at(-1)?.[0]?.sandbox as string | undefined
    } finally {
      start.mockRestore()
    }
  }

  it('binds verified native and Grok conversations to the authorized full access', async () => {
    for (const harness of ['codex', 'claude', 'grok'] as const) {
      const { service, ...rest } = await setupConversation('danger-full-access')
      const combination = rest[harness]
      // Without this fix the binding silently fell back to workspace for both harnesses.
      expect(await launchedSandbox(service, combination.id, 'danger-full-access')).toBe(
        'full-access',
      )
    }
  })

  it('keeps a harness of unknown capability at the workspace boundary', async () => {
    const { service, unknown } = await setupConversation('danger-full-access')
    // The binding decides on capability evidence, so an unverified harness is never granted
    // full access even when the surrounding conversation is unrestricted.
    expect(await launchedSandbox(service, unknown.id, 'danger-full-access')).toBe('workspace')
  })

  it('never widens a read-only conversation to full access', async () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const { service, codex, grok } = await setupConversation(mode)
      const expected = mode === 'read-only' ? 'read-only' : 'workspace'
      expect(await launchedSandbox(service, codex.id, mode)).toBe(expected)
      expect(await launchedSandbox(service, grok.id, mode)).toBe(expected)
    }
  })
})

describe('explicit full-access requests', () => {
  const cleanups: (() => Promise<unknown>)[] = []
  afterEach(async () => {
    while (registeredAdapters.length) registeredAdapters.pop()!()
    while (cleanups.length) await cleanups.pop()!()
  })

  async function setupService() {
    const unknownHarness = await useUnknownCapabilityHarness()
    const root = (await mkdtemp(join(tmpdir(), 'opl-fullaccess-'))).replace(/\\/g, '/')
    cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
    const ctx = {
      connection: testPeerConnection,
      waterfall: async (_name: unknown, _request: unknown, next: () => Promise<unknown[]>) =>
        next(),
      get: () => undefined,
      agents: { get: () => undefined, list: () => [] },
      sessions: { list: () => [], get: () => undefined },
      llm: {
        listProviders: () => [{ id: 'opl-gateway', name: 'OPL Gateway' }],
        listConfigurableProviders: () => [],
        listModels: async () => [
          { id: 'unknown::test-model', name: 'Unknown Model', available: true },
        ],
      },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      typertGateway: { invoke: async () => ({ default: {}, groups: [] }) },
    } as unknown as Context
    const service = new HarnessService(ctx, {
      home: join(root, 'state'),
      command: process.execPath,
      prefix: [resolve('tests/fixtures/acp-agent.mjs')],
      resolveKey: async () => 'test-key',
    })
    cleanups.push(() => service.dispose())
    const catalog = await service.executionCatalog()
    catalog.harnesses = [
      ...catalog.harnesses,
      { id: unknownHarness, name: 'Unknown CLI', kind: 'acp', command: process.execPath },
    ] as typeof catalog.harnesses
    catalog.combinations = [
      {
        id: 'unknown/test',
        name: 'Unknown CLI',
        modelRef: { provider: 'opl-gateway', model: 'unknown::test-model' },
        harnessRef: unknownHarness,
        permissionPolicy: 'workspace',
        isDefault: false,
        enabled: true,
      },
    ] as typeof catalog.combinations
    await service.saveExecutionCatalog(catalog)
    const unknown = (await service.executionCatalog()).combinations.find(
      (item) => item.enabled && item.harnessRef === unknownHarness,
    )!
    return { service, root, unknown }
  }

  it('refuses an explicit full-access request for a harness of unknown capability', async () => {
    const { service, root, unknown } = await setupService()
    await expect(
      service.start({
        combination: unknown.id,
        cwd: root,
        taskId: 'task',
        origin: { kind: 'codex', sessionId: 'parent' },
        sandbox: 'full-access',
      }),
    ).rejects.toThrow(/不会自动降级为工作区权限/)
    // The same identity still resolves its default permission afterwards, so the refusal left
    // no half-created record behind. Permission resolution precedes any CLI connection.
    const record = await service.start(
      {
        combination: unknown.id,
        cwd: root,
        taskId: 'task',
        origin: { kind: 'codex', sessionId: 'parent' },
      },
      true,
    )
    expect(record.sandbox).toBe('workspace')
  })

  it('still defaults an unrequested permission to the workspace boundary', async () => {
    const { service, root, unknown } = await setupService()
    // Permission resolution precedes the platform-specific CLI connection.
    const record = await service.start(
      {
        combination: unknown.id,
        cwd: root,
        taskId: 'task',
        origin: { kind: 'codex', sessionId: 'parent' },
      },
      true,
    )
    expect(record.sandbox).toBe('workspace')
  })
})

// These suites exercise other harnesses; their catalog must not probe a personal ZCode install.
beforeEach(() => {
  vi.spyOn(
    harnessAdapters.find((adapter) => adapter.id === 'minimax-code')!,
    'available',
  ).mockResolvedValue({ available: false, reason: 'MiniMax outside this fixture' })
  vi.spyOn(harnessRegistry, 'inspectHarness').mockImplementation(async (definition) => ({
    id: definition.id,
    name: definition.name,
    installed: true,
    runnable: true,
    path: definition.command ?? process.execPath,
    instructions: 'fixture',
    website: 'https://example.test',
  }))
  vi.spyOn(
    harnessAdapters.find((adapter) => adapter.id === 'zcode')!,
    'available',
  ).mockResolvedValue({ available: false, reason: 'ZCode outside this fixture' })
})

afterEach(() => vi.restoreAllMocks())
