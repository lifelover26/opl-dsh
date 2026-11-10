/**
 * Persisted Auto Review preferences and their closed validation.
 *
 * One flat service config is both the plugin's `static Config` and the section
 * stored under the exclusive `opl-auto-review` settings namespace, so the
 * official settings surface and this service read the same fields. The
 * Remote-facing shape is the shared {@link AutoReviewPreferences} DTO.
 *
 * `revision` is a content digest of the normalized preferences: it is a
 * comparison token for compare-and-swap saves and review freshness, never a
 * substitute for the facts the review recorded.
 */
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import {
  AUTO_REVIEW_BUDGET_RANGE,
  type AutoReviewPreferences,
  type AutoReviewRoute,
} from '../contracts/settings.ts'

/**
 * Exclusive field this service owns inside the `opl-suite` profile entry.
 *
 * The official settings surface edits a profile entry's fields, so the service
 * stores its selection as one volatile field of the entry the suite already
 * owns instead of claiming a namespace of its own.
 */
export const AUTO_REVIEW_FIELD = 'toolAutoReview'
/** Profile entry that carries {@link AUTO_REVIEW_FIELD}. */
export const AUTO_REVIEW_OWNER_NS = 'opl-suite'

/** OPL reviewer routing and the external approval bridge are off by default. */
export const DEFAULT_ENABLED = false
/** Review request deadline; a suggestion, not a calibrated value. */
export const DEFAULT_TIMEOUT_MS = 30000
/** Reviewer output ceiling; a suggestion, not a calibrated value. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

/** Bounds shared with the Client surface; a deadline outside these is invalid. */
export const MIN_TIMEOUT_MS = AUTO_REVIEW_BUDGET_RANGE.timeoutMs.min
export const MAX_TIMEOUT_MS = AUTO_REVIEW_BUDGET_RANGE.timeoutMs.max
/** Bounds shared with the Client surface; a ceiling outside these is invalid. */
export const MIN_MAX_OUTPUT_TOKENS = AUTO_REVIEW_BUDGET_RANGE.maxOutputTokens.min
export const MAX_MAX_OUTPUT_TOKENS = AUTO_REVIEW_BUDGET_RANGE.maxOutputTokens.max

/**
 * The flat service configuration. An empty `reviewerProvider` selects the
 * dedicated Codex reviewer; an explicit provider selects a fixed reviewer or
 * decision model according to `reviewerKind`.
 */
export interface Config {
  enabled: boolean
  reviewerProvider: string
  reviewerModel: string
  reviewerEffort: string
  reviewerKind: 'reviewer' | 'decision'
  timeoutMs: number
  maxOutputTokens: number
}

/** Schemastery schema for {@link Config}; also the plugin's `static Config`. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_ENABLED),
  reviewerProvider: z.string().default(''),
  reviewerModel: z.string().default(''),
  reviewerEffort: z.string().default(''),
  reviewerKind: z.union([z.const('reviewer'), z.const('decision')]).default('reviewer'),
  timeoutMs: z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  maxOutputTokens: z
    .number()
    .step(1)
    .min(MIN_MAX_OUTPUT_TOKENS)
    .max(MAX_MAX_OUTPUT_TOKENS)
    .default(DEFAULT_MAX_OUTPUT_TOKENS),
})

/** A settings section as this service accepts it, with every field optional. */
export type SettingsSection = Partial<Record<keyof Config, unknown>>

