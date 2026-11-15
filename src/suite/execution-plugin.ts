import type { Context } from '@deepseek-ai/cordis'
import * as execution from './execution.ts'
import AutoReviewService from '../auto-review/host/index.ts'
import { Config } from '../execution/host/plugin-config.ts'
export { Config }
export const name = 'opl-execution'
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(execution, { executionLimits: config.executionLimits })
  ctx.plugin(AutoReviewService, config.toolAutoReview.get())
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
