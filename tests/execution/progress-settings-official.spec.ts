import { Context, type Fiber } from '@deepseek-ai/cordis'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Config } from '../../src/execution/host/plugin-config.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'

it('saves execution deadlines through official volatile-field validation and reloads the persisted choice', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opl-progress-settings-'))
  const document = join(home, 'profile-patch.json')
  const root = new Context()
  let harness: HarnessService | undefined
  try {
    root.provide('loader', { await: async () => {} })
    root.provide('profileContext', { home, name: 'fixture', patchPath: document })
    const plugin = { name: 'fixture-execution', Config, apply() {} }
    const raw = { rememberPermissionPreset: true }
    const owner = root.plugin(plugin, raw)
    await owner
    const entry: {
      id: string
      options: { id: string; config: Record<string, unknown> }
      fiber: Fiber
    } = {
      id: 'fixture:opl-execution',
      options: { id: 'opl-execution', config: raw },
      fiber: owner.ctx.fiber,
    }
    let user: Record<string, unknown> = {}
    root.provide('configEditor', {
      entries: () => [entry],
      configuration: () => [{ entry, inherited: raw, override: user }],
      edit: async (
        _entry: unknown,
        change: (
          raw: Record<string, unknown>,
          base: Record<string, unknown>,
        ) => Record<string, unknown>,
      ) => {
        const next = change(structuredClone(entry.options.config), raw)
        await writeFile(document, JSON.stringify({ 'opl-execution': next }))
        user = structuredClone(next)
        entry.options.config = next
        await entry.fiber.update(next, true)
      },
    })
    await root.plugin(SettingsForms)
    harness = new HarnessService(root, { home: join(home, 'harness') })
    expect(harness.executionLimits().enabled).toBe(false)
    const enabled = { enabled: true, firstProgressMs: 120_000, idleProgressMs: 180_000 }
    expect(await harness.saveExecutionLimits(enabled)).toEqual(enabled)
    expect(harness.executionLimits()).toEqual(enabled)
    expect(
      root.settings.describe().find((item) => item.ns === 'opl-execution')?.value,
    ).toMatchObject({ executionLimits: enabled })
    const saved = JSON.parse(await readFile(document, 'utf8'))['opl-execution']
    expect(saved.executionLimits).toEqual(enabled)
    expect(saved.rememberPermissionPreset).toBe(true)
    await owner.dispose()
    const reloaded = root.plugin(plugin, saved)
    await reloaded
    expect((reloaded.ctx.fiber.effectiveConfig as Config).executionLimits.get()).toEqual(enabled)
    entry.fiber = reloaded.ctx.fiber
    expect(await harness.saveExecutionLimits({ ...enabled, enabled: false })).toEqual({
      ...enabled,
      enabled: false,
    })
    expect(
      JSON.parse(await readFile(document, 'utf8'))['opl-execution'].executionLimits.enabled,
    ).toBe(false)
  } finally {
    await harness?.dispose()
    await root.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
