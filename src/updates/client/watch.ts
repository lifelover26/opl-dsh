/** Resume the update status stream independently of the physical connection. */
import type { OplUpdateStatus } from '../contracts.ts'
import type { UpdateConnectionSource } from './config.ts'

/** The generated Remote stream supplies this observation and cancellation interface. */
export interface UpdateWatchStream extends AsyncIterable<OplUpdateStatus> {
  dispose(): void
}

const reconnectDelays = [1000, 3000, 10_000, 30_000] as const
interface Attempt {
  stream?: UpdateWatchStream
  released: boolean
}

/**
 * Observe update invalidations, reopening an ended stream with capped backoff.
 * @param factory - Open one generated Remote stream for the active connection.
 * @param listener - Reread Host status on an item or unexpected stream termination.
 * @param connection - Optional connection generation; absence means one ready generation.
 * @returns Idempotent cleanup of the stream, reconnect timer, and connection observer.
 */
export function subscribeUpdateWatch(
  factory: () => UpdateWatchStream,
  listener: () => void,
  connection?: UpdateConnectionSource,
): () => void {
  let closed = false
  let revision = 0
  let generation = connection?.getSnapshot()
  let current: Attempt | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry = 0

  const connected = () => !connection || generation !== undefined
  const notify = () => {
    try {
      listener()
    } catch (_error) {
      // A failed consumer callback does not stop observation of later Host states.
    }
  }
  const release = (attempt: Attempt | undefined) => {
    if (!attempt?.stream || attempt.released) return
    attempt.released = true
    try {
      attempt.stream.dispose()
    } catch (_error) {
      // A failed carrier cancel must not retain the old generation or its timer.
    }
  }
  const clearRetry = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const waiting = (expected: number) =>
    !closed && revision === expected && connected() && current === undefined

  const ended = (attempt: Attempt, expected: number) => {
    if (closed || revision !== expected || current !== attempt) return
    current = undefined
    release(attempt)
    if (!waiting(expected)) return
    notify()
    if (!waiting(expected)) return
    const delay = reconnectDelays[retry]!
    retry = Math.min(retry + 1, reconnectDelays.length - 1)
    timer = setTimeout(() => {
      timer = undefined
      if (waiting(expected)) open()
    }, delay)
  }
  const open = () => {
    if (closed || !connected() || current || timer !== undefined) return
    const expected = revision
    const attempt: Attempt = { released: false }
    current = attempt
    try {
      attempt.stream = factory()
    } catch (_error) {
      // Endpoint failures can leave the carrier connected; retry this stream only.
      ended(attempt, expected)
      return
    }
    if (closed || revision !== expected || current !== attempt) {
      release(attempt)
      return
    }
    void (async () => {
      try {
        for await (const _status of attempt.stream!) {
          if (closed || revision !== expected || current !== attempt) return
          retry = 0
          notify()
        }
      } catch (_error) {
        // Terminal errors and unexpected completion share the same recovery path.
      } finally {
        ended(attempt, expected)
      }
    })()
  }
  const reconnect = () => {
    if (closed) return
    const next = connection?.getSnapshot()
    if (next === generation) return
    generation = next
    revision += 1
    clearRetry()
    const previous = current
    current = undefined
    release(previous)
    retry = 0
    open()
  }
  const off = connection?.subscribe(reconnect)
  reconnect()
  open()
  return () => {
    if (closed) return
    closed = true
    revision += 1
    clearRetry()
    const previous = current
    current = undefined
    try {
      off?.()
    } finally {
      release(previous)
    }
  }
}
