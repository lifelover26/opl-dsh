import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  maintenancePlan,
  maintenanceEnvironment,
  maintainHarness,
} from '../../src/execution/host/harness-maintenance.ts'
import type { HarnessInstallation } from '../../src/execution/contracts/installations.ts'
const roots: string[] = []
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
it('provides fixed official install plans for missing Codex and Claude CLIs', () => {
  const missing = (
    id:
      | 'codex'
      | 'claude'
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
  expect(maintenancePlan(missing('codex'))).toEqual({
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', '--global', '@openai/codex@latest'],
    npmGlobal: true,
  })
  const claude = maintenancePlan(missing('claude'))
  expect(claude.command).toBe(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh')
  expect(claude.args.join(' ')).toContain('claude.ai/install.')
  expect(claude.args.join(' ')).not.toContain('item.path')
  for (const [id, official] of [
    ['minimax-code', 'filecdn.minimax.chat/public/install.'],
    ['mimo-code', 'mimo.xiaomi.com/install'],
    ['step-code', 'static-openapi.stepfun.com/stepcode/install.'],
    ['opencode', 'opencode-ai'],
    ['kilo', '@kilocode/cli'],
    ['pi', '@earendil-works/pi-coding-agent'],
    ['kimi-code', '@moonshot-ai/kimi-code'],
  ] as const) {
    const plan = maintenancePlan(missing(id))
    expect(plan.command).toMatch(/powershell|sh$|npm(?:\.cmd)?$/)
    expect(plan.args.join(' ')).toContain(official)
    expect(plan.args).not.toContain('-lc')
  }
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
