/** Validation and projection of external Harness observations. */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { HarnessContextReading } from '../contracts/usage.ts'
import type { HarnessSession } from '../contracts/sessions.ts'
import type { HarnessContextUsage } from '../contracts/usage.ts'

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** @param value - Wire count. @returns Whether the count can be added without rounding. */
export function isUsageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Validate canonical disjoint billing buckets, leaving absent breakdowns unknown.
 * @param value - Normalized usage from an owned bridge or native history reader.
 * @returns A detached count record, or undefined for inconsistent statistics.
 */
export function canonicalHarnessUsage(value: unknown): TokenUsage | undefined {
  const raw = object(value)
  if (!isUsageCount(raw.inputTokens) || !isUsageCount(raw.outputTokens)) return
  const fields = ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
  for (const key of fields) if (raw[key] !== undefined && !isUsageCount(raw[key])) return
  const knownPrompt =
    raw.inputTokens + Number(raw.cacheReadTokens ?? 0) + Number(raw.cacheWriteTokens ?? 0)
  const minimum = knownPrompt + raw.outputTokens
  if (!Number.isSafeInteger(minimum)) return
  if (raw.reasoningTokens !== undefined && Number(raw.reasoningTokens) > raw.outputTokens) return
  if (
    raw.totalTokens !== undefined &&
    (Number(raw.totalTokens) < minimum ||
      (raw.cacheReadTokens !== undefined &&
        raw.cacheWriteTokens !== undefined &&
        raw.totalTokens !== minimum))
  )
    return
  if (
    raw.totalTokens === undefined &&
    (raw.cacheReadTokens === undefined || raw.cacheWriteTokens === undefined)
  )
    return
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    totalTokens: Number(raw.totalTokens ?? minimum),
    ...(raw.cacheReadTokens === undefined ? {} : { cacheReadTokens: Number(raw.cacheReadTokens) }),
    ...(raw.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: Number(raw.cacheWriteTokens) }),
    ...(raw.reasoningTokens === undefined ? {} : { reasoningTokens: Number(raw.reasoningTokens) }),
  }
}

/** @param value - External occupancy/capacity. @returns Valid supplied fields; unknowns stay absent. */
export function canonicalHarnessContext(value: unknown): HarnessContextUsage | undefined {
  const raw = object(value)
  if (raw.used !== undefined && !isUsageCount(raw.used)) return
  if (raw.size !== undefined && (!isUsageCount(raw.size) || raw.size === 0)) return
  if (raw.estimated !== undefined && typeof raw.estimated !== 'boolean') return
  if (raw.used === undefined && raw.size === undefined) return
  // An estimated CLI budget may be a compaction threshold exceeded by the final output.
  if (
    raw.used !== undefined &&
    raw.size !== undefined &&
    raw.used > raw.size &&
    raw.estimated !== true
  )
    return
  return {
    ...(raw.used === undefined ? {} : { used: Number(raw.used) }),
    ...(raw.size === undefined ? {} : { size: Number(raw.size) }),
    ...(raw.estimated === undefined ? {} : { estimated: Boolean(raw.estimated) }),
  }
}

/** Select one completed observation only when the DSH Session's combination is unambiguous.
 * @param records - Persisted external Harness sessions.
 * @param nativeSessionId - Official DSH Session requesting the reading.
 * @param selectedCombination - Durable current combination selection, if present.
 * @returns Latest completed route observation, or null when unavailable or ambiguous.
 */
export function latestHarnessContext(
  records: readonly HarnessSession[],
  nativeSessionId: string,
  selectedCombination: string | undefined,
): HarnessContextReading | null {
  const matches = records.filter(
    (record) =>
      record.nativeSessionId === nativeSessionId &&
      record.harnessRef !== 'dsh' &&
      (selectedCombination === undefined || record.combination === selectedCombination),
  )
  if (matches.length !== 1) return null
  const record = matches[0]!
  const turn = record.turns.at(-1)
  if (!turn || turn.state !== 'completed') return null
  const contextUsage = canonicalHarnessContext(turn.contextUsage)
  if (!contextUsage) return null
  const usage = canonicalHarnessUsage(turn.usage)
  return {
    harness: record.harnessRef,
    provider: record.modelRef.provider,
    model: record.modelRef.model,
    operationId: turn.operationId,
    ...(usage ? { usage } : {}),
    contextUsage,
  }
}
