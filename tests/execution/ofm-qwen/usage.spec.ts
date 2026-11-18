import { describe, expect, it } from 'vitest'
import {
  QwenTurnUsage,
  normalizeQwenLiveUsage,
} from '../../../src/execution/host/adapters/qwen/usage.ts'
function frame(input = 100, output = 20, extra: Record<string, unknown> = {}) {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '' },
    _meta: {
      durationMs: 10,
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        cachedReadTokens: 30,
        thoughtTokens: 5,
      },
      ...extra,
    },
  }
}
describe('Qwen official live request usage', () => {
  it('subtracts cache from inclusive input without adding thoughts to output', () => {
    expect(normalizeQwenLiveUsage(frame())).toEqual({
      inputTokens: 70,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 30,
      reasoningTokens: 5,
    })
  })
  it('sums two model requests while preserving the separate request occupancy', () => {
    const turn = new QwenTurnUsage()
    turn.observe(frame())
    turn.observe(frame(200, 40))
    expect(turn.value()).toEqual({
      inputTokens: 240,
      outputTokens: 60,
      totalTokens: 360,
      cacheReadTokens: 60,
      reasoningTokens: 10,
    })
    turn.observe({ sessionUpdate: 'usage_update', used: 200, size: 128000 })
    expect(turn.value()?.totalTokens).toBe(360)
  })
  it.each([
    { durationMs: undefined },
    { durationMs: NaN },
    { durationMs: -1 },
    { parentToolCallId: 'child' },
    { subagentType: 'general' },
    { agent: { depth: 1 } },
    { qwenTranscript: { sourceRecordIds: ['replayed'] } },
    { 'qwen.session.recordId': 'replayed' },
    { timestamp: 123 },
  ])('excludes replay and subagent metadata %j', (meta) => {
    const turn = new QwenTurnUsage()
    turn.observe(frame())
    turn.observe(frame(200, 40, meta))
    expect(turn.value()?.totalTokens).toBe(120)
  })
  it('does not collapse independent requests that reported identical counters', () => {
    const turn = new QwenTurnUsage()
    turn.observe(frame())
    turn.observe(frame())
    expect(turn.value()?.totalTokens).toBe(240)
  })
  it('does not count the same parsed update object twice', () => {
    const turn = new QwenTurnUsage(),
      update = frame()
    turn.observe(update)
    turn.observe(update)
    expect(turn.value()?.totalTokens).toBe(120)
  })
  it.each([
    { inputTokens: -1 },
    { inputTokens: '100' },
    { outputTokens: Infinity },
    { cachedReadTokens: 101 },
    { thoughtTokens: 21 },
    { totalTokens: 121 },
  ])('suppresses partial totals after malformed live counters %j', (bad) => {
    const turn = new QwenTurnUsage()
    turn.observe(frame())
    const update = frame()
    Object.assign(update._meta.usage, bad)
    turn.observe(update)
    expect(turn.value()).toBeUndefined()
  })
  it('suppresses an overflow instead of publishing unsafe accumulated totals', () => {
    const turn = new QwenTurnUsage()
    const update = {
      sessionUpdate: 'agent_message_chunk',
      _meta: { durationMs: 1, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } },
    }
    turn.observe(update)
    turn.observe({ ...update })
    expect(turn.value()).toBeUndefined()
  })
  it('keeps prompt accumulators independent and snapshots immutable', () => {
    const first = new QwenTurnUsage(),
      second = new QwenTurnUsage()
    first.observe(frame())
    first.value()!.inputTokens = 999
    expect(first.value()?.inputTokens).toBe(70)
    expect(second.value()).toBeUndefined()
  })
})
