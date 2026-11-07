import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WindowTitleLocaleKey } from './locales.ts'
import css from '../../shared/client/SettingsSection.module.css'

export interface WindowTitleSettings {
  fixedWindowTitle: boolean
}

/** @param props - Shared settings form and localized labels. @returns The title preference row. */
export function FixedWindowTitleRow({
  form,
  t,
}: PropsLocale<'settings.oplWindowTitle'> & { form: ConfigForm<WindowTitleSettings> }) {
  const source = useRef({
    subscribe: (listener: () => void) => form.subscribe(listener),
    getSnapshot: () => form.getSnapshot(),
  }).current
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const checked = state.value?.fixedWindowTitle ?? true
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
    <div className={css.officialRow} data-opl-preference="fixed-window-title">
      <div className={css.row}>
        <div>
          <h3 className={css.name}>{t('title')}</h3>
          <p className={css.muted}>{t('description')}</p>
        </div>
        <Switch
          label={t('enabled')}
          checked={checked}
          disabled={busy || state.status !== 'ready' || !state.writable}
          onChange={(value) => {
            if (busy || value === checked) return
            setBusy(true)
            setFailed(false)
            void form
              .set('fixedWindowTitle', value)
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
      {failed && <p className={css.error}>{t('saveFailed')}</p>}
    </div>
  )
}

export type { WindowTitleLocaleKey }
