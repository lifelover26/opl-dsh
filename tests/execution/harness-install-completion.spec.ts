import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessDefinition, HarnessProxy } from '../../src/execution/contracts/catalog.ts'
import type { HarnessInstallation } from '../../src/execution/contracts/installations.ts'
import { defaultExecutionCatalog, ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'
import * as registry from '../../src/execution/host/harness-registry.ts'
import * as maintenance from '../../src/execution/host/harness-maintenance.ts'

const tempDirectory = tmpdir()
const cleanup: (() => Promise<unknown>)[] = []
const realMaintainHarness = maintenance.maintainHarness
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function context(): Context {
  return {
    agents: { list: () => [], get: () => undefined },
    sessions: { list: () => [] },
    get: () => undefined,
    waterfall: async (_event: string, _request: unknown, next: () => Promise<unknown[]>) => next(),
  } as unknown as Context
}

async function setup(
  options: { id?: string; command?: string; proxy?: HarnessProxy; installed?: boolean } = {},
) {
  await mkdir(tempDirectory, { recursive: true })
  const root = await mkdtemp(join(tempDirectory, 'install-completion-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const id = options.id ?? 'codex'
  const catalog = defaultExecutionCatalog()
  const definition = catalog.harnesses.find((entry) => entry.id === id)!
  if (options.command !== undefined) definition.command = options.command
  if (options.proxy !== undefined) definition.proxy = options.proxy
  const disk = new ExecutionCatalogStore(root)
  await disk.set(catalog)
  await disk.dispose()
  const installRoot = registry.npmGlobalBin(join(root, 'Custom npm prefix'))
  const installedPath = join(installRoot, id + (process.platform === 'win32' ? '.cmd' : ''))
  const initial: HarnessInstallation = {
    id,
    name: definition.name,
    installed: options.installed ?? false,
    runnable: false,
    verification: options.installed ? 'verified' : 'failed',
    ...(options.installed ? { path: options.command ?? join(root, id), version: '1.0.0' } : {}),
    maintenanceAction: options.installed ? 'update' : 'install',
    instructions: 'fixture',
    website: '',
  }
  const fresh: HarnessInstallation = {
    ...initial,
    installed: true,
    runnable: id !== 'antigravity',
    verification: 'verified',
    path: installedPath,
    version: '9.9.9',
    maintenanceAction: 'update',
  }
  let installed = false
  const inspect = vi.spyOn(registry, 'inspectHarness').mockImplementation(async (harness) =>
    harness.id === id
      ? { ...(installed ? fresh : initial), name: harness.name }
      : {
          id: harness.id,
          name: harness.name,
          installed: false,
          runnable: false,
          instructions: 'fixture',
          website: '',
        },
  )
  const readback = vi
    .spyOn(registry, 'inspectInstalledHarness')
    .mockImplementation(async () => fresh)
  const result: maintenance.MaintenanceResult = {
    command: join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    message: 'fixture installer completed',
    installRoots: [installRoot],
  }
  const maintain = vi.spyOn(maintenance, 'maintainHarness').mockImplementation(async () => {
    await mkdir(installRoot, { recursive: true })
    await writeFile(
      installedPath,
      process.platform === 'win32'
        ? '@echo off\r\necho 9.9.9\r\n'
        : '#!/bin/sh\nprintf "9.9.9\\n"\n',
      { mode: 0o700 },
    )
    installed = true
    return result
  })
  const service = new HarnessService(context(), { home: root })
  let disposed = false
  const dispose = async () => {
    if (!disposed) {
      disposed = true
      await service.dispose()
    }
  }
  cleanup.push(dispose)
  const saved = async () => {
    const bytes = JSON.parse(
      await readFile(join(root, 'profiles/desktop/execution-catalog.json'), 'utf8'),
    )
    return bytes.harnesses.find((entry: HarnessDefinition) => entry.id === id) as HarnessDefinition
  }
  const completed = async () => {
    let item!: HarnessInstallation
    await vi.waitFor(
      async () => {
        item = (await service.installations()).find((entry) => entry.id === id)!
        expect(item.maintenance?.state).toMatch(/^(completed|failed)$/)
      },
      { timeout: 5000, interval: 10 },
    )
    return item
  }
  const reload = async () => {
    await dispose()
    const reloaded = new HarnessService(context(), { home: root })
    cleanup.push(() => reloaded.dispose())
    return (await reloaded.installations()).find((entry) => entry.id === id)!
  }
  return {
    root,
    id,
    service,
    definition,
    initial,
    fresh,
    installedPath,
    installRoot,
    inspect,
    readback,
    result,
    maintain,
    saved,
    completed,
    reload,
  }
}

it('persists a first installation in the actual custom npm prefix and reloads its managed command', async () => {
  const f = await setup()
  expect(f.definition.command).toBe('codex')
  expect((await f.service.updateHarness('codex'))?.state).toBe('running')
  const item = await f.completed()
  expect(item.maintenance).toMatchObject({
    state: 'completed',
    message: 'fixture installer completed',
  })
  expect(f.readback).toHaveBeenCalledWith(f.definition, f.root, f.result, expect.any(String))
  expect(f.result.installRoots).toEqual([f.installRoot])
  expect((await f.saved()).command).toBe(f.installedPath)
  expect((await f.reload()).definition?.command).toBe(f.installedPath)
})

it.each(['explicit-path', 'custom-alias'] as const)(
  'keeps a user-selected %s rather than publishing another detected launcher',
  async (kind) => {
    const command =
      kind === 'explicit-path'
        ? join(tempDirectory, 'selected-standalone', 'codex.exe')
        : 'my-selected-codex'
    const f = await setup({ command })
    await f.service.updateHarness('codex')
    expect((await f.completed()).maintenance?.state).toBe('completed')
    expect(f.fresh.path).not.toBe(command)
    expect((await f.saved()).command).toBe(command)
    expect((await f.reload()).definition?.command).toBe(command)
  },
)

it('completes a verified Antigravity update even though that CLI has no conversation adapter', async () => {
  const f = await setup({ id: 'antigravity', installed: true })
  expect(f.fresh).toMatchObject({ verification: 'verified', version: '9.9.9', runnable: false })
  await f.service.updateHarness(f.id)
  expect((await f.completed()).maintenance?.state).toBe('completed')
  expect(f.maintain).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'antigravity', maintenanceAction: 'update' }),
    undefined,
  )
  expect((await f.saved()).command).toBe('agy')
})

