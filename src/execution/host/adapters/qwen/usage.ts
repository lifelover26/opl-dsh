/** Qwen 0.27.3 reports request deltas on live usage chunks and replays them on load. */
import { normalizeNativeUsage, type NativeTokenUsage } from '../native-usage.ts'
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function liveUsage(update: unknown): { envelope: object; usage: unknown } | undefined {
  const row = object(update)
  const meta = object(row?._meta)
  if (row?.sessionUpdate !== 'agent_message_chunk' || !meta || !Object.hasOwn(meta, 'usage'))
    return undefined
  // Official replay omits durationMs; subagent counters describe a different window.
  if (
    typeof meta.durationMs !== 'number' ||
    !Number.isFinite(meta.durationMs) ||
    meta.durationMs < 0 ||
    [
      'parentToolCallId',
      'subagentType',
      'agent',
      'qwenTranscript',
      'qwen.session.recordId',
      'timestamp',
    ].some((key) => Object.hasOwn(meta, key))
  )
    return undefined
  return { envelope: row, usage: meta.usage }
}
/** Parse one live main-agent request. Input and cached reads become disjoint buckets. */
export function normalizeQwenLiveUsage(update: unknown): NativeTokenUsage | undefined {
  const observed = liveUsage(update)
  return (
    observed &&
    normalizeNativeUsage(observed.usage, 'input-inclusive-cache', {
      cacheRead: 'cachedReadTokens',
      cacheWrite: 'cachedWriteTokens',
      reasoning: 'thoughtTokens',
    })
  )
}
/**
 * Own one prompt's request deltas. Feed each received ACP update once; discard on a new prompt.
 * Identical values from distinct requests remain distinct: the wire supplies no request id.
 */
export class QwenTurnUsage {
  private readonly seen = new WeakSet<object>()
  private total: NativeTokenUsage | undefined
  private invalid = false
  /** Add one live request; replay and subagent notifications never enter this accumulator. */
  observe(update: unknown): void {
    const observed = liveUsage(update)
    if (!observed || this.seen.has(observed.envelope)) return
    this.seen.add(observed.envelope)
    const delta = normalizeQwenLiveUsage(update)
    if (!delta) {
      this.invalid = true
      return
    }
    if (!this.total) {
      this.total = { ...delta }
      return
    }
    const next = { ...this.total }
    for (const name of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
    ] as const) {
      const a = next[name],
        b = delta[name]
      if (a === undefined && b === undefined) continue
      const value = (a ?? 0) + (b ?? 0)
      if (!Number.isSafeInteger(value)) {
        this.invalid = true
        return
      }
      next[name] = value
    }
    this.total = next
  }
  /** Return complete observed billing counters; malformed live deltas suppress partial totals. */
  value(): NativeTokenUsage | undefined {
    return this.invalid || !this.total ? undefined : { ...this.total }
  }
}
