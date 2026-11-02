import { describe, expect, it } from 'vitest'
import { parseVibeContextUsage, VibeTurnUsageTracker } from '../../src/execution/host/usage-vibe.ts'

function update(input = 0, output = 0, cached = 0, used = 120, size = 202_144) {
  return {
    sessionUpdate: 'usage_update',
    used,
    size,
    _meta: {
      promptTokens: input,
      completionTokens: output,
      cachedTokens: cached,
      totalTokens: input + output,
      steps: 2,
      lastTurnTotalTokens: 120,
    },
  }
}

function result(input: number, output: number, cached = 0) {
  return {
    stopReason: 'end_turn',
    usage: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
      ...(cached > 0 ? { cachedReadTokens: cached } : {}),
    },
  }
}

describe('Mistral Vibe cumulative usage', () => {
  it('counts all requests in two turns once across repeated updates and result totals', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update())
    tracker.beginTurn()
    expect(tracker.observeUpdate(update(100, 20, 40)).usage).toBeUndefined()
    tracker.observeUpdate(update(210, 50, 70))
    tracker.observeUpdate(update(210, 50, 70))
    expect(tracker.finishTurn(result(210, 50, 70)).usage).toEqual({
      inputTokens: 140,
      outputTokens: 50,
      totalTokens: 260,
      cacheReadTokens: 70,
    })
    expect(tracker.finishTurn(result(210, 50, 70))).toEqual({})
    tracker.endTurn()

    tracker.beginTurn()
    tracker.observeUpdate(update(270, 60, 90))
    tracker.observeUpdate(update(270, 60, 90))
    expect(tracker.finishTurn(result(270, 60, 90)).usage).toEqual({
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 70,
      cacheReadTokens: 20,
    })
    tracker.endTurn()
    expect(tracker.finishTurn(result(270, 60, 90))).toEqual({})
  })

  it('reads the official uncached result without requiring an active update', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update())
    tracker.beginTurn()
    expect(tracker.finishTurn(result(200, 40))).toEqual({
      usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240, cacheReadTokens: 0 },
    })
  })

  it('subtracts an idle session/load observation instead of rebilling restored history', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate({ sessionId: 'restored', update: update(800, 200, 300) })
    tracker.beginTurn()
    expect(tracker.finishTurn(result(880, 220, 350)).usage).toEqual({
      inputTokens: 30,
      outputTokens: 20,
      totalTokens: 100,
      cacheReadTokens: 50,
    })
  })

  it.each([0, 500])(
    'omits a turn whose first cumulative observation arrives after begin (%s existing input)',
    (existing) => {
      const tracker = new VibeTurnUsageTracker()
      tracker.beginTurn()
      tracker.observeUpdate(update(existing, 0))
      tracker.observeUpdate(update(existing + 100, 10, 30))
      expect(tracker.finishTurn(result(existing + 100, 10, 30)).usage).toBeUndefined()
      tracker.endTurn()

      tracker.beginTurn()
      expect(tracker.finishTurn(result(existing + 130, 15, 40)).usage).toEqual({
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 35,
        cacheReadTokens: 10,
      })
    },
  )

  it('keeps confirmed zero usage separate from an unobserved turn', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update(0, 0, 0, 0))
    tracker.beginTurn()
    expect(tracker.finishTurn(result(0, 0)).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
    })
    tracker.endTurn()

    tracker.beginTurn()
    expect(tracker.finishTurn()).toEqual({})
    tracker.endTurn()
    tracker.beginTurn()
    expect(tracker.finishTurn(result(0, 0)).usage).toBeUndefined()
  })

  it('preserves observed cancellation usage and the terminal baseline', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update(100, 20, 10))
    tracker.beginTurn()
    tracker.observeUpdate(update(150, 25, 30, 90))
    expect(tracker.finishTurn({ ...result(150, 25, 30), stopReason: 'cancelled' })).toEqual({
      usage: { inputTokens: 30, outputTokens: 5, totalTokens: 55, cacheReadTokens: 20 },
      contextUsage: { used: 90, size: 202_144, estimated: true },
    })
    tracker.endTurn()

    tracker.beginTurn()
    expect(tracker.finishTurn(result(160, 28, 35)).usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 13,
      cacheReadTokens: 5,
    })
  })

  it('returns confirmed partial usage once after a rejected prompt and requires a new baseline', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update(100, 20, 10))
    tracker.beginTurn()
    tracker.observeUpdate(update(150, 25, 30, 90))
    expect(tracker.finishTurn()).toEqual({
      usage: { inputTokens: 30, outputTokens: 5, totalTokens: 55, cacheReadTokens: 20 },
      contextUsage: { used: 90, size: 202_144, estimated: true },
    })
    expect(tracker.finishTurn()).toEqual({})
    tracker.endTurn()

    tracker.beginTurn()
    expect(tracker.finishTurn(result(200, 30, 40)).usage).toBeUndefined()
    tracker.endTurn()
    tracker.beginTurn()
    expect(tracker.finishTurn(result(210, 32, 42)).usage).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 2,
    })
  })

  it('accepts a fresh idle update after an error as the next prompt baseline', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update())
    tracker.beginTurn()
    tracker.observeUpdate(update(100, 20))
    expect(tracker.finishTurn().usage?.totalTokens).toBe(120)
    tracker.endTurn()
    tracker.observeUpdate(update(120, 25))

    tracker.beginTurn()
    expect(tracker.finishTurn(result(150, 30)).usage).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      cacheReadTokens: 0,
    })
  })

  it('does not reuse an idle baseline after a turn with no result or usage update', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update(100, 20))
    tracker.beginTurn()
    expect(tracker.finishTurn()).toEqual({})
    tracker.endTurn()
    tracker.beginTurn()
    expect(tracker.finishTurn(result(500, 50)).usage).toBeUndefined()
  })

  it.each([
    { name: 'input', input: 199, output: 41, cached: 60 },
    { name: 'output', input: 201, output: 39, cached: 60 },
    { name: 'cache', input: 201, output: 41, cached: 59 },
    { name: 'uncached input', input: 201, output: 41, cached: 62 },
  ])('omits a turn after its $name counter decreases', ({ input, output, cached }) => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update(100, 20, 30))
    tracker.beginTurn()
    tracker.observeUpdate(update(200, 40, 60))
    tracker.observeUpdate(update(input, output, cached))
    expect(tracker.finishTurn(result(250, 50, 70)).usage).toBeUndefined()
    tracker.endTurn()

    tracker.beginTurn()
    expect(tracker.finishTurn(result(260, 52, 72)).usage).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 2,
    })
  })

  it('omits counters that restarted below the last confirmed total', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update(500, 50, 100))
    tracker.beginTurn()
    tracker.observeUpdate(update(20, 2, 0))
    expect(tracker.finishTurn(result(30, 3)).usage).toBeUndefined()
    tracker.endTurn()
    tracker.beginTurn()
    expect(tracker.finishTurn(result(40, 4)).usage).toBeUndefined()
  })

  it('forgets the pre-edit or pre-fork session counters on reset', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update(100, 20))
    tracker.beginTurn()
    tracker.finishTurn(result(200, 40))
    tracker.endTurn()
    tracker.reset()

    tracker.beginTurn()
    tracker.observeUpdate(update(300, 60))
    expect(tracker.finishTurn(result(400, 80)).usage).toBeUndefined()
    tracker.endTurn()
    tracker.beginTurn()
    expect(tracker.finishTurn(result(410, 82)).usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 0,
    })
    tracker.endTurn()
    tracker.reset()
    tracker.observeUpdate(update(0, 0))
    tracker.beginTurn()
    expect(tracker.finishTurn(result(30, 3)).usage?.totalTokens).toBe(33)
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null])(
    'does not bill a malformed active cumulative count %j',
    (promptTokens) => {
      const tracker = new VibeTurnUsageTracker()
      tracker.observeUpdate(update())
      tracker.beginTurn()
      const active = update(100, 20)
      tracker.observeUpdate({ ...active, _meta: { ...active._meta, promptTokens } })
      const account = tracker.finishTurn(result(200, 40))
      expect(account.usage).toBeUndefined()
      expect(account.contextUsage).toEqual({ used: 120, size: 202_144, estimated: true })
    },
  )

  it.each([
    { inputTokens: 100, outputTokens: 20, totalTokens: 119 },
    { inputTokens: 100, outputTokens: 20 },
    { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: 101 },
    { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: null },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER },
    null,
  ])(
    'does not replace a malformed terminal result with a previous partial snapshot %j',
    (usage) => {
      const tracker = new VibeTurnUsageTracker()
      tracker.observeUpdate(update())
      tracker.beginTurn()
      tracker.observeUpdate(update(50, 10))
      expect(tracker.finishTurn({ stopReason: 'end_turn', usage }).usage).toBeUndefined()
    },
  )

  it('does not infer an idle baseline from context or last-request metadata', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate({
      sessionUpdate: 'usage_update',
      used: 120,
      size: 202_144,
      _meta: { lastTurnTotalTokens: 120, steps: 2 },
    })
    tracker.beginTurn()
    expect(tracker.finishTurn(result(200, 40)).usage).toBeUndefined()
  })

  it('keeps valid billing when the independent context fields are malformed', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update())
    tracker.beginTurn()
    expect(tracker.observeUpdate(update(100, 20, 0, 300, 0))).toEqual({})
    expect(tracker.finishTurn(result(100, 20))).toEqual({
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0 },
    })
  })

  it('uses late complete snapshots for future baselines without emitting another turn account', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update())
    tracker.beginTurn()
    expect(tracker.finishTurn(result(100, 20)).usage?.totalTokens).toBe(120)
    expect(tracker.observeUpdate(update(100, 20)).usage).toBeUndefined()
    tracker.observeUpdate(update(110, 22))
    expect(tracker.finishTurn(result(110, 22))).toEqual({})
    tracker.endTurn()
    tracker.observeUpdate(update(110, 22))

    tracker.beginTurn()
    expect(tracker.finishTurn(result(130, 25)).usage).toEqual({
      inputTokens: 20,
      outputTokens: 3,
      totalTokens: 23,
      cacheReadTokens: 0,
    })
  })

  it('does not seed from repeated stale idle snapshots below the completed turn', () => {
    const tracker = new VibeTurnUsageTracker()
    tracker.observeUpdate(update())
    tracker.beginTurn()
    tracker.finishTurn(result(100, 20))
    tracker.endTurn()
    tracker.observeUpdate(update())
    tracker.observeUpdate(update())
    tracker.beginTurn()
    expect(tracker.finishTurn(result(130, 25)).usage).toBeUndefined()
    tracker.endTurn()

    tracker.beginTurn()
    expect(tracker.finishTurn(result(140, 27)).usage?.totalTokens).toBe(12)
  })
})

