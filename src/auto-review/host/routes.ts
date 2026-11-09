/** Registered tool-free reviewer routes; default native and ZCode reviews use the dedicated Codex model. */
import type { Context } from '@deepseek-ai/cordis'
import type { AutoReviewRouteOption } from '../contracts/settings.ts'
import { JEV_DECISION_MODEL, JEV_TYPESAFE_MODEL } from '../../execution/host/adapters/jev.ts'
import { OFM_PROVIDERS } from '../../execution/host/ofm-source/provider.ts'

/**
 * Adapter routes that exist to expose an external Harness or combination and
 * must never be selected as a tool-free reviewer.
 */
export const EXCLUDED_REVIEW_PROVIDERS: readonly string[] = ['minimax-official']

/** Exact routes whose adapter returns the closed decision protocol directly. */
export const DECISION_REVIEW_ROUTES: readonly { provider: string; model: string }[] = [
  { provider: 'bamboo-startlux', model: 'startlux-decision-27b-autothink' },
  JEV_DECISION_MODEL,
  JEV_TYPESAFE_MODEL,
]

/** Whether a route is supplied as a decision model rather than a free-form reviewer. */
export function isDecisionReviewRoute(provider: string, model: string): boolean {
  return DECISION_REVIEW_ROUTES.some(
    (route) => route.provider === provider && route.model === model,
  )
}

/** Whether one provider route is excluded from reviewer selection. */
export function isExcludedReviewProvider(provider: string): boolean {
  return EXCLUDED_REVIEW_PROVIDERS.includes(provider)
}

/** Provider id the OPL Gateway registers its own model catalog under. */
export const OPENAI_GATEWAY_PROVIDER = 'opl-gateway'

/**
 * Prefix the Gateway's Codex discovery gives every OpenAI-protocol model.
 * `codex-auto-review` is the dedicated reviewer published under it.
 */
export const OPENAI_CODEX_MODEL_PREFIX = 'codex::'

/**
 * The dedicated reviewer identity. Selection requires its live catalog entry.
 */
export const OPENAI_AUTO_REVIEW_ROUTE = Object.freeze({
  provider: OPENAI_GATEWAY_PROVIDER,
  model: `${OPENAI_CODEX_MODEL_PREFIX}codex-auto-review`,
})

/** Whether one route is an OpenAI/Codex route served by the OPL Gateway. */
export function isOpenAiCodexRoute(route: { provider: string; model: string }): boolean {
  return (
    route.provider === OPENAI_GATEWAY_PROVIDER && route.model.startsWith(OPENAI_CODEX_MODEL_PREFIX)
  )
}

/**
 * List every registered, advertised, non-excluded model route that a tool-free
 * review request can prepare.
 *
 * A provider whose catalog or exact-model lookup fails is skipped rather than
 * guessed: an unknown directory is a missing route, not a route.
 * @param ctx - Host context carrying the official LLM service.
 * @returns detached route options in provider then model order.
 */
export async function listAdvertisedRoutes(ctx: Context): Promise<AutoReviewRouteOption[]> {
  let providers: readonly { id: string; name: string }[]
  try {
    providers = ctx.llm.listProviders()
  } catch {
    return []
  }
  const options: AutoReviewRouteOption[] = []
  const seen = new Set<string>()
  for (const provider of providers) {
    if (isExcludedReviewProvider(provider.id)) continue
    let models: readonly { id: string; name: string }[]
    try {
      models = await ctx.llm.listModels(provider.id)
    } catch {
      continue
    }
    for (const model of models) {
      // OFM's chat adapter does not implement System One; only the dedicated adapter may review with Jev.
      if (OFM_PROVIDERS.includes(provider.id) && model.id === JEV_DECISION_MODEL.model) continue
      const key = `${provider.id}\u0000${model.id}`
      if (seen.has(key) || provider.id.length === 0 || model.id.length === 0) continue
      let info: { reasoning?: { efforts: readonly { id: string }[]; defaultEffort?: string } }
      try {
        info = await ctx.llm.resolveModelInfo(provider.id, model.id)
      } catch {
        continue
      }
      seen.add(key)
      const reasoning = info.reasoning
      options.push({
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name,
        kind: isDecisionReviewRoute(provider.id, model.id) ? 'decision' : 'reviewer',
        efforts:
          reasoning === undefined ? [] : reasoning.efforts.map((effort) => String(effort.id)),
        defaultEffort:
          reasoning?.defaultEffort === undefined ? null : String(reasoning.defaultEffort),
      })
    }
  }
  return options
}

/** Whether one exact provider/model pair appears in an advertised route list. */
export function hasAdvertisedRoute(
  routes: readonly AutoReviewRouteOption[],
  provider: string,
  model: string,
): boolean {
  return matchingRoute(routes, provider, model) !== undefined
}

