import { installUpdateRuntime } from '../updates/host/runtime-admission.ts'
import { GatewayModelsService } from '../gateway/host/model-service.ts'
import { SetupService } from '../setup/host/index.ts'
import { UpdateService } from '../updates/host/index.ts'
/** OPL account and collaboration contributions for an unmodified DSH Desktop. */
import type { Context } from '@deepseek-ai/cordis'
import * as gateway from '../gateway/host/index.ts'
import * as nativeModelProviders from '../compat/host/model-providers.ts'
import * as gitBash from '../shell/host/git-bash.ts'
import * as conversationStats from '../conversation-stats/host/index.ts'
import * as mcpApps from '../mcp-apps/host/index.ts'
import * as suiteControl from '../shared/host/suite-control.ts'
import { Config } from './config.ts'
export { Config } from './config.ts'

export const name = 'opl-suite'
export const inject = [
  'loader',
  'llm',
  'settings',
  'credentials',
  'sessionProjections',
  'agents',
  'sessions',
  'sessionController',
  'agentDefaultModel',
  'typertGateway',
  'webServer',
  'connection',
]

/** Mount account services and publish the authenticated local control binding.
 * @param ctx - Official Host context.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform === 'win32') await ctx.plugin(gitBash, {})
  await ctx.plugin(gateway, structuredClone(config.gateway.get()) as gateway.OplGatewayConfig)
  await ctx.plugin(conversationStats)
  await ctx.plugin(mcpApps)
  await ctx.plugin(nativeModelProviders)
  await ctx.plugin(GatewayModelsService)
  await ctx.plugin(SetupService)
  await ctx.plugin(suiteControl)
  ctx.inject(['sessions', 'agents', 'sessionController', 'settings', 'typertGateway'], (child) => {
    child.provide('oplUpdateRuntime', installUpdateRuntime(child))
  })
  await ctx.plugin(UpdateService)
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