it.each(['failed-probe', 'missing-version'] as const)(
  'marks maintenance failed after %s and preserves the original catalog command',
  async (kind) => {
    const f = await setup()
    const { version: _version, ...withoutVersion } = f.fresh
    f.readback.mockResolvedValue(
      kind === 'failed-probe'
        ? {
            ...f.fresh,
            verification: 'failed',
            runnable: false,
            error: 'fixture version readback failed',
          }
        : { ...withoutVersion, verification: 'verified' },
    )
    await f.service.updateHarness(f.id)
    const item = await f.completed()
    expect(item.maintenance?.state).toBe('failed')
    expect(item.maintenance?.message).toContain('fixture installer completed')
    expect(item.maintenance?.message).toContain(
      kind === 'failed-probe' ? 'fixture version readback failed' : '版本回读失败',
    )
    expect((await f.saved()).command).toBe('codex')
    expect((await f.reload()).definition?.command).toBe('codex')
  },
)

it('passes the saved custom proxy to the actual maintenance child without changing Desktop environment', async () => {
  const proxy: HarnessProxy = { mode: 'custom', url: 'http://127.0.0.1:31337' }
  const f = await setup({ id: 'claude', installed: true, proxy })
  const script = join(f.root, 'proxy-updater.cjs')
  const output = join(f.root, 'proxy-environment.json')
  const launcher = join(
    f.root,
    process.platform === 'win32' ? 'proxy updater.cmd' : 'proxy updater',
  )
  await writeFile(
    script,
    `
if (process.argv[2] !== 'update') process.exit(17)
const environment = new Map(Object.entries(process.env))
require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(Object.fromEntries(
  ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','OPENAI_API_KEY'].map(key => [key, environment.get(key) ?? null])
)))
console.log('fixture proxy updater completed')
`,
  )
  await mkdir(dirname(launcher), { recursive: true })
  await writeFile(
    launcher,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o700 },
  )
  f.initial.path = launcher
  f.fresh.path = launcher
  vi.stubEnv('HTTP_PROXY', 'http://inherited.invalid:9999')
  vi.stubEnv('HTTPS_PROXY', 'http://inherited.invalid:9999')
  vi.stubEnv('ALL_PROXY', 'http://inherited.invalid:9999')
  vi.stubEnv('NO_PROXY', 'inherited.invalid')
  vi.stubEnv('http_proxy', 'http://inherited.invalid:9999')
  vi.stubEnv('https_proxy', 'http://inherited.invalid:9999')
  vi.stubEnv('OPENAI_API_KEY', 'test-sensitive')
  f.maintain.mockImplementationOnce(async (item, selectedProxy) => {
    if (item.path !== launcher) throw Error('refusing a non-fixture updater')
    return realMaintainHarness(item, selectedProxy)
  })
  await f.service.updateHarness(f.id)
  expect((await f.completed()).maintenance?.state).toBe('completed')
  expect(f.maintain).toHaveBeenCalledWith(expect.objectContaining({ path: launcher }), proxy)
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    ALL_PROXY: null,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    http_proxy: null,
    https_proxy: null,
    OPENAI_API_KEY: null,
  })
  expect(process.env.HTTP_PROXY).toBe('http://inherited.invalid:9999')
})
