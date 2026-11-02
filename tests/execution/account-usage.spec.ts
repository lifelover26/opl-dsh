import { describe, expect, it, vi } from 'vitest'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { ExternalEditContext } from '../../src/execution/host/message-edit-driver.ts'

const kimiControlMock = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock('../../src/execution/host/adapters/kimi/kimi-edit-control.ts', async (original) => ({
  ...(await original<
    typeof import('../../src/execution/host/adapters/kimi/kimi-edit-control.ts')
  >()),
  startKimiControl: kimiControlMock.start,
}))

import { kimiMessageEditDriver } from '../../src/execution/host/message-edit-kimi.ts'
import {
  parseGrokTurnUsage,
  parseKimiContextUsage,
  parseKimiTranscriptUsage,
  parseMiniMaxContextUsage,
  parseMiniMaxTurnUsage,
  parseOpenCodeKiloTurnUsage,
  parsePoolContextUsage,
  parsePoolTurnUsage,
  readKimiTranscriptUsages,
} from '../../src/execution/host/usage-account.ts'

describe('external Harness usage parsers', () => {
  const miniMaxRow = (extra: Record<string, unknown> = {}) => ({
    id: 8306,
    turnId: 'native-turn',
    model: 'minimax/MiniMax-M3.1-Flash',
    inputTokens: 1_150,
    outputTokens: 96,
    cacheReadTokens: 19_873,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...extra,
  })

  it('sums only MiniMax requests from the selected native turn with disjoint cache buckets', () => {
    expect(
      parseMiniMaxTurnUsage(
        [
          miniMaxRow({ turnId: 'previous-turn', inputTokens: 999_999 }),
          miniMaxRow(),
          miniMaxRow({
            id: 8307,
            inputTokens: 144,
            outputTokens: 9,
            cacheReadTokens: 21_023,
          }),
        ],
        'native-turn',
        'MiniMax-M3.1-Flash',
      ),
    ).toEqual({
      inputTokens: 1_294,
      outputTokens: 105,
      cacheReadTokens: 40_896,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 42_295,
    })
  })

  it.each([
    { id: '' },
    { model: 'minimax/MiniMax-M3' },
    { model: 'other/MiniMax-M3.1-Flash' },
    { inputTokens: -1 },
    { outputTokens: 0.5 },
    { cacheReadTokens: undefined },
    { cacheWriteTokens: undefined },
    { reasoningTokens: 97 },
    { inputTokens: Number.MAX_SAFE_INTEGER },
  ])('withholds incomplete or inconsistent MiniMax usage (%j)', (extra) => {
    expect(
      parseMiniMaxTurnUsage([miniMaxRow(extra)], 'native-turn', 'MiniMax-M3.1-Flash'),
    ).toBeUndefined()
  })

  it('rejects duplicate MiniMax request ids and incomplete reasoning breakdowns', () => {
    for (const rows of [
      [miniMaxRow(), miniMaxRow()],
      [miniMaxRow(), miniMaxRow({ id: 8307, reasoningTokens: undefined })],
      [miniMaxRow({ inputTokens: Number.MAX_SAFE_INTEGER - 19_969 }), miniMaxRow({ id: 8308 })],
    ])
      expect(parseMiniMaxTurnUsage(rows, 'native-turn', 'MiniMax-M3.1-Flash')).toBeUndefined()
    expect(parseMiniMaxTurnUsage([], 'native-turn', 'MiniMax-M3.1-Flash')).toBeUndefined()
    expect(
      parseMiniMaxTurnUsage([miniMaxRow()], 'other-turn', 'MiniMax-M3.1-Flash'),
    ).toBeUndefined()
    expect(parseMiniMaxTurnUsage({}, 'native-turn', 'MiniMax-M3.1-Flash')).toBeUndefined()
  })

  it('converts Grok full prompt buckets into disjoint DSH counters', () => {
    expect(
      parseGrokTurnUsage({
        _meta: {
          usage: {
            inputTokens: 100,
            cachedReadTokens: 20,
            cacheCreationTokens: 5,
            outputTokens: 10,
            reasoningTokens: 4,
            totalTokens: 110,
          },
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 75,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        reasoningTokens: 4,
      },
    })
  })

  it('does not treat Grok outer live context total as billing usage', () => {
    expect(
      parseGrokTurnUsage({
        _meta: {
          totalTokens: 124,
          modelId: 'grok-4.7',
          modelState: { availableModels: [{ id: 'grok-4.7', _meta: { totalContextTokens: 500 } }] },
          usage: { inputTokens: 100, cachedReadTokens: 20, outputTokens: 4, totalTokens: 104 },
        },
      }),
    ).toEqual({
      usage: { inputTokens: 80, outputTokens: 4, totalTokens: 104, cacheReadTokens: 20 },
      contextUsage: { used: 124, size: 500, estimated: true },
    })
  })

  it('parses Pool response usage while ignoring cumulative poolside metadata', () => {
    expect(
      parsePoolTurnUsage({
        usage: { inputTokens: 100, cachedReadTokens: 20, outputTokens: 3, totalTokens: 103 },
        _meta: {
          'poolside/inputTokens': 999,
          'poolside/outputTokens': 999,
          'poolside/cachedReadTokens': 999,
        },
      }),
    ).toEqual({
      usage: { inputTokens: 80, outputTokens: 3, totalTokens: 103, cacheReadTokens: 20 },
    })
  })

  it('parses OpenCode and Kilo ACP result buckets as one completed prompt', () => {
    expect(
      parseOpenCodeKiloTurnUsage({
        usage: { inputTokens: 9_122, outputTokens: 125, totalTokens: 9_247 },
      }),
    ).toEqual({ usage: { inputTokens: 9_122, outputTokens: 125, totalTokens: 9_247 } })
    expect(
      parseOpenCodeKiloTurnUsage({
        usage: {
          inputTokens: 95,
          outputTokens: 7,
          thoughtTokens: 20,
          cachedReadTokens: 11_776,
          totalTokens: 11_898,
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 95,
        outputTokens: 27,
        totalTokens: 11_898,
        cacheReadTokens: 11_776,
        reasoningTokens: 20,
      },
    })
  })

  it('parses context occupancy separately, including estimated used-only updates', () => {
    expect(parsePoolContextUsage({ used: 7_090, size: 125_000 })).toEqual({
      contextUsage: { used: 7_090, size: 125_000 },
    })
    expect(parseMiniMaxContextUsage({ update: { used: 13_765, size: 512_000 } })).toEqual({
      contextUsage: { used: 13_765, size: 512_000 },
    })
    expect(parseMiniMaxContextUsage({ used: 42 })).toEqual({
      contextUsage: { used: 42 },
    })
  })

  it('fails closed for malformed, negative, overflowing, and contradictory buckets', () => {
    expect(parseGrokTurnUsage({ _meta: { usage: { inputTokens: -1, outputTokens: 1 } } })).toEqual(
      {},
    )
    expect(
      parsePoolTurnUsage({
        usage: { inputTokens: Number.MAX_SAFE_INTEGER, cachedReadTokens: 1, outputTokens: 1 },
      }),
    ).toEqual({})
    expect(
      parseGrokTurnUsage({
        _meta: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 5 } },
      }),
    ).toEqual({})
    expect(parsePoolContextUsage({ used: 11, size: 10 })).toEqual({})
  })

  it('converts Kimi native transcript buckets and step fallback into disjoint counters', () => {
    // The documented aggregate folds cache creation into inputTokens. Without the
    // native steps there is no safe way to split uncached input from cache writes.
    expect(
      parseKimiTranscriptUsage({
        usage: { inputTokens: 75, cachedTokens: 20, outputTokens: 10 },
      }),
    ).toBeUndefined()
    expect(
      parseKimiTranscriptUsage({
        steps: [
          { usage: { inputOther: 75, inputCacheRead: 20, inputCacheCreation: 5, output: 10 } },
        ],
      }),
    ).toEqual({
      inputTokens: 75,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    })
  })

  it('pages Kimi transcript from newest to oldest and rejects a stuck cursor', async () => {
    const calls: (string | undefined)[] = []
    const turn = (turnId: string, inputOther: number, output: number) => ({
      kind: 'turn',
      turnId,
      steps: [{ usage: { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 } }],
    })
    const result = await readKimiTranscriptUsages(async (beforeTurn) => {
      calls.push(beforeTurn)
      if (!beforeTurn)
        return {
          code: 0,
          data: {
            has_more: true,
            items: [turn('t3', 30, 3), turn('t2', 20, 2)],
          },
        }
      return {
        code: 0,
        data: {
          has_more: false,
          items: [turn('t1', 10, 1)],
        },
      }
    })
    expect(calls).toEqual([undefined, 't3'])
    expect([...result.keys()]).toEqual(['t3', 't2', 't1'])

    await expect(
      readKimiTranscriptUsages(async () => ({
        code: 0,
        data: { has_more: true, items: [] },
      })),
    ).rejects.toThrow('cursor did not advance')
  })

  it('reads Kimi context status without inventing a token usage record', () => {
    expect(
      parseKimiContextUsage({
        code: 0,
        data: { context_tokens: 19_333, max_context_tokens: 262_144 },
      }),
    ).toEqual({ used: 19_333, size: 262_144 })
    expect(parseKimiContextUsage({ code: 0, data: { context_tokens: -1 } })).toBeUndefined()
  })
})

