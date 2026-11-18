/** Exact OPL Gemini identities and the official Antigravity ACP selection fields. */
import { GATEWAY_ANTIGRAVITY_GEMINI_MODELS } from '../../../../shared/models.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Execution engine used for the Gateway's native Gemini endpoint. */
export const ANTIGRAVITY_HARNESS = 'antigravity'
/** Gateway models whose native Gemini routes this adapter supports. */
export const ANTIGRAVITY_GATEWAY_MODELS: readonly string[] = GATEWAY_ANTIGRAVITY_GEMINI_MODELS
/** Thinking levels verified across the supported models in Antigravity 1.5.9. */
export const ANTIGRAVITY_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const
const MODEL_THINKING_LEVELS: Record<
  string,
  readonly (typeof ANTIGRAVITY_THINKING_LEVELS)[number][]
> = {
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-4-carbon': ['low', 'medium', 'high'],
  'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'],
}
/** Default applied explicitly when the combination expresses no thinking choice. */
export const ANTIGRAVITY_DEFAULT_THINKING = 'high'
/** Official ACP config-option identity for the wire model. */
export const ANTIGRAVITY_MODEL_OPTION = 'model'
/** Official ACP config-option identity for thinking strength. */
export const ANTIGRAVITY_THINKING_OPTION = 'thought_level'

/** Return the exact native model id only for this Gateway group and supported pair. */
export function antigravityWireModel(ref: ModelRef): string | undefined {
  if (ref.provider !== 'opl-gateway' || !ref.model.startsWith('gemini::')) return undefined
  const model = ref.model.slice('gemini::'.length)
  return ANTIGRAVITY_GATEWAY_MODELS.includes(model) ? model : undefined
}

/** Test whether this adapter can select the exact Gateway model reference. */
export function isAntigravityGatewayModel(ref: ModelRef): boolean {
  return antigravityWireModel(ref) !== undefined
}

/** Parsed select values and current selection from an ACP wire advertisement. */
export interface AntigravitySelectOption {
  readonly currentValue: string
  readonly values: readonly string[]
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Read one unambiguous, well-formed select option from the official ACP response. */
export function antigravityConfigOption(
  options: unknown,
  id: string,
): AntigravitySelectOption | undefined {
  if (!Array.isArray(options)) return undefined
  const matching = options.map(object).filter((option) => option?.id === id)
  if (matching.length !== 1) return undefined
  const option = matching[0]!
  if (
    option.type !== 'select' ||
    typeof option.currentValue !== 'string' ||
    !Array.isArray(option.options)
  )
    return undefined
  const values: string[] = []
  for (const entry of option.options) {
    const value = object(entry)?.value
    if (typeof value !== 'string' || !value || values.includes(value)) return undefined
    values.push(value)
  }
  if (!values.includes(option.currentValue)) return undefined
  return { currentValue: option.currentValue, values }
}

/** Supported thinking tiers for a specific Antigravity model ID. */
export function antigravityThinkingLevelsFor(
  model?: string,
): readonly (typeof ANTIGRAVITY_THINKING_LEVELS)[number][] {
  return (model && MODEL_THINKING_LEVELS[model]) || ['low', 'medium', 'high']
}

/** Resolve a choice this adapter can pin; an explicit unsupported effort is never dropped. */
export function antigravityThinking(
  requested: string | undefined,
  model?: string,
): (typeof ANTIGRAVITY_THINKING_LEVELS)[number] | undefined {
  if (requested === undefined) return ANTIGRAVITY_DEFAULT_THINKING
  return antigravityThinkingLevelsFor(model).find((level) => level === requested)
}
