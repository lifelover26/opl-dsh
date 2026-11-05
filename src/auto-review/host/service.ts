/**
 * Auto Review Host service: a review gate in front of every native tool call
 * and every started PTC inner call of a Session that selected the official
 * `auto` permission preset.
 *
 * The service owns two things and nothing else:
 *
 *  - the persisted reviewer selection (one volatile field of the suite's own
 *    profile entry, with `read`/`save` Remote methods using the settings
 *    surface's real revision as a compare-and-swap token), and
 *  - the published lifetime of the `auto` preset plus the `tools/pre-execute`
 *    gate that makes that preset's contract true.
 *
 * Enabling changes no Session's permission and no default preset: it only makes
 * the `auto` entry selectable, and a user chooses it per Session through the
 * official permission surface. Disabling while a live Session still selects
 * `auto` is refused with `auto-sessions-remain`; unloading narrows a pinned
 * `never` approval to the `auto` bundle's own `ask` **before** the preset
 * disappears, so a reload can never let the previous
 * `danger-full-access`/`never` pair run unreviewed. It never migrates a Session
 * to another preset.
 *
 * Every decision is bound to frozen facts. The exact request text, the pending
 * call's durable identity, the authorization facts and the selection revision
 * are captured before the model request and re-verified before sending, after
 * the answer, and after the rest of the `tools/pre-execute` pipeline has run.
 * A call whose authority moved — a new instruction, a new turn, a model switch,
 * a permission change, or a configuration change that returns to an earlier
 * value — is never executed on the strength of the earlier answer.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { RUN_CODE_NAME, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  ReasoningEffortId,
  type GenerateOptions,
  type LlmCallConfig,
  type PreparedLlmCall,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AutoReviewFailure,
  AutoReviewPreferences,
  AutoReviewRouteOption,
  AutoReviewSaveRequest,
  AutoReviewSaveResult,
  AutoReviewStatus,
} from '../contracts/settings.ts'
import {
  POLICY_VERSION,
  REVIEW_POLICY,
  durablePermissionKnobs,
  readDecision,
  reviewUserText,
  snapshotExternalContext,
  sameKnobs,
  snapshotReviewFacts,
  type PermissionKnobs,
  type ReviewDecision,
  type ReviewFacts,
} from './policy.ts'
import {
  OPENAI_AUTO_REVIEW_ROUTE,
  effortConfirmed,
  isExcludedReviewProvider,
  listAdvertisedRoutes,
  matchingRoute,
  resolveExternalReviewerRoute,
  resolveReviewerRoute,
  ReviewerRouteError,
  type ReviewerRouteDiagnostic,
  type ReviewerRouteSource,
} from './routes.ts'
import {
  assessExternalReview,
  externalReviewUserText,
  installExternalReviewBridge,
  sameExternalReviewBinding,
  type ExternalReviewBinding,
  type ExternalReviewBindingPort,
  type ExternalReviewRequest,
} from './external-review.ts'
import {
  AUTO_REVIEW_FIELD,
  AUTO_REVIEW_OWNER_NS,
  Config,
  DEFAULT_PREFERENCES,
  coerceServiceConfig,
  configFromPreferences,
  normalizePreferences,
  preferencesFromConfig,
  revisionOf,
  samePreferences,
  type Config as AutoReviewConfig,
} from './settings.ts'
import {
  createDomainLedger,
  reviewRecordKey,
  type ClosableReviewLedger,
  type ReviewLedger,
  type ReviewRecord,
} from './ledger.ts'
import {
  UNAVAILABLE_CODE,
  UNAVAILABLE_ERROR_NAME,
  acquireReviewLease,
  type ReviewLease,
} from './guard.ts'
import type { AutoReviewMaintenance } from '../contracts/maintenance.ts'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'auto-review': true
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplAutoReview: OplAutoReviewService
    /**
     * Serializes reviewer-settings publication against native and external task
     * admission. Installed by the composition, not by this service.
     */
    oplAutoReviewMaintenance: AutoReviewMaintenance
  }
}

/** Stable name of this Remote namespace; the constructor repeats it literally
 * because the RPC generator requires a string literal service key. */
export const AUTO_REVIEW_SERVICE = 'oplAutoReview'

/** Optional injected sink that replaces the storage-domain ledger, used by focused tests. */
export const LEDGER_SERVICE = 'oplAutoReviewLedger'
/**
 * Optional composition-supplied binding port for external-Harness permission
 * asks. Without it the external bridge conservatively refuses to answer every
 * ask itself and the ordinary human approval flow keeps deciding.
 */
export const EXTERNAL_REVIEW_BINDING_SERVICE = 'oplAutoReviewExternalBinding'
/** Service key of the official domain facility the ledger opens its domain on. */
export const STORAGE_DOMAIN_SERVICE = 'storageDomain'
/** Service key of the composition-owned settings/admission transaction. */
export const MAINTENANCE_SERVICE = 'oplAutoReviewMaintenance'

/** Durable error identity persisted for every final reviewer denial. */
const DENIED_ERROR_NAME = 'AutoReviewDeniedError'
const DENIED_CODE = 'AUTO_REVIEW_DENIED'
/** Durable error identity persisted for a decision whose facts went stale. */
const STALE_ERROR_NAME = 'AutoReviewStaleError'
const STALE_CODE = 'AUTO_REVIEW_STALE'

/** Fixed reason fragments; no provider message or model text enters these. */
const FAILURE_TEXT: Readonly<
  Record<Exclude<ReviewFailureCategory, 'cancelled' | 'stale'>, string>
> = {
  facts: 'the pending action could not be bound to its durable session facts',
  route: 'no registered, advertised reviewer route is available',
  record: 'the review could not be recorded durably',
  timeout: 'the reviewer did not answer before the deadline',
  provider: 'the reviewer request failed',
  output: 'the reviewer answer was not a complete decision',
  gate: 'the remaining execution checks failed',
}

/**
 * The route policy's own fixed refusals.
 *
 * Each is safe to show: it names which link of the route policy failed —
 * selection, registration, advertisement or effort — and never a provider id,
 * a model id from an untrusted source, or an adapter message.
 */
const ROUTE_FAILURE_TEXT: Readonly<Record<ReviewerRouteDiagnostic, string>> = {
  'route-missing': 'no reviewer route is selected',
  'route-excluded': 'the selected reviewer route is not a direct pure-LLM route',
  'route-unavailable': 'the reviewer route is not registered and advertised',
  'preferred-route-unavailable':
    'the dedicated OpenAI auto-review model is not registered and advertised',
  'effort-unadvertised': 'the reviewer reasoning effort is not advertised',
}

/** The stage a review failed at; used only to pick a fixed reason fragment. */
type ReviewFailureCategory =
  | 'facts'
  | 'route'
  | 'record'
  | 'timeout'
  | 'cancelled'
  | 'provider'
  | 'output'
  | 'gate'
  | 'stale'

