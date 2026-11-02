import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, copyFile, constants } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DSH_COMBINATION, GROK_COMBINATION, type HarnessCatalog } from '../contracts/sessions.ts'
import {
  displayModelSource,
  isRetiredModel,
  modelRefKey,
  type CombinationDefinition,
  type ExecutionCatalog,
  type ModelRef,
} from '../contracts/catalog.ts'
import { harnessAllowsFullAccess } from './permissions.ts'
import { normalizeHarnessProxy } from './proxy.ts'
import { OFM_INACTIVE_DEFAULT_HARNESSES } from './ofm-source/selection-policy.ts'
import type { CodexGitBashRuntime } from '../contracts/codex-runtime.ts'
export type { ExecutionCatalog } from '../contracts/catalog.ts'
export const defaultExecutionCatalog = (): ExecutionCatalog => ({
  version: 2,
  models: [],
  harnesses: (
    [
      { id: 'dsh', name: 'DSH', kind: 'dsh', adapter: 'native-session' },
      { id: 'codex', name: 'Codex CLI', kind: 'acp', command: 'codex' },
      { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'claude' },
      { id: 'grok-build', name: 'Grok Build', kind: 'grok-build', adapter: 'acp-v1' },
      { id: 'antigravity', name: 'Antigravity CLI', kind: 'acp', command: 'agy' },
      // The official MiniMax Code CLI signs in with its own account; the suite never
      // supplies an OPL Gateway key for it.
      {
        id: 'minimax-code',
        name: 'MiniMax Code',
        kind: 'acp',
        command: 'mcode',
        adapter: 'acp-v1',
      },
      { id: 'zcode', name: 'ZCode', kind: 'acp', command: 'zcode', adapter: 'zcode-protocol-v1' },
      { id: 'kimi-code', name: 'Kimi Code', kind: 'acp', command: 'kimi', adapter: 'acp-v1' },
      { id: 'mimo-code', name: 'MiMo Code', kind: 'acp', command: 'mimo', adapter: 'acp-v1' },
      { id: 'pool', name: 'Poolside', kind: 'acp', command: 'pool', adapter: 'acp-v1' },
      { id: 'step-code', name: 'StepCode', kind: 'acp', command: 'step', adapter: 'step-rpc-v1' },
      {
        id: 'muse-code',
        name: 'Muse Code',
        kind: 'acp',
        command: 'muse',
        adapter: 'muse-protocol-v1',
      },
      { id: 'opencode', name: 'OpenCode', kind: 'acp', command: 'opencode', adapter: 'acp-v1' },
      { id: 'pi', name: 'Pi Coding Agent', kind: 'acp', command: 'pi', adapter: 'pi-rpc-v1' },
      { id: 'kilo', name: 'Kilo Code', kind: 'acp', command: 'kilo', adapter: 'acp-v1' },
      { id: 'vibe', name: 'Mistral Vibe', kind: 'acp', command: 'vibe-acp', adapter: 'acp-v1' },
    ] satisfies ExecutionCatalog['harnesses']
  ).filter((harness) => !OFM_INACTIVE_DEFAULT_HARNESSES.includes(harness.id)),
  combinations: [
    {
      id: DSH_COMBINATION,
      name: 'DeepSeek-V4.1-Flash + DSH',
      modelRef: { provider: 'opl-gateway', model: 'deepseek-flash' },
      harnessRef: 'dsh',
      permissionPolicy: 'workspace',
      isDefault: true,
      enabled: true,
    },
    {
      id: GROK_COMBINATION,
      name: 'Grok + Grok Build',
      modelRef: { provider: 'opl-gateway', model: 'grok::grok-4.7' },
      harnessRef: 'grok-build',
      permissionPolicy: 'workspace',
      isDefault: true,
      enabled: true,
    },
  ],
})
const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw Error(`${field} 无效`)
  return value.trim()
}
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
/** Retain legacy choices while removing the competing connection reference. */
export function normalizeCatalog(value: unknown): ExecutionCatalog {
  const input = record(value)
  if (!Array.isArray(input.harnesses) || !Array.isArray(input.combinations))
    throw Error('组合目录格式无效')
  const harnesses = input.harnesses.map((raw) => {
    const x = record(raw)
    if (x.kind === 'dsh' && x.id !== 'dsh') throw Error('内置 DSH 的身份不能修改')
    if (!['dsh', 'grok-build', 'acp'].includes(x.kind)) throw Error('Harness 类型无效')
    const proxy = normalizeHarnessProxy(x.proxy)
    let codexRuntime: CodexGitBashRuntime | undefined
    if (x.codexRuntime !== undefined) {
      const runtime = record(x.codexRuntime)
      if (
        x.id !== 'codex' ||
        typeof runtime.version !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,95}$/.test(runtime.version) ||
        typeof runtime.manifestSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(runtime.manifestSha256) ||
        !Array.isArray(runtime.officialPrefix) ||
        runtime.officialPrefix.length > 32 ||
        runtime.officialPrefix.some(
          (arg: unknown) => typeof arg !== 'string' || arg.length > 4096 || /[\r\n\0]/.test(arg),
        )
      )
        throw Error('Codex 候选选择无效')
      codexRuntime = {
        version: runtime.version,
        manifestSha256: runtime.manifestSha256,
        officialCommand: text(runtime.officialCommand, '官方 Codex 路径'),
        officialPrefix: [...runtime.officialPrefix],
      }
    }
    if (
      x.prefix !== undefined &&
      (!Array.isArray(x.prefix) ||
        x.prefix.length > 32 ||
        x.prefix.some(
          (item: unknown) =>
            typeof item !== 'string' || item.length > 4096 || /[\r\n\0]/.test(item),
        ))
    )
      throw Error('Harness 启动参数无效')
    if (x.kind === 'dsh' && proxy && proxy.mode !== 'inherit')
      throw Error('内置 DSH 不使用外部 CLI 代理配置')
    return {
      id: text(x.id, 'Harness ID'),
      name: text(x.name, 'Harness 名称'),
      kind: x.kind,
      ...(x.command ? { command: text(x.command, '可执行文件') } : {}),
      ...(x.prefix !== undefined ? { prefix: [...x.prefix] as string[] } : {}),
      ...(x.adapter ? { adapter: text(x.adapter, '适配器') } : {}),
      ...(proxy ? { proxy } : {}),
      ...(codexRuntime ? { codexRuntime } : {}),
    }
  })
  if (!harnesses.some((x) => x.id === 'dsh' && x.kind === 'dsh')) throw Error('不能移除内置 DSH')
  for (const builtin of defaultExecutionCatalog().harnesses)
    if (!harnesses.some((item) => item.id === builtin.id)) harnesses.push(builtin)
  const harnessOrder = new Map(
    defaultExecutionCatalog().harnesses.map((item, index) => [item.id, index]),
  )
  harnesses.sort(
    (left, right) =>
      (harnessOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (harnessOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  )
  const combinations = input.combinations
    .filter((raw: any) => raw.generated !== true)
    .map((raw) => {
      const x = record(raw)
      let modelRef: ModelRef
      if (input.version === 2)
        modelRef = {
          provider: text(x.modelRef?.provider, '模型来源'),
          model: text(x.modelRef?.model, '模型 ID'),
        }
      else {
        const model = input.models?.find((model: any) => model.id === x.modelId)
        if (!model) throw Error('组合引用不存在的模型')
        if (x.connectionId && x.connectionId !== model.connectionId)
          throw Error('旧组合的模型和连接不一致，原文件已保留，请先处理冲突')
        modelRef = {
          provider: model.connectionId,
          model:
            model.connectionId === 'opl-gateway' && model.routeId && model.routeId !== 'deepseek'
              ? `${model.routeId}::${model.modelId}`
              : model.modelId,
        }
      }
      const harnessRef = text(x.harnessRef ?? x.harnessId, 'Harness 引用'),
        permissionPolicy = x.permissionPolicy ?? x.sandbox
      if (!harnesses.some((h) => h.id === harnessRef)) throw Error('组合引用不存在的 Harness')
      if (!['read-only', 'workspace', 'full-access'].includes(permissionPolicy))
        throw Error('组合权限无效')
      if (permissionPolicy === 'full-access' && !harnessAllowsFullAccess(harnessRef))
        throw Error('此 Harness 不支持 full-access 组合权限')
      return {
        id: text(x.id, '组合 ID'),
        name: text(x.name, '组合名称'),
        modelRef,
        harnessRef,
        permissionPolicy,
        isDefault: x.isDefault === true,
        enabled: x.enabled !== false,
        ...(x.autoEnabled === undefined ? {} : { autoEnabled: x.autoEnabled === true }),
        ...(x.autoEnabledDisabled === undefined
          ? {}
          : { autoEnabledDisabled: x.autoEnabledDisabled === true }),
      }
    })
  if (input.version !== 2)
    for (const item of combinations)
      if (
        item.enabled &&
        !combinations.some(
          (other) =>
            other.enabled &&
            other.isDefault &&
            modelRefKey(other.modelRef) === modelRefKey(item.modelRef),
        )
      )
        item.isDefault = true
  for (const items of [harnesses, combinations])
    if (new Set(items.map((x) => x.id)).size !== items.length) throw Error('目录 ID 重复')
  const defaults = combinations
    .filter((x) => x.isDefault && x.enabled)
    .map((x) => modelRefKey(x.modelRef))
  if (new Set(defaults).size !== defaults.length) throw Error('每个模型只能有一个默认组合')
  return { version: 2, models: [], harnesses, combinations }
}
export class ExecutionCatalogStore {
  readonly filename: string
  private value = defaultExecutionCatalog()
  private ready: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  constructor(home = dshHomePath()) {
    this.filename = join(home, 'profiles/desktop/execution-catalog.json')
    this.ready = this.load()
  }
  private async load() {
    let raw: string
    try {
      raw = await readFile(this.filename, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    const parsed = JSON.parse(raw)
    this.value = normalizeCatalog(parsed)
    const harnessOrderChanged =
      Array.isArray(parsed.harnesses) &&
      parsed.harnesses.map((item: any) => item?.id).join('\0') !==
        this.value.harnesses.map((item) => item.id).join('\0')
    if (parsed.version !== 2 || harnessOrderChanged) {
      if (parsed.version !== 2)
        await copyFile(this.filename, this.filename + '.v1.backup', constants.COPYFILE_EXCL).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code !== 'EEXIST') throw e
          },
        )
      // Preserve old model declarations in the backup; live models now come from DSH.
      await this.persist(this.value)
    }
  }
  private async persist(value: ExecutionCatalog) {
    const { models: _, ...saved } = value
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    const temp = this.filename + '.' + randomUUID()
    await writeFile(temp, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, this.filename)
  }
  async get() {
    await this.ready
    return structuredClone(this.value)
  }
  async set(input: unknown) {
    await this.ready
    const value = normalizeCatalog(input)
    const write = this.queue.then(async () => {
      await this.persist(value)
      this.value = value
    })
    this.queue = write.catch(() => {})
    await write
    return structuredClone(value)
  }
  async dispose() {
    await this.queue
  }
  /**
   * Clean obsolete combination rows against the latest catalog, retaining its launch settings.
   *
   * `stale` is supplied by the model resolver for automatic rows whose default Harness has
   * changed. It is evaluated against the persisted rows only; a user-created combination is
   * never auto-removed because its id never starts with the generated `auto:` prefix.
   */
  async cleanLegacyCombinations(stale: (item: CombinationDefinition) => boolean = () => false) {
    await this.ready
    const write = this.queue.then(async () => {
      const value = normalizeCatalog({
        ...this.value,
        combinations: this.value.combinations
          .filter((item) => !isRetiredModel(item.modelRef))
          .filter((item) => !stale(item))
          .map((item) =>
            item.id === DSH_COMBINATION && item.name === 'DeepSeek + DSH'
              ? { ...item, name: 'DeepSeek-V4.1-Flash + DSH' }
              : item,
          ),
      })
      await this.persist(value)
      this.value = value
      return structuredClone(value)
    })
    this.queue = write.then(
      () => {},
      () => {},
    )
    return write
  }
  /** Publish one verified launch command without overwriting concurrent proxy settings. */
  async setHarnessLaunch(harnessId: string, command: string, prefix: string[]) {
    await this.ready
    const write = this.queue.then(async () => {
      if (!this.value.harnesses.some((h) => h.id === harnessId)) throw Error('Harness 不存在')
      const previous = this.value.harnesses.find((h) => h.id === harnessId)!
      const value = normalizeCatalog({
        ...this.value,
        harnesses: this.value.harnesses.map((h) =>
          h.id === harnessId ? { ...h, command, prefix } : h,
        ),
      })
      await this.persist(value)
      this.value = value
      return { previousCommand: previous.command ?? 'mcode', previousPrefix: previous.prefix ?? [] }
    })
    this.queue = write.then(
      () => {},
      () => {},
    )
    return write
  }
  /** Publish the Codex command and backend selection in one persisted catalog transaction. */
  async setCodexRuntime(
    selection: { command: string; version: string; manifestSha256: string } | null,
  ) {
    await this.ready
    const write = this.queue.then(async () => {
      const previous = this.value.harnesses.find((h) => h.id === 'codex')!
      const officialCommand = previous.codexRuntime?.officialCommand ?? previous.command ?? 'codex'
      const officialPrefix = previous.codexRuntime?.officialPrefix ?? previous.prefix ?? []
      const command = selection?.command ?? officialCommand
      const value = normalizeCatalog({
        ...this.value,
        harnesses: this.value.harnesses.map((h) => {
          if (h.id !== 'codex') return h
          const { codexRuntime: _, ...definition } = h
          return {
            ...definition,
            command,
            prefix: selection ? [] : officialPrefix,
            ...(selection
              ? {
                  codexRuntime: {
                    version: selection.version,
                    manifestSha256: selection.manifestSha256,
                    officialCommand,
                    officialPrefix,
                  },
                }
              : {}),
          }
        }),
      })
      await this.persist(value)
      this.value = value
      return { command, previousCommand: previous.command ?? 'codex' }
    })
    this.queue = write.then(
      () => {},
      () => {},
    )
    return write
  }
  /** Merge one proxy against the latest queued catalog so independent settings do not overwrite it. */
  async setProxy(harnessId: string, proxy: unknown) {
    await this.ready
    const id = text(harnessId, 'Harness ID')
    const normalized = normalizeHarnessProxy(proxy)
    const write = this.queue.then(async () => {
      if (!this.value.harnesses.some((h) => h.id === id)) throw Error('Harness 不存在')
      const value = normalizeCatalog({
        ...this.value,
        harnesses: this.value.harnesses.map((h) => (h.id === id ? { ...h, proxy: normalized } : h)),
      })
      await this.persist(value)
      this.value = value
      return structuredClone(value)
    })
    this.queue = write.then(
      () => {},
      () => {},
    )
    return write
  }
}
export function catalogView(
  catalog: ExecutionCatalog,
  availability: Map<string, { available: boolean; reason?: string }>,
  includeDisabled = false,
): HarnessCatalog['combinations'] {
  return catalog.combinations
    .filter((x) => includeDisabled || x.enabled)
    .map((x) => {
      const model = catalog.models.find((m) => modelRefKey(m.ref) === modelRefKey(x.modelRef)),
        harness = catalog.harnesses.find((h) => h.id === x.harnessRef)
      const status = availability.get(x.id) ?? {
        available: false,
        reason: '尚未安装对应 Harness 适配器',
      }
      return {
        id: x.id,
        name: x.name,
        model: model?.name ?? x.modelRef.model,
        modelId: x.modelRef.model,
        harness: harness?.name ?? x.harnessRef,
        source: displayModelSource(x.modelRef, model?.source),
        ...status,
      }
    })
}
