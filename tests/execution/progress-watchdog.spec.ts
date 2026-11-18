import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProgressWatchdog } from '../../src/execution/host/progress-watchdog.js'

const limits = { enabled: true, firstProgressMs: 100, idleProgressMs: 50 }

describe('ProgressWatchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts the first-progress deadline only at execution start', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    watchdog.progress()
    vi.advanceTimersByTime(1000)
    expect(expire).not.toHaveBeenCalled()
    watchdog.start()
    vi.advanceTimersByTime(99)
    watchdog.start()
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledExactlyOnceWith('first-progress')
    vi.runAllTimers()
    expect(expire).toHaveBeenCalledTimes(1)
  })

  it('refreshes idle time on useful progress', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    watchdog.start()
    vi.advanceTimersByTime(90)
    watchdog.progress()
    vi.advanceTimersByTime(40)
    watchdog.progress()
    vi.advanceTimersByTime(49)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledExactlyOnceWith('idle-progress')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows continuous progress beyond an hour and still expires on later silence', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(
      { enabled: true, firstProgressMs: 90_000, idleProgressMs: 90_000 },
      expire,
    )
    watchdog.start()
    for (let i = 0; i < 90; i++) {
      vi.advanceTimersByTime(60_000)
      watchdog.progress()
    }
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(90_000)
    expect(expire).toHaveBeenCalledExactlyOnceWith('idle-progress')
  })

  it('preserves remaining first-progress time across a human wait', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    watchdog.start()
    vi.advanceTimersByTime(70)
    watchdog.pause()
    watchdog.pause()
    vi.advanceTimersByTime(10000)
    watchdog.progress()
    expect(expire).not.toHaveBeenCalled()
    watchdog.resume()
    watchdog.resume()
    vi.advanceTimersByTime(29)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledExactlyOnceWith('first-progress')
  })

  it('resets inactivity after new progress following a human wait', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    watchdog.start()
    vi.advanceTimersByTime(50)
    watchdog.pause()
    vi.advanceTimersByTime(3_600_000)
    watchdog.resume()
    watchdog.progress()
    vi.advanceTimersByTime(49)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledExactlyOnceWith('idle-progress')
  })

  it('allows a long active tool and resumes the remaining inactivity budget', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    watchdog.start()
    vi.advanceTimersByTime(40)
    watchdog.pauseIdle()
    watchdog.pauseIdle()
    vi.advanceTimersByTime(86_400_000)
    expect(expire).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    watchdog.resumeIdle()
    vi.advanceTimersByTime(59)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledExactlyOnceWith('first-progress')
  })

  it('preserves independent tool and human pauses', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    watchdog.start()
    vi.advanceTimersByTime(40)
    watchdog.pauseIdle()
    vi.advanceTimersByTime(100)
    watchdog.pause()
    vi.advanceTimersByTime(10000)
    watchdog.resume()
    vi.advanceTimersByTime(100)
    expect(expire).not.toHaveBeenCalled()
    watchdog.resumeIdle()
    watchdog.resumeIdle()
    vi.advanceTimersByTime(59)
    expect(expire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expire).toHaveBeenCalledExactlyOnceWith('first-progress')
  })

  it('can end a tool pause during a human wait without restarting timers', () => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    watchdog.start()
    vi.advanceTimersByTime(40)
    watchdog.pause()
    watchdog.pauseIdle()
    watchdog.resumeIdle()
    vi.advanceTimersByTime(10000)
    expect(expire).not.toHaveBeenCalled()
    watchdog.resume()
    vi.advanceTimersByTime(60)
    expect(expire).toHaveBeenCalledExactlyOnceWith('first-progress')
  })

  it.each([false, true])('disposal prevents late callbacks (started: %s)', (started) => {
    const expire = vi.fn()
    const watchdog = new ProgressWatchdog(limits, expire)
    if (started) watchdog.start()
    watchdog.dispose()
    watchdog.start()
    watchdog.progress()
    vi.runAllTimers()
    expect(expire).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['firstProgressMs', 'idleProgressMs'] as const)('rejects invalid %s', (field) => {
    for (const value of [0, -1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648]) {
      expect(() => new ProgressWatchdog({ ...limits, [field]: value }, vi.fn())).toThrow(RangeError)
    }
  })
})

it('never schedules OPL cancellation while disabled, including across progress and pause/resume', () => {
  vi.useFakeTimers()
  const expire = vi.fn()
  const watchdog = new ProgressWatchdog(
    { enabled: false, firstProgressMs: 1, idleProgressMs: 1 },
    expire,
  )
  watchdog.start()
  watchdog.progress()
  watchdog.pause()
  watchdog.resume()
  watchdog.pauseIdle()
  watchdog.resumeIdle()
  vi.advanceTimersByTime(1_000_000)
  expect(expire).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  watchdog.dispose()
  vi.useRealTimers()
})
