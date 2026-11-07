/** Coordinates preparation and an idle restart without owning task execution. */
import type { OplUpdatePolicy, OplUpdateRestart, OplUpdateStatus } from '../contracts.ts'

export const defaultUpdatePolicy: OplUpdatePolicy = {
  mode: 'notify',
  idleMinutes: 5,
  countdownSeconds: 30,
}

/** Validate preferences received from durable settings or a remote caller. */
export function updatePolicy(value: unknown): OplUpdatePolicy {
  const row = value as Partial<OplUpdatePolicy> | null
  if (
    !row ||
    !['notify', 'on-launch', 'idle'].includes(row.mode ?? '') ||
    !Number.isInteger(row.idleMinutes) ||
    row.idleMinutes! < 1 ||
    row.idleMinutes! > 120 ||
    !Number.isInteger(row.countdownSeconds) ||
    row.countdownSeconds! < 15 ||
    row.countdownSeconds! > 300
  )
    throw Error('Invalid update policy')
  return { mode: row.mode!, idleMinutes: row.idleMinutes!, countdownSeconds: row.countdownSeconds! }
}

export interface IdleUpdateOperations {
  status(): OplUpdateStatus
  prepare(): Promise<unknown>
  inspect(): Promise<OplUpdateRestart['reason']>
  handoff(): Promise<void>
  publish(restart: OplUpdateRestart | undefined): void
}

/** Input and busy work reset idle time; only one accepted release can enter handoff. */
export class IdleUpdateCoordinator {
  private timer: ReturnType<typeof setTimeout> | undefined
  private work: Promise<void> | undefined
  private closed = false
  private epoch = 0
  private lastActivity = Date.now()
  private dueAt: number | undefined
  private failedVersion: string | undefined
  private handedOff = false
  private handingOff = false

  constructor(private readonly operations: IdleUpdateOperations) {}

  /** Schedule from actual state changes, coalescing an in-flight inspection. */
  changed(): void {
    if (this.closed || this.handedOff || this.handingOff) return
    this.epoch++
    this.schedule(0)
  }

  /** A real user action restarts the complete idle interval. */
  activity(): void {
    if (this.closed || this.handedOff || this.handingOff) return
    this.lastActivity = Date.now()
    this.dueAt = undefined
    this.operations.publish(undefined)
    this.changed()
  }

  /** Explicit postponement permits a later attempt after the complete idle interval. */
  postpone(): void {
    if (this.handedOff || this.handingOff) throw Error('Update handoff has already begun')
    this.failedVersion = undefined
    this.activity()
  }

  /** Cancel the current automatic attempt without immediately preparing it again. */
  cancel(): void {
    if (this.closed || this.handedOff || this.handingOff) return
    const state = this.operations.status()
    const version = state.release?.version ?? state.pendingVersion
    if (version) this.failedVersion = version
    this.lastActivity = Date.now()
    this.dueAt = undefined
    this.epoch++
    this.operations.publish(undefined)
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Permit an explicit manual prepare after a previous automatic cancellation. */
  retry(): void {
    if (this.closed || this.handedOff || this.handingOff) return
    const version = this.operations.status().release?.version
    if (version && this.failedVersion === version) this.failedVersion = undefined
    this.changed()
  }

  /** A launcher that could not complete quit must leave the current Host usable. */
  handoffFailed(): void {
    if (this.closed) return
    this.handedOff = false
    this.handingOff = false
    const version =
      this.operations.status().pendingVersion ?? this.operations.status().release?.version
    if (version) this.fail(version)
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.closed || this.handedOff || this.handingOff) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.work) {
        this.schedule(1000)
        return
      }
      this.work = this.advance().finally(() => {
        this.work = undefined
      })
      void this.work.catch(() => {})
    }, ms)
    this.timer.unref?.()
  }

  private async advance(): Promise<void> {
    const state = this.operations.status()
    const policy = state.policy ?? defaultUpdatePolicy
    if (
      policy.mode === 'notify' ||
      state.localCandidate ||
      !state.release ||
      state.release.compatibility !== 'enhancement'
    ) {
      this.dueAt = undefined
      this.operations.publish(undefined)
      return
    }
    const version = state.release.version
    if (this.failedVersion === version) return
    const epoch = this.epoch
    if (state.pendingVersion && state.pendingVersion !== version) {
      this.fail(version)
      return
    }
    if (state.pendingVersion !== version) {
      if (state.preparing || state.checking) return
      try {
        await this.operations.prepare()
      } catch {
        if (!this.closed) this.fail(version)
        return
      }
      if (!this.closed && this.operations.status().pendingVersion !== version) {
        this.fail(version)
        return
      }
      if (this.closed || epoch !== this.epoch) return
    }
    if (policy.mode !== 'idle') return
    let reason: OplUpdateRestart['reason']
    try {
      reason = await this.operations.inspect()
    } catch {
      reason = 'activity-unknown'
    }
    if (this.closed || epoch !== this.epoch) return
    if (reason) {
      this.dueAt = undefined
      this.lastActivity = Date.now()
      this.operations.publish({ phase: 'waiting', dueAt: null, reason })
      this.schedule(30_000)
      return
    }
    const idleUntil = this.lastActivity + policy.idleMinutes * 60_000
    if (Date.now() < idleUntil) {
      this.operations.publish({ phase: 'waiting', dueAt: null, reason: null })
      this.schedule(idleUntil - Date.now())
      return
    }
    this.dueAt ??= Date.now() + policy.countdownSeconds * 1000
    if (Date.now() < this.dueAt) {
      this.operations.publish({
        phase: 'countdown',
        dueAt: new Date(this.dueAt).toISOString(),
        reason: null,
      })
      this.schedule(this.dueAt - Date.now())
      return
    }
    this.handingOff = true
    this.operations.publish({ phase: 'handoff', dueAt: null, reason: null })
    try {
      await this.operations.handoff()
      this.handedOff = true
    } catch {
      if (!this.closed) this.fail(version)
    } finally {
      this.handingOff = false
    }
  }

  private fail(version: string): void {
    this.failedVersion = version
    this.operations.publish({ phase: 'failed', dueAt: null, reason: 'update-failed' })
  }

  /** Stop scheduling and await the already owned inspection or handoff. */
  async dispose(): Promise<void> {
    this.closed = true
    this.epoch++
    if (this.timer) clearTimeout(this.timer)
    await this.work?.catch(() => {})
  }
}
