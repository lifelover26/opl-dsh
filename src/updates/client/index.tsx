/** General settings and a sidebar status over the same Host update projection. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Config } from './config.ts'
import { UpdateController } from './controller.ts'
import { UpdatesSection } from './UpdatesSection.tsx'
import { UpdateNotice } from './UpdateNotice.tsx'
import { UPDATE_NAMESPACE, zh, en } from './locales.ts'

export type { Config } from './config.ts'
export const inject = ['slots', 'locale']

/** @param ctx - Official Client context. @param config - Suite-owned Remote adapter. */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.locale.register(UPDATE_NAMESPACE, { zh, en }))
  const controller = new UpdateController(config)
  ctx.effect(() => {
    controller.start()
    return () => controller.stop()
  })
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'opl-updates',
        order: 60,
        locale: UPDATE_NAMESPACE,
        inject: () => ({ controller }),
      },
      UpdatesSection,
    ),
  )
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'opl-updates',
        order: 60,
        locale: UPDATE_NAMESPACE,
        inject: () => ({
          controller,
          ...(config.openSettings ? { openSettings: config.openSettings } : {}),
        }),
      },
      UpdateNotice,
    ),
  )
}
