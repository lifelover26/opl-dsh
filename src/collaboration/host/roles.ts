import { featureSettings } from '../../shared/host/feature-settings.ts'
/** Role definitions remain official; only exact execution-combination references are saved here. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { RoleExecutionCatalog } from '../contracts/roles.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplRoleExecution: RoleExecutionService
  }
}

export class RoleExecutionService extends TypertRemoteService {
  static inject = ['settings', 'agentPresets', 'oplHarness']
  constructor(ctx: Context) {
    super(ctx, 'oplRoleExecution')
    ctx.on(
      'agent/created',
      async ({ agent }) => {
        const preset = ctx.agentPresets.presetForSession(agent.session)
        const combination = preset && this.bindings()[preset]
        if (combination) await ctx.oplHarness.bindRoleCombination(agent, combination)
        return undefined
      },
      { prepend: true },
    )
  }

  private bindings(): Record<string, string> {
    const value = featureSettings(this.ctx, 'opl-collaboration')?.value as
      { roleExecutions?: Record<string, string> } | undefined
    return { ...value?.roleExecutions }
  }

  @Remote('catalog')
  async catalog(): Promise<RoleExecutionCatalog> {
    const [presets, catalog, combinations] = await Promise.all([
      this.ctx.agentPresets.list(),
      this.ctx.oplHarness.executionCatalog(),
      this.ctx.oplHarness.combinations(),
    ])
    const supported = new Set(
      catalog.combinations
        .filter((item) => ['dsh', 'codex', 'claude'].includes(item.harnessRef))
        .map((item) => item.id),
    )
    return {
      bindings: this.bindings(),
      presets: presets.map((item) => ({
        id: item.id,
        name: item.name ?? item.id,
        ...(item.broken ? { broken: item.broken } : {}),
      })),
      combinations: combinations
        .filter((item) => supported.has(item.id))
        .map((item) => ({
          id: item.id,
          name: item.name,
          harness: item.harness,
          available: item.available,
          ...(item.reason ? { reason: item.reason } : {}),
        })),
    }
  }

  @Remote('save')
  async save(request: { bindings: Record<string, string> }): Promise<RoleExecutionCatalog> {
    if (
      !request.bindings ||
      typeof request.bindings !== 'object' ||
      Array.isArray(request.bindings)
    )
      throw Error('角色执行绑定无效')
    const catalog = await this.catalog()
    for (const [preset, combination] of Object.entries(request.bindings)) {
      if (
        typeof combination !== 'string' ||
        !combination.trim() ||
        !catalog.presets.some((item) => item.id === preset && !item.broken)
      )
        throw Error('角色预设不存在或不可用')
      if (
        catalog.bindings[preset] !== combination &&
        !catalog.combinations.some((item) => item.id === combination && item.available)
      )
        throw Error('执行组合不存在、未就绪或尚不支持角色团队')
    }
    const descriptor = featureSettings(this.ctx, 'opl-collaboration')
    if (!descriptor) throw Error('角色设置未加载')
    await this.ctx.settings.mutate(
      descriptor.ns,
      [{ op: 'set', path: ['roleExecutions'], value: { ...request.bindings } }],
      descriptor.revision,
    )
    return this.catalog()
  }
}
