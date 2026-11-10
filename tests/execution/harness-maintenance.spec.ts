import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import {
  maintenancePlan,
  maintenanceEnvironment,
  maintainHarness,
} from '../../src/execution/host/harness-maintenance.ts'
import type { HarnessInstallation } from '../../src/execution/contracts/installations.ts'
const roots: string[] = []
const exec = promisify(execFile)
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const installed = (path: string): HarnessInstallation => ({
  id: 'codex',
  name: 'Codex CLI',
  installed: true,
  path,
  runnable: false,
  instructions: '',
  website: '',
  maintenanceAction: 'update',
})
it('uses fixed official updater arguments and rejects custom Harness commands', () => {
  expect(maintenancePlan(installed('/some path/codex'))).toEqual({
    command: '/some path/codex',
    args: ['update'],
  })
  expect(() => maintenancePlan({ ...installed('/some path/custom'), id: 'custom' })).toThrow(
    '没有自动更新',
  )
  expect(() =>
    maintenancePlan({
      ...installed('/dsh'),
      id: 'dsh',
      maintenanceAction: undefined,
    } as unknown as HarnessInstallation),
  ).toThrow('官方安装')
})
it('provides fixed official install plans for missing CLIs', () => {
  const missing = (
    id:
      | 'codex'
      | 'claude'
      | 'antigravity'
      | 'minimax-code'
      | 'mimo-code'
      | 'step-code'
      | 'opencode'
      | 'kilo'
      | 'pi'
      | 'kimi-code',
  ): HarnessInstallation => ({
    id,
    name: id === 'codex' ? 'Codex CLI' : 'Claude Code',
    installed: false,
    runnable: false,
    instructions: '',
    website: '',
    maintenanceAction: 'install',
  })
  const codex = maintenancePlan(missing('codex'))
  expect(codex.command).toBe(process.platform === 'win32' ? 'powershell.exe' : 'bash')
  expect(codex.args.join(' ')).toContain('chatgpt.com/codex/install.')
  expect(codex.environment).toEqual({ CODEX_NON_INTERACTIVE: '1' })
  const claude = maintenancePlan(missing('claude'))
  expect(claude.command).toBe(process.platform === 'win32' ? 'powershell.exe' : 'bash')
  expect(claude.args.join(' ')).toContain('claude.ai/install.')
  expect(claude.args.join(' ')).not.toContain('item.path')
  for (const [id, official] of [
    ['antigravity', 'antigravity.google/cli/install.'],
    ['minimax-code', 'filecdn.minimax.chat/public/install.'],
    ['mimo-code', 'mimo.xiaomi.com/install'],
    ['step-code', 'static-openapi.stepfun.com/stepcode/install.'],
    ['opencode', 'opencode-ai@1.19.0'],
    ['kilo', '@kilocode/cli@7.8.8'],
    ['pi', '@earendil-works/pi-coding-agent'],
  ] as const) {
    const plan = maintenancePlan(missing(id))
    expect(plan.command).toMatch(/powershell|sh$|npm(?:\.cmd)?$/)
    expect(plan.args.join(' ')).toContain(official)
    expect(plan.args).not.toContain('-lc')
  }
  const kimi = maintenancePlan(missing('kimi-code'))
  expect(kimi.command).toBe(process.platform === 'win32' ? 'powershell.exe' : 'bash')
  expect(kimi.args.join(' ')).toContain('code.kimi.com/kimi-code/install.')
  expect(kimi.environment).toEqual({ KIMI_VERSION: '2.1.1' })
  expect(kimi.expectedVersion).toBe('2.1.1')
  const pi = maintenancePlan(missing('pi'))
  expect(pi.args).toContain('@earendil-works/pi-coding-agent@1.2.0')
  expect(pi.args).toContain('--ignore-scripts')
  expect(pi.expectedVersion).toBe('1.2.0')
})
it('does not pass Gateway or model authentication into package updaters', () => {
  vi.stubEnv('OPL_GATEWAY_CODEX_API_KEY', 'test-sensitive')
  vi.stubEnv('OPENAI_API_KEY', 'test-sensitive')
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-sensitive')
  vi.stubEnv('npm_config_prefix', '/fixture-npm-prefix')
  const env = maintenanceEnvironment()
  expect(env.OPL_GATEWAY_CODEX_API_KEY).toBeUndefined()
  expect(env.OPENAI_API_KEY).toBeUndefined()
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env.HOME).toBe(process.env.HOME)
  expect(env.npm_config_prefix).toBe('/fixture-npm-prefix')
  expect(env.CI).toBe('1')
})

