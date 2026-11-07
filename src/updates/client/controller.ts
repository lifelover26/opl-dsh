/** Shared update projection for General settings and the resident sidebar notice. */
import type { OplUpdatePolicy, OplUpdateStatus } from '../contracts.ts'
import type { Config } from './config.ts'
import { observeUpdateActivity } from './activity.ts'
import { updatePolicy, validUpdatePolicy } from './policy.ts'

/** One foreground request owns the accepted status until it completes or is superseded. */
export type UpdateOperation =
  | 'status'
  | 'check'
  | 'automatic'
  | 'policy'
  | 'prepare'
  | 'cancel'
  | 'postpone'
export type UpdateFailure = `${UpdateOperation}-failed`

/** Accepted Host facts and the current Client request. */
export interface UpdateView {
  readonly status: OplUpdateStatus | null
  readonly operation: UpdateOperation | null
  readonly failure: UpdateFailure | null
  readonly connected: boolean
  /** The retained status has been read on this connection generation. */
  readonly confirmed: boolean
  /** A failed write needs an accepted read before another write. */
  readonly uncertain: boolean
}

/** One subscription and request queue shared by both Client surfaces. */
export class UpdateController {
  private view: UpdateView = {
    status: null,
    operation: null,
    failure: null,
    connected: false,
    confirmed: false,
    uncertain: false,
  }
  private active = false
  private epoch = 0
  private generation: number | undefined
  private refreshQueued = false
  private activityRequest: object | undefined
  private activityQueued = false
  private activityUrgent = false
  private activityTimer: ReturnType<typeof setTimeout> | undefined
  private lastActivityAt = -Infinity
  private activityCountdown: string | null | undefined
  private readonly listeners = new Set<() => void>()
  private readonly disposers: (() => void)[] = []

  /** @param config - Host calls, status events, and connection generation. */
  constructor(private readonly config: Config) {}

  getSnapshot = (): UpdateView => this.view

  /** @param listener - React's snapshot listener. @returns Subscription cleanup. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Subscribe before the initial read so an intervening Host change is retained. */
  start(): void {
    if (this.active) return
    this.active = true
    this.epoch += 1
    this.generation = this.config.connection?.getSnapshot()
    this.setView({
      operation: null,
      connected: !this.config.connection || this.generation !== undefined,
      confirmed: false,
    })
    if (this.config.connection) {
      this.disposers.push(
        this.config.connection.subscribe(() => {
          const next = this.config.connection!.getSnapshot()
          if (next === this.generation) return
          this.generation = next
          this.epoch += 1
          this.refreshQueued = false
          this.clearActivity()
          this.setView({ operation: null, connected: next !== undefined, confirmed: false })
          if (next !== undefined) {
            this.recordActivity()
            this.refresh()
          }
        }),
      )
    }
    if (this.config.subscribe) this.disposers.push(this.config.subscribe(() => this.refresh()))
    this.disposers.push(observeUpdateActivity(this.recordActivity, () => this.stop()))
    this.recordActivity()
    this.refresh()
  }

  /** Release observers and ignore every response from this mount. */
  stop(): void {
    this.active = false
    this.epoch += 1
    this.refreshQueued = false
    this.clearActivity()
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    this.setView({ operation: null, connected: false, confirmed: false })
  }

  /** Coalesce Host changes during an RPC into one subsequent status read. */
  refresh(): void {
    if (!this.active || !this.view.connected) return
    if (this.view.operation) {
      this.refreshQueued = true
      return
    }
    void this.run('status', () => this.config.api.status())
  }

  /** @returns Completion of an explicit update check. */
  async check(): Promise<void> {
    if (!this.available()) return
    await this.run('check', () => this.config.api.check())
  }

  /** @param enabled - Requested automatic-check preference. @returns Accepted result. */
  async setAutomatic(enabled: boolean): Promise<void> {
    if (!this.writable() || this.view.status!.automatic === enabled) return
    await this.run('automatic', () => this.config.api.setAutomatic(enabled))
  }

  /** @param policy - Mode and timing preferences. @returns Completion after acceptance or a reported failure. */
  async setPolicy(policy: OplUpdatePolicy): Promise<void> {
    if (!this.writable() || !validUpdatePolicy(policy)) return
    const current = updatePolicy(this.view.status)
    if (
      current.mode === policy.mode &&
      current.idleMinutes === policy.idleMinutes &&
      current.countdownSeconds === policy.countdownSeconds
    )
      return
    await this.run('policy', () => this.config.api.setPolicy(policy))
  }

  /** Prepare only the explicitly selected compatible release, including local candidates. */
  async prepare(): Promise<void> {
    if (
      !this.writable() ||
      this.view.status!.release?.compatibility !== 'enhancement' ||
      this.view.status!.pendingVersion !== null
    )
      return
    await this.run('prepare', () => this.config.api.prepare())
  }

