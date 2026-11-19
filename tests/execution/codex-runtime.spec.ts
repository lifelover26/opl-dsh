import { mkdtemp, readFile, rm, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as runtime from '../../src/execution/host/codex-runtime.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length) await cleanup.pop()!()
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'opl-codex-runtime-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const agents: { status: string }[] = []
  const activity = vi.fn(async () => [] as unknown[])
  const ctx = {
    agents: { list: () => agents },
    sessions: { list: () => [{ id: 'other-project' }] },
    get: () => undefined,
    waterfall: activity,
  } as unknown as Context
  const service = new HarnessService(ctx, { home: root })
  cleanup.push(() => service.dispose())
  const prepare = vi.spyOn(runtime, 'prepareCodexRuntime').mockImplementation((_home, request) => ({
    version: request.version,
    command: join(root, request.version, 'bin/codex.exe'),
    manifestSha256: 'a'.repeat(64),
    executableSha256: 'b'.repeat(64),
    validation: 'static',
  }))
  const current = async () =>
    (await service.executionCatalog()).harnesses.find((item) => item.id === 'codex')!
  return { root, service, agents, activity, prepare, current }
}
describe('Codex runtime publication', () => {
  it('publishes backend metadata atomically and restores the original command, preserving proxy and other engines', async () => {
    const { root, service, current } = await setup()
    await service.saveHarnessProxy('codex', { mode: 'direct' })
    const original = await service.executionCatalog()
    const first = await service.selectCodexRuntime({ mode: 'git-bash', version: 'candidate-one' })
    expect(first.previousCommand).toBe('codex')
    expect(await current()).toMatchObject({
      command: first.command,
      proxy: { mode: 'direct' },
      codexRuntime: { version: 'candidate-one', officialCommand: 'codex', officialPrefix: [] },
    })
    await service.selectCodexRuntime({ mode: 'git-bash', version: 'candidate-two' })
    const restored = await service.selectCodexRuntime({ mode: 'official' })
    expect(restored.command).toBe('codex')
    expect(await current()).not.toHaveProperty('codexRuntime')
    expect((await current()).proxy).toEqual({ mode: 'direct' })
    expect(
      (await service.executionCatalog()).harnesses.filter((item) => item.id !== 'codex'),
    ).toEqual(original.harnesses.filter((item) => item.id !== 'codex'))
    const saved = JSON.parse(
      await readFile(join(root, 'profiles/desktop/execution-catalog.json'), 'utf8'),
    )
    expect(saved.harnesses.find((item: { id: string }) => item.id === 'codex').command).toBe(
      'codex',
    )
  })
  it('keeps the selected command and files when a candidate upgrade fails verification', async () => {
    const { service, prepare, current } = await setup()
    const first = await service.selectCodexRuntime({ mode: 'git-bash', version: 'one' })
    prepare.mockImplementationOnce(() => {
      throw Error('bad package')
    })
    await expect(service.selectCodexRuntime({ mode: 'git-bash', version: 'two' })).rejects.toThrow(
      'bad package',
    )
    expect((await current()).command).toBe(first.command)
    expect((await current()).codexRuntime?.version).toBe('one')
  })
  it('refuses global activity before import and holds exclusion throughout a pending activity read', async () => {
    const { service, agents, activity, prepare } = await setup()
    agents.push({ status: 'running' })
    await expect(service.selectCodexRuntime({ mode: 'git-bash', version: 'one' })).rejects.toThrow(
      '活动任务',
    )
    expect(prepare).not.toHaveBeenCalled()
    agents.length = 0
    let release!: () => void, entered!: () => void
    const ready = new Promise<void>((done) => {
      entered = done
    })
    const pending = new Promise<unknown[]>((done) => {
      release = () => done([])
    })
    activity.mockImplementationOnce(() => {
      entered()
      return pending
    })
    const selection = service.selectCodexRuntime({ mode: 'git-bash', version: 'one' })
    try {
      await ready
      expect(() => service.assertRuntimeAvailable()).toThrow('切换')
      await expect(service.start({} as never)).rejects.toThrow('切换')
      await expect(service.selectCodexRuntime({ mode: 'official' })).rejects.toThrow('切换')
    } finally {
      release()
      await selection
    }
  })
  it('does not change the live selection when catalog persistence fails', async () => {
    const { root, service, current } = await setup()
    await service.selectCodexRuntime({ mode: 'git-bash', version: 'one' })
    const original = await current()
    const filename = join(root, 'profiles/desktop/execution-catalog.json')
    await rename(filename, filename + '.saved')
    await mkdir(filename)
    await expect(service.selectCodexRuntime({ mode: 'official' })).rejects.toThrow()
    expect(await current()).toEqual(original)
    await rm(filename, { recursive: true })
    await rename(filename + '.saved', filename)
  })
  it('refuses the official updater for a pinned candidate', async () => {
    const { service } = await setup()
    await service.selectCodexRuntime({ mode: 'git-bash', version: 'one' })
    await expect(service.updateHarness('codex')).rejects.toThrow('不使用官方更新器')
  })
})

it.skipIf(process.platform !== 'win32' || !process.env.OPL_TEST_CODEX_PACKAGE)(
  'imports the pinned Windows archive and preserves the selection across rejection and switch-back',
  async () => {
    const { service, prepare, current, root } = await setup()
    prepare.mockRestore()
    const original = await current()
    const version = '0.169.0-opl-gitbash.20261116.1'
    const selected = await service.selectCodexRuntime({
      mode: 'git-bash',
      version,
      source: process.env.OPL_TEST_CODEX_PACKAGE!,
    })
    expect(selected.command).toContain(version)
    const catalog = join(root, 'profiles/desktop/execution-catalog.json')
    const saved = await readFile(catalog)
    await expect(
      service.selectCodexRuntime({ mode: 'git-bash', version, source: root }),
    ).rejects.toThrow()
    expect(await readFile(catalog)).toEqual(saved)
    await service.selectCodexRuntime({ mode: 'official' })
    expect((await current()).command).toBe(original.command)
    expect(await current()).not.toHaveProperty('codexRuntime')
  },
  120_000,
)
