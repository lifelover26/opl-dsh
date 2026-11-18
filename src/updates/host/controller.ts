/** One Host owns release discovery, prepared-update state and the check schedule. */
import type {
  OplUpdateApi,
  OplUpdateError,
  OplUpdateFailure,
  OplUpdatePolicy,
  OplUpdateRelease,
  OplUpdateRestart,
  OplUpdateStatus,
} from '../contracts.ts'
import { describeUpdateFailure } from '../../../installer/update-errors.mjs'
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
  armPending?(): Promise<void>
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

const persistedErrors = new Set<Exclude<OplUpdateError, null>>([
  'check-failed',
  'prepare-failed',
  'prepare-network-failed',
  'prepare-proxy-failed',
  'prepare-timeout',
  'prepare-http-failed',
  'prepare-integrity-failed',
  'prepare-lock-failed',
  'prepare-installation-failed',
])

const failureStages = new Set<OplUpdateFailure['stage']>([
  'acquire',
  'installation',
  'discovery',
  'download',
  'verify',
  'stage',
  'confirm',
  'cancel',
  'apply',
  'save',
])
const failureReasons = new Set<OplUpdateFailure['reason']>([
  'network',
  'proxy',
  'timeout',
  'http',
  'integrity',
  'busy',
  'installation',
  'release-changed',
  'filesystem',
  'unknown',
])

