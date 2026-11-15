import { describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/execution/host/plugin-config.ts'
import { executionLimitsSchema } from '../../src/execution/contracts/limits.ts'
import { ProgressWatchdog } from '../../src/execution/host/progress-watchdog.ts'

describe('execution progress limits', () => {
  it('supplies bounded defaults and preserves partial deployment overrides', () => {
    expect(Config({}).executionLimits).toEqual({
      firstProgressMs: 90_000,
      idleProgressMs: 90_000,
    })
    expect(Config({ executionLimits: { idleProgressMs: 120_000 } }).executionLimits).toEqual({
      firstProgressMs: 90_000,
      idleProgressMs: 120_000,
    })
  })

  it('resolves shared defaults and accepts the timer limit', () => {
    expect(executionLimitsSchema({})).toEqual(Config({}).executionLimits)
    expect(executionLimitsSchema({ idleProgressMs: 2_147_483_647 }).idleProgressMs).toBe(
      2_147_483_647,
    )
  })

  it('does not enforce the removed total limit from existing settings', () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    const limits = Config({ executionLimits: { totalMs: 1 } }).executionLimits
    const watchdog = new ProgressWatchdog(limits, expire)
    try {
      watchdog.start()
      vi.advanceTimersByTime(89_999)
      expect(expire).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(expire).toHaveBeenCalledExactlyOnceWith('first-progress')
    } finally {
      watchdog.dispose()
      vi.useRealTimers()
    }
  })

  for (const field of ['firstProgressMs', 'idleProgressMs']) {
    it.each([0, -1, 0.5, 2_147_483_648, NaN, Infinity, -Infinity, '90000'])(
      `rejects invalid ${field}: %s`,
      (value) => {
        expect(() => Config({ executionLimits: { [field]: value } })).toThrow()
      },
    )
  }
})
