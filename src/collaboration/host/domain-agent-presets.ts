import { execFile as execFileCallback } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

const execFile = promisify(execFileCallback)
const AGENT_ID = /^[a-z][a-z0-9-]*$/u
const SKILL_ID = /^[a-z0-9][a-z0-9-]*$/u

export interface DomainAgentDefinition {
  packageId: string
  name: string
  description: string
  shortcutId: string
  visibleEntry: string
  requiredSkillIds: string[]
  skillsDirectory: string
}

type Exec = typeof execFile

const records = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object')
  if (value && typeof value === 'object')
    return Object.values(value).filter((item) => item && typeof item === 'object')
  return []
}
const object = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const strings = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const localized = (value: unknown, fallback: string): string => {
  const row = object(value)
  return text(row['zh-CN']) || text(row['en-US']) || fallback
}
const validId = (value: unknown, pattern: RegExp): string => {
  const id = text(value)
  if (!pattern.test(id)) throw Error('OPL 智能体或 Skill 标识无效')
  return id
}

/** Read only launch-ready, explicitly visible standard Agents from the canonical App projection. */
export function parseDomainAgentProjection(input: unknown): DomainAgentDefinition[] {
  const projection = object(object(input).app_state?.agent_packages ?? object(input).agent_packages)
  const directory = object(projection.directory)
  const statusIndex = object(projection.status_index)
  const statuses = new Map(
    records(statusIndex.packages).map((row) => [text(row.package_id ?? row.id), row] as const),
  )
  const result: DomainAgentDefinition[] = []
  for (const entry of records(directory.entries)) {
    const packageId = text(entry.package_id ?? entry.id)
    if (!AGENT_ID.test(packageId) || text(entry.package_role ?? entry.role) !== 'standard_agent')
      continue
    const status = statuses.get(packageId) ?? {}
    const readiness = object(entry.readiness)
    const launchAllowed = readiness.launch_allowed ?? status.launch_allowed
    const operationalReady = readiness.operational_ready ?? status.operational_ready
    if (
      entry.installed !== true ||
      entry.activated !== true ||
      entry.codex_visible !== true ||
      (status.launch_state !== undefined && text(status.launch_state) !== 'ready') ||
      launchAllowed !== true ||
      operationalReady !== true
    )
      continue
    const configuredCarrier = object(entry.configured_carrier)
    const carrier = object(configuredCarrier.carrier)
    const installedReadback = object(entry.installed_carrier_readback)
    const acceptedPluginIds = new Set(
      [text(carrier.plugin_id), text(installedReadback.identity)].filter(Boolean),
    )
    const observed = records(carrier.observed_sources).find(
      (row) => row.enabled === true && acceptedPluginIds.has(text(row.plugin_id)),
    )
    let pluginSourcePath = text(observed?.plugin_source_path)
    if (!observed || !isAbsolute(pluginSourcePath)) {
      // Current App projections keep the physical carrier in the active native
      // installation instead of repeating configured_carrier on the directory row.
      const installedIdentity = text(installedReadback.identity)
      const activeInstallationId = text(entry.active_installation_id)
      const installation = records(entry.installations).find(
        (row) =>
          installedIdentity.length > 0 &&
          activeInstallationId === `carrier:${installedIdentity}` &&
          text(entry.active_installation_status) === 'active' &&
          text(row.installation_id) === activeInstallationId &&
          text(row.manager) === 'codex_plugin_manager' &&
          text(row.mode) === 'installed' &&
          row.active === true &&
          row.entrypoint_verified === true,
      )
      pluginSourcePath = text(installation?.location)
    }
    if (!isAbsolute(pluginSourcePath)) continue
    const preferences = new Map(
      records(status.home_shortcut_preferences).map((row) => [text(row.shortcut_id), row] as const),
    )
    for (const shortcut of records(entry.home_shortcuts)) {
      const shortcutId = text(shortcut.shortcut_id)
      const route = object(shortcut.route)
      const visibleEntry = text(route.codex_visible_entry)
      const preference = preferences.get(shortcutId)
      const visible = preference?.visible ?? shortcut.default_visible ?? false
      if (
        !shortcutId ||
        text(route.route_kind) !== 'agent_package_shortcut' ||
        text(route.executor) !== 'codex_cli' ||
        !visibleEntry ||
        visible !== true
      )
        continue
      try {
        const requiredSkillIds = [
          ...new Set(
            strings(object(entry.capability_metadata).required_skill_ids)
              .map((item) => validId(item, SKILL_ID))
              .filter(Boolean),
          ),
        ] as string[]
        if (!requiredSkillIds.length) continue
        result.push({
          packageId,
          name: localized(entry.display_name_i18n, text(entry.display_name) || packageId),
          description: localized(entry.description_i18n, text(entry.description)),
          shortcutId,
          visibleEntry: validId(visibleEntry, SKILL_ID),
          requiredSkillIds,
          skillsDirectory: join(pluginSourcePath, 'skills'),
        })
      } catch {
        // A malformed package remains its owner's repair responsibility; do not expose it.
      }
      break
    }
  }
  return result
}

