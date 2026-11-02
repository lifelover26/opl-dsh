/** Completed Step RPC message accounting and the separate session context estimate. */
import type { NativeContextUsage, NativeTokenUsage } from '../native-usage.ts'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

function sum(values: readonly number[]): number | undefined {
  const total = values.reduce((current, value) => current + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

/** Step input excludes cache reads and writes; the final message owns these counters. */
function messageUsage(value: unknown): NativeTokenUsage | undefined {
  const usage = object(value)
  const inputTokens = count(usage.input)
  const outputTokens = count(usage.output)
  const cacheReadTokens = count(usage.cacheRead)
  const cacheWriteTokens = count(usage.cacheWrite)
  const reportedTotal = count(usage.totalTokens)
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    (usage.cacheRead !== undefined && cacheReadTokens === undefined) ||
    (usage.cacheWrite !== undefined && cacheWriteTokens === undefined) ||
    (usage.totalTokens !== undefined && reportedTotal === undefined)
  )
    return undefined
  const known = sum([inputTokens, outputTokens, cacheReadTokens ?? 0, cacheWriteTokens ?? 0])
  if (
    known === undefined ||
    (reportedTotal !== undefined &&
      (reportedTotal < known ||
        (cacheReadTokens !== undefined &&
          cacheWriteTokens !== undefined &&
          reportedTotal !== known)))
  )
    return undefined
  const totalTokens =
    reportedTotal ??
    (cacheReadTokens !== undefined && cacheWriteTokens !== undefined ? known : undefined)
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  }
}

type MessageSlot = {
  role: 'assistant' | 'toolResult'
  timestamp: number
  toolCallId?: string
}

/**
 * One ACP prompt's completed assistant, owned tool, and compaction-summary LLM work.
 * Streaming snapshots, history, session totals and repeated completion envelopes add nothing.
 */
export class StepTurnUsage {
  private slot: MessageSlot | undefined
  private compacting = false
  private invalid = false
  private readonly requests: NativeTokenUsage[] = []
  private readonly responses = new Set<string>()
  private readonly tools = new Map<string, string>()
  private readonly completedTools = new Set<string>()

  constructor(
    private readonly provider: string,
    private readonly model: string,
  ) {}

  /** Clear prompt observations before dispatch; loading history never calls accept. */
  reset(): void {
    this.slot = undefined
    this.compacting = false
    this.invalid = false
    this.requests.length = 0
    this.responses.clear()
    this.tools.clear()
    this.completedTools.clear()
  }