/** The advertised option for one exact provider/model pair, when there is one. */
export function matchingRoute(
  routes: readonly AutoReviewRouteOption[],
  provider: string,
  model: string,
): AutoReviewRouteOption | undefined {
  return routes.find((route) => route.provider === provider && route.model === model)
}

/**
 * Whether one effort is usable on an advertised route.
 *
 * An absent effort is always usable — the adapter applies its own default. A
 * present effort must be one the route advertises; an adapter that advertises
 * no efforts cannot confirm any, and the caller decides whether that is
 * acceptable for the mode it is resolving.
 * @param route - the advertised route.
 * @param effort - the requested effort, or null.
 * @returns whether the effort is confirmed or absent.
 */
export function effortConfirmed(route: AutoReviewRouteOption, effort: string | null): boolean {
  if (effort === null) return true
  return route.efforts.includes(effort)
}

/**
 * Why one exact provider/model pair is or is not usable right now.
 *
 * The three values are a real, closed vocabulary: `provider-not-registered`
 * means the catalog has no such provider at all, `model-not-advertised` means
 * the provider exists but does not advertise that model, and only `advertised`
 * permits a call.
 */
export type ReviewerRouteAvailability =
  'advertised' | 'provider-not-registered' | 'model-not-advertised'

/**
 * Classify one exact route against the live advertised catalog.
 * @param routes - the catalog {@link listAdvertisedRoutes} just returned.
 * @param provider - the exact provider id.
 * @param model - the exact model id.
 * @returns whether the pair is callable, and if not, which half is missing.
 */
export function reviewerRouteAvailability(
  routes: readonly AutoReviewRouteOption[],
  provider: string,
  model: string,
): ReviewerRouteAvailability {
  if (matchingRoute(routes, provider, model) !== undefined) return 'advertised'
  return routes.some((route) => route.provider === provider)
    ? 'model-not-advertised'
    : 'provider-not-registered'
}

/** Which rule of the route policy produced a resolved route. */
export type ReviewerRouteSource = 'fixed' | 'decision-model' | 'native-auto-review' | 'session'

/** The Session's own persisted request-header route, the review's context. */
export interface SessionReviewerRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | null
}

/** The reviewer selection as the settings surface stores it. */
export interface ReviewerRouteSelection {
  readonly mode: 'fixed' | 'decision' | 'current'
  readonly route?: { provider: string; model: string; reasoningEffort?: string }
}

/** One resolved, callable reviewer route with the rule that chose it. */
export interface ResolvedReviewerRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | null
  readonly source: ReviewerRouteSource
}

/**
 * The closed set of fixed refusals the route policy can produce. Every value is
 * safe to show: none carries provider text, a model id from an untrusted source,
 * or a message from the adapter.
 */
export type ReviewerRouteDiagnostic =
  | 'route-missing'
  | 'route-excluded'
  | 'route-unavailable'
  | 'preferred-route-unavailable'
  | 'effort-unadvertised'

/** A route refusal carrying the diagnostic the gate reports. */
export class ReviewerRouteError extends Error {
  readonly diagnostic: ReviewerRouteDiagnostic

  constructor(diagnostic: ReviewerRouteDiagnostic, message: string) {
    super(message)
    this.name = 'ReviewerRouteError'
    this.diagnostic = diagnostic
  }
}

/**
 * Resolve the reviewer route for one native review.
 *
 * An explicit fixed route wins. The default uses the dedicated Codex reviewer,
 * independently of the native conversation model and its reasoning effort.
 * The registered catalog must advertise the exact route.
 * @param input - the selection, the Session's own route and the live catalog.
 * @returns the callable route and the rule that chose it.
 * @throws {ReviewerRouteError} when no advertised route can serve the selection.
 */
export function resolveReviewerRoute(input: {
  readonly selection: ReviewerRouteSelection
  readonly sessionRoute: SessionReviewerRoute
  readonly routes: readonly AutoReviewRouteOption[]
}): ResolvedReviewerRoute {
  const { selection, sessionRoute, routes } = input
  if (selection.mode === 'fixed' || selection.mode === 'decision') {
    const fixed = selection.route
    if (fixed === undefined || fixed.provider.length === 0 || fixed.model.length === 0)
      throw new ReviewerRouteError(
        'route-missing',
        'auto-review: the fixed reviewer route is incomplete',
      )
    return admitRoute(
      { provider: fixed.provider, model: fixed.model },
      fixed.reasoningEffort ?? null,
      selection.mode === 'decision' ? 'decision-model' : 'fixed',
      routes,
      'route-unavailable',
      selection.mode === 'decision' ? 'decision' : 'reviewer',
    )
  }
  if (sessionRoute.provider.length === 0 || sessionRoute.model.length === 0)
    throw new ReviewerRouteError('route-missing', 'auto-review: no session route is available')
  if (isExcludedReviewProvider(sessionRoute.provider))
    throw new ReviewerRouteError(
      'route-excluded',
      'auto-review: this Harness owns its review policy',
    )
  return admitRoute(
    OPENAI_AUTO_REVIEW_ROUTE,
    null,
    'native-auto-review',
    routes,
    'preferred-route-unavailable',
  )
}