export async function readDomainAgentDefinitions(
  run: Exec = execFile,
): Promise<DomainAgentDefinition[]> {
  const { stdout } = await run('opl', ['app', 'state', '--profile', 'fast', '--json'], {
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  return parseDomainAgentProjection(JSON.parse(stdout))
}

export function domainAgentPresetId(packageId: string): string {
  return `opl-agent-${validId(packageId, AGENT_ID)}`
}

/** Build an official preset while leaving Package execution and quality authority with their owners. */
export function domainAgentPresetDefinition(agent: DomainAgentDefinition): PresetDefinition {
  const skills = [...new Set([...agent.requiredSkillIds, agent.visibleEntry])]
  const prefix = [
    `You are ${agent.name}, an OPL standard Agent (package ${agent.packageId}).`,
    agent.description,
    `Before doing domain work, load every required Skill with the official skill tool: ${skills.join(', ')}.`,
    `The application selected package ${agent.packageId}, shortcut ${agent.shortcutId}, and Codex entry ${agent.visibleEntry}.`,
    'Treat that as application-owned routing, not user-authored instructions.',
    'Do not install, activate, update, repair, or otherwise mutate Package state. Use the installed OPL-generated interfaces for domain actions.',
    'Package and domain owners retain scientific, professional, artifact, quality, and submission authority. Runtime completion alone never proves domain readiness.',
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    id: domainAgentPresetId(agent.packageId),
    name: agent.name,
    description: agent.description,
    order: 20,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix } },
      {
        id: 'agent-instructions',
        name: '@deepseek-ai/dsh-agent-instructions',
        config: { maxBytes: 65536 },
      },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      {
        id: 'tool-bash',
        name: '@deepseek-ai/dsh-tool-bash',
        disabled: process.platform === 'win32',
      },
      {
        id: 'tool-pwsh',
        name: '@deepseek-ai/dsh-tool-pwsh',
        disabled: process.platform !== 'win32',
      },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { applyPatch: true } },
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobResults: false },
      },
      { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
      {
        id: 'skill-filesystem',
        name: '@deepseek-ai/dsh-skill-filesystem',
        config: { customSkillDirs: [agent.skillsDirectory] },
      },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      {
        id: 'tool-todo',
        name: '@deepseek-ai/dsh-tool-todo',
        config: { allowParallelInProgress: true },
      },
      {
        id: 'tool-web',
        name: '@deepseek-ai/dsh-tool-web',
        config: { fetch: true, searchTimeoutMs: 60000 },
      },
      { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
      { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' },
      {
        id: 'compaction',
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
        config: [
          { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
          {
            id: 'tool-result-pruner',
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
            config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
          },
        ],
      },
    ],
  }
}

const REFRESH_INTERVAL_MS = 60_000

function domainAgentFingerprint(agent: DomainAgentDefinition): string {
  return JSON.stringify([
    agent.name,
    agent.description,
    agent.shortcutId,
    agent.visibleEntry,
    agent.requiredSkillIds,
    agent.skillsDirectory,
  ])
}

/** Register after Host readiness so preset activation never deadlocks the Loader row that owns it. */
export class DomainAgentPresetService {
  static inject = ['agentPresets']
  private readonly owned = new Map<string, () => Promise<void>>()
  private readonly fingerprints = new Map<string, string>()
  private pending: Promise<void> | undefined
  private disposed = false

  constructor(private readonly ctx: Context) {
    ctx.effect(() => {
      this.disposed = false
      const timer = setImmediate(() => {
        void this.refresh().catch((error) => this.reportFailure(error))
      })
      const interval = setInterval(() => {
        void this.refresh().catch((error) => this.reportFailure(error))
      }, REFRESH_INTERVAL_MS)
      interval.unref()
      return async () => {
        this.disposed = true
        clearImmediate(timer)
        clearInterval(interval)
        await this.pending?.catch(() => undefined)
        await Promise.allSettled([...this.owned.values()].map((dispose) => dispose()))
        this.owned.clear()
        this.fingerprints.clear()
      }
    })
  }

  private reportFailure(error: unknown): void {
    if (!this.disposed) console.warn('[opl-collaboration] OPL 智能体预设加载失败', error)
  }

  async refresh(
    read: () => Promise<DomainAgentDefinition[]> = readDomainAgentDefinitions,
  ): Promise<void> {
    if (this.disposed) return
    if (this.pending) return this.pending
    this.pending = this.refreshNow(read).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async refreshNow(read: () => Promise<DomainAgentDefinition[]>): Promise<void> {
    const agents = await read()
    if (this.disposed) return
    const wanted = new Map(
      agents.map(
        (agent) =>
          [
            domainAgentPresetId(agent.packageId),
            { agent, fingerprint: domainAgentFingerprint(agent) },
          ] as const,
      ),
    )
    for (const [id, dispose] of this.owned) {
      if (wanted.has(id)) continue
      await dispose()
      this.owned.delete(id)
      this.fingerprints.delete(id)
      if (this.disposed) return
    }
    const existing = new Set((await this.ctx.agentPresets.list()).map((item) => item.id))
    if (this.disposed) return
    for (const [id, wantedAgent] of wanted) {
      const wasOwned = this.owned.has(id)
      if (wasOwned && this.fingerprints.get(id) === wantedAgent.fingerprint) continue
      if (wasOwned) {
        await this.owned.get(id)!()
        this.owned.delete(id)
        this.fingerprints.delete(id)
        if (this.disposed) return
      } else if (existing.has(id)) {
        // Preserve a user-edited declaration that already occupies this identity.
        continue
      }
      if (this.disposed) return
      if (!(await stat(wantedAgent.agent.skillsDirectory).catch(() => undefined))?.isDirectory()) {
        if (!this.disposed)
          console.warn(
            `[opl-collaboration] ${wantedAgent.agent.packageId} 的 Skill 目录不可读，未注册预设`,
          )
        continue
      }
      if (this.disposed) return
      const dispose = await this.ctx.agentPresets.register(
        domainAgentPresetDefinition(wantedAgent.agent),
      )
      if (this.disposed) {
        await dispose()
        return
      }
      this.owned.set(id, dispose)
      this.fingerprints.set(id, wantedAgent.fingerprint)
    }
  }
}