describe('Kimi edit-history usage association', () => {
  it('attaches statistics to exact native turn ids and preserves history when stats are absent', async () => {
    const control = {
      readUserMessages: vi.fn(async () => [
        {
          turnId: 'turn-1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'same text',
          attachmentIds: [],
        },
        {
          turnId: 'turn-2',
          ordinal: 2,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'same text',
          attachmentIds: [],
        },
      ]),
      readTurnStatistics: vi.fn(async (sessionId: string, latestTurnId?: string) => {
        expect(sessionId).toBe('kimi-session')
        expect(latestTurnId).toBe('turn-2')
        return new Map([
          ['turn-1', { usage: { inputTokens: 10, outputTokens: 1 } }],
          ['turn-2', { usage: { inputTokens: 20, outputTokens: 2 } }],
        ])
      }),
      undo: vi.fn(),
      close: vi.fn(async () => {}),
    }
    kimiControlMock.start.mockResolvedValue(control)
    const disconnect = vi.fn(async () => {})
    const reconnect = vi.fn(async () => {})
    const ctx = {
      record: {
        harnessRef: 'kimi-code',
        acpSessionId: 'kimi-session',
        cwd: 'C:/work',
        turns: [],
      } as unknown as HarnessSession,
      launch: { home: '', command: 'kimi', args: [], env: {} },
      signal: new AbortController().signal,
      transport: () => ({ request: async () => ({}) }),
      snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
      disconnect,
      reconnect,
    } as ExternalEditContext

    const history = await kimiMessageEditDriver().read(ctx)
    expect(history.boundaries.map((item) => item.id)).toEqual(['turn-1', 'turn-2'])
    expect(history.boundaries.map((item) => item.statistics?.usage)).toEqual([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
    ])
    expect(control.close).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(reconnect).toHaveBeenCalledWith('kimi-session')

    control.readTurnStatistics.mockRejectedValueOnce(Error('transcript unavailable'))
    const withoutStatistics = await kimiMessageEditDriver().read(ctx)
    expect(withoutStatistics.boundaries.map((item) => item.id)).toEqual(['turn-1', 'turn-2'])
    expect(withoutStatistics.boundaries.every((item) => item.statistics === undefined)).toBe(true)
    expect(control.close).toHaveBeenCalledTimes(2)
    expect(reconnect).toHaveBeenCalledTimes(2)
  })

  it('releases the temporary server and reconnects when reading anchors fails', async () => {
    const control = {
      readUserMessages: vi.fn(async () => {
        throw Error('transcript unavailable')
      }),
      readTurnStatistics: vi.fn(async () => new Map()),
      undo: vi.fn(),
      close: vi.fn(async () => {}),
    }
    kimiControlMock.start.mockResolvedValue(control)
    const disconnect = vi.fn(async () => {})
    const reconnect = vi.fn(async () => {})
    const ctx = {
      record: {
        harnessRef: 'kimi-code',
        acpSessionId: 'kimi-session',
        cwd: 'C:/work',
        turns: [],
      } as unknown as HarnessSession,
      launch: { home: '', command: 'kimi', args: [], env: {} },
      signal: new AbortController().signal,
      transport: () => ({ request: async () => ({}) }),
      snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
      disconnect,
      reconnect,
    } as ExternalEditContext

    await expect(kimiMessageEditDriver().read(ctx)).rejects.toThrow('transcript unavailable')
    expect(control.readTurnStatistics).not.toHaveBeenCalled()
    expect(control.close).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(reconnect).toHaveBeenCalledWith('kimi-session')
  })

  it('does not attach current context to an older editable anchor', async () => {
    const control = {
      readUserMessages: vi.fn(async () => [
        {
          turnId: 'editable-turn',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'same text',
          attachmentIds: [],
        },
        {
          turnId: 'cron-turn',
          ordinal: 2,
          state: 'completed',
          origin: { kind: 'cron' },
          prompt: 'scheduled task',
          attachmentIds: [],
        },
      ]),
      readTurnStatistics: vi.fn(async (_sessionId: string, latestTurnId?: string) => {
        expect(latestTurnId).toBeUndefined()
        return new Map([['editable-turn', { usage: { inputTokens: 20, outputTokens: 2 } }]])
      }),
      undo: vi.fn(),
      close: vi.fn(async () => {}),
    }
    kimiControlMock.start.mockResolvedValue(control)
    const ctx = {
      record: {
        harnessRef: 'kimi-code',
        acpSessionId: 'kimi-session',
        cwd: 'C:/work',
        turns: [],
      } as unknown as HarnessSession,
      launch: { home: '', command: 'kimi', args: [], env: {} },
      signal: new AbortController().signal,
      transport: () => ({ request: async () => ({}) }),
      snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
      disconnect: async () => {},
      reconnect: async () => {},
    } as ExternalEditContext

    const history = await kimiMessageEditDriver().read(ctx)
    expect(history.boundaries).toHaveLength(1)
    expect(history.boundaries[0]?.id).toBe('editable-turn')
    expect(history.boundaries[0]?.statistics).toEqual({
      usage: { inputTokens: 20, outputTokens: 2 },
    })
  })
})
