/** Browser input observations; reporting and connection ownership stay in the controller. */

/**
 * Observe trusted input and a return to the foreground without periodic activity pulses.
 * @param activity - Report an actual interaction to the active Host generation.
 * @param leaving - Stop pending work when this document is unloaded.
 * @returns Idempotent listener cleanup, including non-browser environments.
 */
export function observeUpdateActivity(activity: () => void, leaving: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const doc = document
  const win = window
  let closed = false
  const input = (event: Event) => {
    if (!closed && event.isTrusted && doc.visibilityState !== 'hidden') activity()
  }
  const foreground = (event: Event) => {
    if (
      !closed &&
      event.isTrusted &&
      (event.type !== 'focus' || event.target === win) &&
      doc.visibilityState !== 'hidden' &&
      doc.hasFocus()
    )
      activity()
  }
  const leave = () => {
    if (!closed) leaving()
  }
  const events = ['pointerdown', 'keydown', 'input', 'wheel'] as const
  for (const name of events) doc.addEventListener(name, input, { capture: true, passive: true })
  doc.addEventListener('visibilitychange', foreground)
  win.addEventListener('focus', foreground)
  win.addEventListener('pagehide', leave)
  win.addEventListener('unload', leave)
  return () => {
    if (closed) return
    closed = true
    for (const name of events) doc.removeEventListener(name, input, true)
    doc.removeEventListener('visibilitychange', foreground)
    win.removeEventListener('focus', foreground)
    win.removeEventListener('pagehide', leave)
    win.removeEventListener('unload', leave)
  }
}
