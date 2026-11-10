/** Windows-only execution checks use private roots and wait for child termination. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import {
  antigravityBashScriptPath,
  antigravityPowerShellLiteral,
  handleAntigravityShellHook,
  type AntigravityShellState,
} from '../../../src/execution/host/adapters/antigravity/shell-hook.ts'
import {
  ANTIGRAVITY_BASH_GUIDANCE,
  prepareAntigravityShell,
  type AntigravityShellBinding,
} from '../../../src/execution/host/adapters/antigravity/shell.ts'
import { resolveNativeGitBash } from '../../../src/execution/host/adapters/native-bash.ts'

const exec = promisify(execFile)
const roots: string[] = []
const bindings: AntigravityShellBinding[] = []
const bash = process.platform === 'win32' ? resolveNativeGitBash() : undefined
const WINDOWS_GIT_BASH = process.platform === 'win32' && !!bash

afterEach(async () => {
  for (const binding of bindings.splice(0)) await binding.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opl-agy-shell-'))
  roots.push(root)
  return root
}

function environment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'ProgramFiles']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  )
}

async function fixture() {
  const root = await directory()
  const workspace = join(root, 'work 中文 space')
  const profile = join(root, 'profile 中文 space')
  const hookPath = join(root, 'runtime 中文 space', 'shell-hook.mjs')
  await mkdir(dirname(hookPath), { recursive: true })
  await mkdir(join(workspace, '.agents'), { recursive: true })
  await writeFile(join(workspace, '.agents', 'hooks.json'), '{"user-owned":{}}')
  await build({
    entryPoints: [
      join(import.meta.dirname, '../../../src/execution/host/adapters/antigravity/shell-hook.ts'),
    ],
    outfile: hookPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
  })
  const binding = await prepareAntigravityShell({
    profile,
    workspace,
    node: process.execPath,
    bash: bash!,
    hookPath,
    env: environment(),
  })
  bindings.push(binding)
  const state = JSON.parse(
    await readFile(binding.env.OPL_AGY_SHELL_STATE!, 'utf8'),
  ) as AntigravityShellState
  return { root, workspace, profile, hookPath, binding, state }
}

describe('Antigravity shell argument literals', () => {
  it('keeps spaces, Chinese and PowerShell expression text literal', () => {
    expect(antigravityPowerShellLiteral("C:/中文 a'$(Get-Process)/bash.exe")).toBe(
      "'C:/中文 a''$(Get-Process)/bash.exe'",
    )
    expect(antigravityBashScriptPath('C:\\用户\\a b\\command.sh')).toBe('/c/用户/a b/command.sh')
    expect(antigravityBashScriptPath('\\\\server\\share\\a b.sh')).toBe('//server/share/a b.sh')
  })

  it('refuses relative paths and line breaks in interpreter arguments', () => {
    expect(() => antigravityBashScriptPath('command.sh')).toThrow()
    expect(() => antigravityPowerShellLiteral('C:/a\n; exit 0')).toThrow()
    expect(() => antigravityBashScriptPath('C:/a\0.sh')).toThrow()
  })
})

// The feature forwards an official Windows PowerShell tool into Git for Windows.
// POSIX CI still checks argument parsing; it cannot execute that Windows transport.
describe.runIf(WINDOWS_GIT_BASH)('Antigravity official Hook shell forwarding', () => {
  it('loads the Hook through an exact runtime with spaces and leaves workspace customizations intact', async () => {
    const f = await fixture()
    await expect(f.binding.verify()).resolves.toBeUndefined()
    await expect(f.binding.verifyInvocation()).rejects.toThrow()
    await handleAntigravityShellHook(
      'pre-invocation',
      {
        invocationNum: 0,
        conversationId: randomUUID(),
      },
      f.state,
    )
    await expect(f.binding.verifyInvocation()).resolves.toBeUndefined()
    await f.binding.invalidateInvocation()
    await expect(f.binding.verifyInvocation()).rejects.toThrow()
    expect(await readFile(join(f.workspace, '.agents', 'hooks.json'), 'utf8')).toBe(
      '{"user-owned":{}}',
    )
    expect(await readFile(join(f.profile, '.gemini', 'GEMINI.md'), 'utf8')).toBe(
      ANTIGRAVITY_BASH_GUIDANCE,
    )
    const hooks = JSON.parse(
      await readFile(join(f.profile, '.gemini', 'config', 'hooks.json'), 'utf8'),
    )
    expect(hooks['opl-dsh-git-bash'].PreToolUse[0].hooks[0].command).toMatch(
      /^opl-agy-shell-[a-f0-9-]+\.cmd pre-tool$/u,
    )
    expect(f.binding.env.PATHEXT).toBeTruthy()
  }, 20_000)

  it('writes unique UTF-8 scripts concurrently and preserves Bash output and exit status', async () => {
    const f = await fixture()
    const command = 'printf "BASH=%s\\n" "$BASH_VERSION"; printf "中文 空格\\n"; exit 7'
    const input = {
      conversationId: randomUUID(),
      stepIdx: 4,
      toolCall: {
        name: 'run_command',
        args: { CommandLine: command, WaitMsBeforeAsync: 5000, Cwd: f.workspace },
      },
    }
    const [first, second] = await Promise.all([
      handleAntigravityShellHook('pre-tool', input, f.state),
      handleAntigravityShellHook('pre-tool', input, f.state),
    ])
    expect(first.decision).toBe('allow')
    expect(first).not.toHaveProperty('permissionOverrides')
    expect(Object.keys(first.overwrite as object)).toEqual(['CommandLine'])
    expect(first).not.toEqual(second)
    const executions = await f.binding.executions()
    expect(executions).toHaveLength(2)
    expect(new Set(executions.map((entry) => entry.script)).size).toBe(2)
    for (const execution of executions) {
      expect(await readFile(execution.script, 'utf8')).toBe(`${command}\n`)
      expect(execution).toMatchObject({
        interpreter: bash,
        conversationId: input.conversationId,
        stepIdx: 4,
      })
      expect(execution).not.toHaveProperty('command')
    }
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    let observed: { code?: unknown; stdout?: unknown; killed?: unknown } = {}
    try {
      await exec(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          (first.overwrite as { CommandLine: string }).CommandLine,
        ],
        {
          env: f.binding.env,
          cwd: f.workspace,
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 8192,
        },
      )
    } catch (error) {
      observed = error as typeof observed
    }
    expect(observed.killed).toBe(false)
    expect(observed.code).toBe(7)
    expect(observed.stdout).toContain('BASH=')
    expect(observed.stdout).toContain('中文 空格')
  }, 20_000)

  it('refuses broken configuration and malformed tools before any unforwarded command can run', async () => {
    const f = await fixture()
    for (const input of [
      null,
      {},
      { toolCall: { name: 'other', args: {} } },
      { toolCall: { name: 'run_command', args: { CommandLine: ' ' } } },
    ])
      await expect(handleAntigravityShellHook('pre-tool', input, f.state)).rejects.toThrow()
    expect(await readdir(f.state.scripts)).toEqual([])
    await writeFile(join(f.profile, '.gemini', 'config', 'hooks.json'), '{}')
    await expect(f.binding.verify()).rejects.toThrow(/未发送模型请求/u)
  }, 20_000)

  it('cleans only its own runtime generation after shutdown and retains shell audit identities', async () => {
    const f = await fixture()
    await writeFile(join(f.profile, 'keep.txt'), 'retained')
    await handleAntigravityShellHook(
      'pre-tool',
      {
        toolCall: { name: 'run_command', args: { CommandLine: 'printf ok' } },
      },
      f.state,
    )
    const [execution] = await f.binding.executions()
    await f.binding.dispose()
    expect(existsSync(execution!.script)).toBe(false)
    expect(await readFile(join(f.profile, 'keep.txt'), 'utf8')).toBe('retained')
    expect(await readdir(join(f.profile, 'opl-shell-audit'))).toHaveLength(1)
    expect(await readFile(join(f.workspace, '.agents', 'hooks.json'), 'utf8')).toBe(
      '{"user-owned":{}}',
    )
    await expect(f.binding.verify()).rejects.toThrow()
  }, 20_000)
})
