/** Host-backed count selector placed beside the native performance preference. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PreferenceRow.module.css'

export type StatisticsMode = 'current' | 'history'
/** The count preference is one field of the existing Suite settings namespace. */
export interface StatisticsSettings {
  conversationStats: StatisticsMode
}

/** @param props - Official shared settings form and localized labels. @returns One general settings row. */
export function StatisticsPreferenceRow({
  form,
  t,
}: PropsLocale<'settings.oplConversationStats'> & { form: ConfigForm<StatisticsSettings> }) {
  const source = useMemo(
    () => ({
      subscribe: (listener: () => void) => form.subscribe(listener),
      getSnapshot: () => form.getSnapshot(),
    }),
    [form],
  )
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const mode = state.value?.conversationStats ?? 'current'
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const select = async (value: string) => {
    if ((value !== 'current' && value !== 'history') || busy) return
    button.current?.focus({ preventScroll: true })
    setOpen(false)
    if (value === mode) return
    setBusy(true)
    setFailed(false)
    try {
      const accepted = await form.set('conversationStats', value)
      if (live.current) setFailed(!accepted)
    } catch (_error) {
      // ConfigForms owns the recovery read; show no success for a failed transport.
      if (live.current) setFailed(true)
    } finally {
      if (live.current) setBusy(false)
    }
  }
  return (
    <div className={css.row} data-opl-preference="conversation-counts">
      <div className={css.text} title={t('help')}>
        <div className={css.title}>{t('title')}</div>
        <div className={css.description}>{t('description')}</div>
        {failed && (
          <div role="alert" className={css.error}>
            {t('saveFailed')}
          </div>
        )}
      </div>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        portal
        selectedId={mode}
        items={(['current', 'history'] as const).map((id) => ({ id, label: t(id) }))}
        onSelect={(value) => void select(value)}
        anchor={
          <button
            ref={button}
            type="button"
            className={css.selector}
            aria-label={t('title')}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={busy || state.status !== 'ready' || !state.writable}
            onClick={() => setOpen((value) => !value)}
          >
            {t(mode)}
            <IconChevronDownOutlineRegular className={css.chevron} />
          </button>
        }
      />
    </div>
  )
}
