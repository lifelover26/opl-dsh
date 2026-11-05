import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executablePath,
  inspectHarness,
  harnessVersion,
  npmGlobalBin,
} from '../../src/execution/host/harness-registry.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Harness executable discovery', () => {
  it.skipIf(process.platform === 'win32')('uses the same discovered CLI in execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-harness-registry-'))
    roots.push(root)
    const command = join(root, 'codex')
    await writeFile(command, '#!/bin/sh\nprintf "codex-cli 9.9.9\\n"\n', { mode: 0o700 })
    vi.stubEnv('PATH', root)
    expect(await executablePath('codex')).toBe(command)
    const item = await inspectHarness({ id: 'codex', name: 'Codex CLI', kind: 'acp' }, root)
    expect(item.path).toBe(command)
  })
  it('reads a version printed on stderr and records a configured absolute path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-harness-registry-'))
    roots.push(root)
    const command = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    await writeFile(
      command,
      process.platform === 'win32'
        ? '@echo off\r\necho codex-cli 9.9.9 1>&2\r\n'
        : '#!/bin/sh\nprintf "codex-cli 9.9.9\\n" >&2\n',
    )
    await chmod(command, 0o700)
    const item = await inspectHarness(
      { id: 'codex', name: 'Codex CLI', kind: 'acp', command },
      root,
    )
    expect(item).toMatchObject({
      installed: true,
      runnable: true,
      verification: 'verified',
      path: command,
      detectedBy: 'configured-path',
      version: 'codex-cli 9.9.9',
      maintenanceAction: 'update',
    })
  })

  it.runIf(process.platform === 'win32')(
    'probes a cmd shim whose absolute path contains spaces',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'opl-harness-registry-'))
      roots.push(root)
      const install = join(root, 'Program Files Extra', 'Codex CLI')
      await mkdir(install, { recursive: true })
      const command = join(install, 'codex.cmd')
      await writeFile(command, '@echo off\r\necho codex-cli 9.9.9 1>&2\r\n')
      const item = await inspectHarness(
        { id: 'codex', name: 'Codex CLI', kind: 'acp', command },
        root,
      )
      expect(item).toMatchObject({
        installed: true,
        runnable: true,
        path: command,
        detectedBy: 'configured-path',
        version: 'codex-cli 9.9.9',
        maintenanceAction: 'update',
      })
    },
  )

  it('offers install when a built-in CLI is absent', async () => {
    vi.stubEnv('PATH', '')
    const root = await mkdtemp(join(tmpdir(), 'opl-harness-missing-'))
    roots.push(root)
    const item = await inspectHarness(
      { id: 'claude', name: 'Claude Code', kind: 'acp', command: '/definitely/missing/claude' },
      root,
    )
    expect(item).toMatchObject({
      installed: false,
      installable: true,
      maintenanceAction: 'install',
    })
  })

  it('does not launch the ZCode desktop entry point during discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-zcode-discovery-'))
    roots.push(root)
    const command = join(root, process.platform === 'win32' ? 'zcode.cmd' : 'zcode')
    const marker = join(root, 'launched')
    await writeFile(
      command,
      process.platform === 'win32'
        ? `@echo off\r\necho launched > "${marker}"\r\n`
        : `#!/bin/sh\nprintf launched > "${marker}"\n`,
    )
    await chmod(command, 0o700)
    const item = await inspectHarness({ id: 'zcode', name: 'ZCode', kind: 'acp', command }, root)
    expect(item).toMatchObject({ installed: true, runnable: true, path: command })
    expect(item).not.toHaveProperty('version')
    expect(item.verification).toBe('not-probed')
    await expect(access(marker)).rejects.toThrow()
  })

  it.runIf(process.platform === 'win32')(
    'detects and executes npm cmd shims instead of their POSIX or PowerShell siblings',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'opl-npm-shims-'))
      roots.push(root)
      const bin = join(root, 'Program Files', 'npm')
      await mkdir(bin, { recursive: true })
      vi.stubEnv('PATH', bin)
      vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD;.PS1')
      for (const [id, command, label] of [
        ['codex', 'codex', 'codex-cli'],
        ['kimi-code', 'kimi', 'kimi'],
        ['opencode', 'opencode', 'opencode'],
        ['kilo', 'kilo', 'kilo'],
        ['pi', 'pi', 'pi'],
      ]) {
        const script = join(bin, command + '.cjs')
        await writeFile(script, `process.stdout.write(${JSON.stringify(label + ' 9.9.9\n')})`)
        await writeFile(join(bin, command), '#!/bin/sh\nexit 81\n')
        await writeFile(join(bin, command + '.ps1'), 'exit 82\r\n')
        const shim = join(bin, command + '.cmd')
        // npm's cmd-shim layout passes its complete argument vector to Node.
        await writeFile(
          shim,
          `@ECHO off\r\nSETLOCAL\r\n"${process.execPath}" "%~dp0\\${command}.cjs" %*\r\n`,
        )
        expect(await executablePath(command, id)).toBe(shim)
        const automatic = await inspectHarness({ id: id!, name: id!, kind: 'acp' }, root)
        const configured = await inspectHarness(
          { id: id!, name: id!, kind: 'acp', command: shim },
          root,
        )
        expect(automatic).toMatchObject({ path: shim, verification: 'verified', runnable: true })
        expect(automatic.version).toBe(configured.version)
        expect(automatic.version).toBe(label + ' 9.9.9')
      }
    },
  )

  it.runIf(process.platform === 'win32')(
    'honors each PATH directory and PATHEXT order while excluding directories and unsupported scripts',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'opl-path-order-'))
      roots.push(root)
      const first = join(root, 'first')
      const second = join(root, 'second')
      await mkdir(first)
      await mkdir(second)
      vi.stubEnv('PATH', [first, second].join(delimiter))
      vi.stubEnv('PATHEXT', '.PS1;.EXE;.CMD')
      await mkdir(join(first, 'codex.exe'))
      await writeFile(join(first, 'codex.cmd'), '')
      await writeFile(join(first, 'codex.ps1'), '')
      await writeFile(join(second, 'codex'), '')
      await writeFile(join(second, 'codex.exe'), '')
      expect(await executablePath('codex')).toBe(join(first, 'codex.cmd'))
      await rm(join(first, 'codex.exe'), { recursive: true })
      await writeFile(join(first, 'codex.exe'), '')
      expect(await executablePath('codex')).toBe(join(first, 'codex.exe'))
      vi.stubEnv('PATHEXT', '.CMD;.EXE')
      expect(await executablePath('codex')).toBe(join(first, 'codex.cmd'))
      await writeFile(join(first, 'codex.cmd.exe'), '')
      await rm(join(first, 'codex.cmd'))
      await writeFile(join(second, 'codex.cmd'), '')
      expect(await executablePath('codex.cmd', 'codex')).toBe(join(second, 'codex.cmd'))
    },
  )

  it('rejects directories and preserves a missing explicit path even when a default command exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-explicit-command-'))
    roots.push(root)
    const name = process.platform === 'win32' ? 'codex.cmd' : 'codex'
    const command = join(root, name)
    await writeFile(command, '', { mode: 0o700 })
    vi.stubEnv('PATH', root)
    const missing = join(root, 'missing', name)
    expect(await executablePath(missing, 'codex')).toBeUndefined()
    const directory = join(root, 'directory')
    await mkdir(directory)
    expect(await executablePath(directory, 'codex')).toBeUndefined()
    const item = await inspectHarness(
      { id: 'codex', name: 'Codex CLI', kind: 'acp', command: missing },
      root,
    )
    expect(item).toMatchObject({ installed: false, runnable: false, verification: 'failed' })
    expect(item.error).toContain(missing)
  })

  it('uses npm prefix launcher directories appropriate to the host platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-npm-prefix-'))
    roots.push(root)
    vi.stubEnv('PATH', '')
    vi.stubEnv('npm_config_prefix', root)
    const name = 'opl-prefix-fixture' + (process.platform === 'win32' ? '.cmd' : '')
    await mkdir(join(root, 'bin'))
    for (const bin of [root, join(root, 'bin')])
      await writeFile(join(bin, name), '', { mode: 0o700 })
    const bin = process.platform === 'win32' ? root : join(root, 'bin')
    expect(await executablePath('opl-prefix-fixture', 'codex')).toBe(join(bin, name))
    expect(npmGlobalBin(root, 'win32')).toBe(root)
    expect(npmGlobalBin(root, 'darwin')).toBe(join(root, 'bin'))
  })

  it('retains the official MiniMax launcher name and known installation root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-minimax-root-'))
    roots.push(root)
    vi.stubEnv('PATH', '')
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
    vi.stubEnv('APPDATA', root)
    vi.stubEnv('MINIMAX_CODE_HOME', root)
    const path = join(root, process.platform === 'win32' ? 'mcode.cmd' : 'mcode')
    await writeFile(path, '', { mode: 0o700 })
    expect(await executablePath('mcode', 'minimax-code')).toBe(path)
  })

  it('does not accept successful login prompts or warnings as CLI versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-cli-unversioned-'))
    roots.push(root)
    const script = join(root, 'unversioned.cjs')
    await writeFile(
      script,
      'console.log("Sign in at https://example.invalid/login token=test-sensitive")',
    )
    const item = await inspectHarness(
      { id: 'codex', name: 'Codex CLI', kind: 'acp', command: process.execPath, prefix: [script] },
      root,
    )
    expect(item).toMatchObject({ installed: true, runnable: false, verification: 'failed' })
    expect(item.version).toBeUndefined()
    expect(item.error).toContain('未返回可识别的版本号')
    expect(item.error).toContain('退出码 0')
    expect(item.error).not.toContain('Sign in')
    expect(item.error).not.toContain('test-sensitive')
    expect(item.error).not.toContain('https://')
  })

  it('reports the real probe exit status and timeout instead of marking a found file runnable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-cli-probe-failure-'))
    roots.push(root)
    const script = join(root, 'probe.cjs')
    const definition = {
      id: 'codex',
      name: 'Codex CLI',
      kind: 'acp' as const,
      command: process.execPath,
      prefix: [script],
    }
    await writeFile(
      script,
      'console.error("missing runtime dependency token=test-sensitive"); process.exit(9)',
    )
    const failed = await inspectHarness(definition, root)
    expect(failed).toMatchObject({ installed: true, runnable: false, verification: 'failed' })
    expect(failed.error).toContain('退出码 9')
    expect(failed.error).toContain('missing runtime dependency')
    expect(failed.error).not.toContain('test-sensitive')
    await writeFile(script, 'setInterval(() => {}, 1000)')
    const timedOut = await inspectHarness(definition, root, undefined, {
      versionTimeoutMs: 100,
      fresh: true,
    })
    expect(timedOut).toMatchObject({ installed: true, runnable: false, verification: 'failed' })
    expect(timedOut.error).toContain('超过 0.1 秒')
  })

  it('reuses a bounded version probe until the entry changes or fresh verification is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-cli-probe-cache-'))
    roots.push(root)
    const command = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
    const script = join(root, 'probe.cjs')
    const count = join(root, 'count')
    await writeFile(
      script,
      `require('node:fs').appendFileSync(${JSON.stringify(count)}, '1'); console.log('codex-cli 9.9.9')`,
    )
    const launcher =
      process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`
    await writeFile(command, launcher, { mode: 0o700 })
    const definition = { id: 'codex', name: 'Codex CLI', kind: 'acp' as const, command }
    const first = await Promise.all([
      inspectHarness(definition, root),
      inspectHarness(definition, root),
    ])
    expect(first.every((item) => item.verification === 'verified')).toBe(true)
    expect(await readFile(count, 'utf8')).toBe('1')
    await inspectHarness(definition, root)
    expect(await readFile(count, 'utf8')).toBe('1')
    await writeFile(
      command,
      launcher + (process.platform === 'win32' ? 'rem changed\r\n' : '# changed\n'),
    )
    await inspectHarness(definition, root)
    expect(await readFile(count, 'utf8')).toBe('11')
    await inspectHarness(definition, root, undefined, { fresh: true })
    expect(await readFile(count, 'utf8')).toBe('111')
  })

  it('finds version lines on either stream while ignoring preceding warnings', () => {
    for (const version of ['codex-cli 0.160.1', '0.160.1', 'v0.160.1', '0.160.1 (Codex CLI)'])
      expect(
        harnessVersion('Warning: update available\n' + version, { id: 'codex', name: 'Codex CLI' }),
      ).toBe(version)
    expect(
      harnessVersion('Kimi Code CLI, version 2.1.1', { id: 'kimi-code', name: 'Kimi Code' }),
    ).toBe('Kimi Code CLI, version 2.1.1')
    expect(
      harnessVersion('Warning: node 24.20.0 is unsupported', { id: 'codex', name: 'Codex CLI' }),
    ).toBeUndefined()
    expect(harnessVersion('Please sign in', { id: 'codex', name: 'Codex CLI' })).toBeUndefined()
  })
})
