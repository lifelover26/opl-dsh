/** Endpoint prefixes consumed by the official provider SDKs and Gateway model listing. */
import { OPL_GATEWAY_INFERENCE_BASE_URL } from './opl-credentials.ts'

/** Anthropic's SDK appends `/v1/messages` to its configured prefix. */
export const OPL_GATEWAY_ANTHROPIC_BASE_URL = OPL_GATEWAY_INFERENCE_BASE_URL.slice(0, -3)

/** Native Gemini API published by the same Gateway, independently of its Chat prefix. */
export const OPL_GATEWAY_GEMINI_NATIVE_BASE_URL = 'https://gateway.medopl.com'

/** Return the default prefix for one protocol; custom endpoints are resolved separately. */
export function gatewayInferenceBaseURL(api: string): string {
  switch (api) {
    case 'anthropic-messages':
      return OPL_GATEWAY_ANTHROPIC_BASE_URL
    case 'messages':
    case 'openai-completions':
    case 'openai-responses':
      return OPL_GATEWAY_INFERENCE_BASE_URL
    default:
      throw Error('Unsupported Gateway protocol')
  }
}

/** Identify only the two endpoint spellings owned by the current OPL bundle. */
export function isDefaultGatewayBaseURL(value: unknown): boolean {
  return value === OPL_GATEWAY_INFERENCE_BASE_URL || value === OPL_GATEWAY_ANTHROPIC_BASE_URL
}

/**
 * Keep model listing on the same endpoint prefix as inference. Gateway lists
 * every group with OpenAI bearer auth, including its Anthropic inference groups.
 * @param baseURL - effective inference prefix, without URL credentials or query data.
 * @param api - protocol whose SDK consumes that prefix.
 * @returns OpenAI listing prefix; the discovery service appends `/models`.
 * @throws Error when the configured URL or protocol cannot identify a listing prefix.
 */
export function gatewayDiscoveryBaseURL(baseURL: string, api: string): string {
  if (!['messages', 'openai-completions', 'openai-responses', 'anthropic-messages'].includes(api))
    throw Error('Unsupported Gateway protocol')
  const url = new URL(baseURL)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error('Invalid Gateway endpoint')
  const prefix = baseURL.replace(/\/+$/u, '')
  return api === 'anthropic-messages' && !prefix.endsWith('/v1') ? `${prefix}/v1` : prefix
}
