/** The local clock renders the Host's deadline without reading or scheduling updates. */
import { useEffect, useState } from 'react'

/**
 * Render a live deadline only while its Host status is accepted for this connection.
 * @param dueAt - Host restart deadline, or null outside a countdown.
 * @param enabled - Whether the current connection confirms this status.
 * @returns Remaining whole seconds, clamped at zero, or null for no confirmed deadline.
 */
export function useUpdateCountdown(
  dueAt: string | null | undefined,
  enabled: boolean,
): number | null {
  const [now, setNow] = useState(Date.now)
  const deadline = dueAt ? Date.parse(dueAt) : NaN
  useEffect(() => {
    if (!enabled || !Number.isFinite(deadline)) return
    const started = Date.now()
    setNow(started)
    if (started >= deadline) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= deadline) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [deadline, enabled])
  return enabled && Number.isFinite(deadline)
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : null
}
