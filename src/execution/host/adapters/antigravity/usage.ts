/** Antigravity ACP accounting and a separate estimate from the latest Gemini request. */
import {
  normalizeNativeContextUsage,
  normalizeNativeUsage,
  type NativeContextUsage,
  type NativeTokenUsage,
} from '../native-usage.ts'

/**
 * Normalize the official ACP prompt result's `usage` object.
 * Input excludes cached reads; output already includes thoughts. Neither is added twice.
 * @param value - Antigravity `session/prompt` result.usage, not a session cumulative counter.
 * @returns Disjoint DSH token buckets when the advertised arithmetic is consistent.
 */
export function normalizeAntigravityUsage(value: unknown): NativeTokenUsage | undefined {
  return normalizeNativeUsage(value, 'input-disjoint-cache', {
    cacheRead: 'cachedReadTokens',
    cacheWrite: 'cachedWriteTokens',
    reasoning: 'thoughtTokens',
  })
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Estimate occupancy using the last complete selected-model Gemini request, never turn sums.
 * @param value - Native `usageMetadata` from the latest complete Gemini response.
 * @param contextWindow - Optional capacity explicitly supplied by the model-source owner.
 * @returns An estimated request-plus-response reading or the independently known capacity.
 */
export function antigravityContextUsage(
  value: unknown,
  contextWindow?: number,
): NativeContextUsage | undefined {
  const capacity =
    contextWindow === undefined ? undefined : normalizeNativeContextUsage({ size: contextWindow })
  const usage =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  if (!usage) return capacity
  const prompt = integer(usage.promptTokenCount)
  const candidates = integer(usage.candidatesTokenCount)
  const thoughts = usage.thoughtsTokenCount === undefined ? 0 : integer(usage.thoughtsTokenCount)
  const cached =
    usage.cachedContentTokenCount === undefined ? 0 : integer(usage.cachedContentTokenCount)
  if (
    prompt === undefined ||
    candidates === undefined ||
    thoughts === undefined ||
    cached === undefined ||
    cached > prompt
  )
    return capacity
  const used = prompt + candidates + thoughts
  if (!Number.isSafeInteger(used) || used === 0) return capacity
  if (usage.totalTokenCount !== undefined && integer(usage.totalTokenCount) !== used)
    return capacity
  return normalizeNativeContextUsage({
    used,
    ...(capacity?.size === undefined ? {} : { size: capacity.size }),
    estimated: true,
  })
}
