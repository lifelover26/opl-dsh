/** Replace only the official activity pill's turn and step counters. */
import { createElement, useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../contracts/index.ts'
import type { StatisticsSettings } from './PreferenceRow.tsx'

interface ActivityProps {
  useProjection: UseProjection
}

/** Public slot inspection and the one Host settings form. */
export interface ActivityCountOptions {
  entries(): readonly StoredEntry[]
  subscribe(listener: () => void): () => void
  form: ConfigForm<StatisticsSettings>
}

/**
 * Decorate the native activity registration, preserving its detail/speed dialog and subscriptions.
 * @param options - Composer dock entries and shared settings form.
 * @returns Disposer restoring the exact component when this decorator still owns it.
 */
export function installActivityCounts(options: ActivityCountOptions): () => void {
  const subscribePreference = (listener: () => void) => options.form.subscribe(listener)
  const preferenceSnapshot = () => options.form.getSnapshot()
  let current: StoredEntry | undefined
  let restore = () => {}
  const reconcile = () => {
    const entry = options.entries().find((entry) => entry.options.id === 'activity')
    if (entry === current) return
    restore()
    current = entry
    if (!entry) return
    const original = entry.component
    // Slot inspection erases the standard injected props of the native activity entry.
    const component = original as ComponentType<ActivityProps>
    const resident = (props: ActivityProps) => {
      const preference = useSyncExternalStore(subscribePreference, preferenceSnapshot)
      const mode = preference.value?.conversationStats
      const counts = props.useProjection('oplConversationCounts')
      // sessionStats is supplied by the pinned official runtime, not by the OPL type graph.
      const read = props.useProjection as (key: string, ...args: unknown[]) => unknown
      const historical = read('sessionStats') as { turns: number; steps: number } | undefined
      const projected = useMemo(
        () =>
          mode === 'current' && counts && historical
            ? { ...historical, turns: counts.turns, steps: counts.steps }
            : historical,
        [mode, counts, historical],
      )
      const useProjection = useMemo(
        () =>
          ((key: string, ...args: unknown[]) => {
            if (key !== 'sessionStats') return read(key, ...args)
            const selector = args[0]
            return read(
              key,
              () => (typeof selector === 'function' ? selector(projected) : projected),
              args[1],
            )
          }) as UseProjection,
        [props.useProjection, projected],
      )
      return createElement(component, { ...props, useProjection })
    }
    const decorated = (props: ActivityProps) =>
      typeof props.useProjection === 'function'
        ? createElement(resident, props)
        : createElement(component, props)
    entry.component = decorated
    restore = () => {
      if (entry.component === decorated) entry.component = original
    }
  }
  const off = options.subscribe(reconcile)
  reconcile()
  return () => {
    off()
    restore()
  }
}
