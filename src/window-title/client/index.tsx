import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { FixedWindowTitleRow, type WindowTitleSettings } from './FixedWindowTitleRow.tsx'
import { installFixedWindowTitle } from './title.ts'
import { WINDOW_TITLE_NAMESPACE, zh, en, type WindowTitleLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplWindowTitle': WindowTitleLocaleKey
  }
}

export const inject = ['slots', 'locale', 'configForms']

/** Install the fixed-title observer and expose its setting in General settings. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(WINDOW_TITLE_NAMESPACE, { zh, en }))
  const form = ctx.configForms.get<WindowTitleSettings>('opl-suite')
  const title = installFixedWindowTitle(
    document,
    form.getSnapshot().value?.fixedWindowTitle ?? true,
  )
  const off = form.subscribe(() => {
    title.setEnabled(form.getSnapshot().value?.fixedWindowTitle ?? true)
  })
  ctx.effect(() => {
    return () => {
      off()
      title.dispose()
    }
  })
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'opl-fixed-window-title',
        order: 35,
        locale: WINDOW_TITLE_NAMESPACE,
        inject: () => ({ form }),
      },
      FixedWindowTitleRow,
    ),
  )
}
