/**
 * OPL reviewer routing and external-Harness approval adapter.
 *
 * The official experimental-auto-review plugin owns the native Auto preset,
 * tool gate, decision policy, history binding and unload behavior. This service
 * only selects an independent reviewer through the public llm/stream seam and
 * handles exactly bound external permission asks not covered by that plugin.
 * Disabling this adapter leaves official Auto on its current-session model.
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import {
  ReasoningEffortId,
  type GenerateOptions,
  type LlmCallConfig,
  type PreparedLlmCall,
  type StreamChunk,
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
  snapshotExternalContext,
  sameKnobs,
  type PermissionKnobs,
  type ReviewDecision,
  type ReviewSessionRoute,
} from './policy.ts'
import {
  OPENAI_AUTO_REVIEW_ROUTE,
  effortConfirmed,
  listAdvertisedRoutes,
  matchingRoute,
  resolveExternalReviewerRoute,
  resolveReviewerRoute,
  type ReviewerRouteSource,
} from './routes.ts'
import {
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
  /** The Harness turn's stable operation identity; external asks only. */
  readonly turnId?: string
  readonly callId: string
  readonly rootCallId: string
  readonly mode: 'external-approval'
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

/** Persist OPL route preferences without owning the native Auto lifecycle. */
export class OplAutoReviewService extends TypertRemoteService {
  static inject = ['agents', 'approval', 'llm', 'permissionPresets', 'sessions', 'tools']
  static Config = Config

  private current: AutoReviewPreferences
  private sectionRevision: number | undefined
  private accepting = false
  private draining = false
  private readonly active = new Set<Promise<void>>()
  private readonly lifecycle = new AbortController()
  private lastFailure: AutoReviewFailure | null = null
  private saving: Promise<void> = Promise.resolve()
  private ledgerSink: ClosableReviewLedger | undefined
  private recordSeq = 0

  constructor(ctx: Context, config: AutoReviewConfig) {
    super(ctx, 'oplAutoReview')
    try {
      this.current = preferencesFromConfig(coerceServiceConfig(config))
    } catch {
      this.current = DEFAULT_PREFERENCES
      this.lastFailure = 'invalid-settings'
    }
    ctx.effect(() => {
      const off = ctx.on('llm/stream', (options, next) => this.routeNative(options, next), {
        prepend: true,
      })
      return async () => {
        this.draining = true
        this.accepting = false
        this.lifecycle.abort(new Error('auto-review: the routing adapter is unloading'))
        await Promise.allSettled([...this.active])
        off()
      }
    }, 'opl review routing lifecycle')
    ctx.effect(
      () =>
        installExternalReviewBridge(ctx, {
          port: () => this.externalBindingPort(),
          eligible: (agent) => this.externalReviewEligible(agent),
          review: (binding, request) => this.reviewExternalAsk(binding, request),
          fresh: (binding, request) => this.externalFresh(binding, request),
        }),
      'opl external review bridge',
    )
    ctx.effect(() => () => this.ledgerSink?.close(), 'opl review ledger lifecycle')
    this.refresh()
  }

  @Remote('read')
  async read(): Promise<AutoReviewStatus> {
    this.refresh()
    return await this.status()
  }

  /**
   * Persist one selection against the revision it was read at.
   *
   * Enabling validates that the chosen reviewer route is registered and
   * advertised, including reasoning effort. Changes are refused while a review
   * or native agent is running. Idle Auto sessions do not block disabling this
   * adapter: native preset, tool gate and lifecycle remain official-owned.
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
          // Re-check at the publication point: a review or an agent may have
          // started while the reviewer catalog was being resolved.
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

      // Publish only after the settings owner committed the route selection.
      this.current = next
      this.sectionRevision = outcome.revision + 1
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
      this.accepting = this.current.enabled && !this.draining
      return
    }
    let descriptor: { ns: string; value: unknown; revision: number } | undefined
    try {
      descriptor = settings.describe().find((item) => item.ns === AUTO_REVIEW_OWNER_NS)
    } catch {
      this.accepting = this.current.enabled && !this.draining
      return
    }
    const raw =
      descriptor === undefined
        ? undefined
        : (descriptor.value as Record<string, unknown> | undefined)?.[AUTO_REVIEW_FIELD]
    if (descriptor === undefined || raw === undefined) {
      this.accepting = this.current.enabled && !this.draining
      return
    }
    try {
      this.current = preferencesFromConfig(coerceServiceConfig(raw))
      this.sectionRevision = descriptor.revision
    } catch {
      this.lastFailure = 'invalid-settings'
    }
    this.accepting = this.current.enabled && !this.draining
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

  /** Requests this transport adapter prepared; identity prevents recursive routing. */
  private readonly routed = new WeakSet<GenerateOptions>()

