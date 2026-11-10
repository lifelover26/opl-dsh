import { describe, expect, it } from 'vitest'
import {
  antigravityContextUsage,
  normalizeAntigravityUsage,
} from '../../../src/execution/host/adapters/antigravity/usage.ts'

describe('Antigravity per-prompt usage', () => {
  it('keeps cached input disjoint and does not add thoughts to inclusive output twice', () => {
    expect(
      normalizeAntigravityUsage({
        inputTokens: 2695,
        cachedReadTokens: 6290,
        cachedWriteTokens: 0,
        outputTokens: 61,
        thoughtTokens: 53,
        totalTokens: 9046,
      }),
    ).toEqual({
      inputTokens: 2695,
      cacheReadTokens: 6290,
      cacheWriteTokens: 0,
      outputTokens: 61,
      reasoningTokens: 53,
      totalTokens: 9046,
    })
  })

  it.each([
    {
      inputTokens: 2695,
      outputTokens: 61,
      cachedReadTokens: 6290,
      thoughtTokens: 53,
      totalTokens: 9099,
    },
    { inputTokens: 1, outputTokens: 2, thoughtTokens: 3 },
    { inputTokens: '12', outputTokens: 2 },
    { inputTokens: 12, outputTokens: 2, cachedReadTokens: -1 },
    { inputTokens: 12, outputTokens: 2, cachedWriteTokens: 1.5 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    { inputTokens: 0, outputTokens: 0 },
    {},
    null,
  ])('omits malformed or contradictory usage %j', (value) => {
    expect(normalizeAntigravityUsage(value)).toBeUndefined()
  })
})

describe('Antigravity context estimate', () => {
  it('uses the last native request and response without adding cached input again', () => {
    expect(
      antigravityContextUsage(
        {
          promptTokenCount: 8985,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 53,
          cachedContentTokenCount: 6290,
          totalTokenCount: 9046,
        },
        1_000_000,
      ),
    ).toEqual({ used: 9046, size: 1_000_000, estimated: true })
  })

  it('does not treat cumulative ACP per-turn counters as context occupancy', () => {
    expect(
      antigravityContextUsage({ inputTokens: 100_000, outputTokens: 5000 }, 1_000_000),
    ).toEqual({ size: 1_000_000 })
    expect(antigravityContextUsage({ inputTokens: 100_000, outputTokens: 5000 })).toBeUndefined()
  })

  it('does not invent a capacity for a valid native usage record', () => {
    expect(
      antigravityContextUsage({
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      }),
    ).toEqual({ used: 120, estimated: true })
  })

  it.each([
    {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 10,
      totalTokenCount: 120,
    },
    { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 101 },
    { promptTokenCount: 100, candidatesTokenCount: -1 },
    { promptTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: 1 },
    { promptTokenCount: 0, candidatesTokenCount: 0 },
  ])('retains only a valid capacity when request counters are contradictory', (value) => {
    expect(antigravityContextUsage(value, 1_000_000)).toEqual({ size: 1_000_000 })
  })

  it('refuses occupancy larger than the source-owned capacity', () => {
    expect(
      antigravityContextUsage({ promptTokenCount: 100, candidatesTokenCount: 20 }, 100),
    ).toBeUndefined()
  })
})
