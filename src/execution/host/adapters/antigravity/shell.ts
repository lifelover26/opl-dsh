/** Isolated official Antigravity Hook configuration for Windows Git Bash. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { resolveNativeGitBash } from '../native-bash.ts'
import type { AntigravityShellExecution, AntigravityShellState } from './shell-hook.ts'

const exec = promisify(execFile)
const failure = (cause?: unknown) =>
  Error('Antigravity Git Bash 接线验证失败，未发送模型请求，也未回退其他 shell。', { cause })
const PROBE = 'OPL_ANTIGRAVITY_BASH:'

/** Shell guidance loaded as an official always-on global rule in this private profile. */
export const ANTIGRAVITY_BASH_GUIDANCE = [
  '# OPL DSH command interpreter',
  '',
  'Every run_command CommandLine is Bash source executed by Git for Windows Bash.',
  'Generate Bash syntax, even when the built-in tool description names PowerShell or pwsh.',
  'Use POSIX paths such as /c/Users/... inside commands. Do not wrap commands in PowerShell or CMD.',
  'OPL DSH forwards each command through a verified official PreToolUse hook; the hook preserves the exit status.',
  '',
].join('\n')

/** Inputs for one isolated Antigravity child; no ambient credential files are copied. */
export interface AntigravityShellOptions {
  readonly profile: string
  readonly workspace: string
  readonly node: string
  readonly hookPath: string
  readonly bash?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}

/** Child settings and owned Hook lifecycle; dispose only after its process tree has stopped. */
export interface AntigravityShellBinding {
  readonly env: NodeJS.ProcessEnv
  readonly args: string[]
  /** Reject files changed since the bridge prepared this Hook. */
  verify(): Promise<void>
  /** Before each prompt, refuse readiness left by an earlier prompt. */
  invalidateInvocation(): Promise<void>
  /** Called by the native proxy before forwarding a selected-model request. */
  verifyInvocation(): Promise<void>
  /** Actual shell identities produced by this live bridge's Hook. */
  executions(): Promise<readonly AntigravityShellExecution[]>
  /** Remove only this generation's temporary scripts after all children stop. */
  dispose(): Promise<void>
}

