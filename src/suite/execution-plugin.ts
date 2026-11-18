import type { Context } from '@deepseek-ai/cordis'
import * as execution from './execution.ts'
import AutoReviewService from '../auto-review/host/index.ts'
import { Config } from '../execution/host/plugin-config.ts'
export { Config }
export const inject = [...new Set([...execution.inject, ...AutoReviewService.inject])]
export const name = 'opl-execution'

/** Mount the execution runtime before the reviewer adapter that uses its binding port.
 * @param ctx - Official Host context.
 * @param config - Execution settings from the profile.
 * @returns Once the runtime and reviewer adapter have started.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(execution, {
    executionLimits: config.executionLimits.get(),
    rememberPermissionPreset: config.rememberPermissionPreset.get(),
  })
  await ctx.plugin(AutoReviewService, config.toolAutoReview.get())
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
}