  /** Consume final messages only when their matching start belongs to the active prompt. */
  accept(value: unknown): void {
    const event = object(value)
    if (event.type === 'compaction_start') {
      if (this.compacting) this.invalid = true
      this.compacting = true
      return
    }
    if (event.type === 'compaction_end') {
      if (!this.compacting) return
      this.compacting = false
      const result = object(event.result)
      // Custom compaction handlers may omit usage, including after an interrupted summary.
      if (result.usage !== undefined) this.recordUsage(result.usage)
      return
    }
    if (this.compacting) return
    if (event.type !== 'message_start' && event.type !== 'message_end') return
    const message = object(event.message)
    if (message.role !== 'assistant' && message.role !== 'toolResult') return
    if (
      message.role === 'toolResult' &&
      (typeof message.toolCallId !== 'string' ||
        this.tools.get(message.toolCallId) !== message.toolName)
    )
      return
    if (event.type === 'message_start') {
      if (this.slot) this.invalid = true
      this.slot = undefined
      const timestamp = count(message.timestamp)
      if (timestamp === undefined) {
        this.invalid = true
        return
      }
      if (message.role === 'assistant') {
        if (message.provider !== this.provider || message.model !== this.model) {
          this.invalid = true
          return
        }
        this.slot = { role: message.role, timestamp }
      } else if (
        typeof message.toolCallId === 'string' &&
        this.tools.get(message.toolCallId) === message.toolName
      ) {
        this.slot = { role: message.role, timestamp, toolCallId: message.toolCallId }
      }
      return
    }
    const slot = this.slot
    if (!slot) return
    this.slot = undefined
    if (slot.role !== message.role || slot.timestamp !== message.timestamp) {
      this.invalid = true
      return
    }
    if (slot.role === 'assistant') {
      if (message.provider !== this.provider || message.model !== this.model) {
        this.invalid = true
        return
      }
      const responseId = typeof message.responseId === 'string' ? message.responseId : ''
      if (responseId && this.responses.has(responseId)) return
      if (responseId) this.responses.add(responseId)
      if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(message.stopReason))) {
        this.invalid = true
        return
      }
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const raw of blocks) {
        const block = object(raw)
        if (block.type !== 'toolCall') continue
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string') {
          this.invalid = true
          return
        }
        if (this.tools.has(block.id)) {
          this.invalid = true
          return
        }
        this.tools.set(block.id, block.name)
      }
    } else {
      if (
        slot.toolCallId !== message.toolCallId ||
        this.tools.get(slot.toolCallId!) !== message.toolName
      ) {
        this.invalid = true
        return
      }
      if (this.completedTools.has(slot.toolCallId!)) return
      this.completedTools.add(slot.toolCallId!)
      // A tool without nested LLM work has no usage field.
      if (message.usage === undefined) return
    }
    // An interrupted request may not have received provider counters; earlier completed
    // calls still report their own final usage.
    if (
      message.role === 'assistant' &&
      (message.stopReason === 'error' || message.stopReason === 'aborted') &&
      message.usage === undefined
    )
      return
    this.recordUsage(message.usage)
  }

  private recordUsage(value: unknown): void {
    const usage = messageUsage(value)
    if (!usage) {
      this.invalid = true
      return
    }
    if (
      usage.inputTokens +
        usage.outputTokens +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0) ===
        0 &&
      (usage.totalTokens ?? 0) === 0
    )
      return
    this.requests.push(usage)
  }

  /** Return completed work; interrupted turns can retain calls completed before interruption. */
  snapshot(interrupted = false): NativeTokenUsage | undefined {
    if (
      this.invalid ||
      (!interrupted && (this.slot || this.compacting)) ||
      this.requests.length === 0
    )
      return undefined
    const inputTokens = sum(this.requests.map((usage) => usage.inputTokens))
    const outputTokens = sum(this.requests.map((usage) => usage.outputTokens))
    if (inputTokens === undefined || outputTokens === undefined) return undefined
    const result: NativeTokenUsage = { inputTokens, outputTokens }
    for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      if (this.requests.some((usage) => usage[key] === undefined)) continue
      const total = sum(this.requests.map((usage) => usage[key]!))
      if (total === undefined) return undefined
      result[key] = total
    }
    return result
  }
}

/**
 * Read Step's current context estimate for the pinned model and exact session.
 * Null or unavailable occupancy retains capacity without retaining an earlier reading.
 */
export function stepContextUsage(
  stateValue: unknown,
  statsValue: unknown,
  expected: { sessionId: string; provider: string; model: string; contextWindow?: number },
): NativeContextUsage | undefined {
  const state = object(stateValue)
  const model = object(state.model)
  if (
    state.sessionId !== expected.sessionId ||
    model.provider !== expected.provider ||
    model.id !== expected.model
  )
    return undefined
  const size = count(model.contextWindow)
  if (
    size === undefined ||
    size === 0 ||
    (expected.contextWindow !== undefined && size !== expected.contextWindow)
  )
    return undefined
  const capacity: NativeContextUsage = { size, estimated: true }
  const stats = object(statsValue)
  const context = object(stats.contextUsage)
  if (stats.sessionId !== expected.sessionId || context.contextWindow !== size) return capacity
  const used = count(context.tokens)
  if (used === undefined || used > size) return capacity
  return { used, ...capacity }
}