  /** Route only the official review request, preserving its policy and history. */
  private routeNative(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    if (options.purpose !== 'auto-review' || this.routed.has(options)) return next()
    this.refresh()
    if (!this.current.enabled) return next()
    return this.nativeReviewStream(options)
  }

  /** This wraps transport only; the official plugin parses and applies the decision. */
  private async *nativeReviewStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.draining) throw new Error('auto-review: the routing adapter is closing')
    const completed = Promise.withResolvers<void>()
    this.active.add(completed.promise)
    const controller = new AbortController()
    const timeoutMs = this.current.timeoutMs
    const maxOutputTokens = this.current.maxOutputTokens
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const requestId = randomUUID()
    let began = false
    let finished = false
    let text = ''
    let signal: AbortSignal | undefined
    try {
      signal = AbortSignal.any([
        this.lifecycle.signal,
        controller.signal,
        ...(options.signal === undefined ? [] : [options.signal]),
      ])
      const route = resolveReviewerRoute({
        selection: this.current.reviewer,
        sessionRoute: {
          provider: options.provider,
          model: options.model,
          reasoningEffort:
            options.reasoningEffort === undefined ? null : String(options.reasoningEffort),
        },
        routes: await listAdvertisedRoutes(this.ctx),
      })
      const revision = this.revisionToken()
      await this.ledger().append({
        kind: 'native-request',
        seq: ++this.recordSeq,
        at: new Date().toISOString(),
        sessionId: String(options.sessionId ?? ''),
        requestId,
        selectionRevision: revision,
        policyOwner: '@deepseek-ai/dsh-experimental-auto-review',
        reviewer: {
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
        },
        timeoutMs,
        maxOutputTokens,
        request: { system: options.system ?? '', messages: JSON.stringify(options.messages) },
      })
      began = true
      const prepared = await deadline(this.prepare(route, maxOutputTokens, signal), signal)
      // Both the original request and prepared config are immutable. Copy controls
      // onto a new request; leave the official policy, messages and purpose intact.
      const request: GenerateOptions = {
        ...options,
        ...prepared.config,
        signal,
      }
      this.routed.add(request)
      const iterator = prepared.stream(request)[Symbol.asyncIterator]()
      try {
        for (;;) {
          const chunk = await deadline(iterator.next(), signal)
          if (chunk.done) break
          if (chunk.value.type === 'text-delta') text += chunk.value.text
          if (chunk.value.type === 'finish') finished = chunk.value.reason.kind === 'stop'
          yield chunk.value
        }
      } finally {
        this.routed.delete(request)
        if (iterator.return !== undefined) void iterator.return().catch(() => undefined)
      }
    } finally {
      clearTimeout(timer)
      try {
        if (began)
          await this.ledger().append({
            kind: 'native-response',
            seq: ++this.recordSeq,
            at: new Date().toISOString(),
            sessionId: String(options.sessionId ?? ''),
            requestId,
            status: signal?.aborted === true ? 'cancelled' : finished ? 'finished' : 'failed',
            text,
          })
      } finally {
        this.active.delete(completed.promise)
        completed.resolve()
      }
    }
  }

  /** Whether one Session selects the official `auto` preset, or cannot be read. */
  private autoSelection(session: Session): 'auto' | 'other' | 'unknown' {
    try {
      return this.ctx.permissionPresets.current(session) === AUTO_PRESET ? 'auto' : 'other'
    } catch {
      return 'unknown'
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
  private sessionRouteOf(session: Session): ReviewSessionRoute {
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
      this.routed.add(options)
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
        await this.recordResult(agent, frozen, beginRecord, 'stale', 'none')
        settled = true
        throw new Error('auto-review: the external permission ask changed during review')
      }
      const committed = await this.recordResult(
        agent,
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
        await this.recordResult(agent, frozen, beginRecord, 'stale', decision.decision, decision)
        throw Error('auto-review: external facts changed during outcome commit')
      }
      return decision
    } catch (error) {
      if (!settled)
        await this.recordResult(agent, frozen, beginRecord, 'deny', 'none').catch(() => undefined)
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
    sessionRoute: ReviewSessionRoute,
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
   * This outcome belongs only to the external approval bridge. Native records
   * retain the official request/response without interpreting authorization.
   * @returns the stored record key, or undefined when it could not be committed.
   */
  private async recordResult(
    agent: Agent,
    frozen: FrozenReview,
    record: string,
    status: 'allow' | 'ask' | 'deny' | 'stale' | 'cancel',
    reviewer: 'allow' | 'deny' | 'none',
    decision?: ReviewDecision,
    supersedes?: string,
  ): Promise<string | undefined> {
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
    if (!this.accepting) return preferences.enabled ? 'unavailable' : 'disabled'
    return ready ? 'ready' : 'unavailable'
  }
}

export default OplAutoReviewService
export { POLICY_VERSION }
