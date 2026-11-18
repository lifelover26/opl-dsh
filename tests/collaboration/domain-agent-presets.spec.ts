import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import {
  DomainAgentPresetService,
  domainAgentPresetDefinition,
  domainAgentPresetId,
  parseDomainAgentProjection,
  type DomainAgentDefinition,
} from '../../src/collaboration/host/domain-agent-presets.ts'

const carrierDirectory = resolve('fixtures', 'opl', 'plugins', 'med-autoscience')
const skillsDirectory = join(carrierDirectory, 'skills')

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function projection(overrides: Record<string, unknown> = {}): any {
  const entry = {
    package_id: 'mas',
    package_role: 'standard_agent',
    display_name: 'Med Auto Science',
    display_name_i18n: { 'zh-CN': 'Med Auto Science' },
    description_i18n: { 'zh-CN': '医学研究与论文工作。' },
    installed: true,
    activated: true,
    codex_visible: true,
    readiness: { launch_allowed: true, operational_ready: true },
    capability_metadata: { required_skill_ids: ['med-autoscience'] },
    configured_carrier: {
      carrier: {
        plugin_id: 'med-autoscience@med-autoscience',
        observed_sources: [
          {
            plugin_id: 'med-autoscience@med-autoscience',
            enabled: true,
            plugin_source_path: carrierDirectory,
          },
        ],
      },
    },
    home_shortcuts: [
      {
        shortcut_id: 'research',
        default_visible: true,
        route: {
          route_kind: 'agent_package_shortcut',
          executor: 'codex_cli',
          codex_visible_entry: 'med-autoscience',
        },
      },
    ],
    ...overrides,
  }
  return {
    app_state: {
      agent_packages: {
        directory: { entries: [entry] },
        status_index: {
          packages: {
            mas: { package_id: 'mas', launch_state: 'ready', home_shortcut_preferences: [] },
          },
        },
      },
    },
  }
}

describe('OPL domain Agent projection', () => {
  it('reads only ready, visible standard Agents and their exact Skill route', () => {
    expect(parseDomainAgentProjection(projection())).toEqual([
      {
        packageId: 'mas',
        name: 'Med Auto Science',
        description: '医学研究与论文工作。',
        shortcutId: 'research',
        visibleEntry: 'med-autoscience',
        requiredSkillIds: ['med-autoscience'],
        skillsDirectory,
      },
    ])
  })

  it('accepts the exact local carrier identity returned by the native readback', () => {
    const value = projection()
    const [entry] = value.app_state.agent_packages.directory.entries
    entry.configured_carrier.carrier.observed_sources[0].plugin_id =
      'med-autoscience@med-autoscience-local'
    entry.installed_carrier_readback = { identity: 'med-autoscience@med-autoscience-local' }
    expect(parseDomainAgentProjection(value)).toHaveLength(1)
  })

  it('reads the verified active carrier installation in the current App projection', () => {
    const value = projection()
    const [entry] = value.app_state.agent_packages.directory.entries
    const identity = 'med-autoscience@med-autoscience-local'
    entry.configured_carrier = null
    entry.installed_carrier_readback = { identity }
    entry.active_installation_id = `carrier:${identity}`
    entry.active_installation_status = 'active'
    entry.installations = [
      {
        installation_id: `carrier:${identity}`,
        manager: 'codex_plugin_manager',
        mode: 'installed',
        location: carrierDirectory,
        active: true,
        entrypoint_verified: true,
      },
    ]
    expect(parseDomainAgentProjection(value)).toEqual([
      expect.objectContaining({
        packageId: 'mas',
        skillsDirectory,
      }),
    ])
    entry.installations[0].active = false
    expect(parseDomainAgentProjection(value)).toEqual([])
  })

  it.each([
    ['inactive', { activated: false }],
    ['not installed', { installed: false }],
    ['not launchable', { readiness: { launch_allowed: false, operational_ready: true } }],
    ['not operational', { readiness: { launch_allowed: true, operational_ready: false } }],
    ['not Codex visible', { codex_visible: false }],
  ])('does not expose %s Packages', (_label, patch) => {
    expect(parseDomainAgentProjection(projection(patch))).toEqual([])
  })

  it('respects the canonical home shortcut visibility preference', () => {
    const value = projection()
    value.app_state.agent_packages.status_index.packages.mas.home_shortcut_preferences = [
      { shortcut_id: 'research', visible: false },
    ]
    expect(parseDomainAgentProjection(value)).toEqual([])
  })

  it('builds an official preset with the primary Skill and no Package mutation authority', () => {
    const [agent] = parseDomainAgentProjection(projection())
    const definition = domainAgentPresetDefinition(agent!)
    expect(definition.id).toBe('opl-agent-mas')
    expect(definition.name).toBe('Med Auto Science')
    expect(definition.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }),
        expect.objectContaining({
          id: 'skill-filesystem',
          config: { customSkillDirs: [skillsDirectory] },
        }),
      ]),
    )
    const persona = definition.plugins.find((row) => row.id === 'persona')
    expect(JSON.stringify(persona)).toContain('med-autoscience')
    expect(JSON.stringify(persona)).toContain('Do not install, activate, update, repair')
    expect(JSON.stringify(persona)).not.toContain('{{')
  })
})

