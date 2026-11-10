/** Validated request budgets shared by the Host and settings form. */
export const AUTO_REVIEW_BUDGET_RANGE = {
  timeoutMs: { min: 1000, max: 60000 },
  maxOutputTokens: { min: 64, max: 32768 },
} as const

/** User-selected native LLM review settings; no credential values cross this API. */
export interface AutoReviewRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** OPL routing/bridge is off by default; the official Auto plugin owns native permissions. */
export interface AutoReviewPreferences {
  enabled: boolean
  reviewer:
    | { mode: 'current' }
    | { mode: 'fixed'; route: AutoReviewRoute }
    | { mode: 'decision'; route: AutoReviewRoute }
  timeoutMs: number
  maxOutputTokens: number
}

/** One advertised, registered pure-LLM route eligible for a tool-free review request. */
export interface AutoReviewRouteOption {
  provider: string
  providerName: string
  model: string
  modelName: string
  /** Decision routes return the closed allow/deny protocol directly. */
  kind?: 'reviewer' | 'decision'
  efforts: string[]
  defaultEffort: string | null
}

/** Safe failure labels contain neither provider errors nor reviewer reasoning. */
export type AutoReviewFailure =
  | 'unavailable'
  | 'invalid-settings'
  | 'stale-settings'
  | 'sessions-active'
  /** Compatibility with older Hosts; the current adapter does not emit this refusal. */
  | 'auto-sessions-remain'
  | 'save-failed'

/** Detached process settings and readiness, separate from a Session's selected permission. */
export interface AutoReviewStatus {
  preferences: AutoReviewPreferences
  revision: string
  state: 'disabled' | 'ready' | 'unavailable' | 'draining'
  routes: AutoReviewRouteOption[]
  activeReviews: number
  autoSessions: number
  failure: AutoReviewFailure | null
}

/** A save compares the last read revision; the Host revalidates all route and lifecycle facts. */
export interface AutoReviewSaveRequest {
  expectedRevision: string
  preferences: AutoReviewPreferences
}

/** Rejected writes preserve current settings and expose only fixed failure labels. */
export type AutoReviewSaveResult =
  | { ok: true; status: AutoReviewStatus }
  | { ok: false; failure: AutoReviewFailure; status: AutoReviewStatus }

/** Injectable Client calls are backed by generated Remote methods in the suite. */
export interface AutoReviewClientApi {
  read(): Promise<AutoReviewStatus>
  save(request: AutoReviewSaveRequest): Promise<AutoReviewSaveResult>
}

/** Connection loss and replacement invalidate observations from a previous Host. */
export interface AutoReviewConnectionSource {
  getSnapshot(): number | undefined
  subscribe(listener: () => void): () => void
}
