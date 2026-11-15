import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'

/** New packages own their fields; the old monolithic profile remains read-compatible. */
export function featureSettings(ctx: Context, namespace: string) {
  const settings = ctx.settings?.describe() ?? []
  return (
    settings.find((item) => item.ns === namespace) ??
    settings.find((item) => item.ns === 'opl-suite')
  )
}
