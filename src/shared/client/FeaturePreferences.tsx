import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { StatisticsSettings } from '../../conversation-stats/client/PreferenceRow.tsx'
import css from './SettingsSection.module.css'

export interface SuiteFeatureSettings extends StatisticsSettings {
  enhancedConversationStats: boolean
}

export const labels = {
  zh: {
    title: '界面增强',
    description: '可选的会话统计展示。',
    counts: '增强会话统计',
    countsDescription: '替换官方统计中的轮次和步数。',
    remember: '记住权限预设',
    rememberDescription: '将此后在原生会话中明确选择的权限预设保存为官方默认权限，用于新会话。',
    saveFailed: '设置未能保存，请重试。',
  },
  en: {
    title: 'Interface enhancements',
    description: 'Optional conversation statistics display.',
    counts: 'Enhanced conversation statistics',
    countsDescription: 'Replace the official turn and step counts. Off by default.',
    remember: 'Remember permission preset',
    rememberDescription:
      'Save future explicit native-session permission choices as the official default permission for new conversations.',
    saveFailed: 'Could not save. Please try again.',
  },
} as const

export const SUITE_FEATURE_NAMESPACE = 'settings.oplSuiteFeatures'
export type SuiteFeatureLocaleKey = keyof typeof labels.zh

export function FeatureSwitch<T>({
  form,
  field,
  title,
  description,
  saveFailed,
}: {
  form: ConfigForm<T>
  field: keyof T & string
  title: string
  description: string
  saveFailed: string
}) {
  const source = useRef({
    subscribe: (listener: () => void) => form.subscribe(listener),
    getSnapshot: () => form.getSnapshot(),
  }).current
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const checked = state.value?.[field] === true
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  return (
    <div className={css.officialRow}>
      <div className={css.preferenceContent}>
        <div className={css.preferenceText}>
          <h3 className={css.preferenceTitle}>{title}</h3>
          <p className={css.preferenceDescription}>{description}</p>
        </div>
        <Switch
          label={title}
          checked={checked}
          disabled={busy || state.status !== 'ready' || !state.writable}
          onChange={(value) => {
            if (busy || value === checked) return
            setBusy(true)
            setFailed(false)
            void form
              .set(field, value)
              .then((accepted) => {
                if (live.current) setFailed(!accepted)
              })
              .catch(() => {
                if (live.current) setFailed(true)
              })
              .finally(() => {
                if (live.current) setBusy(false)
              })
          }}
        />
      </div>
      {failed && (
        <p role="alert" className={css.error}>
          {saveFailed}
        </p>
      )}
    </div>
  )
}

/** Existing suite settings rows for optional presentation features. */
export function SuiteFeaturePreferences({
  form,
  t,
}: PropsLocale<'settings.oplSuiteFeatures'> & { form: ConfigForm<SuiteFeatureSettings> }) {
  return (
    <div data-opl-preference="suite-features">
      <FeatureSwitch
        form={form}
        field="enhancedConversationStats"
        title={t('counts')}
        description={t('countsDescription')}
        saveFailed={t('saveFailed')}
      />
    </div>
  )
}

export interface PermissionMemorySettings {
  rememberPermissionPreset: boolean
}

/** Persist the opt-in to the existing execution configuration owner. */
export function PermissionMemoryPreference({
  form,
  t,
}: PropsLocale<'settings.oplSuiteFeatures'> & { form: ConfigForm<PermissionMemorySettings> }) {
  return (
    <>
      <FeatureSwitch
        form={form}
        field="rememberPermissionPreset"
        title={t('remember')}
        description={t('rememberDescription')}
        saveFailed={t('saveFailed')}
      />
    </>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oplSuiteFeatures': SuiteFeatureLocaleKey
  }
}
