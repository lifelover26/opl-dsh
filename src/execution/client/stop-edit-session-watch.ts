/** Refresh history on official Session lifecycle changes, without polling or stream-delta requests. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'

/** @param session - Official Session read face. @param listener - Refresh after lifecycle or editable-history changes. @param events - Official event window, when available. @returns Unsubscribe callback. */
export function watchStopEditSession(
  session: ObservableSnapshot<{ running: boolean; blank: boolean; openState: string }>,
  listener: () => void,
  events?: SessionEventSource,
): () => void {
  const key = () => {
    const { running, blank, openState } = session.getSnapshot()
    return `${running}:${blank}:${openState}`
  }
  let previous = key()
  const offSession = session.subscribe(() => {
    const next = key()
    if (next === previous) return
    previous = next
    listener()
  })
  let revision = events?.getSnapshot().revision
  const offEvents = events?.subscribe(() => {
    const next = events.getSnapshot()
    if (next.revision === revision) return
    revision = next.revision
    const change = next.change
    if (
      change.kind === 'replace' ||
      change.kind === 'prepend' ||
      (change.kind === 'append' &&
        change.entries.some(
          (entry) =>
            entry.type === 'event' &&
            (entry.event.type === 'user/message' ||
              entry.event.type === 'system/message' ||
              entry.event.type === 'turn/end'),
        ))
    )
      listener()
  })
  return () => {
    offSession()
    offEvents?.()
  }
}
