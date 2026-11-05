/**
 * Turn a resolved model-source route into the official CLI's own configuration.
 *
 * The route is owned by the model-source plugin and reaches this adapter only through
 * `options.modelSources.resolve`, which already rejects an incompatible protocol and a
 * source that was replaced or unloaded while the read was in flight. This module adds
 * nothing of its own: it serialises exactly what the source returned, refuses anything
 * it cannot express, and never repairs, rewrites, or substitutes an endpoint, a key, or
 * a model id.
 *
 * The configuration travels through `OPENCODE_CONFIG_CONTENT`, which the pinned CLI
 * reads from its own environment and merges as the highest-precedence `local` source
 * (verified: `opencode debug config` reports the merged document, and a config that sets
 * `shell` reaches the shell selector). Nothing is written into the user's config files,
 * and the key never reaches a log, an error, or a repository file.
 */
import type { ExternalModelRoute } from '../../model-sources.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { OPENCODE_PROTOCOL } from './opencode-models.ts'

/**
 * Provider id used inside the CLI's own namespace, chosen to avoid user collisions.
 *
 * A dedicated namespace also keeps this suite's route separate from OpenCode's built-in
 * `opencode/*` catalog: adding a source never removes or shadows a model the CLI ships.
 */
export const OPENCODE_ROUTE_PROVIDER_ID = 'oplopencode'
/**
 * The only wire protocol this suite bridges.
 *
 * The pinned CLI bundles `@ai-sdk/openai-compatible` for a custom provider, which speaks
 * OpenAI Chat Completions. The bundled Responses and Anthropic loaders build their own
 * upstream request shapes, so `responses` and `messages` are refused instead of
 * approximated.
 */
export const OPENCODE_SUPPORTED_PROTOCOLS = [OPENCODE_PROTOCOL] as const
/** Bundled by the official CLI, so no provider SDK is fetched at launch time. */
const OPENCODE_NPM = '@ai-sdk/openai-compatible'

/** The exact `model` config value the CLI must advertise and then report. */
export function openCodeModelValue(model: string): string {
  return `${OPENCODE_ROUTE_PROVIDER_ID}/${model}`
}

/**
 * Reject a route this suite cannot express exactly.
 *
 * `model` is the model the session record is bound to. A source that resolves a
 * different model is refused rather than followed: the record's model is the one the
 * user chose, and silently running another model is never acceptable.
 *
 * @throws when the protocol is unsupported, the model differs, or a field is unsafe.
 */
function assertExpressible(route: ExternalModelRoute, model: string): void {
  if (!OPENCODE_SUPPORTED_PROTOCOLS.includes(route.protocol as 'chat'))
    throw new HarnessConfigurationError(
      `所选来源的协议（${route.protocol}）未被官方 OpenCode 适配验证；官方仅为自定义端点打包了 OpenAI 兼容的 provider 适配器（Chat Completions），其余协议需要各自的服务端适配器，本套件未实现。已停止，未启动 OpenCode，未猜测端点或模型。`,
    )
  if (route.model !== model)
    throw new HarnessConfigurationError(
      `模型来源返回的模型（${route.model}）与所选组合（${model}）不一致；已停止，未启动 OpenCode，不会静默改用其他模型。`,
    )
  if (!model.trim() || /[\r\n\0]/.test(model))
    throw new HarnessConfigurationError('模型来源未提供可用的模型 ID，已停止，未启动 OpenCode。')
  if (!route.apiKey.trim())
    throw new HarnessConfigurationError('模型来源未提供可用凭据，已停止，未启动 OpenCode。')
  if (!route.baseURL.trim())
    throw new HarnessConfigurationError('模型来源未提供可用端点，已停止，未启动 OpenCode。')
}

export interface OpenCodeRouteConfig {
  /** Serialised configuration handed to the child through `OPENCODE_CONFIG_CONTENT`. */
  readonly content: string
  /** The exact model value this configuration makes the CLI advertise. */
  readonly modelValue: string
  /** Never logged or echoed; exposed only so diagnostics can prove it was populated. */
  readonly hasKey: true
}

/**
 * Serialise one resolved route into the official CLI's configuration format.
 *
 * The provider declares exactly the bound model and no variants, so this namespace's
 * model option holds exactly one value and the pinned value is unambiguous — including
 * when the model id itself contains `/` or `:`, both verified against the pinned binary.
 *
 * @param route - the route the owning source resolved.
 * @param model - the model the session record is bound to; must match `route.model`.
 * @returns the configuration content and the model value it pins.
 */
export function buildOpenCodeRouteConfig(
  route: ExternalModelRoute,
  model: string,
): OpenCodeRouteConfig {
  assertExpressible(route, model)
  const modelValue = openCodeModelValue(model)
  return {
    content: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [OPENCODE_ROUTE_PROVIDER_ID]: {
          npm: OPENCODE_NPM,
          name: 'OPL Route',
          options: { baseURL: route.baseURL, apiKey: route.apiKey },
          models: {
            [model]: {
              name: model,
              ...(route.imageInput === true
                ? { modalities: { input: ['text', 'image'], output: ['text'] } }
                : {}),
            },
          },
        },
      },
    }),
    modelValue,
    hasKey: true,
  }
}