it.each([
  ['AMD64', undefined],
  ['ARM64', undefined],
  ['x86', 'AMD64'],
  ['AMD64', 'ARM64'],
] as const)(
  'preserves installer architecture %s / %s without passing credentials',
  (arch, native) => {
    vi.stubEnv('PROCESSOR_ARCHITECTURE', arch)
    vi.stubEnv('PROCESSOR_ARCHITEW6432', native)
    vi.stubEnv('OPL_GATEWAY_GEMINI_API_KEY', 'test-sensitive')
    const env = maintenanceEnvironment()
    expect(env.PROCESSOR_ARCHITECTURE).toBe(arch)
    expect(env.PROCESSOR_ARCHITEW6432).toBe(native)
    expect(env.OPL_GATEWAY_GEMINI_API_KEY).toBeUndefined()
  },
)

it.skipIf(process.platform !== 'win32')(
  'lets the Windows installer select its platform and returns readable Chinese diagnostics',
  async () => {
    vi.stubEnv('PROCESSOR_ARCHITECTURE', 'x86')
    vi.stubEnv('PROCESSOR_ARCHITEW6432', 'AMD64')
    const plan = maintenancePlan({
      ...installed('unused'),
      id: 'antigravity',
      path: undefined,
      installed: false,
      maintenanceAction: 'install',
    })
    // The official installer selects the native architecture before downloading a binary.
    const installer = `
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -eq 'AMD64') { $platform = 'windows_amd64' }
elseif ($arch -eq 'ARM64') { $platform = 'windows_arm64' }
else { throw 'Fatal: Unsupported CPU architecture.' }
Write-Output "平台=$platform"
Write-Error '安装测试：目录不可写'
`
    const encoded = Buffer.from(installer, 'utf8').toString('base64')
    const args = [...plan.args]
    args[args.length - 1] =
      `function Invoke-RestMethod { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) }; ` +
      args.at(-1)!
    const pending = exec(plan.command, args, {
      env: maintenanceEnvironment(),
      timeout: 30000,
      maxBuffer: 16384,
      windowsHide: true,
    })
    pending.child.stdin?.end()
    await expect(pending).rejects.toMatchObject({
      code: 1,
      killed: false,
      stdout: expect.stringContaining('平台=windows_amd64'),
      stderr: expect.stringContaining('安装测试：目录不可写'),
    })
  },
)

it('runs the installed updater without shell interpolation and reports its real failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-maintenance-'))
  roots.push(root)
  const command = join(root, 'codex with spaces' + (process.platform === 'win32' ? '.cmd' : ''))
  await writeFile(
    command,
    process.platform === 'win32'
      ? '@echo off\r\nif not "%~1"=="update" exit /b 7\r\necho token=test-sensitive 1>&2\r\nexit /b 9\r\n'
      : '#!/bin/sh\n[ "$1" = update ] || exit 7\nprintf "token=test-sensitive\\n" >&2\nexit 9\n',
    { mode: 0o700 },
  )
  try {
    await maintainHarness(installed(command))
    expect.fail('the updater must report its nonzero exit')
  } catch (error) {
    expect(String(error)).toContain('9')
    expect(String(error)).toContain(command)
    expect(String(error)).not.toContain('test-sensitive')
    expect(String(error)).toContain('[REDACTED]')
  }
})
