import type { Context } from '@deepseek-ai/cordis'
import * as execution from './execution.ts'
import AutoReviewService from '../auto-review/host/index.ts'
import { Config } from '../execution/host/plugin-config.ts'
export { Config }
export const inject = execution.inject
export const name = 'opl-execution'
export async function apply(ctx: Context, config: Config): Promise<void> {
  const runtime = await ctx.plugin(execution, { executionLimits: config.executionLimits })
  const missing = Object.keys(runtime.inject).filter(
    (service) => runtime.ctx.get(service) === undefined,
  )
  if (missing.length) throw new Error(`执行服务缺少依赖：${missing.join(', ')}`)
  await ctx.plugin(AutoReviewService, config.toolAutoReview.get())
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
