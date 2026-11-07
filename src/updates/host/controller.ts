/** One Host owns release discovery, prepared-update state and the check schedule. */
import type {
  OplUpdateApi,
  OplUpdatePolicy,
  OplUpdateRelease,
  OplUpdateRestart,
  OplUpdateStatus,
} from '../contracts.ts'
import { defaultUpdatePolicy, IdleUpdateCoordinator, updatePolicy } from './idle.ts'

export interface InstalledUpdateIdentity {
  suiteVersion: string
  officialVersion: string
  localCandidate?: boolean
}

export interface UpdateOperations {
  installed(): Promise<InstalledUpdateIdentity>
  automatic(): boolean
  saveAutomatic(enabled: boolean): Promise<void>
  load(): Promise<unknown>
  save(status: OplUpdateStatus): Promise<void>
  discover(current: InstalledUpdateIdentity, signal: AbortSignal): Promise<OplUpdateRelease | null>
  pending(): Promise<string | null>
  prepare(signal: AbortSignal, expectedVersion: string): Promise<void>
  cancel(): Promise<void>
  policy?(): OplUpdatePolicy
  savePolicy?(policy: OplUpdatePolicy): Promise<void>
  inspect?(): Promise<OplUpdateRestart['reason']>
  handoff?(): Promise<void>
}

const interval = 6 * 60 * 60 * 1000
const initialDelay = 15_000
const stable = /^\d+\.\d+\.\d+$/
function cached(value: unknown): Partial<OplUpdateStatus> {
  if (!value || typeof value !== 'object') return {}
  const row = value as Partial<OplUpdateStatus>
  const result: Partial<OplUpdateStatus> = {}
  for (const key of ['checkedAt', 'lastSuccessAt'] as const)
    if (typeof row[key] === 'string' && Number.isFinite(Date.parse(row[key])))
      result[key] = row[key]
  const release = row.release
  if (
    release &&
    stable.test(release.version) &&
    typeof release.officialVersion === 'string' &&
    typeof release.publishedAt === 'string' &&
    Number.isFinite(Date.parse(release.publishedAt)) &&
    release.url ===
      `https://github.com/gaofeng21cn/opl-dsh/releases/tag/opl-dsh-v${release.version}` &&
    ['enhancement', 'full-suite'].includes(release.compatibility)
  )
    result.release = release
  if (row.error === 'check-failed' || row.error === 'prepare-failed') result.error = row.error
  return result
}

/** Explicit policy controls preparation and the independently owned idle update. */
export class UpdateController implements OplUpdateApi {
  private value: OplUpdateStatus = {
    installedVersion: '',
    officialVersion: '',
    localCandidate: false,
    automatic: true,
    checking: false,
    preparing: false,
    checkedAt: null,
    lastSuccessAt: null,
    error: null,
    release: null,
    pendingVersion: null,
  }
  private readonly listeners = new Set<() => void>()
  private initialization: Promise<void> | undefined
  private checking: Promise<OplUpdateStatus> | undefined
  private preparing: Promise<OplUpdateStatus> | undefined
  private cancelling: Promise<OplUpdateStatus> | undefined
  private checkAbort: AbortController | undefined
  private prepareAbort: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private saves: Promise<void> = Promise.resolve()
  private readonly settingsWrites = new Set<Promise<void>>()
  private readonly idle: IdleUpdateCoordinator

  constructor(private readonly operations: UpdateOperations) {
    this.idle = new IdleUpdateCoordinator({
      status: () => this.value,
      prepare: () => this.prepare(),
      inspect: () => this.operations.inspect?.() ?? Promise.resolve('desktop-unavailable'),
      handoff: async () => {
        if (!this.operations.handoff) throw Error('Desktop update handoff is unavailable')
        await this.operations.handoff()
      },
      publish: (restart) => {
        if (JSON.stringify(this.value.restart) === JSON.stringify(restart)) return
        this.value.restart = restart
        this.publish()
        void this.persist().catch(() => {})
      },
    })
  }

  /** Begin delayed automatic checks after mounting; status reads never wait for the network. */
  start(): void {
    void this.initialize()
      .then(() => {
        this.schedule(initialDelay)
        this.idle.changed()
      })
      .catch(() => this.schedule(initialDelay))
  }

  private initialize(): Promise<void> {
    if (this.initialization) return this.initialization
    const work = (async () => {
      const current = await this.operations.installed()
      const raw = (await this.operations.load()) as Partial<OplUpdateStatus> | null
      const stored = cached(raw)
      this.value = {
        ...this.value,
        ...stored,
        installedVersion: current.suiteVersion,
        officialVersion: current.officialVersion,
        localCandidate: current.localCandidate === true,
        automatic: this.operations.automatic(),
        policy: this.operations.policy?.() ?? { ...defaultUpdatePolicy },
      }
      // Discovery cached for another installed package cannot assert its compatibility.
      if (
        raw?.installedVersion !== current.suiteVersion ||
        raw.officialVersion !== current.officialVersion
      )
        Object.assign(this.value, {
          release: null,
          checkedAt: null,
          lastSuccessAt: null,
          error: null,
        })
      try {
        this.value.pendingVersion = await this.operations.pending()
      } catch {
        this.value.error = 'prepare-failed'
      }
      this.publish()
    })()
    this.initialization = work
    void work.catch(() => {
      if (this.initialization === work) this.initialization = undefined
    })
    return work
  }

