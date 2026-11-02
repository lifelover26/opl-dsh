/** Final-message ownership and context estimates from the official Step RPC protocol. */
import { describe, expect, it } from 'vitest'
import {
  StepTurnUsage,
  stepContextUsage,
} from '../../../src/execution/host/adapters/step/step-usage.ts'

const provider = 'opl-step-free-lane'
const model = 'step-5-preview-free'
const usage = { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, totalTokens: 135 }
const normalized = {
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  totalTokens: 135,
}

const assistant = (timestamp: number, fields: Record<string, unknown> = {}) => ({
  role: 'assistant',
  provider,
  model,
  timestamp,
  content: [],
  stopReason: 'stop',
  usage,
  ...fields,
})

function complete(tracker: StepTurnUsage, message: Record<string, unknown>): void {
  tracker.accept({ type: 'message_start', message })
  tracker.accept({ type: 'message_end', message })
}

describe('Step prompt usage', () => {
  it('sums final assistant calls and owned tools once across multiple tool steps', () => {
    const tracker = new StepTurnUsage(provider, model)
    const first = assistant(1, {
      responseId: 'response-1',
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: 'one', name: 'search' },
        { type: 'toolCall', id: 'two', name: 'read' },
      ],
    })
    tracker.accept({ type: 'message_start', message: first })
    tracker.accept({ type: 'message_update', usage: { ...usage, input: 999_999 } })
    tracker.accept({ type: 'message_update', usage: { ...usage, input: 999_999 } })
    tracker.accept({ type: 'message_end', message: first })
    const nested = {
      role: 'toolResult',
      toolCallId: 'one',
      toolName: 'search',
      timestamp: 2,
      usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 13 },
    }
    complete(tracker, nested)
    complete(tracker, nested)
    complete(tracker, { role: 'toolResult', toolCallId: 'two', toolName: 'read', timestamp: 3 })
    complete(tracker, {
      role: 'toolResult',
      toolCallId: 'unowned',
      toolName: 'search',
      timestamp: 4,
      usage: { ...usage, totalTokens: 99_999 },
    })
    const final = assistant(5, {
      responseId: 'response-2',
      usage: { input: 180, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 250 },
    })
    complete(tracker, final)
    complete(tracker, final)
    tracker.accept({ type: 'message_end', message: final })
    tracker.accept({ type: 'turn_end', message: final, toolResults: [nested] })
    tracker.accept({ type: 'agent_end', messages: [first, nested, final] })
    expect(tracker.snapshot()).toEqual({
      inputTokens: 287,
      outputTokens: 32,
      cacheReadTokens: 73,
      cacheWriteTokens: 6,
      totalTokens: 398,
    })
  })

  it('starts a new prompt without reusing earlier message or session totals', () => {
    const tracker = new StepTurnUsage(provider, model)
    complete(tracker, assistant(1))
    tracker.reset()
    tracker.accept({ type: 'message_end', message: assistant(1) })
    tracker.accept({ type: 'get_session_stats', tokens: { input: 100_000, output: 10_000 } })
    complete(tracker, assistant(2, { usage: { input: 8, output: 3 } }))
    expect(tracker.snapshot()).toEqual({ inputTokens: 8, outputTokens: 3 })
  })

  it('counts a prompt-owned compaction summary once without counting its streaming messages', () => {
    const tracker = new StepTurnUsage(provider, model)
    complete(tracker, assistant(1))
    tracker.accept({ type: 'compaction_start', reason: 'threshold' })
    complete(tracker, assistant(2))
    const summary = {
      type: 'compaction_end',
      result: { usage: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 10 } },
    }
    tracker.accept(summary)
    tracker.accept(summary)
    expect(tracker.snapshot()).toEqual({
      inputTokens: 104,
      outputTokens: 13,
      cacheReadTokens: 22,
      cacheWriteTokens: 6,
      totalTokens: 145,
    })
  })

  it.each(['error', 'aborted'])(
    'keeps completed calls when a later %s has no provider usage',
    (reason) => {
      const tracker = new StepTurnUsage(provider, model)
      complete(tracker, assistant(1))
      complete(tracker, assistant(2, { stopReason: reason, usage: undefined }))
      expect(tracker.snapshot(true)).toEqual(normalized)
    },
  )

  it('keeps completed work before an unfinished cancelled request', () => {
    const tracker = new StepTurnUsage(provider, model)
    complete(tracker, assistant(1))
    tracker.accept({ type: 'message_start', message: assistant(2) })
    expect(tracker.snapshot()).toBeUndefined()
    expect(tracker.snapshot(true)).toEqual(normalized)
  })

  it('includes final nonzero usage from an unsuccessful provider request', () => {
    const tracker = new StepTurnUsage(provider, model)
    complete(tracker, assistant(1, { stopReason: 'error' }))
    complete(
      tracker,
      assistant(2, {
        stopReason: 'aborted',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      }),
    )
    expect(tracker.snapshot(true)).toEqual(normalized)
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['negative input', { ...usage, input: -1 }],
    ['fractional output', { ...usage, output: 1.5 }],
    ['string cache', { ...usage, cacheRead: '20' }],
    ['null cache', { ...usage, cacheWrite: null }],
    ['invalid total', { ...usage, totalTokens: 1 }],
    ['nonfinite total', { ...usage, totalTokens: Infinity }],
    ['overflow', { ...usage, input: Number.MAX_SAFE_INTEGER }],
  ])('withholds a turn containing %s final usage', (_name, value) => {
    const tracker = new StepTurnUsage(provider, model)
    complete(tracker, assistant(1))
    complete(tracker, assistant(2, { usage: value }))
    expect(tracker.snapshot()).toBeUndefined()
  })

  it('withholds an aggregate that exceeds safe integer precision', () => {
    const tracker = new StepTurnUsage(provider, model)
    for (const timestamp of [1, 2])
      complete(
        tracker,
        assistant(timestamp, {
          usage: { input: Number.MAX_SAFE_INTEGER, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      )
    expect(tracker.snapshot()).toBeUndefined()
  })

  it('preserves optional unknown fields instead of filling cache or total with zero', () => {
    const tracker = new StepTurnUsage(provider, model)
    complete(tracker, assistant(1, { usage: { input: 9, output: 2 } }))
    expect(tracker.snapshot()).toEqual({ inputTokens: 9, outputTokens: 2 })
    tracker.reset()
    complete(tracker, assistant(2, { usage: { input: 9, output: 2, totalTokens: 15 } }))
    expect(tracker.snapshot()).toEqual({ inputTokens: 9, outputTokens: 2, totalTokens: 15 })
  })

  it.each([{ timestamp: 2 }, { provider: 'other-provider' }, { model: 'other-model' }])(
    'rejects a final message that differs from its owned start: %j',
    (change) => {
      const tracker = new StepTurnUsage(provider, model)
      tracker.accept({ type: 'message_start', message: assistant(1) })
      tracker.accept({ type: 'message_end', message: assistant(1, change) })
      expect(tracker.snapshot()).toBeUndefined()
    },
  )

  it('refuses ambiguous overlapping starts instead of charging either final message', () => {
    const tracker = new StepTurnUsage(provider, model)
    tracker.accept({ type: 'message_start', message: assistant(1) })
    complete(tracker, assistant(2))
    expect(tracker.snapshot()).toBeUndefined()
  })
})

describe('Step context estimate', () => {
  const expected = { sessionId: 'session-1', provider, model, contextWindow: 262_144 }
  const state = {
    sessionId: expected.sessionId,
    model: { provider, id: model, contextWindow: 262_144 },
  }
  const stats = {
    sessionId: expected.sessionId,
    tokens: { input: 999_999, output: 999_999, total: 1_999_998 },
    contextUsage: { tokens: 60_000, contextWindow: 262_144, percent: 22.8 },
  }

  it('uses the current official context estimate independently of billed session tokens', () => {
    expect(stepContextUsage(state, stats, expected)).toEqual({
      used: 60_000,
      size: 262_144,
      estimated: true,
    })
  })

  it.each([null, undefined, -1, '60000', 1.5, 300_000])(
    'retains only capacity when occupancy is %j, including post-compaction null',
    (tokens) => {
      expect(
        stepContextUsage(
          state,
          { ...stats, contextUsage: { ...stats.contextUsage, tokens } },
          expected,
        ),
      ).toEqual({ size: 262_144, estimated: true })
    },
  )

  it('preserves a reported empty context as an estimate of zero', () => {
    expect(
      stepContextUsage(
        state,
        { ...stats, contextUsage: { ...stats.contextUsage, tokens: 0 } },
        expected,
      ),
    ).toEqual({ used: 0, size: 262_144, estimated: true })
  })

  it.each([
    undefined,
    {},
    { ...stats, sessionId: 'other-session' },
    { ...stats, contextUsage: { tokens: 20, contextWindow: 32768 } },
  ])('does not retain old occupancy from unavailable or mismatched statistics', (value) => {
    expect(stepContextUsage(state, value, expected)).toEqual({ size: 262_144, estimated: true })
  })

  it.each([
    { ...state, sessionId: 'other-session' },
    { ...state, model: { ...state.model, id: 'other-model' } },
    { ...state, model: { ...state.model, provider: 'other-provider' } },
    { ...state, model: { ...state.model, contextWindow: 32768 } },
    { ...state, model: { ...state.model, contextWindow: 0 } },
  ])('withholds a context observation from the wrong live session or capacity', (value) => {
    expect(stepContextUsage(value, stats, expected)).toBeUndefined()
  })

  it('marks the official effective runtime window estimated when source metadata is unavailable', () => {
    const { contextWindow: _capacity, ...unknownCapacity } = expected
    expect(stepContextUsage(state, stats, unknownCapacity)).toEqual({
      used: 60_000,
      size: 262_144,
      estimated: true,
    })
  })
})
