import type { Context } from '@deepseek-ai/cordis'
import { Config } from '../collaboration/host/plugin-config.ts'
import { CoordinationService } from '../collaboration/host/settings-service.ts'
import { RoleExecutionService } from '../collaboration/host/roles.ts'
import TaskFeedbackService from '../collaboration/host/feedback/index.ts'
import { OfficialCollaborationBridge } from '../collaboration/host/official-tools.ts'
import { installCollaborationTools } from '../collaboration/host/tools.ts'
import { installExternalCodex } from '../collaboration/host/external-codex.ts'
import { DomainAgentPresetService } from '../collaboration/host/domain-agent-presets.ts'
export { Config }
export const name = 'opl-collaboration'
export const inject = [
  'oplHarness',
  'settings',
  'agents',
  'typertGateway',
  'connection',
  'webServer',
  'permissionPresets',
  'workspaceRegistry',
  'sessionController',
  'sandboxPolicy',
  'approval',
  'agentPresets',
]
export function apply(ctx: Context, config: Config): void {
  ctx.provide('oplOfficialCollaboration', new OfficialCollaborationBridge(ctx))
  installCollaborationTools(ctx, ctx.oplHarness)
  installExternalCodex(ctx, ctx.oplHarness)
  ctx.plugin(CoordinationService)
  ctx.plugin(DomainAgentPresetService)
  ctx.plugin(RoleExecutionService)
  ctx.plugin(TaskFeedbackService, {
    wakeTransport: config.wakeTransport.get(),
    wakeExecutable: config.wakeExecutable.get(),
    wakeExecution: config.wakeExecution.get(),
    wakeDistro: config.wakeDistro.get(),
  })
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
}