  private publish(): void {
    if (this.closed) return
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (_error) {
        /* One disconnected consumer cannot block the others. */
      }
    }
  }

  private persist(): Promise<void> {
    const value = structuredClone(this.value)
    this.saves = this.saves.catch(() => {}).then(() => this.operations.save(value))
    return this.saves
  }

  /** Subscribe to invalidations. The caller owns the returned disposer. */
  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async status(): Promise<OplUpdateStatus> {
    await this.initialize()
    return structuredClone(this.value)
  }

  private schedule(delay?: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed || !this.operations.automatic()) return
    const last = Date.parse(this.value.checkedAt ?? '')
    const wait =
      delay ??
      (Number.isFinite(last)
        ? Math.max(initialDelay, interval - (Date.now() - last))
        : initialDelay)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
        .catch(() => {})
        .finally(() => this.schedule())
    }, wait)
    this.timer.unref?.()
  }

  async check(): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed) throw Error('Update service is closed')
    if (this.checking) return this.checking
    const abort = (this.checkAbort = new AbortController())
    const work = (async () => {
      let succeeded = false
      this.value.checking = true
      this.publish()
      try {
        const current = await this.operations.installed()
        const release = await this.operations.discover(current, abort.signal)
        if (!this.closed && !abort.signal.aborted) {
          this.value.release = release
          succeeded = true
          this.value.error = null
        }
      } catch (_error) {
        if (!this.closed && !abort.signal.aborted) this.value.error = 'check-failed'
      } finally {
        this.value.checking = false
        if (!this.closed) {
          this.value.checkedAt = new Date().toISOString()
          if (succeeded) this.value.lastSuccessAt = this.value.checkedAt
          try {
            await this.persist()
          } catch {
            this.value.error = 'check-failed'
          }
          this.publish()
        }
      }
      return structuredClone(this.value)
    })()
    this.checking = work
    try {
      return await work
    } finally {
      this.checking = undefined
      this.checkAbort = undefined
      this.schedule()
      this.idle.changed()
    }
  }

  async setAutomatic(enabled: boolean): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed) throw Error('Update service is closed')
    const work = Promise.resolve().then(() => this.operations.saveAutomatic(enabled))
    this.settingsWrites.add(work)
    try {
      await work
    } finally {
      this.settingsWrites.delete(work)
    }
    if (this.closed) return this.status()
    this.value.automatic = enabled
    this.schedule()
    this.publish()
    return this.status()
  }

  async prepare(): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed) throw Error('Update service is closed')
    if (this.preparing) return this.preparing
    if (this.cancelling) await this.cancelling
    if (this.closed) throw Error('Update service is closed')
    if (this.preparing) return this.preparing
    if (this.value.release?.compatibility !== 'enhancement')
      throw Error('A full Suite installer is required')
    this.idle.retry()
    const expectedVersion = this.value.release.version
    const abort = (this.prepareAbort = new AbortController())
    const work = (async () => {
      this.value.preparing = true
      this.publish()
      try {
        await this.operations.prepare(abort.signal, expectedVersion)
        if (!this.closed && !abort.signal.aborted) {
          this.value.pendingVersion = await this.operations.pending()
          this.value.error = null
        }
      } catch (_error) {
        if (!this.closed && !abort.signal.aborted) this.value.error = 'prepare-failed'
      } finally {
        this.value.preparing = false
        if (!this.closed) {
          await this.persist().catch(() => {
            this.value.error = 'prepare-failed'
          })
          this.publish()
        }
      }
      return structuredClone(this.value)
    })()
    this.preparing = work
    try {
      return await work
    } finally {
      this.preparing = undefined
      this.prepareAbort = undefined
      this.idle.changed()
    }
  }

  async cancel(): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed || this.value.restart?.phase === 'handoff')
      throw Error('Update service is closing')
    if (this.cancelling) return this.cancelling
    const work = (async () => {
      this.idle.cancel()
      this.prepareAbort?.abort()
      await this.preparing
      await this.operations.cancel()
      this.value.pendingVersion = null
      this.value.error = null
      try {
        await this.persist()
      } catch {
        this.value.error = 'prepare-failed'
      }
      this.publish()
      return this.status()
    })()
    this.cancelling = work
    try {
      return await work
    } finally {
      this.cancelling = undefined
    }
  }

  /** Save the complete validated policy before changing automatic behavior. */
  async setPolicy(value: OplUpdatePolicy): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed || this.value.restart?.phase === 'handoff')
      throw Error('Update service is closing')
    const policy = updatePolicy(value)
    if (!this.operations.savePolicy) throw Error('Update settings are unavailable')
    const work = this.operations.savePolicy(policy)
    this.settingsWrites.add(work)
    try {
      await work
    } finally {
      this.settingsWrites.delete(work)
    }
    if (!this.closed) {
      this.value.policy = policy
      this.value.restart = undefined
      this.idle.postpone()
      this.publish()
    }
    return this.status()
  }

  /** Reset idle time without cancelling the verified downloaded package. */
  async postpone(): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed || this.value.restart?.phase === 'handoff')
      throw Error('Update service is closing')
    this.idle.postpone()
    await this.persist()
    return this.status()
  }

  /** Trusted Client input postpones only the idle restart. */
  async activity(): Promise<void> {
    if (this.closed) return
    this.idle.activity()
  }

  /** Publish a failed quit without retrying the same update in a loop. */
  handoffFailed(): void {
    this.idle.handoffFailed()
  }

  /** Abort owned requests and wait for their file operations before unloading. */
  async dispose(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.checkAbort?.abort()
    this.prepareAbort?.abort()
    await this.idle.dispose()
    this.publish()
    this.listeners.clear()
    await Promise.allSettled([
      this.initialization,
      this.checking,
      this.preparing,
      this.cancelling,
      this.saves,
      ...this.settingsWrites,
    ])
  }
}