function validFailure(value: unknown): value is OplUpdateFailure {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<OplUpdateFailure>
  if (!failureStages.has(row.stage as OplUpdateFailure['stage'])) return false
  if (!failureReasons.has(row.reason as OplUpdateFailure['reason'])) return false
  if (
    row.httpStatus !== undefined &&
    (!Number.isInteger(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599)
  )
    return false
  if (
    row.systemCode !== undefined &&
    (typeof row.systemCode !== 'string' || !/^[A-Z][A-Z0-9_-]{1,63}$/u.test(row.systemCode))
  )
    return false
  return true
}

function errorForFailure(failure: OplUpdateFailure): Exclude<OplUpdateError, null> {
  switch (failure.reason) {
    case 'proxy':
      return 'prepare-proxy-failed'
    case 'network':
      return 'prepare-network-failed'
    case 'timeout':
      return 'prepare-timeout'
    case 'http':
      return 'prepare-http-failed'
    case 'integrity':
    case 'release-changed':
      return 'prepare-integrity-failed'
    case 'busy':
      return 'prepare-lock-failed'
    case 'installation':
    case 'filesystem':
      return 'prepare-installation-failed'
    default:
      return 'prepare-failed'
  }
}

/** Map updater exceptions to a fixed, non-sensitive status category. */
export function classifyPrepareFailure(error: unknown): Exclude<OplUpdateError, null> {
  const details = describeUpdateFailure(error, 'download') as OplUpdateFailure
  if (validFailure(details) && details.reason !== 'unknown') return errorForFailure(details)
  const row =
    error && typeof error === 'object'
      ? (error as { code?: unknown; message?: unknown; cause?: unknown })
      : {}
  const code = typeof row.code === 'string' ? row.code.toLowerCase() : ''
  const message =
    typeof row.message === 'string' ? row.message.toLowerCase() : String(error).toLowerCase()
  const cause =
    row.cause && typeof row.cause === 'object'
      ? String((row.cause as { code?: unknown }).code ?? '').toLowerCase()
      : ''
  const text = `${code} ${cause} ${message}`
  if (text.includes('timeout') || text.includes('timed out') || code === 'etimedout')
    return 'prepare-timeout'
  if (
    /http\s+\d{3}/u.test(text) ||
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('socket') ||
    /\beconn|\benet|\bund_err_/u.test(text)
  )
    return /http\s+\d{3}/u.test(text) ? 'prepare-http-failed' : 'prepare-network-failed'
  if (text.includes('proxy')) return 'prepare-proxy-failed'
  if (
    text.includes('sha-256') ||
    text.includes('校验') ||
    text.includes('摘要') ||
    text.includes('增强 zip') ||
    text.includes('增强包') ||
    text.includes('清单')
  )
    return 'prepare-integrity-failed'
  if (
    text.includes('更新锁') ||
    text.includes('更新正在进行') ||
    text.includes('无法取得增强更新锁') ||
    text.includes('suite-operation-busy')
  )
    return 'prepare-lock-failed'
  if (
    text.includes('安装回执') ||
    text.includes('原安装') ||
    text.includes('官方桌面') ||
    text.includes('协议') ||
    text.includes('兼容') ||
    text.includes('版本不符')
  )
    return 'prepare-installation-failed'
  return 'prepare-failed'
}

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
  if (
    typeof row.error === 'string' &&
    persistedErrors.has(row.error as Exclude<OplUpdateError, null>)
  )
    result.error = row.error as OplUpdateError
  if (validFailure(row.failure)) result.failure = row.failure
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
    failure: null,
    release: null,
    pendingVersion: null,
  }
  private readonly listeners = new Set<() => void>()
  private initialization: Promise<void> | undefined
  private checking: Promise<OplUpdateStatus> | undefined
  private preparing: Promise<OplUpdateStatus> | undefined
  private cancelling: Promise<OplUpdateStatus> | undefined
  private applying: Promise<OplUpdateStatus> | undefined
  private applyEpoch = 0
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
          failure: null,
        })
      try {
        this.value.pendingVersion = await this.operations.pending()
        if (this.value.pendingVersion) await this.operations.armPending?.()
      } catch {
        this.value.error = 'prepare-failed'
        this.value.failure = { stage: 'acquire', reason: 'filesystem' }
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
    if (this.closed || this.value.restart?.phase === 'handoff')
      throw Error('Update service is closing')
    if (this.checking) return this.checking
    this.applyEpoch++
    this.idle.changed()
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
          this.value.failure = null
        }
      } catch (_error) {
        if (!this.closed && !abort.signal.aborted) {
          this.value.error = 'check-failed'
          this.value.failure = describeUpdateFailure(_error, 'discovery')
        }
      } finally {
        this.value.checking = false
        if (!this.closed) {
          this.value.checkedAt = new Date().toISOString()
          if (succeeded) this.value.lastSuccessAt = this.value.checkedAt
          try {
            await this.persist()
          } catch {
            this.value.error = 'check-failed'
            this.value.failure = { stage: 'save', reason: 'filesystem' }
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
    this.assertOpen()
    if (this.preparing) return this.preparing
    if (this.cancelling) await this.cancelling
    this.assertOpen()
    if (this.preparing) return this.preparing
    if (this.value.release?.compatibility !== 'enhancement')
      throw Error('A full Suite installer is required')
    this.idle.retry()
    const expectedVersion = this.value.release.version
    const abort = (this.prepareAbort = new AbortController())
    const work = (async () => {
      this.value.preparing = true
      // A new attempt supersedes the previous failure; do not display stale red text while downloading.
      this.value.error = null
      this.value.failure = null
      this.publish()
      try {
        await this.operations.prepare(abort.signal, expectedVersion)
        if (!this.closed && !abort.signal.aborted) {
          this.value.pendingVersion = await this.operations.pending()
          if (this.value.pendingVersion) await this.operations.armPending?.()
          this.value.error = null
          this.value.failure = null
        }
      } catch (_error) {
        if (!this.closed && !abort.signal.aborted) {
          this.value.failure = describeUpdateFailure(_error, 'download')
          this.value.error = errorForFailure(this.value.failure)
        }
      } finally {
        this.value.preparing = false
        if (!this.closed) {
          await this.persist().catch(() => {
            this.value.error = 'prepare-failed'
            this.value.failure = { stage: 'save', reason: 'filesystem' }
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

  private assertOpen(): void {
    if (this.closed || this.value.restart?.phase === 'handoff')
      throw Error('Update service is closing')
  }

  /** Prepare the displayed version and request one immediate, idle-only restart. */
  async applyNow(): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed || this.value.restart?.phase === 'handoff')
      throw Error('Update service is closing')
    if (this.value.localCandidate)
      throw Error('Local candidate builds require a full Suite installer')
    if (this.applying) return this.applying
    const work = (async () => {
      // Discovery and cancellation are owned lifecycle operations. Join them before
      // selecting a release instead of rejecting a concurrent explicit request.
      await this.checking
      await this.cancelling
      if (this.closed || this.value.restart?.phase === 'handoff')
        throw Error('Update service is closing')
      if (this.value.release?.compatibility !== 'enhancement')
        throw Error('A full Suite installer is required')
      const version = this.value.release.version
      const epoch = ++this.applyEpoch
      if (this.value.pendingVersion && this.value.pendingVersion !== version) {
        this.value.error = 'prepare-integrity-failed'
        this.value.failure = { stage: 'confirm', reason: 'release-changed' }
        await this.persist().catch(() => {})
        this.publish()
        return structuredClone(this.value)
      }
      if (this.value.pendingVersion !== version) await this.prepare()
      if (this.closed || this.applyEpoch !== epoch) return structuredClone(this.value)
      if (this.value.pendingVersion !== version) {
        this.value.error ??= 'prepare-failed'
        this.value.failure ??= { stage: 'confirm', reason: 'unknown' }
        await this.persist().catch(() => {})
        this.publish()
        return structuredClone(this.value)
      }
      if (
        this.checking ||
        this.cancelling ||
        this.value.release?.version !== version ||
        this.value.release.compatibility !== 'enhancement'
      )
        return structuredClone(this.value)
      await this.idle.applyNow(version)
      return structuredClone(this.value)
    })()
    this.applying = work
    try {
      return await work
    } finally {
      if (this.applying === work) this.applying = undefined
    }
  }

  async cancel(): Promise<OplUpdateStatus> {
    await this.initialize()
    if (this.closed || this.value.restart?.phase === 'handoff')
      throw Error('Update service is closing')
    if (this.cancelling) return this.cancelling
    this.applyEpoch++
    const work = (async () => {
      this.idle.cancel()
      this.prepareAbort?.abort()
      await this.preparing
      await this.operations.cancel()
      this.value.pendingVersion = null
      this.value.error = null
      this.value.failure = null
      try {
        await this.persist()
      } catch {
        this.value.error = 'prepare-failed'
        this.value.failure = { stage: 'save', reason: 'filesystem' }
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
    this.applyEpoch++
    this.idle.changed()
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
    this.applyEpoch++
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
    this.applyEpoch++
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
      this.applying,
      this.saves,
      ...this.settingsWrites,
    ])
  }
}
