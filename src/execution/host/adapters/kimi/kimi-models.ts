import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalWireProtocol } from '../../model-sources.ts'

/** Harness identity in the suite's Harness catalog. */
export const KIMI_HARNESS = 'kimi-code'
/** The model provider that owns the combinations this harness serves. */
export const KIMI_PROVIDER = 'our-free-model'

/**
 * ACP config-option ids advertised by `kimi acp` (verified against 2.1.1).
 * `thinking` only exists for a model whose catalog row declares thinking support.
 */
export const KIMI_MODEL_OPTION = 'model'
export const KIMI_THINKING_OPTION = 'thinking'
export const KIMI_MODE_OPTION = 'mode'

/**
 * The catalog id the official CLI exposes for a route supplied through the environment.
 *
 * `applyEnvModelConfig()` in the published build registers the route under the fixed
 * alias `__kimi_env_model__` and sets it as `defaultModel`, so `session/new` advertises
 * exactly one `model` value: this alias. The model's real name is carried separately by
 * `KIMI_MODEL_NAME` and is what goes on the wire. Measured against the 2.1.1 binary
 * with a loopback provider: the advertisement was `["__kimi_env_model__"]` while the
 * recorded request body carried `model: "moonshotai/kimi-k3"`.
 */
export const KIMI_ENV_MODEL_ALIAS = '__kimi_env_model__'

/**
 * The protocol this harness pins.
 *
 * `modelSources.resolve` takes the expected protocol as an argument, so the caller must
 * choose before the source answers. `messages` is the verified pairing: the 2.1.1 binary
 * sent `POST /v1/messages?beta=true` with `anthropic-version: 2023-06-01` to the route
 * supplied by the source. A source that declares a different protocol fails closed.
 */
export const KIMI_PROTOCOL: ExternalWireProtocol = 'messages'

/**
 * The provider type the CLI needs for each wire protocol.
 *
 * The official env overlay accepts only `kimi`, `anthropic`, and `openai`; anything else
 * makes the CLI exit at start-up. `responses` has no equivalent, so it is refused here
 * rather than passed through to be rejected by the child.
 */
const PROVIDER_TYPE: Partial<Record<ExternalWireProtocol, string>> = {
  messages: 'anthropic',
  chat: 'openai',
}

/**
 * Translate a suite wire protocol into the official `KIMI_MODEL_PROVIDER_TYPE` value.
 * @returns the provider type, or `undefined` when the CLI cannot express the protocol.
 */
export function kimiProviderType(protocol: ExternalWireProtocol): string | undefined {
  return PROVIDER_TYPE[protocol]
}

/** Protocols this harness can express to the official CLI. */
export const KIMI_PROTOCOLS: readonly ExternalWireProtocol[] = [KIMI_PROTOCOL, 'chat']

/**
 * Return the caller's requested thinking value without inventing one.
 *
 * The offered values differ per model (`off` plus declared efforts, or `off`/`on`), so
 * there is no default effort to fall back on. An absent choice stays absent and the CLI
 * keeps its own default.
 */
export function kimiThinkingValue(requested?: string): string | undefined {
  const choice = typeof requested === 'string' ? requested.trim() : ''
  return choice.length > 0 ? choice : undefined
}

/** The exact wire models this harness serves, and nothing else. */
export const KIMI_MODELS: readonly string[] = [
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k3',
  'moonshotai/kimi-k3.1-pro',
]

/**
 * Whether this adapter serves the given reference.
 *
 * The list is an exact allowset. Other models published by the same provider — other
 * Moonshot-family coding models, GLM, or OSS entries — belong to other harnesses, and
 * claiming them here would hand this harness traffic it has no admission for.
 */
export function isKimiCodeModel(ref: ModelRef): boolean {
  return ref.provider === KIMI_PROVIDER && KIMI_MODELS.includes(ref.model)
}

/** Environment the official CLI reads for a route supplied by the suite. */
export const KIMI_ROUTE_ENV = {
  model: 'KIMI_MODEL_NAME',
  apiKey: 'KIMI_MODEL_API_KEY',
  baseUrl: 'KIMI_MODEL_BASE_URL',
  providerType: 'KIMI_MODEL_PROVIDER_TYPE',
  /** Owned runtime data root; isolates the CLI from any Moonshot account profile. */
  home: 'KIMI_CODE_HOME',
} as const