describe('Mistral Vibe context observations', () => {
  it('keeps last-call occupancy and the effective CLI window separate from cumulative billing', () => {
    expect(parseVibeContextUsage(update(50_000, 5_000, 20_000, 120))).toEqual({
      contextUsage: { used: 120, size: 202_144, estimated: true },
    })
  })

  it('leaves a restored zero context unknown when the session has already billed model calls', () => {
    expect(parseVibeContextUsage({ update: update(50_000, 5_000, 20_000, 0) })).toEqual({
      contextUsage: { size: 202_144, estimated: true },
    })
    expect(parseVibeContextUsage(update(0, 0, 0, 0))).toEqual({
      contextUsage: { used: 0, size: 202_144, estimated: true },
    })
  })

  it('preserves estimated occupancy above the CLI compaction threshold', () => {
    expect(parseVibeContextUsage(update(300_000, 30_000, 100_000, 202_145))).toEqual({
      contextUsage: { used: 202_145, size: 202_144, estimated: true },
    })
  })

  it.each([
    { used: -1, size: 100 },
    { used: 1, size: 0 },
    { used: 1.5, size: 100 },
    { used: 1, size: Infinity },
    { used: 1, size: Number.MAX_SAFE_INTEGER + 1 },
    { used: '1', size: 100 },
    { used: null, size: 100 },
    { used: 1 },
    { size: 100 },
  ])('omits malformed or incomplete occupancy %j', (context) => {
    expect(
      parseVibeContextUsage({
        sessionUpdate: 'usage_update',
        ...context,
        _meta: { promptTokens: 100, completionTokens: 20, cachedTokens: 0, totalTokens: 120 },
      }),
    ).toEqual({})
  })

  it('requires a usage_update and never takes its occupancy from result billing', () => {
    expect(parseVibeContextUsage(result(100, 20))).toEqual({})
    expect(parseVibeContextUsage({ ...update(100, 20), sessionUpdate: 'other' })).toEqual({})
    expect(parseVibeContextUsage({ sessionUpdate: 'usage_update', _meta: update()._meta })).toEqual(
      {},
    )
  })
})