function validateRuntimePath(value: string): void {
  if (!isAbsolute(value) || /[\0\r\n"]/u.test(value)) throw failure()
}

async function file(value: string): Promise<void> {
  if (!isAbsolute(value) || !(await stat(value)).isFile()) throw failure()
}

async function realDirectory(value: string): Promise<void> {
  await mkdir(value, { recursive: true, mode: 0o700 })
  const result = await lstat(value)
  if (!result.isDirectory() || result.isSymbolicLink()) throw failure()
}

/** Verify an actual Git Bash/MSYS process before the official agent may start. */
export async function verifyAntigravityGitBash(
  bash: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!win32.isAbsolute(bash) || win32.basename(bash).toLowerCase() !== 'bash.exe') throw failure()
  try {
    const output = await exec(
      bash,
      ['--noprofile', '--norc', '-c', `printf '${PROBE}'; /usr/bin/uname -s`],
      { env, windowsHide: true, timeout: 10_000, maxBuffer: 4096 },
    )
    if (!new RegExp(`^${PROBE}(?:MINGW(?:32|64)?_NT-|MSYS_NT-)`).test(output.stdout.trim()))
      throw failure()
  } catch {
    throw failure()
  }
}

/**
 * Prepare official profile-level hooks and verify their own runtime before launch.
 * @param options - suite-owned profile, exact runtime and official workspace.
 * @returns child environment and checks used by the ACP wrapper and native proxy.
 */
export async function prepareAntigravityShell(
  options: AntigravityShellOptions,
): Promise<AntigravityShellBinding> {
  const platform = options.platform ?? process.platform
  const profile = resolve(options.profile)
  if (!isAbsolute(options.profile) || !isAbsolute(options.workspace)) throw failure()
  const env = { ...(options.env ?? {}) }
  for (const key of ['PATHEXT', 'ComSpec', 'SystemRoot', 'WINDIR'])
    if (env[key] === undefined && process.env[key] !== undefined) env[key] = process.env[key]
  const config = join(profile, '.gemini', 'config')
  const cli = join(profile, '.gemini', 'antigravity-cli')
  const temp = join(profile, 'tmp')
  for (const directory of [profile, config, cli, temp]) await realDirectory(directory)
  const settingsFile = join(cli, 'settings.json')
  const settings = JSON.stringify({ modelProvider: 'gemini' })
  await writeFile(settingsFile, settings, { encoding: 'utf8', mode: 0o600 })
  const profileEnv: NodeJS.ProcessEnv = {
    ...env,
    GEMINI_CLI_HOME: profile,
    USERPROFILE: profile,
    APPDATA: join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(profile, 'AppData', 'Local'),
    TEMP: temp,
    TMP: temp,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  }
  for (const directory of [profileEnv.APPDATA!, profileEnv.LOCALAPPDATA!])
    await realDirectory(directory)
  if (platform !== 'win32') {
    // Git Bash is a Windows adaptation. Native POSIX tools retain their own interpreter.
    return {
      env: profileEnv,
      args: [],
      verify: async () => {
        if ((await readFile(settingsFile, 'utf8')) !== settings) throw failure()
      },
      invalidateInvocation: async () => {},
      verifyInvocation: async () => {},
      executions: async () => [],
      dispose: async () => {},
    }
  }
  const bash = options.bash ?? resolveNativeGitBash({ env })
  if (!bash) throw failure()
  await verifyAntigravityGitBash(bash, profileEnv)
  await file(options.node)
  await file(options.hookPath)
  validateRuntimePath(options.node)
  validateRuntimePath(options.hookPath)
  const hookSource = await readFile(options.hookPath)
  const generation = await mkdtemp(join(temp, 'opl-shell-'))
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    const current = await lstat(generation)
    if (current.isSymbolicLink()) await unlink(generation)
    else if (current.isDirectory()) await rm(generation, { recursive: true, force: true })
    else throw failure()
    disposed = true
  }
  try {
    const audit = join(profile, 'opl-shell-audit')
    await realDirectory(audit)
    const scripts = join(generation, 'scripts')
    const bin = join(generation, 'bin')
    await realDirectory(scripts)
    await realDirectory(bin)
    const nonce = randomUUID()
    const state: AntigravityShellState = {
      version: 1,
      nonce,
      bash,
      scripts,
      audit,
      invocation: join(generation, 'invocation'),
    }
    const stateFile = join(generation, 'state.json')
    await writeFile(stateFile, JSON.stringify(state), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const name = `opl-agy-shell-${nonce}.cmd`
    const shim = join(bin, name)
    const shimSource = [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%OPL_AGY_SHELL_NODE%" --expose-internals "%OPL_AGY_SHELL_HOOK%" %*',
      'exit /b %errorlevel%',
      '',
    ].join('\r\n')
    await writeFile(shim, shimSource, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    profileEnv.PATH = `${bin}${delimiter}${profileEnv.PATH ?? ''}`
    profileEnv.OPL_AGY_SHELL_STATE = stateFile
    profileEnv.OPL_AGY_SHELL_NODE = options.node
    profileEnv.OPL_AGY_SHELL_HOOK = options.hookPath
    const hookFile = join(config, 'hooks.json')
    const hooks = JSON.stringify({
      'opl-dsh-git-bash': {
        PreInvocation: [{ type: 'command', command: `${name} pre-invocation`, timeout: 10 }],
        PreToolUse: [
          {
            matcher: '^run_command$',
            hooks: [{ type: 'command', command: `${name} pre-tool`, timeout: 10 }],
          },
        ],
      },
    })
    const ruleFile = join(profile, '.gemini', 'GEMINI.md')
    await writeFile(hookFile, hooks, { encoding: 'utf8', mode: 0o600 })
    await writeFile(ruleFile, ANTIGRAVITY_BASH_GUIDANCE, { encoding: 'utf8', mode: 0o600 })
    const expected = new Map([
      [settingsFile, Buffer.from(settings)],
      [stateFile, Buffer.from(JSON.stringify(state))],
      [shim, Buffer.from(shimSource)],
      [hookFile, Buffer.from(hooks)],
      [ruleFile, Buffer.from(ANTIGRAVITY_BASH_GUIDANCE)],
      [options.hookPath, hookSource],
    ])
    const verify = async () => {
      if (disposed) throw failure()
      for (const [path, value] of expected) {
        const current = await readFile(path)
        if (!current.equals(value)) throw failure()
      }
    }
    const comspec =
      profileEnv.ComSpec ?? join(profileEnv.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const selfTest = await exec(comspec, ['/d', '/s', '/c', `${name} self-test`], {
      env: profileEnv,
      cwd: options.workspace,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
    })
    const result: unknown = JSON.parse(selfTest.stdout)
    if (!result || typeof result !== 'object' || !('nonce' in result) || result.nonce !== nonce)
      throw failure()
    await verify()
    return {
      env: profileEnv,
      args: [],
      verify,
      invalidateInvocation: async () => {
        await verify()
        await rm(state.invocation, { force: true })
      },
      verifyInvocation: async () => {
        await verify()
        if ((await readFile(state.invocation, 'utf8')) !== nonce) throw failure()
      },
      executions: async () => {
        if (disposed) return []
        const names = (await readdir(audit)).filter((entry) => entry.startsWith(`${nonce}-`))
        const entries = await Promise.all(
          names.map((entry) => readFile(join(audit, entry), 'utf8')),
        )
        return entries.map((entry) => JSON.parse(entry) as AntigravityShellExecution)
      },
      dispose,
    }
  } catch (cause) {
    await dispose()
    throw failure(cause)
  }
}