/** The stage→category mapping for a thrown failure. */
const STAGE_CATEGORY: Readonly<Record<ReviewStage, ReviewFailureCategory>> = {
  facts: 'facts',
  route: 'route',
  record: 'record',
  prepare: 'provider',
  read: 'output',
}

type ReviewStage = 'facts' | 'route' | 'record' | 'prepare' | 'read'

/** One resolved reviewer route. */
interface ReviewerRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | null
  /** The route-policy rule that chose it; recorded with every review. */
  readonly source: ReviewerRouteSource
}

/** The durable identity of the pending call one decision is bound to. */
interface PendingIdentity {
  readonly turn: number
  /** The native step; absent for an external-Harness permission ask. */
  readonly step?: number
  /** The Harness turn's stable operation identity; external asks only. */
  readonly turnId?: string
  readonly callId: string
  readonly rootCallId: string
  readonly mode: 'native' | 'ptc-inner' | 'external-approval'
  readonly name: string
}

/** The exact facts one decision is bound to. */
interface FrozenReview {
  /** The complete request text that was sent; compared as text, never as a digest. */
  readonly factsText: string
  /** The real turn/step and call identity, never a placeholder. */
  readonly pending: PendingIdentity
  /** The selection revision token the review was authorized under. */
  readonly revision: string
  /** The durable permission knobs the review was authorized under. */
  readonly knobs: PermissionKnobs
  readonly route: ReviewerRoute
  readonly timeoutMs: number
  readonly maxOutputTokens: number
}

/** One committed settings publication. */
interface SaveCommit {
  readonly committed: true
  readonly before: AutoReviewPreferences
  readonly revision: number
}

/** One accepted review with the facts its freshness checks need. */
interface ReviewSuccess {
  readonly ok: true
  readonly decision: ReviewDecision
  readonly frozen: FrozenReview
  /** Ledger record this outcome is correlated with. */
  readonly beginRecord: string
}

/** One review that produced no usable decision. */
interface ReviewFailure {
  readonly ok: false
  readonly category: ReviewFailureCategory
  /** Which link of the route policy refused, when the failure was a route one. */
  readonly routeDiagnostic?: ReviewerRouteDiagnostic
}

type ReviewOutcome = ReviewSuccess | ReviewFailure

/** The settings surface this service uses when one is mounted. */
interface SettingsPort {
  describe(): readonly { ns: string; value: unknown; revision: number }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** Whether one value is a well-formed save request. */
function isSaveRequest(value: unknown): value is AutoReviewSaveRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => key !== 'expectedRevision' && key !== 'preferences')) return false
  return typeof record['expectedRevision'] === 'string'
}

/** Bound one promise by an abort signal, so a signal-ignoring adapter still settles. */
function deadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('auto-review: the review was aborted'))
    if (signal.aborted) {
      abort()
      return
    }
    const onAbort = (): void => abort()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('auto-review: the reviewer failed'))
      },
    )
  })
}

/**
 * Strip anything that is not plain single-line text from a reviewer's own
 * reason and cap its length before it reaches a UI or an audit field.
 */
function sanitizeReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const cleaned = reason
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length === 0) return undefined
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}…` : cleaned
}

/** Materialize a final reviewer denial. */
function denialDecision(exec: ToolExecution, decision: ReviewDecision): PreToolDecision {
  const reason = sanitizeReason(decision.decision === 'deny' ? decision.reason : undefined)
  return {
    kind: 'deny',
    reason: `Auto review rejected tool "${exec.name}"; its body was not executed`,
    info: {
      name: DENIED_ERROR_NAME,
      code: DENIED_CODE,
      ...(reason === undefined ? {} : { reason }),
    },
  }
}

/** Ask the user to decide one call the reviewer denied under the `ask` policy. */
function askDecision(exec: ToolExecution, decision: ReviewDecision): PreToolDecision {
  const reason = sanitizeReason(decision.decision === 'deny' ? decision.reason : undefined)
  const denial = `Auto review denied tool "${exec.name}"`
  return {
    kind: 'ask',
    reason: reason === undefined ? denial : `${denial}: ${reason}`,
    displayReason:
      reason === undefined
        ? { en: 'Auto review denied this call.', zh: 'Auto review 拒绝了此调用。' }
        : {
            en: `Auto review denied this call: ${reason}`,
            zh: `Auto review 拒绝了此调用：${reason}`,
          },
  }
}

/** Fail closed: no decision of ours exists, so the body does not run. */
function failureDecision(
  exec: ToolExecution,
  category: Exclude<ReviewFailureCategory, 'cancelled' | 'stale'>,
  routeDiagnostic?: ReviewerRouteDiagnostic,
): PreToolDecision {
  const detail =
    category === 'route' && routeDiagnostic !== undefined
      ? ROUTE_FAILURE_TEXT[routeDiagnostic]
      : FAILURE_TEXT[category]
  return {
    kind: 'deny',
    reason: `Auto review of tool "${exec.name}" did not complete (${detail}); its body was not executed`,
  }
}

/** Fail closed: the reviewed facts no longer describe what would run. */
function staleDecision(exec: ToolExecution): PreToolDecision {
  return {
    kind: 'deny',
    reason: `Auto review facts changed before tool "${exec.name}" could run; its body was not executed`,
    info: { name: STALE_ERROR_NAME, code: STALE_CODE },
  }
}

/** Fail closed: the Session selects `auto` but the reviewer cannot run. */
function unavailableDecision(exec: ToolExecution): PreToolDecision {
  return {
    kind: 'deny',
    reason: `Auto review is not available for tool "${exec.name}"; its body was not executed`,
    info: { name: UNAVAILABLE_ERROR_NAME, code: UNAVAILABLE_CODE },
  }
}

/**
 * The Auto Review Host service.
 *
 * It reviews only while the reviewed Session selects the official `auto`
 * preset, and it always calls the next `tools/pre-execute` listener and returns
 * that listener's own deny/ask/cancel unchanged. A reviewer `allow` never
 * upgrades a downstream denial, and a reviewer denial under `ask` reaches the
 * human instead of running.
 */
export class OplAutoReviewService extends TypertRemoteService {
  static inject = ['agents', 'approval', 'llm', 'permissionPresets', 'sessions', 'tools']
  static Config = Config

  /** The last known selection; refreshed from settings before every decision. */
  private current: AutoReviewPreferences
  /** The real settings revision the selection was read at, when one exists. */
  private sectionRevision: number | undefined
  /** Whether new reviews may start. */
  private accepting = false
  /** Whether the integration is stopping and holds no further authority. */
  private draining = false
  /** Real in-flight reviewer lifecycles; unload waits for this set to empty. */
  private readonly active = new Set<Promise<void>>()
  /** Per-integration lifetime cancellation, replaced when the service restarts. */
  private lifecycle = new AbortController()
  /** The live `auto` preset publication, when enabled. */
  private autoDisposer: (() => Promise<void>) | undefined
  /** The most recent fixed failure label, or null. */
  private lastFailure: AutoReviewFailure | null = null
  /** Serializes saves so the revision compare-and-swap cannot be raced. */
  private saving: Promise<void> = Promise.resolve()
  /** The resolved ledger sink, cached after the first use. */
  private ledgerSink: ClosableReviewLedger | undefined
  /** The root-owned review lease this instance holds. */
  private readonly lease: ReviewLease
  /** Monotonic ledger record sequence: distinct records never share a key. */
  private recordSeq = 0

  constructor(ctx: Context, config: AutoReviewConfig) {
    // The RPC generator requires the service key as a string literal here.
    super(ctx, 'oplAutoReview')
    // The lease (and the conservative guard behind it) belongs to the root
    // Context, so this Host can go away without dropping the last refusal.
    this.lease = acquireReviewLease(ctx)
    const initial = coerceServiceConfig(config)
    try {
      this.current = preferencesFromConfig(initial)
    } catch {
      this.current = DEFAULT_PREFERENCES
      this.lastFailure = 'invalid-settings'
    }
    ctx.effect(() => {
      const off = ctx.on(
        'tools/pre-execute',
        (exec: ToolExecution, next: () => Promise<PreToolDecision>) => this.gate(exec, next),
        { prepend: true },
      )
      return async () => {
        try {
          // A rejected shutdown is not swallowed: it surfaces to the unload.
          await this.shutdown()
        } finally {
          // This listener belongs to this fiber. Removing it is safe only
          // because the root guard keeps refusing whenever `shutdown` could not
          // prove the conservative state; the lease is what carries that fact.
          off()
        }
      }
    }, 'opl auto review lifecycle')
    // The external-Harness bridge is a separate listener on the official
    // approval waterfall. It never answers an ask it cannot bind exactly, so an
    // unbound ask reaches the ordinary human flow exactly as before.
    ctx.effect(
      () =>
        installExternalReviewBridge(ctx, {
          port: () => this.externalBindingPort(),
          eligible: (agent) => this.externalReviewEligible(agent),
          review: (binding, request) => this.reviewExternalAsk(binding, request),
          fresh: (binding, request) => this.externalFresh(binding, request),
        }),
      'opl auto review external bridge',
    )
    // The domain handle this service opened is its own to release, so it is
    // closed here rather than left to the facility's unmount path.
    ctx.effect(() => () => this.ledgerSink?.close(), 'opl auto review ledger lifecycle')
    this.refresh()
    if (this.current.enabled) {
      // A stale conservative lease must be cleared by real narrowing, never by
      // assuming the previous Host's unload was safe.
      if (!this.start()) this.lastFailure = 'unavailable'
    }
  }

  /**
   * Read the current selection, its revision, the advertised reviewer routes
   * and the live lifecycle counts.
   * @returns the status a settings surface renders.
   */
  @Remote('read')
  async read(): Promise<AutoReviewStatus> {
    this.refresh()
    return await this.status()
  }

  /**
   * Persist one selection against the revision it was read at.
   *
   * Enabling validates that the chosen reviewer route is registered and
   * advertised, including its reasoning effort. Disabling is refused while any
   * live Session still selects `auto`; a save that would change the selection
   * while a review is in flight or any native agent of this Host is running is
   * refused as well. The settings write happens before any lifecycle change, so
   * a refused or failed write leaves the gate, the preset and the selection
   * exactly as they were.
   * @param request - the expected revision and the desired selection.
   * @returns the accepted status, or the preserved status with a fixed failure.
   */
  @Remote('save')
  async save(request: AutoReviewSaveRequest): Promise<AutoReviewSaveResult> {
    return await this.serialize(async () => {
      if (!isSaveRequest(request)) return await this.reject('invalid-settings')
      let next: AutoReviewPreferences
      try {
        next = normalizePreferences(request.preferences)
      } catch {
        return await this.reject('invalid-settings')
      }
      if (this.draining) return await this.reject('sessions-active')
      const maintenance = this.maintenancePort()
      if (maintenance === undefined) return await this.reject('unavailable')
      const settings = this.settingsPort()
      if (settings === undefined) return await this.reject('unavailable')

      // The entire validation and the durable write happen inside the
      // composition's exclusion, so no native or external admission can begin
      // between the activity check and the publication.
      let outcome: SaveCommit | { readonly failure: AutoReviewFailure }
      try {
        outcome = await maintenance.change(async () => {
          this.refresh()
          const revision = this.sectionRevision
          if (revision === undefined) return { failure: 'unavailable' as const }
          if (request.expectedRevision !== String(revision))
            return { failure: 'stale-settings' as const }
          const before = this.current
          const changed = !samePreferences(next, before)
          if (changed) {
            if (this.active.size > 0) return { failure: 'sessions-active' as const }
            if (this.runningAgents() !== 0) return { failure: 'sessions-active' as const }
          }
          if (next.enabled) {
            // A previous lifetime that could not prove a conservative state
            // must be made conservative here, before anything is enabled.
            if (this.lease.conservative && !this.narrowAllAuto())
              return { failure: 'sessions-active' as const }
            const routes = await listAdvertisedRoutes(this.ctx)
            if (next.reviewer.mode === 'fixed' || next.reviewer.mode === 'decision') {
              const route = matchingRoute(
                routes,
                next.reviewer.route.provider,
                next.reviewer.route.model,
              )
              if (route === undefined) return { failure: 'invalid-settings' as const }
              if (next.reviewer.mode === 'decision' && route.kind !== 'decision')
                return { failure: 'invalid-settings' as const }
              if (next.reviewer.mode === 'fixed' && route.kind === 'decision')
                return { failure: 'invalid-settings' as const }
              if (!effortConfirmed(route, next.reviewer.route.reasoningEffort ?? null))
                return { failure: 'invalid-settings' as const }
            } else if (
              !matchingRoute(
                routes,
                OPENAI_AUTO_REVIEW_ROUTE.provider,
                OPENAI_AUTO_REVIEW_ROUTE.model,
              )
            ) {
              return { failure: 'unavailable' as const }
            }
          }
          if (!next.enabled && before.enabled && this.autoSessionCount() !== 0)
            return { failure: 'auto-sessions-remain' as const }
          // Re-check at the publication point: a review or an agent may have
          // started while the catalog and the lease were being resolved.
          if (changed && (this.active.size > 0 || this.runningAgents() !== 0))
            return { failure: 'sessions-active' as const }
          try {
            await settings.update(
              AUTO_REVIEW_OWNER_NS,
              { [AUTO_REVIEW_FIELD]: configFromPreferences(next) },
              revision,
            )
          } catch (error) {
            return {
              failure: ((error as { code?: unknown } | null)?.code === 'SETTINGS_CONFLICT'
                ? 'stale-settings'
                : 'save-failed') as AutoReviewFailure,
            }
          }
          return { committed: true as const, before, revision }
        })
      } catch {
        // The exclusion was busy or refused: publication behind its back is
        // never acceptable, so the save fails instead of faking success.
        return await this.reject('sessions-active')
      }
      if ('failure' in outcome) return await this.reject(outcome.failure)

      // The write is committed before any lifecycle change, so a failure below
      // cannot leave an already-disabled integration behind.
      this.current = next
      this.sectionRevision = outcome.revision + 1
      if (next.enabled) {
        if (!this.start()) return await this.reject('unavailable')
      } else if (outcome.before.enabled) {
        await this.drain()
      }
      this.lastFailure = null
      return { ok: true, status: await this.status() }
    })
  }

  /** The composition-owned settings and admission transaction, when mounted. */
  private maintenancePort(): AutoReviewMaintenance | undefined {
    const candidate = this.ctx.get(MAINTENANCE_SERVICE) as AutoReviewMaintenance | undefined
    return candidate === undefined ? undefined : candidate
  }

  /** Refresh the remembered selection from the settings surface, then reconcile. */
  private refresh(): void {
    this.sectionRevision = undefined
    const settings = this.settingsPort()
    if (settings === undefined) {
      this.reconcile()
      return
    }
    let descriptor: { ns: string; value: unknown; revision: number } | undefined
    try {
      descriptor = settings.describe().find((item) => item.ns === AUTO_REVIEW_OWNER_NS)
    } catch {
      this.reconcile()
      return
    }
    const raw =
      descriptor === undefined
        ? undefined
        : (descriptor.value as Record<string, unknown> | undefined)?.[AUTO_REVIEW_FIELD]
    if (descriptor === undefined || raw === undefined) {
      this.reconcile()
      return
    }
    try {
      this.current = preferencesFromConfig(coerceServiceConfig(raw))
      this.sectionRevision = descriptor.revision
    } catch {
      this.lastFailure = 'invalid-settings'
    }
    this.reconcile()
  }

  /** The mounted settings surface, when the composition provides one. */
  private settingsPort(): SettingsPort | undefined {
    const candidate = this.ctx.get('settings') as SettingsPort | undefined
    return candidate === undefined ? undefined : candidate
  }

  /** Whether the composition actually persists this service's selection. */
  private get wired(): boolean {
    return this.sectionRevision !== undefined
  }

  /**
   * Align the live integration with the remembered selection.
   *
   * A selection that turned `enabled` on starts accepting. A selection that
   * turned it off stops accepting only once no live Session still selects
   * `auto`; while one does, the guard stays exactly where it is and the status
   * reports `auto-sessions-remain` instead of silently dropping the gate.
   */
  private reconcile(): void {
    if (this.draining) return
    if (this.current.enabled) {
      if (!this.accepting && !this.start()) this.lastFailure = 'unavailable'
      return
    }
    if (!this.accepting) {
      this.releaseAuto()
      this.lease.live = false
      return
    }
    // An unreadable session list counts as "not proven empty", never as none.
    if (this.autoSessionCount() !== 0) {
      this.lastFailure = 'auto-sessions-remain'
      return
    }
    this.accepting = false
    this.releaseAuto()
    this.lease.live = false
  }

  /**
   * Publish the `auto` preset and start accepting reviews.
   * @returns whether the integration is accepting; false leaves the guard in
   * place instead of enabling a reviewer that could not be made safe.
   */
  private start(): boolean {
    if (this.draining) return false
    // A lease left conservative by an earlier Host is only cleared by proving
    // the conservative state again, never by assuming the unload was safe.
    if (this.lease.conservative && !this.narrowAllAuto()) return false
    this.lease.conservative = false
    if (this.autoDisposer === undefined) {
      this.autoDisposer = this.ctx.permissionPresets.registerAuto(() => {
        this.admit()
      })
    }
    this.accepting = true
    this.lease.live = true
    if (this.lifecycle.signal.aborted) this.lifecycle = new AbortController()
    return true
  }

  /** Withdraw the `auto` preset publication. */
  private releaseAuto(): void {
    const dispose = this.autoDisposer
    this.autoDisposer = undefined
    if (dispose === undefined) return
    try {
      void Promise.resolve(dispose()).catch(() => {})
    } catch {
      // Already released; the preset is gone either way.
    }
  }

  /**
   * The synchronous admission gate the preset plugin runs before a live `auto`
   * selection or a stored `auto` restore. Throwing refuses the selection, so a
   * load or restore that cannot be reviewed is never published.
   */
  private admit(): void {
    if (!this.accepting || this.draining)
      throw new Error('auto-review: the integration is not accepting reviews')
    if (!this.current.enabled) throw new Error('auto-review: Auto Review is disabled')
    if (!this.hasRegisteredReviewer(this.current))
      throw new Error('auto-review: no registered reviewer route is available')
  }

  /** Whether a registered, non-excluded provider could serve this selection. */
  private hasRegisteredReviewer(preferences: AutoReviewPreferences): boolean {
    let providers: readonly { id: string }[]
    try {
      providers = this.ctx.llm.listProviders()
    } catch {
      return false
    }
    const usable = providers.filter((provider) => !isExcludedReviewProvider(provider.id))
    const reviewer = preferences.reviewer
    if (reviewer.mode === 'current') return usable.length > 0
    const fixed = reviewer.route.provider
    return usable.some((provider) => provider.id === fixed)
  }

  /**
   * Stop accepting, withdraw `auto`, and wait for the real in-flight reviewer
   * lifecycles to settle. Used by a validated disable; a disable is only
   * accepted with no `auto` Session left, so no conservative narrowing is owed.
   */
  private async drain(): Promise<void> {
    this.draining = true
    this.accepting = false
    this.lifecycle.abort(new Error('auto-review: the integration stopped'))
    this.releaseAuto()
    await Promise.allSettled([...this.active])
    this.draining = false
    this.lease.live = false
  }

  /**
   * Unload: refuse new reviews, abort in-flight ones, leave a durable
   * conservative fact for every Session still pinned to `auto` with `never`,
   * and wait for the real reviewer lifecycles to end.
   *
   * Nothing here is best effort. When the conservative state cannot be proven —
   * the session list is unreadable, or any narrowing write fails — the lease is
   * left conservative so the root guard keeps refusing `auto` traffic, the
   * `auto` preset is not withdrawn, and the unload rejects instead of reporting
   * a safe state it did not reach.
   */
  private async shutdown(): Promise<void> {
    this.draining = true
    this.accepting = false
    // The conservative protection exists BEFORE this Host withdraws its own
    // capability and before the first await. In-flight reviewer streams may
    // ignore the abort and hold this unload open for an arbitrary time, and the
    // gate listener dies with this fiber; a call arriving in that window must
    // already be refused by the root guard, not by a listener that is about to
    // be removed.
    this.lease.conservative = true
    this.lease.live = false
    this.lifecycle.abort(new Error('auto-review: the integration is unloading'))
    const safe = this.narrowAllAuto()
    await Promise.allSettled([...this.active])
    // The lease is released only once the durable narrowing AND the drain are
    // both proven. Anything less keeps refusing.
    if (!safe) throw new Error('auto-review: unloading could not prove a conservative state')
    this.lease.conservative = false
    this.releaseAuto()
  }

  /**
   * Narrow every live `auto` identity that pinned `never` to the `auto`
   * bundle's own durable `ask`.
   *
   * This is the fact that makes a reload safe. It only ever narrows — `never`
   * to `ask` — and never touches the sandbox mode or the preset identity, so it
   * is not the official implementation's `auto` → `danger-full-access`
   * migration.
   *
   * The selection is read from the Session's own durable knob events rather
   * than from the permission projection: this runs while the owning context is
   * being torn down, and the projection (or the live preset service) may
   * already be gone.
   * @returns whether the conservative state was proven for every live Session.
   */
  private narrowAllAuto(): boolean {
    let sessions: readonly Session[]
    try {
      sessions = this.ctx.sessions.list()
    } catch {
      return false
    }
    for (const session of sessions) {
      const knobs = durablePermissionKnobs(session)
      if (knobs === null) return false
      if (knobs.preset !== AUTO_PRESET) continue
      if (knobs.sandbox !== 'danger-full-access') continue
      if (knobs.approval !== 'never') continue
      try {
        setApprovalPolicy(session, 'ask')
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * The `tools/pre-execute` gate.
   *
   * A call that this service does not own is passed straight through: only a
   * Session that selects the official `auto` preset is reviewed, so a default
   * or disabled integration never changes any other Session's pipeline. The
   * outer PTC transport is skipped only because every started inner call
   * re-enters this same waterfall with a parent token and is reviewed there.
   */
  private async gate(
    exec: ToolExecution,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const agent = exec.agent
    if (agent === undefined) return await next()
    if (exec.parent === undefined && exec.name === RUN_CODE_NAME) return await next()
    const selection = this.autoSelection(agent.session)
    if (selection === 'other') return await next()
    this.refresh()
    // Reading the selection failed, or the Session selects `auto`: both refuse,
    // because neither can show that the call is outside this contract.
    if (selection === 'unknown' || !this.current.enabled) return unavailableDecision(exec)
    if (this.draining || this.lifecycle.signal.aborted) return { kind: 'cancel' }
    if (!this.accepting) return unavailableDecision(exec)

    const outcome = await this.review(agent, exec)
    if (this.draining || this.lifecycle.signal.aborted) return { kind: 'cancel' }
    if (!outcome.ok) {
      if (outcome.category === 'cancelled') return { kind: 'cancel' }
      if (outcome.category === 'stale') return staleDecision(exec)
      this.lastFailure = 'unavailable'
      return failureDecision(exec, outcome.category, outcome.routeDiagnostic)
    }
    if (outcome.decision.decision === 'deny' && this.approvalPolicyOf(agent.session) === 'never') {
      const committed = await this.recordResult(
        agent,
        exec,
        outcome.frozen,
        outcome.beginRecord,
        'deny',
        'deny',
        outcome.decision,
      )
      if (committed === undefined) return failureDecision(exec, 'record')
      return denialDecision(exec, outcome.decision)
    }

    let downstream: PreToolDecision
    try {
      downstream = await next()
    } catch {
      const cancelled = this.draining || this.lifecycle.signal.aborted || exec.signal.aborted
      const committed = await this.recordResult(
        agent,
        exec,
        outcome.frozen,
        outcome.beginRecord,
        cancelled ? 'cancel' : 'deny',
        outcome.decision.decision,
        outcome.decision,
      )
      if (cancelled) return { kind: 'cancel' }
      return failureDecision(exec, committed === undefined ? 'record' : 'gate')
    }
    if (this.draining || this.lifecycle.signal.aborted) return { kind: 'cancel' }
    this.refresh()
    // The downstream pipeline is asynchronous, so the facts are re-verified
    // after it settles: a call that lost its authority mid-pipeline must not
    // ride an earlier allow.
    if (!this.verifyFrozen(agent, exec, outcome.frozen)) {
      const committed = await this.recordResult(
        agent,
        exec,
        outcome.frozen,
        outcome.beginRecord,
        'stale',
        'none',
      )
      if (committed === undefined) return failureDecision(exec, 'record')
      return staleDecision(exec)
    }

    // A downstream refusal is final and authorizes nothing, so it is recorded
    // and returned without a second wait.
    if (outcome.decision.decision === 'deny' || downstream.kind !== 'allow') {
      const proposal: PreToolDecision =
        downstream.kind === 'allow' ? askDecision(exec, outcome.decision) : downstream
      const committed = await this.recordResult(
        agent,
        exec,
        outcome.frozen,
        outcome.beginRecord,
        proposal.kind === 'ask' ? 'ask' : proposal.kind,
        outcome.decision.decision,
        outcome.decision,
      )
      if (committed === undefined) return failureDecision(exec, 'record')
      return proposal
    }

    // The reviewer allowed and the pipeline allowed: this is exactly the point
    // where the durable outcome still authorizes execution, so it is committed
    // first and the facts are checked again on the other side of that commit.
    // The record must never claim an execution the call did not earn.
    const committed = await this.recordResult(
      agent,
      exec,
      outcome.frozen,
      outcome.beginRecord,
      'allow',
      'allow',
      outcome.decision,
    )
    if (committed === undefined) return failureDecision(exec, 'record')
    const revocation = this.revocation(agent, exec, outcome.frozen)
    if (revocation !== undefined) {
      await this.recordResult(
        agent,
        exec,
        outcome.frozen,
        outcome.beginRecord,
        revocation,
        outcome.decision.decision,
        outcome.decision,
        committed,
      )
      return revocation === 'cancel' ? { kind: 'cancel' } : staleDecision(exec)
    }
    return downstream
  }

  /**
   * Why an already-committed allow may no longer authorize execution.
   *
   * The durable commit is asynchronous, so the lifetime, the caller's own
   * cancellation, and every frozen fact are re-checked after it.
   * @returns the revoking outcome, or undefined while the call still stands.
   */
  private revocation(
    agent: Agent,
    exec: ToolExecution,
    frozen: FrozenReview,
  ): 'cancel' | 'stale' | undefined {
    if (this.draining || this.lifecycle.signal.aborted || exec.signal.aborted) return 'cancel'
    this.refresh()
    return this.verifyFrozen(agent, exec, frozen) ? undefined : 'stale'
  }

  /** Whether one Session selects the official `auto` preset, or cannot be read. */
  private autoSelection(session: Session): 'auto' | 'other' | 'unknown' {
    try {
      return this.ctx.permissionPresets.current(session) === AUTO_PRESET ? 'auto' : 'other'
    } catch {
      return 'unknown'
    }
  }

  /** The session's own approval override, when it has one. */
  private approvalPolicyOf(session: Session): string | undefined {
    try {
      return this.ctx.approval.overrideOf(session)
    } catch {
      return undefined
    }
  }

  /** Every live Session this Host knows about, or null when unreadable. */
  private sessions(): readonly Session[] | null {
    try {
      return this.ctx.sessions.list()
    } catch {
      return null
    }
  }

  /** How many live Sessions currently select `auto`; -1 when unreadable. */
  private autoSessionCount(): number {
    const sessions = this.sessions()
    if (sessions === null) return -1
    let count = 0
    for (const session of sessions) if (this.autoSelection(session) === 'auto') count += 1
    return count
  }

  /** How many native agents are running; null when the agent registry is unreadable. */
  private runningAgents(): number | null {
    try {
      return this.ctx.agents.list().filter((agent) => agent.status === 'running').length
    } catch {
      return null
    }
  }

  /** The visible surface length; -1 makes a failed read compare unequal. */
  private surfaceLength(session: Session): number {
    try {
      return session.surface.nodes.length
    } catch {
      return -1
    }
  }

  /** The compare-and-swap token, taken from the real settings revision. */
  private revisionToken(): string {
    return this.sectionRevision === undefined ? 'unavailable' : String(this.sectionRevision)
  }

  /**
   * Review one pending call with a tool-free, registration-bound request.
   * @param agent - the agent whose session authorizes the call.
   * @param exec - the immutable pending execution.
   * @returns the decision plus the frozen facts its freshness checks need.
   */
  private async review(agent: Agent, exec: ToolExecution): Promise<ReviewOutcome> {
    const controller = new AbortController()
    const timeoutMs = this.current.timeoutMs
    const maxOutputTokens = this.current.maxOutputTokens
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    let stage: ReviewStage = 'facts'
    let frozen: FrozenReview | undefined
    let beginRecord: string | undefined
    try {
      const facts = snapshotReviewFacts(agent, exec)
      const factsText = reviewUserText(facts)
      const knobs = durablePermissionKnobs(agent.session)
      // An unreadable permission log is not a permission state: no review may
      // be cut from facts that were never read.
      if (knobs === null) return { ok: false, category: 'facts' }
      const pending: PendingIdentity = {
        turn: facts.turn,
        step: facts.step,
        callId: String(exec.callId),
        rootCallId: String(exec.rootCallId),
        mode: exec.parent === undefined ? 'native' : 'ptc-inner',
        name: exec.name,
      }
      stage = 'route'
      const route = await this.reviewerRouteFor(facts)
      stage = 'facts'
      frozen = {
        factsText,
        pending,
        revision: this.revisionToken(),
        knobs,
        route,
        timeoutMs,
        maxOutputTokens,
      }
      // Verified before sending as well: the frozen facts must already be the
      // live facts, so a later change is a real difference.
      if (!this.verifyFrozen(agent, exec, frozen)) return { ok: false, category: 'stale' }
      stage = 'record'
      beginRecord = await this.recordBegin(agent, facts.sessionRoute, factsText, route, frozen)
      stage = 'prepare'
      const signal = AbortSignal.any([exec.signal, this.lifecycle.signal, controller.signal])
      const prepared = await this.prepare(route, maxOutputTokens, signal)
      stage = 'read'
      const options: GenerateOptions = {
        ...prepared.config,
        sessionId: agent.session.id,
        purpose: 'auto-review',
        system: REVIEW_POLICY,
        messages: [{ role: 'user', content: [{ type: 'text', text: factsText }] }],
        signal,
      }
      const iterator = prepared.stream(options)[Symbol.asyncIterator]()
      const read = readDecision(iterator)
      // The real lifecycle, not the abort race: the active set holds this until
      // the underlying reviewer stream has actually ended, so an unload waits
      // for the provider instead of assuming an abort settled it.
      const lifecycle = read.then(
        () => undefined,
        () => undefined,
      )
      this.active.add(lifecycle)
      void lifecycle.then(() => {
        this.active.delete(lifecycle)
      })
      const decision = await deadline(read, signal)
      // Re-read the selection first: a settings revision that moved while the
      // reviewer was answering (even back to the same value) must be seen.
      this.refresh()
      if (!this.verifyFrozen(agent, exec, frozen)) {
        // The reviewer's own opinion is recorded as `reviewer: none` here on
        // purpose: the decision was never accepted, so it must not read as one.
        await this.recordResult(agent, exec, frozen, beginRecord, 'stale', 'none')
        return { ok: false, category: 'stale' }
      }
      this.lastFailure = null
      return { ok: true, decision, frozen, beginRecord }
    } catch (error) {
      const category =
        this.lifecycle.signal.aborted || exec.signal.aborted
          ? 'cancelled'
          : timedOut || controller.signal.aborted
            ? 'timeout'
            : STAGE_CATEGORY[stage]
      const routeDiagnostic =
        category === 'route' && error instanceof ReviewerRouteError ? error.diagnostic : undefined
      if (frozen !== undefined && beginRecord !== undefined) {
        const committed = await this.recordResult(
          agent,
          exec,
          frozen,
          beginRecord,
          category === 'cancelled' ? 'cancel' : 'deny',
          'none',
        )
        if (committed === undefined) return { ok: false, category: 'record' }
      }
      return {
        ok: false,
        category,
        ...(routeDiagnostic === undefined ? {} : { routeDiagnostic }),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Resolve the reviewer route for one review through the closed route policy.
   *
   * An explicitly selected `fixed` route is used verbatim. Otherwise a Session
   * whose own request-header route is an OpenAI/Codex route served by the OPL
   * Gateway is reviewed by the dedicated OpenAI auto-review model, and every
   * other model keeps its own route. There is no fallback between the two: a
   * route the policy chose but the live catalog does not advertise fails closed
   * with its own diagnostic instead of borrowing a different model.
   */
  private async reviewerRouteFor(facts: ReviewFacts): Promise<ReviewerRoute> {
    const preferences = this.current
    return resolveReviewerRoute({
      selection:
        preferences.reviewer.mode === 'fixed' || preferences.reviewer.mode === 'decision'
          ? {
              mode: preferences.reviewer.mode,
              route: {
                provider: preferences.reviewer.route.provider,
                model: preferences.reviewer.route.model,
                ...(preferences.reviewer.route.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: preferences.reviewer.route.reasoningEffort }),
              },
            }
          : { mode: 'current' },
      sessionRoute: facts.sessionRoute,
      routes: await listAdvertisedRoutes(this.ctx),
    })
  }

  /** The composition-supplied binding port for external permission asks. */
  private externalBindingPort(): ExternalReviewBindingPort | undefined {
    return this.ctx.get(EXTERNAL_REVIEW_BINDING_SERVICE) as ExternalReviewBindingPort | undefined
  }

  /**
   * Whether one external permission ask may be answered by the reviewer.
   *
   * Everything that is not provably inside this contract leaves the ask to the
   * ordinary approval chain: a disabled or draining integration, a Session that
   * does not select `auto`, an unreadable permission log, and a `never` policy —
   * which is a closed decision that a review must never upgrade.
   */
  private externalReviewEligible(agent: Agent): boolean {
    if (this.draining || this.lifecycle.signal.aborted) return false
    if (!this.accepting) return false
    this.refresh()
    if (!this.current.enabled) return false
    try {
      if (this.autoSelection(agent.session) !== 'auto') return false
      const knobs = durablePermissionKnobs(agent.session)
      if (knobs === null) return false
      return knobs.approval !== 'never'
    } catch {
      return false
    }
  }

  /**
   * Whether one bound external ask still describes exactly what would run.
   *
   * The binding is re-read from the composition rather than trusted from the
   * first read, so a reconnected Harness, a new turn or a different action can
   * never ride an earlier answer. With frozen facts in hand the selection
   * revision and the durable permission knobs are compared as well.
   */
  private readonly externalFrozen = new WeakMap<ExternalReviewRequest, FrozenReview>()

  private externalFresh(
    binding: ExternalReviewBinding,
    request: ExternalReviewRequest,
    frozen?: FrozenReview,
  ): boolean {
    frozen ??= this.externalFrozen.get(request)
    if (this.draining || this.lifecycle.signal.aborted) return false
    if (request.signal?.aborted === true) return false
    if (!this.current.enabled) return false
    if (this.autoSelection(request.agent.session) !== 'auto') return false
    // The authorization the ask was read from must still be the live one: the
    // owning Session, its preset and the Harness task's own boundary.
    if (binding.authorization.sessionId !== String(request.agent.session.id)) return false
    if (binding.authorization.preset !== this.livePreset(request.agent.session)) return false
    const knobs = durablePermissionKnobs(request.agent.session)
    if (knobs === null || knobs.approval === 'never') return false
    if (frozen !== undefined) {
      if (this.revisionToken() !== frozen.revision) return false
      if (!sameKnobs(knobs, frozen.knobs)) return false
      try {
        if (
          snapshotExternalContext(request.agent) +
            '\n\n' +
            externalReviewUserText(binding, request) !==
          frozen.factsText
        )
          return false
      } catch {
        return false
      }
    }
    let current: ExternalReviewBinding | null
    try {
      current = this.externalBindingPort()?.bind(request.agent, request) ?? null
    } catch {
      return false
    }
    return current !== null && sameExternalReviewBinding(binding, current)
  }

  /** The Session's live permission preset, or an empty string when unreadable. */
  private livePreset(session: Session): string {
    try {
      return this.ctx.permissionPresets.current(session)
    } catch {
      return ''
    }
  }

  /** The Session's persisted request-header route, as recorded authorization. */
  private sessionRouteOf(session: Session): ReviewFacts['sessionRoute'] {
    let config: { provider: string; model: string; reasoningEffort?: unknown } | undefined
    try {
      config = session.requestHeader()?.config
    } catch {
      config = undefined
    }
    return {
      provider: config?.provider ?? '',
      model: config?.model ?? '',
      reasoningEffort:
        config?.reasoningEffort === undefined ? null : String(config.reasoningEffort),
    }
  }

  /**
   * Review one bound external-Harness permission ask with the same tool-free
   * request, the same route policy and the same durable record as a native call.
   *
   * Every failure — an unresolvable route, an unreadable permission log, a
   * ledger that cannot commit, a reviewer that throws or times out, and a
   * binding that moved while the reviewer was answering — rejects the ask. The
   * grant is a single `allowed-once`, and it is never produced from anything
   * other than a complete reviewer decision whose frozen facts still hold.
   */
  private async reviewExternalAsk(
    binding: ExternalReviewBinding,
    request: ExternalReviewRequest,
  ): Promise<ReviewDecision> {
    const agent = request.agent
    if (!this.externalReviewEligible(agent))
      throw new Error('auto-review: the external permission ask is not reviewable')
    const knobs = durablePermissionKnobs(agent.session)
    if (knobs === null) throw new Error('auto-review: the permission facts are unreadable')
    // The binding must describe the very Session this ask was raised for.
    if (binding.authorization.sessionId !== String(agent.session.id))
      throw new Error('auto-review: the external permission ask belongs to another Session')
    const route = await resolveExternalReviewerRoute({
      selection:
        this.current.reviewer.mode === 'fixed' || this.current.reviewer.mode === 'decision'
          ? {
              mode: this.current.reviewer.mode,
              route: {
                provider: this.current.reviewer.route.provider,
                model: this.current.reviewer.route.model,
                ...(this.current.reviewer.route.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: this.current.reviewer.route.reasoningEffort }),
              },
            }
          : { mode: 'current' },
      routes: await listAdvertisedRoutes(this.ctx),
    })
    const factsText =
      snapshotExternalContext(agent) + '\n\n' + externalReviewUserText(binding, request)
    const timeoutMs = this.current.timeoutMs
    const maxOutputTokens = this.current.maxOutputTokens
    const identity = binding.callId
    const frozen: FrozenReview = {
      factsText,
      pending: {
        turn: binding.turn,
        turnId: binding.turnId,
        callId: identity,
        rootCallId: identity,
        mode: 'external-approval',
        name: binding.action.name,
      },
      revision: this.revisionToken(),
      knobs,
      route,
      timeoutMs,
      maxOutputTokens,
    }
    this.externalFrozen.set(request, frozen)
    if (!this.externalFresh(binding, request, frozen))
      throw new Error('auto-review: the external permission ask is stale')
    const beginRecord = await this.recordBegin(
      agent,
      this.sessionRouteOf(agent.session),
      factsText,
      route,
      frozen,
    )
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    /** Whether an outcome for this ask is already durably recorded. */
    let settled = false
    try {
      const signal = AbortSignal.any([
        this.lifecycle.signal,
        controller.signal,
        ...(request.signal === undefined ? [] : [request.signal]),
      ])
      const prepared = await this.prepare(route, maxOutputTokens, signal)
      const options: GenerateOptions = {
        ...prepared.config,
        sessionId: agent.session.id,
        purpose: 'auto-review',
        system: REVIEW_POLICY,
        messages: [{ role: 'user', content: [{ type: 'text', text: factsText }] }],
        signal,
      }
      const iterator = prepared.stream(options)[Symbol.asyncIterator]()
      const read = readDecision(iterator)
      const lifecycle = read.then(
        () => undefined,
        () => undefined,
      )
      this.active.add(lifecycle)
      void lifecycle.then(() => {
        this.active.delete(lifecycle)
      })
      const decision = await deadline(read, signal)
      this.refresh()
      if (!this.externalFresh(binding, request, frozen)) {
        // The decision was never accepted, so it is recorded as `reviewer: none`.
        await this.recordResult(agent, undefined, frozen, beginRecord, 'stale', 'none')
        settled = true
        throw new Error('auto-review: the external permission ask changed during review')
      }
      const committed = await this.recordResult(
        agent,
        undefined,
        frozen,
        beginRecord,
        decision.decision === 'allow' ? 'allow' : 'deny',
        decision.decision,
        decision,
      )
      if (committed === undefined)
        throw new Error('auto-review: the external outcome could not be recorded')
      settled = true
      if (!this.externalFresh(binding, request, frozen)) {
        await this.recordResult(
          agent,
          undefined,
          frozen,
          beginRecord,
          'stale',
          decision.decision,
          decision,
        )
        throw Error('auto-review: external facts changed during outcome commit')
      }
      return decision
    } catch (error) {
      if (!settled)
        await this.recordResult(agent, undefined, frozen, beginRecord, 'deny', 'none').catch(
          () => undefined,
        )
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** Prepare one registration-bound, tool-free, session-less reviewer call. */
  private async prepare(
    route: ReviewerRoute,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<PreparedLlmCall> {
    const config: LlmCallConfig = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === null
        ? {}
        : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
      temperature: 0,
      maxTokens: maxOutputTokens,
    }
    return await this.ctx.llm.prepareCall(config, signal)
  }

  /**
   * Re-derive the live facts and compare them with the frozen ones.
   *
   * The comparison is over the exact request text that was sent, never a digest:
   * a same-length edit, a changed tool argument, a new instruction, a new turn,
   * a model switch, a permission change, or a configuration change that returns
   * to an earlier value all make the frozen facts stop describing the call.
   */
  private verifyFrozen(agent: Agent, exec: ToolExecution, frozen: FrozenReview): boolean {
    if (!this.current.enabled) return false
    if (this.revisionToken() !== frozen.revision) return false
    if (this.autoSelection(agent.session) !== 'auto') return false
    if (!sameKnobs(durablePermissionKnobs(agent.session), frozen.knobs)) return false
    try {
      return reviewUserText(snapshotReviewFacts(agent, exec)) === frozen.factsText
    } catch {
      return false
    }
  }

  /** The ledger sink: an injected one when present, else the mounted domain facility. */
  private ledger(): ReviewLedger {
    const injected = this.ctx.get(LEDGER_SERVICE) as ReviewLedger | undefined
    if (injected !== undefined) return injected
    this.ledgerSink ??= createDomainLedger(
      () => this.ctx.get(STORAGE_DOMAIN_SERVICE) as DomainFacility | undefined,
    )
    return this.ledgerSink
  }

  /**
   * Record the exact facts of one review before its model request.
   * @returns the ledger record identity the outcome is correlated with.
   * @throws when the record cannot be committed; the caller then denies.
   */
  private async recordBegin(
    agent: Agent,
    sessionRoute: ReviewFacts['sessionRoute'],
    factsText: string,
    route: ReviewerRoute,
    frozen: FrozenReview,
  ): Promise<string> {
    this.recordSeq += 1
    const record: ReviewRecord = {
      kind: 'begin',
      record: '',
      seq: this.recordSeq,
      at: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
      sessionId: String(agent.session.id),
      selectionRevision: frozen.revision,
      reviewer: {
        mode: this.current.reviewer.mode,
        source: route.source,
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        timeoutMs: frozen.timeoutMs,
        maxOutputTokens: frozen.maxOutputTokens,
      },
      pending: frozen.pending,
      authorization: {
        preset: frozen.knobs.preset ?? '',
        sandbox: frozen.knobs.sandbox ?? '',
        approval: frozen.knobs.approval ?? '',
        surfaceLength: this.surfaceLength(agent.session),
        sessionRoute,
      },
      request: { system: REVIEW_POLICY, messages: factsText },
    }
    const key = reviewRecordKey(record)
    await this.ledger().append({ ...record, record: key })
    return key
  }

  /**
   * Record the fixed outcome of one review.
   *
   * `reviewer` is what the reviewer said and `status` is what the gate actually
   * returned; they differ exactly when a decision stopped being executable, so
   * an outrun `allow` is never stored as one.
   *
   * The pending execution is only ever used for the native and PTC paths; an
   * external-Harness ask has none, so it is recorded as absent rather than as a
   * stand-in.
   * @returns the stored record key, or undefined when it could not be committed.
   */
  private async recordResult(
    agent: Agent,
    exec: ToolExecution | undefined,
    frozen: FrozenReview,
    record: string,
    status: 'allow' | 'ask' | 'deny' | 'stale' | 'cancel',
    reviewer: 'allow' | 'deny' | 'none',
    decision?: ReviewDecision,
    supersedes?: string,
  ): Promise<string | undefined> {
    void exec
    this.recordSeq += 1
    const reason =
      decision !== undefined && decision.decision === 'deny'
        ? sanitizeReason(decision.reason)
        : undefined
    const entry: ReviewRecord = {
      kind: 'result',
      record,
      seq: this.recordSeq,
      at: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
      sessionId: String(agent.session.id),
      pending: frozen.pending,
      reviewer,
      status,
      ...(supersedes === undefined ? {} : { supersedes }),
      ...(decision === undefined ? {} : { risk: decision.risk, decision: decision.decision }),
      ...(reason === undefined ? {} : { reason }),
    }
    try {
      await this.ledger().append(entry)
      return reviewRecordKey(entry)
    } catch {
      return undefined
    }
  }

  /** Serialize saves so two callers cannot both win the revision comparison. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.saving.then(work, work)
    this.saving = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Preserve the current selection and report one fixed failure label. */
  private async reject(failure: AutoReviewFailure): Promise<AutoReviewSaveResult> {
    this.lastFailure = failure
    return { ok: false, failure, status: await this.status() }
  }

  /** Assemble the status from the remembered selection and live facts. */
  private async status(): Promise<AutoReviewStatus> {
    const preferences = this.current
    const routes = await listAdvertisedRoutes(this.ctx)
    const ready = preferences.enabled && this.routeReady(preferences, routes)
    const state = this.stateOf(preferences, ready)
    const observedFailure =
      state === 'unavailable' ? 'unavailable' : this.wired ? this.lastFailure : 'unavailable'
    return {
      preferences,
      revision: this.wired ? String(this.sectionRevision) : revisionOf(preferences),
      state,
      routes,
      activeReviews: this.active.size,
      autoSessions: Math.max(0, this.autoSessionCount()),
      failure: observedFailure,
    }
  }

  /** Whether the remembered selection names a usable reviewer route. */
  private routeReady(
    preferences: AutoReviewPreferences,
    routes: readonly AutoReviewRouteOption[],
  ): boolean {
    if (preferences.reviewer.mode === 'current')
      return (
        matchingRoute(routes, OPENAI_AUTO_REVIEW_ROUTE.provider, OPENAI_AUTO_REVIEW_ROUTE.model) !==
        undefined
      )
    const route = matchingRoute(
      routes,
      preferences.reviewer.route.provider,
      preferences.reviewer.route.model,
    )
    return (
      route !== undefined &&
      (preferences.reviewer.mode !== 'decision' || route.kind === 'decision') &&
      (preferences.reviewer.mode !== 'fixed' || route.kind !== 'decision')
    )
  }

  /** The reported lifecycle state. */
  private stateOf(preferences: AutoReviewPreferences, ready: boolean): AutoReviewStatus['state'] {
    if (this.draining) return 'draining'
    if (!this.accepting) return preferences.enabled ? 'draining' : 'disabled'
    return ready ? 'ready' : 'unavailable'
  }
}

export default OplAutoReviewService
export { POLICY_VERSION }
