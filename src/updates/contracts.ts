/** Automatic installation never changes the official Desktop version. */
export type OplUpdateMode = 'notify' | 'on-launch' | 'idle'

/** Persisted user choice for preparing and applying compatible updates. */
export interface OplUpdatePolicy {
  mode: OplUpdateMode
  idleMinutes: number
  countdownSeconds: number
}

/** A pending restart is observable and can be postponed before handoff. */
export interface OplUpdateRestart {
  phase: 'waiting' | 'countdown' | 'handoff' | 'failed'
  dueAt: string | null
  reason:
    'busy' | 'activity-unknown' | 'other-profile' | 'desktop-unavailable' | 'update-failed' | null
}

/** Public update status contains release metadata, never local installer paths. */
export interface OplUpdateRelease {
  version: string
  officialVersion: string
  url: string
  publishedAt: string
  compatibility: 'enhancement' | 'full-suite'
}

/** Last successful discovery survives a failed or cancelled check. */
export interface OplUpdateStatus {
  installedVersion: string
  officialVersion: string
  localCandidate: boolean
  automatic: boolean
  checking: boolean
  preparing: boolean
  checkedAt: string | null
  lastSuccessAt: string | null
  error: 'check-failed' | 'prepare-failed' | null
  release: OplUpdateRelease | null
  pendingVersion: string | null
  policy?: OplUpdatePolicy
  restart?: OplUpdateRestart | undefined
}

/** Browser consumers use generated RPC through this component interface. */
export interface OplUpdateApi {
  status(): Promise<OplUpdateStatus>
  check(): Promise<OplUpdateStatus>
  setAutomatic(enabled: boolean): Promise<OplUpdateStatus>
  prepare(): Promise<OplUpdateStatus>
  cancel(): Promise<OplUpdateStatus>
  setPolicy(policy: OplUpdatePolicy): Promise<OplUpdateStatus>
  postpone(): Promise<OplUpdateStatus>
  activity(): Promise<void>
}