describe('DomainAgentPresetService', () => {
  function fixture(): {
    ctx: Context
    registered: Map<string, PresetDefinition>
    disposed: string[]
  } {
    const registered = new Map<string, PresetDefinition>()
    const disposed: string[] = []
    const ctx = {
      agentPresets: {
        list: async () => [...registered.values()].map((item) => ({ id: item.id })),
        register: async (definition: PresetDefinition) => {
          if (registered.has(definition.id)) throw Error('duplicate')
          registered.set(definition.id, definition)
          return async () => {
            disposed.push(definition.id)
            registered.delete(definition.id)
          }
        },
      },
      on: () => undefined,
      effect: () => undefined,
    } as unknown as Context
    return { ctx, registered, disposed }
  }

  async function agent(): Promise<DomainAgentDefinition> {
    const directory = await mkdtemp(join(tmpdir(), 'opl-domain-agent-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    return {
      packageId: 'mas',
      name: 'Med Auto Science',
      description: '医学研究。',
      shortcutId: 'research',
      visibleEntry: 'med-autoscience',
      requiredSkillIds: ['med-autoscience'],
      skillsDirectory: directory,
    }
  }

  it('registers once, preserves existing user declarations, and disposes removed Agents', async () => {
    const { ctx, registered, disposed } = fixture()
    const service = new DomainAgentPresetService(ctx)
    const definition = await agent()
    await service.refresh(async () => [definition])
    await service.refresh(async () => [definition])
    expect([...registered.keys()]).toEqual(['opl-agent-mas'])
    await service.refresh(async () => [])
    expect(disposed).toEqual(['opl-agent-mas'])
    expect(registered.size).toBe(0)
    expect(domainAgentPresetId('mas')).toBe('opl-agent-mas')
  })

  it('replaces an owned preset when its carrier or Skill definition changes', async () => {
    const { ctx, registered, disposed } = fixture()
    const service = new DomainAgentPresetService(ctx)
    const initial = await agent()
    await service.refresh(async () => [initial])
    const changed = {
      ...initial,
      name: 'Renamed MAS',
      skillsDirectory: await agent().then((row) => row.skillsDirectory),
    }
    await service.refresh(async () => [changed])
    expect(disposed).toEqual(['opl-agent-mas'])
    expect(registered.get('opl-agent-mas')?.name).toBe('Renamed MAS')
  })

  it('does not register presets after the owning plugin is disabled', async () => {
    const { ctx, registered } = fixture()
    let disposeEffect: (() => Promise<void>) | undefined
    ctx.effect = ((callback: () => () => Promise<void>) => {
      disposeEffect = callback()
    }) as Context['effect']
    const service = new DomainAgentPresetService(ctx)
    let resolveRead!: (agents: DomainAgentDefinition[]) => void
    const refreshing = service.refresh(
      () =>
        new Promise<DomainAgentDefinition[]>((resolve) => {
          resolveRead = resolve
        }),
    )
    const disposing = disposeEffect!()
    resolveRead([await agent()])
    await Promise.all([refreshing, disposing])
    expect(registered.size).toBe(0)
  })
})