/** The composition defaults; also the fallback without a settings store. */
export const DEFAULT_PREFERENCES: AutoReviewPreferences = Object.freeze({
  enabled: DEFAULT_ENABLED,
  reviewer: Object.freeze({ mode: 'current' as const }),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readBoundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  return value >= min && value <= max ? value : undefined
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Coerce one settings section (or plugin config) into the complete flat form.
 *
 * Unknown keys are ignored — a profile may carry fields this build no longer
 * knows — but a present field with an unusable value falls back to its default
 * rather than being silently reinterpreted.
 * @param value - the raw section or already-validated plugin config.
 * @returns a complete configuration.
 */
export function coerceServiceConfig(value: unknown): Config {
  const record = isRecord(value) ? value : {}
  const reviewerProvider = readText(record['reviewerProvider']) ?? ''
  const reviewerModel = readText(record['reviewerModel']) ?? ''
  return {
    enabled: typeof record['enabled'] === 'boolean' ? record['enabled'] : DEFAULT_ENABLED,
    reviewerProvider,
    reviewerModel,
    reviewerEffort: readText(record['reviewerEffort']) ?? '',
    reviewerKind:
      record['reviewerKind'] === 'decision' ||
      (reviewerProvider === 'bamboo-startlux' &&
        reviewerModel === 'startlux-decision-27b-autothink')
        ? 'decision'
        : 'reviewer',
    timeoutMs:
      readBoundedInteger(record['timeoutMs'], MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
    maxOutputTokens:
      readBoundedInteger(record['maxOutputTokens'], MIN_MAX_OUTPUT_TOKENS, MAX_MAX_OUTPUT_TOKENS) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
  }
}

/**
 * Project the flat configuration onto the Remote-facing preferences.
 *
 * A reviewer naming a provider without a model (or the reverse) is an
 * incomplete fixed selection, not a silent request for the current route, so
 * it is refused rather than reinterpreted.
 * @param config - a complete flat configuration.
 * @returns the equivalent preferences.
 * @throws when the reviewer selection is half specified.
 */
export function preferencesFromConfig(config: Config): AutoReviewPreferences {
  const named = config.reviewerProvider.length > 0 || config.reviewerModel.length > 0
  if (named && (config.reviewerProvider.length === 0 || config.reviewerModel.length === 0))
    throw new Error('auto-review: the fixed reviewer needs both a provider and a model')
  const reviewer: AutoReviewPreferences['reviewer'] = named
    ? {
        mode: config.reviewerKind === 'decision' ? 'decision' : 'fixed',
        route: {
          provider: config.reviewerProvider,
          model: config.reviewerModel,
          ...(config.reviewerEffort.length > 0 ? { reasoningEffort: config.reviewerEffort } : {}),
        },
      }
    : { mode: 'current' }
  return {
    enabled: config.enabled,
    reviewer,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
  }
}

/**
 * Project the Remote-facing preferences onto the flat configuration.
 * @param preferences - validated preferences.
 * @returns the equivalent flat section.
 */
export function configFromPreferences(preferences: AutoReviewPreferences): Config {
  const route = preferences.reviewer.mode === 'current' ? undefined : preferences.reviewer.route
  return {
    enabled: preferences.enabled,
    reviewerProvider: route?.provider ?? '',
    reviewerModel: route?.model ?? '',
    reviewerEffort: route?.reasoningEffort ?? '',
    reviewerKind: preferences.reviewer.mode === 'decision' ? 'decision' : 'reviewer',
    timeoutMs: preferences.timeoutMs,
    maxOutputTokens: preferences.maxOutputTokens,
  }
}

/**
 * Validate one untrusted preferences value into the closed DTO shape.
 *
 * Extra members, wrong member types, an unbounded number, and a fixed route
 * missing its provider or model are all rejected; the caller turns the throw
 * into the fixed `invalid-settings` label.
 * @param value - the untrusted value from a Remote request.
 * @returns detached, frozen preferences.
 * @throws when the value does not match the preferences contract.
 */
export function normalizePreferences(value: unknown): AutoReviewPreferences {
  if (!isRecord(value)) throw new Error('auto-review: preferences must be an object')
  const keys = Object.keys(value)
  if (keys.some((key) => !['enabled', 'reviewer', 'timeoutMs', 'maxOutputTokens'].includes(key)))
    throw new Error('auto-review: preferences carry an unknown member')
  if (typeof value['enabled'] !== 'boolean')
    throw new Error('auto-review: enabled must be a boolean')
  const timeoutMs = readBoundedInteger(value['timeoutMs'], MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  if (timeoutMs === undefined) throw new Error('auto-review: timeoutMs is out of range')
  const maxOutputTokens = readBoundedInteger(
    value['maxOutputTokens'],
    MIN_MAX_OUTPUT_TOKENS,
    MAX_MAX_OUTPUT_TOKENS,
  )
  if (maxOutputTokens === undefined) throw new Error('auto-review: maxOutputTokens is out of range')
  return Object.freeze({
    enabled: value['enabled'],
    reviewer: normalizeReviewer(value['reviewer']),
    timeoutMs,
    maxOutputTokens,
  })
}

/** Validate the reviewer selection and its optional fixed route. */
function normalizeReviewer(value: unknown): AutoReviewPreferences['reviewer'] {
  if (!isRecord(value)) throw new Error('auto-review: reviewer must be an object')
  const mode = value['mode']
  if (mode === 'current') {
    if (Object.keys(value).some((key) => key !== 'mode'))
      throw new Error('auto-review: a current reviewer carries no route')
    return Object.freeze({ mode: 'current' as const })
  }
  if (mode !== 'fixed' && mode !== 'decision')
    throw new Error('auto-review: reviewer mode must be current, fixed, or decision')
  if (Object.keys(value).some((key) => key !== 'mode' && key !== 'route'))
    throw new Error('auto-review: a fixed reviewer carries an unknown member')
  const route = normalizeRoute(value['route'])
  return Object.freeze({ mode, route })
}

/** Validate one fixed reviewer route. */
function normalizeRoute(value: unknown): AutoReviewRoute {
  if (!isRecord(value)) throw new Error('auto-review: a fixed reviewer requires a route')
  const keys = Object.keys(value)
  if (keys.some((key) => !['provider', 'model', 'reasoningEffort'].includes(key)))
    throw new Error('auto-review: the reviewer route carries an unknown member')
  const provider = value['provider']
  const model = value['model']
  if (typeof provider !== 'string' || provider.trim() === '')
    throw new Error('auto-review: the reviewer route needs a provider')
  if (typeof model !== 'string' || model.trim() === '')
    throw new Error('auto-review: the reviewer route needs a model')
  const effort = value['reasoningEffort']
  if (effort !== undefined && (typeof effort !== 'string' || effort.trim() === ''))
    throw new Error('auto-review: the reviewer effort must be a non-empty string')
  return Object.freeze({
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  })
}

/** The canonical comparison form of one preferences value. */
function canonicalPreferences(preferences: AutoReviewPreferences): string {
  const reviewer =
    preferences.reviewer.mode === 'fixed' || preferences.reviewer.mode === 'decision'
      ? {
          mode: preferences.reviewer.mode,
          route: {
            provider: preferences.reviewer.route.provider,
            model: preferences.reviewer.route.model,
            reasoningEffort: preferences.reviewer.route.reasoningEffort ?? null,
          },
        }
      : { mode: 'current' }
  return JSON.stringify({
    enabled: preferences.enabled,
    reviewer,
    timeoutMs: preferences.timeoutMs,
    maxOutputTokens: preferences.maxOutputTokens,
  })
}

/**
 * The compare-and-swap token for one preferences value.
 * @param preferences - validated preferences.
 * @returns a stable content digest.
 */
export function revisionOf(preferences: AutoReviewPreferences): string {
  return createHash('sha256').update(canonicalPreferences(preferences)).digest('hex').slice(0, 32)
}

/** Whether two preferences values are the same selection. */
export function samePreferences(
  left: AutoReviewPreferences,
  right: AutoReviewPreferences,
): boolean {
  return canonicalPreferences(left) === canonicalPreferences(right)
}
