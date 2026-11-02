/** Per-turn accounting for Mistral Vibe 3.0.4's cumulative ACP statistics. */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { HarnessContextUsage, HarnessStatistics } from '../contracts/usage.ts'
import { canonicalHarnessContext, isUsageCount } from './usage.ts'

type ObjectValue = Record<string, unknown>

interface VibeCounters {
  input: number
  output: number
  total: number
  cached: number
}

const cumulativeKeys = ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'] as const

const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined

function usageUpdate(value: unknown): ObjectValue | undefined {
  const envelope = object(value)
  const update = object(envelope?.update) ?? envelope
  return update?.sessionUpdate === 'usage_update' ? update : undefined
}

function counters(
  input: unknown,
  output: unknown,
  total: unknown,
  cached: unknown,
): VibeCounters | undefined {
  if (
    !isUsageCount(input) ||
    !isUsageCount(output) ||
    !isUsageCount(total) ||
    !isUsageCount(cached) ||
    !Number.isSafeInteger(input + output) ||
    total !== input + output ||
    cached > input
  )
    return undefined
  return { input, output, total, cached }
}

function resultCounters(value: unknown): VibeCounters | undefined {
  const usage = object(value)
  if (!usage) return undefined
  return counters(
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    // Vibe emits None, omitted on the wire, when its known cached count is zero.
    usage.cachedReadTokens === undefined ? 0 : usage.cachedReadTokens,
  )
}

function difference(next: VibeCounters, previous: VibeCounters): TokenUsage | undefined {
  const input = next.input - previous.input
  const output = next.output - previous.output
  const total = next.total - previous.total
  const cached = next.cached - previous.cached
  if (input < 0 || output < 0 || total < 0 || cached < 0 || cached > input) return undefined
  return {
    inputTokens: input - cached,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cached,
  }
}

/**
 * Read Vibe's context gauge and effective CLI window independently of billing.
 * The gauge may be zero when no last-call reading exists; the window is a compaction threshold.
 * @param value - Direct ACP usage_update or its enclosing session update params.
 * @returns Valid occupancy fields; an unknown restored zero retains only the effective window.
 */
export function parseVibeContextUsage(value: unknown): HarnessStatistics {
  const update = usageUpdate(value)
  if (!update || update.used === undefined || update.size === undefined) return {}
  const meta = object(update._meta)
  const cumulative = counters(
    meta?.promptTokens,
    meta?.completionTokens,
    meta?.totalTokens,
    meta?.cachedTokens,
  )
  const contextUsage = canonicalHarnessContext({
    used: update.used === 0 && cumulative && cumulative.total > 0 ? undefined : update.used,
    size: update.size,
    estimated: true,
  })
  return contextUsage ? { contextUsage } : {}
}

/**
 * Difference Vibe's session totals against a baseline observed before the prompt.
 * Use one tracker per ACP session; reset it when an edit or fork changes that session.
 * A turn without an idle baseline omits usage. A valid final result seeds the next turn.
 */
export class VibeTurnUsageTracker {
  private active = false
  private finished = false
  private invalid = false
  private reference: VibeCounters | undefined
  private idleBaseline: VibeCounters | undefined
  private baseline: VibeCounters | undefined
  private latest: VibeCounters | undefined
  private contextUsage: HarnessContextUsage | undefined

  /**
   * Observe new/load idle statistics or cumulative statistics during a prompt.
   * Active updates cannot establish a missing pre-prompt baseline.
   * @param value - Direct ACP usage_update or its enclosing session update params.
   * @returns Independently validated context; billing is returned only by finishTurn.
   */
  observeUpdate(value: unknown): HarnessStatistics {
    const account = parseVibeContextUsage(value)
    if (this.active && account.contextUsage) this.contextUsage = { ...account.contextUsage }
    const meta = object(usageUpdate(value)?._meta)
    if (meta && cumulativeKeys.some((key) => meta[key] !== undefined)) {
      this.accept(
        counters(meta.promptTokens, meta.completionTokens, meta.totalTokens, meta.cachedTokens),
      )
    }
    return account
  }

  /** Freeze the observed idle baseline immediately before session/prompt. */
  beginTurn(): void {
    this.baseline = this.active ? undefined : this.idleBaseline
    this.idleBaseline = undefined
    this.latest = undefined
    this.contextUsage = undefined
    this.active = true
    this.finished = false
    this.invalid = false
  }

  /**
   * Consume one turn's delta, including confirmed partial usage on error or cancellation.
   * Without valid terminal counters, the next prompt requires a fresh idle baseline.
   * @param result - Complete PromptResponse, or undefined when no result was returned.
   * @returns One turn account; repeated calls and calls while idle return an empty account.
   */
  finishTurn(result?: unknown): HarnessStatistics {
    if (!this.active || this.finished) return {}
    const response = object(result)
    if (response?.usage !== undefined) {
      const total = resultCounters(response.usage)
      if (this.accept(total)) this.idleBaseline = total
    }
    this.finished = true
    const usage =
      !this.invalid && this.baseline && this.latest
        ? difference(this.latest, this.baseline)
        : undefined
    return {
      ...(usage ? { usage } : {}),
      ...(this.contextUsage ? { contextUsage: { ...this.contextUsage } } : {}),
    }
  }

  /** Release the active turn after consuming its final account. */
  endTurn(): void {
    this.active = false
    this.finished = false
    this.invalid = false
    this.baseline = undefined
    this.latest = undefined
    this.contextUsage = undefined
  }

  /** Forget cumulative counters when the ACP session or its edited history changes. */
  reset(): void {
    this.endTurn()
    this.reference = undefined
    this.idleBaseline = undefined
  }

  private accept(next: VibeCounters | undefined): boolean {
    if (!next || (this.reference && !difference(next, this.reference))) {
      this.invalid = true
      this.idleBaseline = undefined
      return false
    }
    this.reference = next
    if (!this.active || this.finished) this.idleBaseline = next
    else this.latest = next
    return true
  }
}
