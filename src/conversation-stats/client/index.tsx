/** Count scope preference over the official activity pill and settings form. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { StatisticsPreferenceRow, type StatisticsSettings } from './PreferenceRow.tsx'
import { installActivityCounts } from './activity.tsx'
import { STATISTICS_NAMESPACE, zh, en, type StatisticsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplConversationStats': StatisticsLocaleKey
  }
}

export const inject = ['slots', 'locale', 'configForms']

/** @param ctx - Official Client context with the shared Host settings mirror. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(STATISTICS_NAMESPACE, { zh, en }))
  const form = ctx.configForms.get<StatisticsSettings>('opl-suite')
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'opl-conversation-counts',
        order: 31,
        locale: STATISTICS_NAMESPACE,
        inject: () => ({ form }),
      },
      StatisticsPreferenceRow,
    ),
  )
  ctx.slots.inject('conversation.composer.dock', () =>
    installActivityCounts({
      entries: () => ctx.slots.entriesOfSlot('conversation.composer.dock'),
      subscribe: (listener) => ctx.slots.subscribe('conversation.composer.dock', listener),
      form,
    }),
  )
}
