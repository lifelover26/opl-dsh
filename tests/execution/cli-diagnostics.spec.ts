import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HarnessDefinition } from '../../src/execution/contracts/catalog.ts'
import {
  executablePath,
  harnessDiagnostic,
  harnessVersion,
  inspectHarness,
} from '../../src/execution/host/harness-registry.ts'
import { maintainHarness } from '../../src/execution/host/harness-maintenance.ts'

const temporaryRoot = tmpdir()
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const definition: HarnessDefinition = { id: 'codex', name: 'Codex CLI', kind: 'acp' }

async function isolatedWindows() {
  const root = await mkdtemp(join(temporaryRoot, 'opl-cli-diagnostics-'))
  roots.push(root)
  const roaming = join(root, 'AppData', 'Roaming')
  const local = join(root, 'AppData', 'Local')
  vi.stubEnv('PATH', join(root, 'Empty PATH'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('APPDATA', roaming)
  vi.stubEnv('LOCALAPPDATA', local)
  vi.stubEnv('npm_config_prefix', join(root, 'Unused npm prefix'))
  const nativeRoot = join(local, 'OpenAI', 'Codex', 'bin')
  return { root, roaming, local, nativeRoot }
}

/** Use the existing Node image as a synthetic native CLI; no compiler or installation is needed. */
async function nativeNode(path: string) {
  await mkdir(dirname(path), { recursive: true })
  await link(process.execPath, path).catch(() => copyFile(process.execPath, path))
}

async function npmStyleCodex(roaming: string, version = 'codex-cli 0.166.0') {
  const bin = join(roaming, 'npm')
  await mkdir(bin, { recursive: true })
  await nativeNode(join(bin, 'node.exe'))
  const script = join(bin, 'codex-fixture.cjs')
  const calls = join(bin, 'calls.jsonl')
  await writeFile(
    script,
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.at(-1) !== '--version') process.exit(91);
console.log(${JSON.stringify(version)});
`,
  )
  const command = join(bin, 'codex.cmd')
  await writeFile(command, '@echo off\r\n"%~dp0node.exe" "%~dp0codex-fixture.cjs" %*\r\n')
  return { command, calls }
}

describe.runIf(process.platform === 'win32')('Windows CLI discovery without npm', () => {
  it('probes the existing APPDATA npm-style cmd launcher using its adjacent node.exe', async () => {
    const fixture = await isolatedWindows()
    const cli = await npmStyleCodex(fixture.roaming)
    expect(await executablePath('npm')).toBeUndefined()
    const item = await inspectHarness(definition, fixture.root)
    expect(item).toMatchObject({
      installed: true,
      path: cli.command,
      detectedBy: 'known-path',
      version: 'codex-cli 0.166.0',
      verification: 'verified',
      runnable: true,
      maintenanceAction: 'update',
    })
    expect(await readFile(cli.calls, 'utf8')).toBe('["--version"]\n')
  })

  it('finds a unique versioned desktop native exe independently of npm', async () => {
    const fixture = await isolatedWindows()
    const native = join(fixture.nativeRoot, 'a159911ff70742e9', 'codex.exe')
    await nativeNode(native)
    const script = join(fixture.root, 'native-fixture.cjs')
    await writeFile(script, 'console.log("codex-cli 0.166.0-alpha.6")')
    await mkdir(join(fixture.nativeRoot, 'decoy', 'codex.exe'), { recursive: true })
    await mkdir(join(fixture.nativeRoot, 'nested', 'old'), { recursive: true })
    await writeFile(join(fixture.nativeRoot, 'nested', 'old', 'codex.exe'), '')
    expect(await executablePath('npm')).toBeUndefined()
    expect(await executablePath('codex')).toBe(native)
    const item = await inspectHarness({ ...definition, prefix: [script] }, fixture.root)
    expect(item).toMatchObject({
      installed: true,
      path: native,
      detectedBy: 'app-bundle',
      version: 'codex-cli 0.166.0-alpha.6',
      verification: 'verified',
      runnable: true,
    })
    expect(item.discovery).toBeUndefined()
  })

  it('keeps the common cmd selection and lists the native file without probing it', async () => {
    const fixture = await isolatedWindows()
    const cli = await npmStyleCodex(fixture.roaming)
    const native = join(fixture.nativeRoot, 'a159911ff70742e9', 'codex.exe')
    await nativeNode(native)
    const script = join(fixture.root, 'unselected-native.cjs')
    const marker = join(fixture.root, 'native-started')
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); console.log('codex-cli 0.166.0-alpha.6')`,
    )
    const selected = { ...definition, prefix: [script] }
    const item = await inspectHarness(selected, fixture.root)
    await inspectHarness(selected, fixture.root)
    expect(item).toMatchObject({
      path: cli.command,
      version: 'codex-cli 0.166.0',
      verification: 'verified',
      discovery: { otherPaths: [native] },
    })
    expect((await readFile(cli.calls, 'utf8')).trim().split('\n')).toHaveLength(1)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires an explicit path when multiple desktop entries exist', async () => {
    const fixture = await isolatedWindows()
    const candidates: string[] = []
    for (const name of ['a159911ff70742e9', 'ffffffffffffffff']) {
      const path = join(fixture.nativeRoot, name, 'codex.exe')
      candidates.push(path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'synthetic non-executable image')
    }
    expect(await executablePath('codex')).toBeUndefined()
    const item = await inspectHarness(definition, fixture.root)
    expect(item).toMatchObject({ installed: true, verification: 'failed', runnable: false })
    expect(item.path).toBeUndefined()
    expect(item.maintenanceAction).toBeUndefined()
    expect(item.discovery?.otherPaths.sort()).toEqual(candidates.sort())
    expect(item.error).toContain('绝对路径')
    const explicit = await inspectHarness({ ...definition, command: candidates[0]! }, fixture.root)
    expect(explicit.path).toBe(candidates[0])
    expect(explicit.error).toContain('启动失败')
  })

  it('bounds discovery and requests selection instead of treating a partial scan as unique', async () => {
    const fixture = await isolatedWindows()
    for (let index = 0; index < 34; index++)
      await mkdir(join(fixture.nativeRoot, 'release-' + index), { recursive: true })
    const item = await inspectHarness(definition, fixture.root)
    expect(item.discovery).toEqual({ otherPaths: [], limited: true })
    expect(item.path).toBeUndefined()
    expect(item.maintenanceAction).toBeUndefined()
    expect(item.error).toContain('搜索达到上限')
  })

  it('keeps a failing explicit bridge and its prefix while identifying other existing entries', async () => {
    const fixture = await isolatedWindows()
    const cli = await npmStyleCodex(fixture.roaming)
    const native = join(fixture.nativeRoot, 'a159911ff70742e9', 'codex.exe')
    await mkdir(dirname(native), { recursive: true })
    await writeFile(native, '')
    const script = join(fixture.root, 'custom-bridge.cjs')
    await writeFile(
      script,
      'console.error("custom bridge failed api_key=test-sensitive"); process.exit(9)',
    )
    const selected = { ...definition, command: process.execPath, prefix: [script] }
    const original = structuredClone(selected)
    const item = await inspectHarness(selected, fixture.root)
    expect(selected).toEqual(original)
    expect(item).toMatchObject({
      path: process.execPath,
      detectedBy: 'configured-path',
      verification: 'failed',
      runnable: false,
      discovery: { otherPaths: [cli.command, native] },
    })
    expect(item.error).toContain('退出码 9')
    expect(item.error).toContain('custom bridge failed')
    expect(item.error).not.toContain('test-sensitive')
    await expect(readFile(cli.calls)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await executablePath(selected.command, 'codex')).toBe(process.execPath)
  })

  it('reports a missing installer dependency before starting an npm installation', async () => {
    const fixture = await isolatedWindows()
    expect(await executablePath('npm')).toBeUndefined()
    await expect(
      maintainHarness({
        id: 'codex',
        name: 'Codex CLI',
        installed: false,
        runnable: false,
        instructions: '',
        website: '',
        maintenanceAction: 'install',
      }),
    ).rejects.toThrow('安装依赖检查（尚未启动安装）')
    const cli = await npmStyleCodex(fixture.roaming)
    const item = await inspectHarness(definition, fixture.root)
    expect(item).toMatchObject({ path: cli.command, verification: 'verified' })
  })
})

it('redacts labelled credentials and links from bounded probe diagnostics', () => {
  const diagnostic = harnessDiagnostic(
    '\u001b[31mfailed\u001b[0m\n' +
      'Authorization: Bearer test-sensitive-auth\n' +
      '{"apiKey": "test-sensitive-json", "client_secret": "test-sensitive-client"}\n' +
      'OPENAI_API_KEY=test-sensitive-env password="test-sensitive spaced password"\n' +
      'https://private.example.invalid/path?token=test-sensitive-url',
  )
  expect(diagnostic).toContain('failed')
  expect(diagnostic).toContain('[REDACTED]')
  expect(diagnostic).toContain('[链接]')
  expect(diagnostic).not.toContain('test-sensitive')
  expect(diagnostic).not.toContain('private.example.invalid')
  expect(diagnostic).not.toContain('\u001b')
  expect(harnessDiagnostic('x'.repeat(2000))).toHaveLength(1800)
})

it('keeps prerelease versions while excluding trailing diagnostic text from successful version labels', () => {
  expect(harnessVersion('codex-cli 0.166.0-alpha.6 token=test-sensitive', definition)).toBe(
    'codex-cli 0.166.0-alpha.6',
  )
})
