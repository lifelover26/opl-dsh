import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessInstallation } from '../../src/execution/contracts/installations.ts'
import { maintainHarness } from '../../src/execution/host/harness-maintenance.ts'
import {
  executablePath,
  inspectHarness,
  inspectInstalledHarness,
  npmGlobalBin,
} from '../../src/execution/host/harness-registry.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fakeNpm(
  options: { prefix?: string; noLauncher?: boolean; versionOutput?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'opl-cli-install-'))
  roots.push(root)
  const npmBin = join(root, 'Node tools')
  const prefix = options.prefix ?? join(root, 'Actual global prefix')
  const globalBin = npmGlobalBin(prefix)
  const log = join(root, 'npm-invocations.jsonl')
  const source = join(npmBin, 'npm.cjs')
  await mkdir(npmBin, { recursive: true })
  await writeFile(
    source,
    `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, interactive: !process.env.CI, sensitive: !!process.env.OPENAI_API_KEY }) + '\\n');
if (args.join(' ') === 'prefix --global') {
  console.log(${JSON.stringify(prefix)});
} else if (args[0] === 'install' && args[1] === '--global') {
  const names = { '@kilocode/cli@7.8.8': 'kilo', 'opencode-ai@1.19.0': 'opencode', '@earendil-works/pi-coding-agent@1.2.0': 'pi' };
  const name = names[args[2]];
  if (!name) process.exit(31);
  if (!${JSON.stringify(options.noLauncher ?? false)}) {
    fs.mkdirSync(${JSON.stringify(globalBin)}, { recursive: true });
    const script = path.join(${JSON.stringify(globalBin)}, name + '.cjs');
    const version = ${JSON.stringify(options.versionOutput)} ?? (name === 'opencode' ? 'opencode 1.19.0' : name + ' 9.9.9');
    fs.writeFileSync(script, 'console.log(' + JSON.stringify(version) + ')');
    const command = path.join(${JSON.stringify(globalBin)}, name + (process.platform === 'win32' ? '.cmd' : ''));
    fs.writeFileSync(command, process.platform === 'win32'
      ? '@echo off\\r\\n"' + process.execPath + '" "' + script + '" %*\\r\\n'
      : '#!/bin/sh\\nexec "' + process.execPath + '" "' + script + '" "$@"\\n');
    fs.chmodSync(command, 0o700);
  }
  console.log('added official fixture package');
} else process.exit(32);
`,
  )
  const npm = join(npmBin, process.platform === 'win32' ? 'npm.cmd' : 'npm')
  await writeFile(
    npm,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${source}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`,
    { mode: 0o700 },
  )
  if (process.platform === 'win32') await writeFile(join(npmBin, 'npm'), '#!/bin/sh\nexit 87\n')
  vi.stubEnv('PATH', npmBin)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('APPDATA', root)
  vi.stubEnv('LOCALAPPDATA', root)
  vi.stubEnv('npm_config_prefix', join(root, 'Unused environment prefix'))
  vi.stubEnv('OPENAI_API_KEY', 'test-sensitive')
  return { root, prefix, globalBin, npm, log }
}

function missing(id = 'opencode'): HarnessInstallation {
  return {
    id,
    name: id,
    installed: false,
    runnable: false,
    instructions: '',
    website: '',
    maintenanceAction: 'install',
  }
}

it('verifies a fresh install in the actual npm global prefix with the same npm shim', async () => {
  const fixture = await fakeNpm()
  const definition = { id: 'opencode', name: 'OpenCode', kind: 'acp' as const, command: 'opencode' }
  const result = await maintainHarness(missing())
  expect(result.command).toBe(fixture.npm)
  expect(result.installRoots).toEqual([fixture.globalBin])
  expect(result.message).toContain('added official fixture package')
  expect(result.message).toContain(fixture.globalBin)
  const fresh = await inspectInstalledHarness(definition, fixture.root, result)
  const command = join(
    fixture.globalBin,
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
  )
  expect(fresh).toMatchObject({
    path: command,
    installed: true,
    runnable: true,
    verification: 'verified',
    version: 'opencode 1.19.0',
  })
  expect(await executablePath('opencode')).toBe(command)
  await inspectHarness(definition, fixture.root)
  await inspectHarness(definition, fixture.root)
  const calls = (await readFile(fixture.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(calls).toEqual([
    { args: ['prefix', '--global'], interactive: false, sensitive: false },
    { args: ['install', '--global', 'opencode-ai@1.19.0'], interactive: false, sensitive: false },
  ])
})

it('finds Antigravity in the Windows user-local fallback when LOCALAPPDATA is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-antigravity-path-'))
  roots.push(root)
  const bin = join(root, 'AppData', 'Local', 'agy', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'agy.cmd'), '@echo off\r\necho 1.5.3\r\n')
  vi.stubEnv('PATH', '')
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('APPDATA', join(root, 'AppData', 'Roaming'))
  vi.stubEnv('LOCALAPPDATA', '')

  const result = await inspectHarness(
    { id: 'antigravity', name: 'Antigravity CLI', kind: 'acp', command: 'agy' },
    root,
    undefined,
    { fresh: true },
  )
  expect(result).toMatchObject({
    path: join(bin, 'agy.cmd'),
    detectedBy: 'known-path',
    installed: true,
    runnable: true,
    verification: 'verified',
    version: '1.5.3',
  })
})

it('keeps the user-local Antigravity fallback when LOCALAPPDATA points elsewhere', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-antigravity-wrong-localappdata-'))
  roots.push(root)
  const bin = join(root, 'AppData', 'Local', 'agy', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'agy.cmd'), '@echo off\r\necho 1.5.3\r\n')
  vi.stubEnv('PATH', '')
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('APPDATA', join(root, 'AppData', 'Roaming'))
  vi.stubEnv('LOCALAPPDATA', join(root, 'wrong-localappdata'))

  const result = await inspectHarness(
    { id: 'antigravity', name: 'Antigravity CLI', kind: 'acp', command: 'agy' },
    root,
    undefined,
    { fresh: true },
  )
  expect(result).toMatchObject({
    path: join(bin, 'agy.cmd'),
    detectedBy: 'known-path',
    installed: true,
    runnable: true,
    verification: 'verified',
    version: '1.5.3',
  })
})

it('reports a newly installed official candidate without replacing a stale explicit path', async () => {
  const fixture = await fakeNpm()
  const stale = join(fixture.root, 'Old removed installation', 'opencode.exe')
  const definition = { id: 'opencode', name: 'OpenCode', kind: 'acp' as const, command: stale }
  const before = await inspectHarness(definition, fixture.root)
  expect(before.installed).toBe(false)
  const result = await maintainHarness(before)
  const fresh = await inspectInstalledHarness(definition, fixture.root, result)
  const candidate = join(
    fixture.globalBin,
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
  )
  expect(fresh).toMatchObject({
    installed: false,
    runnable: false,
    verification: 'failed',
    installedCandidate: { path: candidate, verification: 'verified', version: 'opencode 1.19.0' },
  })
  expect(fresh.path).toBeUndefined()
  expect(fresh.error).toContain(stale)
  expect(fresh.error).toContain(candidate)
  expect(definition.command).toBe(stale)
  expect(await executablePath(stale, 'opencode')).toBeUndefined()
})

it('rejects an update that writes a different global installation from the configured launcher', async () => {
  const fixture = await fakeNpm({ versionOutput: 'kilo 9.9.9' })
  const old = join(fixture.root, process.platform === 'win32' ? 'kilo.cmd' : 'kilo')
  await writeFile(
    old,
    process.platform === 'win32'
      ? '@echo off\r\necho kilo 7.8.8\r\n'
      : '#!/bin/sh\nprintf "kilo 7.8.8\\n"\n',
  )
  await chmod(old, 0o700)
  const definition = { id: 'kilo', name: 'Kilo Code', kind: 'acp' as const, command: old }
  const before = await inspectHarness(definition, fixture.root)
  expect(before).toMatchObject({ path: old, verification: 'verified', version: 'kilo 7.8.8' })
  const result = await maintainHarness(before)
  const fresh = await inspectInstalledHarness(definition, fixture.root, result)
  expect(fresh).toMatchObject({
    path: old,
    runnable: false,
    verification: 'failed',
    version: 'kilo 7.8.8',
    installedCandidate: { verification: 'verified', version: 'kilo 9.9.9' },
  })
  expect(fresh.error).toContain('当前配置仍指向')
  expect(definition.command).toBe(old)
})

it('does not start installation when npm cannot report an absolute global prefix', async () => {
  const fixture = await fakeNpm({ prefix: 'not-an-absolute-prefix' })
  await expect(maintainHarness(missing('opencode'))).rejects.toThrow('尚未启动安装')
  const calls = (await readFile(fixture.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(calls.map((call) => call.args)).toEqual([['prefix', '--global']])
})

it('rejects successful installer output when its actual global target has no launcher', async () => {
  const fixture = await fakeNpm({ noLauncher: true })
  const result = await maintainHarness(missing('opencode'))
  const fresh = await inspectInstalledHarness(
    { id: 'opencode', name: 'OpenCode', kind: 'acp' },
    fixture.root,
    result,
  )
  expect(fresh.verification).toBe('failed')
  expect(fresh.runnable).toBe(false)
  expect(fresh.error).toContain(fixture.globalBin)
  expect(fresh.error).toContain('未找到 opencode 启动入口')
})

it('rejects an installed launcher that returns a login message instead of a version', async () => {
  const fixture = await fakeNpm({ versionOutput: 'Sign in to continue' })
  const result = await maintainHarness(missing('opencode'))
  const fresh = await inspectInstalledHarness(
    { id: 'opencode', name: 'OpenCode', kind: 'acp' },
    fixture.root,
    result,
  )
  expect(fresh).toMatchObject({ installed: true, runnable: false, verification: 'failed' })
  expect(fresh.version).toBeUndefined()
  expect(fresh.error).toContain('未返回可识别的版本号')
})
