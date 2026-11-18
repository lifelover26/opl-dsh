import { LlmError } from '../../shared/llm-error.ts'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-user-questions'
import { ProgressWatchdog } from './progress-watchdog.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Timer ownership supplied by the logical-turn owner, shared across retries. */
export interface NativeProgressClock {
  start(): void
  progress(): void
}

/** Whether a provider chunk contains new useful model output. */
export function nativeUsefulProgress(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length > 0
    case 'tool-call-delta':
      return chunk.argumentsDelta.length > 0 || Boolean(chunk.name)
    default:
      return false
  }
}

/**
 * Observe actual stream consumption using a logical-turn-owned clock.
 * The owner must start idempotently, dispose on turn completion, and cancel its
 * agent on expiry. Frozen waterfall requests cannot accept a replacement signal.
 * Signal cancellation rejects pending pulls and closes the consumer immediately;
 * provider iterator cleanup is best effort and cannot delay that rejection.
 */
export async function* guardNativeProgress(
  next: () => AsyncIterable<StreamChunk>,
  clock: NativeProgressClock,
  signal?: AbortSignal,
  expiry?: { signal: AbortSignal; reason: () => string | undefined },
): AsyncIterable<StreamChunk> {
  clock.start()
  const iterator = next()[Symbol.asyncIterator]()
  let rejectAbort: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  // The abort promise can settle between pulls; retain an observer throughout.
  void aborted.catch(() => {})
  const onAbort = () => rejectAbort?.(expiryError(expiry?.reason()))
  signal?.addEventListener('abort', onAbort, { once: true })
  expiry?.signal.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  if (expiry?.signal.aborted) onAbort()
  let completed = false
  try {
    while (true) {
      if (signal?.aborted || expiry?.signal.aborted) throw expiryError(expiry?.reason())
      const result = await Promise.race([iterator.next(), aborted])
      if (signal?.aborted || expiry?.signal.aborted) throw expiryError(expiry?.reason())
      if (result.done) {
        completed = true
        return
      }
      if (nativeUsefulProgress(result.value)) clock.progress()
      yield result.value
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    expiry?.signal.removeEventListener('abort', onAbort)
    if (!completed && iterator.return) {
      // Providers may ignore cancellation even in return(); never await teardown.
      try {
        void Promise.resolve(iterator.return()).catch(() => {})
      } catch (_error) {
        // A synchronous provider cleanup failure cannot replace cancellation.
      }
    }
  }
}

function expiryError(reason?: string): LlmError {
  return reason
    ? new LlmError(`Native execution stopped: ${reason}`, 'native-execution-timeout')
    : new LlmError('Native execution cancelled', 'native-execution-cancelled')
}

/** Install session-owned deadlines, shared by all requests in each live turn. */
export function installNativeProgressGuard(
  ctx: import('@deepseek-ai/cordis').Context,
  limits:
    | import('./progress-watchdog.js').ProgressWatchdogLimits
    | (() => import('./progress-watchdog.js').ProgressWatchdogLimits),
  shouldGuard: (options: import('@deepseek-ai/dsh-llm').GenerateOptions) => boolean,
  enabled: boolean | (() => boolean) = false,
): void {
  type TurnClock = {
    turn: number
    clock: ProgressWatchdog
    requestSignals: Set<AbortSignal>
    expiry: AbortController
    reason?: string
    expired: boolean
  }
  const clocks = new Map<string, TurnClock>()
  const abortListeners = new Map<AbortSignal, () => void>()
  const turnKey = (agent: import('@deepseek-ai/dsh-agent').Agent) => agent.session.id
  const release = (key: string) => {
    const turn = clocks.get(key)
    if (!turn) return
    for (const signal of turn.requestSignals) {
      const listener = abortListeners.get(signal)
      if (listener) signal.removeEventListener('abort', listener)
      abortListeners.delete(signal)
    }
    turn.clock.dispose()
    turn.expiry.abort()
    clocks.delete(key)
    toolDepth.delete(key)
    waitDepth.delete(key)
  }
  ctx.on('llm/stream', (options, next) => {
    const signal = options.signal
    const agent = options.sessionId && ctx.agents.get(options.sessionId)
    if (
      !signal ||
      signal.aborted ||
      !agent ||
      !(typeof enabled === 'function' ? enabled() : enabled) ||
      !shouldGuard(options)
    )
      return next()
    const key = turnKey(agent)
    let turn = clocks.get(key)
    const turnNumber = activeTurn.get(key)
    if (turn && turnNumber !== undefined && turn.turn !== turnNumber) {
      release(key)
      turn = undefined
    }
    if (!turn) {
      const expiry = new AbortController()
      const record: TurnClock = {
        turn: turnNumber ?? 0,
        clock: undefined as never,
        requestSignals: new Set(),
        expiry,
        expired: false,
      }
      const clock = new ProgressWatchdog(
        typeof limits === 'function' ? limits() : limits,
        (reason) => {
          record.reason = {
            'first-progress': '原生执行首次进展等待超时',
            'idle-progress': '原生执行长时间没有新进展',
          }[reason]
          record.expired = true
          expiry.abort()
          agent.cancel({ kind: 'hook', reason: record.reason }, { keepInbox: true })
        },
      )
      record.clock = clock
      turn = record
      clocks.set(key, turn)
    }
    if (turn.expired) {
      return guardNativeProgress(
        async function* () {
          throw expiryError(turn!.reason)
        },
        turn.clock,
        signal,
        { signal: turn.expiry.signal, reason: () => turn!.reason },
      )
    }
    turn.requestSignals.add(signal)
    if (!abortListeners.has(signal)) {
      const listener = () => {
        abortListeners.delete(signal)
        turn!.requestSignals.delete(signal)
      }
      abortListeners.set(signal, listener)
      signal.addEventListener('abort', listener, { once: true })
    }
    return guardNativeProgress(next, turn.clock, signal, {
      signal: turn.expiry.signal,
      reason: () => turn.reason,
    })
  })
  const activeTurn = new Map<string, number>()
  ctx.on(
    'agent/request',
    async ({ agent, turn }, next) => {
      const key = turnKey(agent)
      const previous = clocks.get(key)
      if (previous && previous.turn !== turn) release(key)
      activeTurn.set(key, turn)
      return next()
    },
    { prepend: true },
  )
  const toolDepth = new Map<string, number>()
  const pauseDepth = (key: string) => {
    const depth = toolDepth.get(key) ?? 0
    toolDepth.set(key, depth + 1)
    if (depth === 0) clocks.get(key)?.clock.pauseIdle()
  }
  const resumeDepth = (key: string) => {
    const depth = toolDepth.get(key) ?? 0
    if (depth <= 1) {
      toolDepth.delete(key)
      clocks.get(key)?.clock.resumeIdle()
    } else toolDepth.set(key, depth - 1)
  }
  const waitDepth = new Map<string, number>()
  const pauseWait = (key: string) => {
    const depth = waitDepth.get(key) ?? 0
    waitDepth.set(key, depth + 1)
    if (depth === 0) clocks.get(key)?.clock.pause()
  }
  const resumeWait = (key: string) => {
    const depth = waitDepth.get(key) ?? 0
    if (depth <= 1) {
      waitDepth.delete(key)
      clocks.get(key)?.clock.resume()
    } else waitDepth.set(key, depth - 1)
  }
  ctx.on(
    'tools/pre-execute',
    (exec, next) => {
      const key = exec.agent && turnKey(exec.agent)
      const turn = key && clocks.get(key)
      if (key && turn) pauseDepth(key)
      return next().finally(() => {
        if (key && turn && clocks.get(key) === turn) resumeDepth(key)
      })
    },
    { prepend: true },
  )
  ctx.on(
    'tools/execute',
    (exec, next) => {
      const key = exec.agent && turnKey(exec.agent)
      const turn = key && clocks.get(key)
      if (key && turn) pauseDepth(key)
      return next().finally(() => {
        if (key && turn && clocks.get(key) === turn) resumeDepth(key)
      })
    },
    { prepend: true },
  )
  ctx.on(
    'approval/request',
    async (_req, next) => {
      const key = _req.agent && turnKey(_req.agent)
      const turn = key && clocks.get(key)
      if (key && turn) pauseWait(key)
      try {
        return await next()
      } finally {
        if (key && turn && clocks.get(key) === turn) resumeWait(key)
      }
    },
    { prepend: true },
  )
  ctx.on(
    'user-questions/request',
    async (request, next) => {
      const key = request.agent && turnKey(request.agent)
      const turn = key && clocks.get(key)
      if (key && turn) pauseWait(key)
      try {
        return await next()
      } finally {
        if (key && turn && clocks.get(key) === turn) resumeWait(key)
      }
    },
    { prepend: true },
  )
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const key = turnKey(agent)
    if (clocks.get(key)?.turn === turn) release(key)
    if (activeTurn.get(key) === turn) activeTurn.delete(key)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const key = turnKey(agent)
    release(key)
    activeTurn.delete(key)
  })
  ctx.effect(() => () => {
    for (const key of clocks.keys()) release(key)
    activeTurn.clear()
  })
}