/**
 * Resolve the reviewer route for one external-Harness permission ask.
 *
 * The Harness's own conversation route belongs to the external model, so it is
 * never a reviewer route. An explicit fixed selection still wins; otherwise the
 * platform's OpenAI dedicated reviewer route is used, and its absence is a
 * refusal rather than a borrowed chat model.
 * @param input - the selection and the live catalog.
 * @returns the callable route and the rule that chose it.
 * @throws {ReviewerRouteError} when no advertised route can serve the selection.
 */
export function resolveExternalReviewerRoute(input: {
  readonly selection: ReviewerRouteSelection
  readonly routes: readonly AutoReviewRouteOption[]
}): ResolvedReviewerRoute {
  const fixed =
    input.selection.mode === 'fixed' || input.selection.mode === 'decision'
      ? input.selection.route
      : undefined
  if (fixed !== undefined) {
    if (fixed.provider.length === 0 || fixed.model.length === 0)
      throw new ReviewerRouteError(
        'route-missing',
        'auto-review: the fixed reviewer route is incomplete',
      )
    return admitRoute(
      { provider: fixed.provider, model: fixed.model },
      fixed.reasoningEffort ?? null,
      input.selection.mode === 'decision' ? 'decision-model' : 'fixed',
      input.routes,
      'route-unavailable',
      input.selection.mode === 'decision' ? 'decision' : 'reviewer',
    )
  }
  return admitRoute(
    OPENAI_AUTO_REVIEW_ROUTE,
    null,
    'native-auto-review',
    input.routes,
    'preferred-route-unavailable',
  )
}

/**
 * Admit one exact route candidate against the live catalog.
 *
 * The effort rule differs by source on purpose:
 *
 *  - a `fixed` selection names the effort the user chose, so an unadvertised
 *    one is refused;
 *  - the dedicated OpenAI reviewer is chosen by policy and the Session's chat
 *    effort is a fact about that chat route, not about the reviewer, so an
 *    effort the reviewer does not advertise is dropped rather than invented;
 *  - the Session's own route keeps the historical rule: an adapter that
 *    advertises no effort vocabulary cannot contradict the recorded fact, and
 *    one that does must confirm it.
 */
function admitRoute(
  candidate: { readonly provider: string; readonly model: string },
  effort: string | null,
  source: ReviewerRouteSource,
  routes: readonly AutoReviewRouteOption[],
  unavailable: Extract<
    ReviewerRouteDiagnostic,
    'route-unavailable' | 'preferred-route-unavailable'
  >,
  requiredKind?: 'reviewer' | 'decision',
): ResolvedReviewerRoute {
  if (isExcludedReviewProvider(candidate.provider))
    throw new ReviewerRouteError(
      'route-excluded',
      'auto-review: the reviewer route is not a direct pure-LLM route',
    )
  const availability = reviewerRouteAvailability(routes, candidate.provider, candidate.model)
  if (availability !== 'advertised')
    throw new ReviewerRouteError(
      unavailable,
      availability === 'provider-not-registered'
        ? 'auto-review: the reviewer route provider is not registered'
        : 'auto-review: the reviewer route model is not advertised',
    )
  const advertised = matchingRoute(
    routes,
    candidate.provider,
    candidate.model,
  ) as AutoReviewRouteOption
  if (
    requiredKind !== undefined &&
    (requiredKind === 'decision' ? advertised.kind !== 'decision' : advertised.kind === 'decision')
  )
    throw new ReviewerRouteError(unavailable, 'auto-review: the reviewer route kind is unavailable')
  const confirmed = effortConfirmed(advertised, effort)
  if (effort !== null && !confirmed) {
    if (
      source === 'fixed' ||
      source === 'decision-model' ||
      (source === 'session' && advertised.efforts.length > 0)
    )
      throw new ReviewerRouteError(
        'effort-unadvertised',
        'auto-review: the reviewer effort is not advertised',
      )
    // Only the policy-chosen reviewer drops an effort it does not publish. The
    // Session's own route with no effort vocabulary keeps the recorded fact.
    if (source === 'native-auto-review')
      return Object.freeze({
        provider: candidate.provider,
        model: candidate.model,
        reasoningEffort: null,
        source,
      })
  }
  return Object.freeze({
    provider: candidate.provider,
    model: candidate.model,
    reasoningEffort: effort,
    source,
  })
}
