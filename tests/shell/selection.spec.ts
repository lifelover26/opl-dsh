import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
vi.mock('../../src/shell/host/git-bash.ts', () => ({
  resolveGitBashPath: () => 'C:/Git/bin/bash.exe',
}))
import { nativeShellStatus, selectNativeShell } from '../../src/shell/host/selection.ts'

const expr = (source: string) => ({ __jsExpr: source })
function setup() {
  const suite = {
    id: 'opl-suite',
    name: '@one-person-lab/dsh-opl',
    config: { nativeShellReceipt: '', untouched: true },
  }
  const definitions = [
    {
      id: 'bash-sandbox',
      name: '@deepseek-ai/dsh-bash-sandbox',
      disabled: expr("process.platform === 'win32'"),
    },
    {
      id: 'pwsh-sandbox',
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: expr("process.platform !== 'win32'"),
    },
    { id: 'opl-native-git-bash', name: '@one-person-lab/dsh-opl/git-bash', disabled: true },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: true },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: true },
    ...['standard', 'cordis', 'ptc'].map((id) => ({
      id: 'preset-' + id,
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id,
        untouched: 'keep',
        plugins: [
          {
            id: 'tool-bash',
            name: '@deepseek-ai/dsh-tool-bash',
            disabled: expr("process.platform === 'win32'"),
          },
          {
            id: 'tool-pwsh',
            name: '@deepseek-ai/dsh-tool-pwsh',
            disabled: expr("process.platform !== 'win32'"),
          },
          { id: 'other', name: 'another-tool', config: { keep: true } },
        ],
      },
    })),
    {
      id: 'preset-minimal',
      name: '@deepseek-ai/dsh-agent-preset',
      config: { plugins: [{ id: 'persistent-shell', name: 'group' }] },
    },
    suite,
  ]
  const entries = definitions.map((options) => ({
    id: options.id,
    options,
    parent: { tree: { update: vi.fn() } },
  }))
  const update = vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const entry = entries.find((row) => row.options.id === id)!
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete (entry.options as Record<string, unknown>)[key]
      else Object.assign(entry.options, { [key]: structuredClone(value) })
    }
  })
  for (const entry of entries) entry.parent.tree.update = update
  const inspect = vi.fn(async () => true)
  const mutate = vi.fn(async (_ns, ops) => {
    suite.config.nativeShellReceipt = ops[0].value
  })
  const ctx = {
    loader: { entries: () => entries },
    settings: { describe: () => [{ ns: 'opl-suite', value: suite.config, revision: 7 }], mutate },
    agents: { list: () => [] },
    get: (name: string) => (name === 'agents' ? { list: () => [] } : { inspect }),
  } as unknown as Context
  return { ctx, definitions, entries, update, mutate, inspect, suite }
}
describe('explicit native Windows Git Bash selection', () => {
  it('leaves the official default unchanged when reading status', () => {
    const f = setup()
    expect(nativeShellStatus(f.ctx, 'win32')).toEqual({ available: true, enabled: false })
    expect(f.update).not.toHaveBeenCalled()
    expect(nativeShellStatus(f.ctx, 'linux')).toEqual({ available: false, enabled: false })
  })
  it('stores a restart choice without changing any active provider or preset', async () => {
    const f = setup()
    const before = structuredClone(f.definitions)
    expect(await selectNativeShell(f.ctx, true, 'win32')).toMatchObject({
      pending: true,
      desired: true,
      enabled: false,
    })
    expect(f.update).not.toHaveBeenCalled()
    expect(f.mutate).toHaveBeenCalledExactlyOnceWith(
      'opl-suite',
      [{ op: 'set', path: ['nativeShellReceipt'], value: f.suite.config.nativeShellReceipt }],
      7,
    )
    for (const row of f.definitions.filter((item) => item.id !== 'opl-suite'))
      expect(row).toEqual(before.find((item) => item.id === row.id))
    expect(nativeShellStatus(f.ctx, 'win32')).toMatchObject({ pending: true, desired: true })
    expect(await selectNativeShell(f.ctx, false, 'win32')).toEqual({
      available: true,
      enabled: false,
    })
    expect(f.suite.config.nativeShellReceipt).toBe('')
  })
  it('refuses active work before any configuration mutation', async () => {
    const f = setup()
    f.inspect.mockResolvedValueOnce(false)
    await expect(selectNativeShell(f.ctx, true, 'win32')).rejects.toThrow('任务活动')
    expect(f.update).not.toHaveBeenCalled()
  })
  it('records a pending choice when an Agent is loaded and applies it next boot', async () => {
    const f = setup()
    vi.spyOn(f.ctx.agents, 'list').mockReturnValue([{}] as never)
    expect(await selectNativeShell(f.ctx, true, 'win32')).toMatchObject({
      pending: true,
      enabled: false,
    })
    expect(f.update).not.toHaveBeenCalled()
    expect(f.mutate).toHaveBeenCalledOnce()
  })
})
it('uses official SettingsForms persistence rather than writing the bundle Loader tree', async () => {
  const { Context: CordisContext } = await import('@deepseek-ai/cordis')
  const { default: SettingsForms } = await import('@deepseek-ai/dsh-settings')
  const { Config } = await import('../../src/suite/config.ts')
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'opl-shell-profile-'))
  const document = join(home, 'profile-patch.json')
  const root = new CordisContext()
  try {
    const f = setup()
    root.provide('loader', { entries: () => f.entries, await: async () => {} })
    root.provide('profileContext', { home, name: 'fixture', patchPath: document })
    root.provide('oplUpdateRuntime', { inspect: async () => true })
    const suite = root.plugin({ name: 'fixture-suite', Config, apply() {} }, {})
    await suite
    const entry = {
      id: 'fixture:opl-suite',
      options: { id: 'opl-suite', config: {} },
      fiber: suite.ctx.fiber,
    }
    let user: Record<string, unknown> = {}
    root.provide('configEditor', {
      entries: () => [entry],
      configuration: () => [{ entry, inherited: {}, override: user }],
      edit: async (
        _entry: unknown,
        change: (
          raw: Record<string, unknown>,
          inherited: Record<string, unknown>,
        ) => Record<string, unknown>,
      ) => {
        const next = change(entry.options.config, {})
        await writeFile(document, JSON.stringify({ 'opl-suite': next }))
        user = structuredClone(next)
        entry.options.config = next
        await entry.fiber.update(next, true)
      },
    })
    await root.plugin(SettingsForms)
    expect(await selectNativeShell(root, true, 'win32')).toMatchObject({
      desired: true,
      pending: true,
    })
    const saved = JSON.parse(await readFile(document, 'utf8'))
    const receipt = JSON.parse(saved['opl-suite'].nativeShellReceipt)
    expect(receipt).toMatchObject({ pending: true, enabled: true })
    expect(receipt.entries).toHaveLength(6)
    expect(f.update).not.toHaveBeenCalled()
    expect(nativeShellStatus(root, 'win32')).toMatchObject({ desired: true, pending: true })
  } finally {
    await root.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