  /** @returns Whether a download or prepared update can be cancelled now. */
  canCancel(): boolean {
    return (
      this.active &&
      this.view.connected &&
      this.view.confirmed &&
      !this.view.uncertain &&
      this.view.status?.restart?.phase !== 'handoff' &&
      (this.view.operation === null ||
        this.view.operation === 'prepare' ||
        (this.view.operation === 'status' &&
          Boolean(this.view.status?.preparing || this.view.status?.pendingVersion))) &&
      (this.view.operation === 'prepare' ||
        Boolean(this.view.status?.preparing) ||
        Boolean(this.view.status?.pendingVersion))
    )
  }

  /** Cancel a download or prepared update without exiting or restarting the app. */
  async cancel(): Promise<void> {
    if (!this.canCancel()) return
    this.epoch += 1
    this.refreshQueued = false
    await this.run('cancel', () => this.config.api.cancel())
  }

  /** @returns Whether an observed countdown can be postponed before handoff. */
  canPostpone(): boolean {
    return (
      this.active &&
      this.view.connected &&
      this.view.confirmed &&
      !this.view.uncertain &&
      (this.view.operation === null ||
        this.view.operation === 'status' ||
        this.view.operation === 'check') &&
      this.view.status?.restart?.phase === 'countdown'
    )
  }

  /** Keep the prepared version and restart the Host's idle waiting period. */
  async postpone(): Promise<void> {
    if (!this.canPostpone()) return
    this.epoch += 1
    this.refreshQueued = false
    await this.run('postpone', () => this.config.api.postpone())
  }

  /** Coalesce real input; the first interaction in an observed countdown bypasses throttling. */
  private recordActivity = (): void => {
    if (!this.active || !this.view.connected) return
    this.activityQueued = true
    const restart = this.view.status?.restart
    if (
      this.view.confirmed &&
      restart?.phase === 'countdown' &&
      restart.dueAt !== this.activityCountdown
    )
      this.activityUrgent = true
    this.flushActivity()
  }

  private flushActivity(): void {
    if (!this.active || !this.view.connected || !this.activityQueued || this.activityRequest) return
    if (this.activityTimer !== undefined) clearTimeout(this.activityTimer)
    this.activityTimer = undefined
    const delay = this.activityUrgent ? 0 : Math.max(0, this.lastActivityAt + 10_000 - Date.now())
    if (delay > 0) {
      this.activityTimer = setTimeout(() => {
        this.activityTimer = undefined
        this.flushActivity()
      }, delay)
      return
    }
    const request = {}
    this.activityRequest = request
    this.activityQueued = false
    this.activityUrgent = false
    this.lastActivityAt = Date.now()
    this.activityCountdown = this.view.confirmed ? this.view.status?.restart?.dueAt : undefined
    void (async () => {
      try {
        await this.config.api.activity()
      } catch (_error) {
        // Activity never confirms settings or schedules a status read; the Host owns restart state.
      } finally {
        if (this.activityRequest !== request) return
        this.activityRequest = undefined
        this.flushActivity()
      }
    })()
  }

  private clearActivity(): void {
    if (this.activityTimer !== undefined) clearTimeout(this.activityTimer)
    this.activityTimer = undefined
    this.activityRequest = undefined
    this.activityQueued = false
    this.activityUrgent = false
    this.lastActivityAt = -Infinity
    this.activityCountdown = undefined
  }

  private available(): boolean {
    return (
      this.active &&
      this.view.connected &&
      !this.view.operation &&
      !this.view.status?.checking &&
      !this.view.status?.preparing &&
      this.view.status?.restart?.phase !== 'handoff'
    )
  }

  private writable(): boolean {
    return (
      this.available() && this.view.confirmed && this.view.status !== null && !this.view.uncertain
    )
  }

  private async run(
    operation: UpdateOperation,
    request: () => Promise<OplUpdateStatus>,
  ): Promise<void> {
    const epoch = this.epoch
    this.setView({ operation })
    try {
      const status = await request()
      if (!this.active || epoch !== this.epoch) return
      this.setView({ status, operation: null, failure: null, uncertain: false, confirmed: true })
    } catch (_error) {
      // Transport errors can contain local paths; only fixed labels reach the view.
      if (!this.active || epoch !== this.epoch) return
      this.setView({
        operation: null,
        failure: `${operation}-failed`,
        uncertain: operation !== 'status' && operation !== 'check' ? true : this.view.uncertain,
      })
    }
    if (!this.active || epoch !== this.epoch || !this.refreshQueued) return
    this.refreshQueued = false
    this.refresh()
  }

  private setView(patch: Partial<UpdateView>): void {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }
}
