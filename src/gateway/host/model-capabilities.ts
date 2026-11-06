/** Exact model inputs from public pi-ai provider catalogs. */
import { GATEWAY_GROUPS, type GatewayGroupId } from '../contracts/groups.ts'
import type { ModelDraft } from '../contracts/models.ts'
import { gatewayInferenceBaseURL } from './protocol.ts'
import { OPL_GATEWAY_INFERENCE_BASE_URL } from './opl-credentials.ts'

/** Exact input declarations; they neither advertise models nor verify Gateway image acceptance. */
export const GATEWAY_MODEL_INPUT_DEFAULTS = [
  { group: 'codex', id: 'gpt-6-astra', input: ['text', 'image'] },
  { group: 'codex', id: 'gpt-6.1-sol', input: ['text', 'image'] },
  { group: 'codex', id: 'gpt-6-sol', input: ['text', 'image'] },
  { group: 'codex', id: 'gpt-6-luna', input: ['text', 'image'] },
  { group: 'codex', id: 'gpt-6.1-terra', input: ['text', 'image'] },
  { group: 'aws', id: 'claude-opus-5-5', input: ['text', 'image'] },
  { group: 'kiro', id: 'claude-opus-5-5', input: ['text', 'image'] },
  { group: 'grok', id: 'grok-4.7', input: ['text', 'image'] },
  { group: 'gemini', id: 'gemini-4-argon', input: ['text', 'image'] },
  { group: 'gemini', id: 'gemini-3.8-flash', input: ['text', 'image'] },
  { group: 'gemini', id: 'gemini-3.1-pro', input: ['text', 'image'] },
] as const

/**
 * Fill absent or empty inputs only on exact bundled routes and model IDs. An unchanged
 * automatic catalog can refresh its former text defaults; user input policies,
 * custom endpoints, credentials, and protocols remain authoritative.
 * @param group - Gateway credential group.
 * @param profile - effective provider connection and optional modality policy.
 * @param models - candidate or configured models, including lossless JSON extensions.
 * @param options - whether a matching saved catalog hash identifies automatic input defaults.
 * @returns models with approved missing or automatic input declarations completed.
 */
export function withGatewayModelInputDefaults(
  group: GatewayGroupId,
  profile: { api?: unknown; baseURL?: unknown; apiKeyEnv?: unknown; defaultInput?: unknown },
  models: readonly ModelDraft[],
  options: { refreshAutomaticInputs?: boolean } = {},
): ModelDraft[] {
  const definition = GATEWAY_GROUPS.find((item) => item.id === group)!
  if (
    profile.api !== definition.api ||
    profile.apiKeyEnv !== definition.credential ||
    profile.defaultInput !== undefined ||
    (profile.baseURL !== gatewayInferenceBaseURL(definition.api) &&
      !(
        definition.api === 'anthropic-messages' &&
        profile.baseURL === OPL_GATEWAY_INFERENCE_BASE_URL
      ))
  )
    return [...models]
  return models.map((model) => {
    const missingInput =
      model.input === undefined || (Array.isArray(model.input) && model.input.length === 0)
    const automaticDefault =
      options.refreshAutomaticInputs === true &&
      Array.isArray(model.input) &&
      model.input.length === 1 &&
      model.input[0] === 'text'
    if (!missingInput && !automaticDefault) return model
    const declared = GATEWAY_MODEL_INPUT_DEFAULTS.find(
      (entry) => entry.group === group && entry.id === model.id,
    )
    return declared ? { ...model, input: [...declared.input] } : model
  })
}
