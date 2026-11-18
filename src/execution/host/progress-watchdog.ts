/** Bounds gaps between caller-recognized useful progress, never total task duration. */
import type { ExecutionLimits } from '../contracts/limits.ts'
export type ProgressWatchdogLimits = ExecutionLimits

/** Inactivity deadline that ended an execution. */
export type ProgressExpiryReason = 'first-progress' | 'idle-progress'

/** Pauses inactivity time during active tools and explicitly surfaced human waits. */
export class ProgressWatchdog {
  private readonly limits: ProgressWatchdogLimits
  private started = false
  private idlePaused = false
  private paused = false
  private progressReason: ProgressExpiryReason = 'first-progress'
  private progressRemaining = 0
  private armedAt = 0
  private disposed = false
  private progressTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    limits: ProgressWatchdogLimits,
    private readonly onExpire: (reason: ProgressExpiryReason) => void,
  ) {
    this.limits = {
      enabled: limits.enabled,
      firstProgressMs: limits.firstProgressMs,
      idleProgressMs: limits.idleProgressMs,
    }
    for (const [name, value] of Object.entries({
      firstProgressMs: limits.firstProgressMs,
      idleProgressMs: limits.idleProgressMs,
    })) {
      if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647)
        throw new RangeError(`${name} must be a positive integer timer duration`)
    }
  }

  /** Starts the first-progress deadline when execution begins. Repeated calls do nothing. */
  start(): void {
    if (this.started || this.disposed || !this.limits.enabled) return
    this.started = true
    this.progressRemaining = this.limits.firstProgressMs
    this.arm()
  }

  /** Records useful output or tool activity; callers exclude empty output and heartbeats. */
  progress(): void {
    if (!this.started || this.disposed || this.paused) return
    clearTimeout(this.progressTimer)
    this.progressRemaining = this.limits.idleProgressMs
    this.progressReason = 'idle-progress'
    this.arm()
  }

  /** Excludes an explicitly surfaced human wait from inactivity time. */
  pause(): void {
    if (!this.started || this.disposed || this.paused) return
    if (!this.idlePaused) this.captureRemaining()
    this.paused = true
    clearTimeout(this.progressTimer)
  }

  /** Continues the remaining budget after the human wait ends. */
  resume(): void {
    if (!this.started || this.disposed || !this.paused) return
    this.paused = false
    this.arm()
  }

  /** Suspends inactivity time while a tool is active. */
  pauseIdle(): void {
    if (!this.started || this.disposed || this.idlePaused) return
    if (!this.paused) this.captureRemaining()
    this.idlePaused = true
    clearTimeout(this.progressTimer)
  }

  /** Continues the remaining inactivity budget when active tools finish. */
  resumeIdle(): void {
    if (!this.started || this.disposed || !this.idlePaused) return
    this.idlePaused = false
    this.arm()
  }

  private captureRemaining(): void {
    this.progressRemaining = Math.max(
      0,
      this.progressRemaining - Math.max(0, performance.now() - this.armedAt),
    )
  }

  private arm(): void {
    if (this.paused || this.idlePaused) return
    this.armedAt = performance.now()
    this.progressTimer = setTimeout(() => this.expire(this.progressReason), this.progressRemaining)
  }

  /** Cancels the deadline and prevents future expiration callbacks. */
  dispose(): void {
    this.disposed = true
    clearTimeout(this.progressTimer)
  }

  private expire(reason: ProgressExpiryReason): void {
    if (this.disposed) return
    this.dispose()
    this.onExpire(reason)
  }
}
