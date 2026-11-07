/** Remote update status uses an owned stream instead of polling the Client. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OplUpdatePolicy, OplUpdateStatus } from '../contracts.ts'
import { UpdateController } from './controller.ts'
import { updateOperations } from './runtime.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplUpdates: UpdateService
  }
}

/** Background checks never replace the active Desktop or its plugins. */
export class UpdateService extends TypertRemoteService {
  static inject = ['settings', 'oplUpdateRuntime']
  private readonly controller: UpdateController
  private readonly shutdown = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'oplUpdates')
    this.controller = new UpdateController(updateOperations(ctx))
    ctx.effect(() => {
      const offFailure = ctx.oplUpdateRuntime.onFailure(() => this.controller.handoffFailed())
      this.controller.start()
      return async () => {
        offFailure()
        this.shutdown.abort()
        await this.controller.dispose()
        ctx.oplUpdateRuntime.drained('controller')
      }
    })
  }

  /** Read local state without waiting for the release server. */
  @Remote('status')
  status(): Promise<OplUpdateStatus> {
    return this.controller.status()
  }

  /** Check the stable release metadata; simultaneous checks share one request. */
  @Remote('check')
  check(): Promise<OplUpdateStatus> {
    return this.controller.check()
  }

  /** @param enabled - Whether the Host checks after startup and every six hours. */
  @Remote('automatic')
  automatic(enabled: boolean): Promise<OplUpdateStatus> {
    return this.controller.setAutomatic(enabled)
  }

  /** Download and verify the explicitly chosen update for the next stopped launch. */
  @Remote('prepare')
  prepare(): Promise<OplUpdateStatus> {
    return this.controller.prepare()
  }

  /** Cancel a download or prepared update without removing the installed release. */
  @Remote('cancel')
  cancel(): Promise<OplUpdateStatus> {
    return this.controller.cancel()
  }

  /** Persist the explicitly chosen compatible-update policy. */
  @Remote('policy')
  policy(policy: OplUpdatePolicy): Promise<OplUpdateStatus> {
    return this.controller.setPolicy(policy)
  }

  /** Keep the downloaded package and restart the idle interval. */
  @Remote('postpone')
  postpone(): Promise<OplUpdateStatus> {
    return this.controller.postpone()
  }

  /** Actual Client input postpones an idle restart. */
  @Remote('activity')
  activity(): Promise<void> {
    return this.controller.activity()
  }

  /** Publish state invalidations until this caller disconnects or the plugin unloads. */
  @Remote({ name: 'watch', mode: 'stream' })
  async *watch(): AsyncIterable<OplUpdateStatus> {
    const signals = [this.shutdown.signal, this.ctx.invocation?.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    )
    const signal = AbortSignal.any(signals)
    let dirty = true
    let wake: (() => void) | undefined
    const notify = () => {
      dirty = true
      wake?.()
    }
    const off = this.controller.subscribe(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!signal.aborted) {
        if (!dirty)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        wake = undefined
        if (signal.aborted) break
        dirty = false
        yield await this.controller.status()
      }
    } finally {
      off()
      signal.removeEventListener('abort', notify)
    }
  }
}
