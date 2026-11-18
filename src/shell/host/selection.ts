/** Explicit Windows shell selection through the official persisted Loader entries. */
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { NativeShellStatus } from '../contracts/selection.ts'
import { resolveGitBashPath } from './git-bash.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const providers = [
  ['bash-sandbox', '@deepseek-ai/dsh-bash-sandbox', true],
  ['pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox', true],
  ['opl-native-git-bash', '@one-person-lab/dsh-opl/git-bash', false],
] as const
const presetIds = ['preset-standard', 'preset-ptc', 'preset-cordis']
const tools = ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh']
interface ToolEntry {
  name: string
  disabled?: unknown
}
interface Receipt {
  pending: boolean
  enabled?: boolean
  entries: SavedEntry[]
}
interface SavedEntry {
  id: string
  name: string
  preset: boolean
  before: unknown[]
  after: boolean[]
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function presetTools(entry: Entry): ToolEntry[] {
  const plugins: unknown = entry.options.config?.plugins
  if (!Array.isArray(plugins)) throw Error('官方预设 Shell 工具配置不可用')
  return tools.map((name) => {
    const matches = plugins.filter((row) => row?.name === name)
    if (matches.length !== 1) throw Error('无法唯一识别官方预设 Shell 工具，未修改配置')
    return matches[0] as ToolEntry
  })
}
function plan(ctx: Context): { entry: Entry; saved: SavedEntry }[] {
  const all = [...ctx.loader.entries()]
  const result: { entry: Entry; saved: SavedEntry }[] = providers.map(([id, name, disabled]) => {
    const matches = all.filter((entry) => entry.options.id === id && entry.options.name === name)
    if (matches.length !== 1) throw Error(`无法唯一识别 Shell 插件 ${id}，未修改配置`)
    const entry = matches[0]!
    return {
      entry,
      saved: {
        id: entry.options.id,
        name,
        preset: false,
        before: [entry.options.disabled ?? null],
        after: [disabled],
      },
    }
  })
  const presets = all.filter(
    (entry) =>
      presetIds.includes(entry.options.id) &&
      entry.options.name === '@deepseek-ai/dsh-agent-preset',
  )
  if (!presets.length) throw Error('未找到官方 Agent 预设，未修改 Shell 配置')
  for (const entry of presets)
    result.push({
      entry,
      saved: {
        id: entry.options.id,
        name: entry.options.name,
        preset: true,
        before: presetTools(entry).map((tool) => tool.disabled ?? null),
        after: [false, true],
      },
    })
  return result
}
function readReceipt(ctx: Context): Receipt | undefined {
  const value = ctx.settings.describe().find((row) => row.ns === 'opl-suite')?.value as
    { nativeShellReceipt?: string } | undefined
  if (!value?.nativeShellReceipt) return undefined
  const raw: unknown = JSON.parse(value.nativeShellReceipt)
  const receipt = Array.isArray(raw) ? { pending: false, entries: raw } : raw
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !Array.isArray((receipt as Receipt).entries) ||
    (receipt as Receipt).entries.length < providers.length + 1
  )
    throw Error('Shell 恢复记录无效')
  const saved = (receipt as Receipt).entries
  for (const row of saved) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.preset !== 'boolean' ||
      !Array.isArray(row.before) ||
      !Array.isArray(row.after) ||
      row.before.length !== row.after.length
    )
      throw Error('Shell 恢复记录无效')
  }
  return receipt as Receipt
}
async function saveReceipt(ctx: Context, saved: Receipt | undefined): Promise<void> {
  const suite = ctx.settings.describe().find((entry) => entry.ns === 'opl-suite')
  if (!suite) throw Error('OPL 设置入口不可用')
  await ctx.settings.mutate(
    'opl-suite',
    [
      {
        op: 'set',
        path: ['nativeShellReceipt'],
        value: saved ? JSON.stringify(saved) : '',
      },
    ],
    suite.revision,
  )
}
function currentValues(entry: Entry, saved: SavedEntry): unknown[] {
  return saved.preset
    ? presetTools(entry).map((row) => row.disabled ?? null)
    : [entry.options.disabled ?? null]
}
function assertOwned(current: ReturnType<typeof plan>, saved: SavedEntry[]): void {
  if (current.length !== saved.length) throw Error('Shell 插件或预设已变更，已拒绝覆盖')
  for (const row of saved) {
    const match = current.find(
      ({ entry }) => entry.options.id === row.id && entry.options.name === row.name,
    )
    if (
      !match ||
      match.saved.preset !== row.preset ||
      !equal(row.after, match.saved.after) ||
      !equal(currentValues(match.entry, row), row.after)
    )
      throw Error('Shell 插件配置已由用户修改，已拒绝覆盖；请先在插件管理中核对配置')
  }
}
function pendingFailure(ctx: Context): string | undefined {
  try {
    const value = ctx.settings.describe().find((row) => row.ns === 'opl-suite')?.value as
      { nativeShellReceipt?: string } | undefined
    const raw = value?.nativeShellReceipt ?? ''
    const saved = JSON.parse(
      readFileSync(join(dshHomePath(), 'profiles/desktop/native-shell-status.json'), 'utf8'),
    ) as { receiptHash?: string; message?: string }
    if (saved.receiptHash && saved.receiptHash !== createHash('sha256').update(raw).digest('hex'))
      return
    return typeof saved.message === 'string' ? saved.message : undefined
  } catch (error) {
    // A missing or unreadable optional failure record does not change the saved preference.
    return undefined
  }
}
/** Read the effective opt-in and any ownership conflict without changing official defaults. */
export function nativeShellStatus(ctx: Context, platform = process.platform): NativeShellStatus {
  if (platform !== 'win32') return { available: false, enabled: false }
  try {
    const current = plan(ctx)
    const saved = readReceipt(ctx)
    if (saved && !saved.pending) assertOwned(current, saved.entries)
    return {
      available: true,
      enabled: saved !== undefined && (!saved.pending || saved.enabled === false),
      ...(saved?.pending
        ? {
            pending: true,
            desired: saved.enabled === true,
            reason: pendingFailure(ctx) ?? '将在下次启动前应用 Shell 选择',
          }
        : {}),
    }
  } catch (error) {
    return {
      available: false,
      enabled: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
/** Save a pending choice in the official profile settings without changing loaded Agents. */
export async function selectNativeShell(
  ctx: Context,
  enabled: boolean,
  platform = process.platform,
): Promise<NativeShellStatus> {
  if (platform !== 'win32') throw Error('Git Bash 选项仅适用于 Windows')
  const runtime = ctx.get('oplUpdateRuntime')
  if (!runtime) throw Error('任务活动状态暂不可用，请稍后重试')
  if (!(await runtime.inspect())) throw Error('仍有任务活动，请停止后再保存 Shell 选择')
  const current = plan(ctx)
  const saved = readReceipt(ctx)
  if (saved && (!saved.pending || saved.enabled === false)) assertOwned(current, saved.entries)
  const currentlyEnabled = saved !== undefined && (!saved.pending || saved.enabled === false)
  if (enabled === currentlyEnabled) {
    if (saved?.pending)
      await saveReceipt(
        ctx,
        currentlyEnabled ? { pending: false, entries: saved.entries } : undefined,
      )
    return nativeShellStatus(ctx, platform)
  }
  if (enabled) resolveGitBashPath()
  const original = saved?.entries ?? structuredClone(current.map((row) => row.saved))
  await saveReceipt(ctx, { pending: true, enabled, entries: original })
  return { available: true, enabled: currentlyEnabled, pending: true, desired: enabled }
}
