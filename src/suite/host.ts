import { GatewayModelsService } from '../gateway/host/model-service.ts'
import { SetupService } from '../setup/host/index.ts'
import { CoordinationService } from '../collaboration/host/settings-service.ts'
import { UpdateService } from '../updates/host/index.ts'
import TaskFeedbackService from '../collaboration/host/feedback/index.ts'
import AutoReviewService from '../auto-review/host/index.ts'
/** OPL account and collaboration contributions for an unmodified DSH Desktop. */
import type { Context } from '@deepseek-ai/cordis'
import * as gateway from '../gateway/host/index.ts'
import * as control from './execution.ts'
import * as nativeModelProviders from '../compat/host/model-providers.ts'
import * as gitBash from '../shell/host/git-bash.ts'
import * as conversationStats from '../conversation-stats/host/index.ts'
import { Config } from './config.ts'
export { Config } from './config.ts'

export const name = 'opl-suite'
export const inject: string[] = []

/** Mount account services and publish the authenticated local control binding.
 * @param ctx - Official Host context.
 */
export function apply(ctx: Context, config: Config): void {
  if (process.platform === 'win32') ctx.plugin(gitBash, {})
  ctx.plugin(gateway, structuredClone(config.gateway.get()) as gateway.OplGatewayConfig)
  ctx.plugin(control, { executionLimits: config.executionLimits })
  ctx.plugin(conversationStats)
  ctx.plugin(nativeModelProviders)
  ctx.plugin(GatewayModelsService)
  ctx.plugin(SetupService)
  ctx.plugin(CoordinationService)
  ctx.plugin(UpdateService)
  ctx.plugin(AutoReviewService, config.toolAutoReview.get())
  ctx.plugin(TaskFeedbackService, {
    wakeTransport: config.wakeTransport.get(),
    wakeExecutable: config.wakeExecutable.get(),
    wakeExecution: config.wakeExecution.get(),
    wakeDistro: config.wakeDistro.get(),
  })
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
