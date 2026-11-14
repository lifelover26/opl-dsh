import type { ExternalModelRoute } from '../../model-sources.ts'
import { buildBuiltinProviderConfig } from '../zcode-protocol.ts'
import { OFM_PROVIDER } from '../../ofm-source/provider.ts'

export const ZCODE_OFM_HARNESS = 'zcode'
/** Exact registry provider this route claims. The region route is not claimed here. */
export const ZCODE_OFM_PROVIDER_ID = OFM_PROVIDER

/**
 * Models this run adapts through ZCode.
 *
 * These ids are the Our Free Model catalog ids, not ZCode's own `GLM-5.3`
 * spelling. They are an adaptation intent, not proof of availability: the owning
 * plugin's live catalog decides that, and `resolve()` proves it before every launch.
 *
 * The EAC AMD lane keeps its namespaced id through the same personal provider.
 */
export const ZCODE_OFM_MODELS = ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'amd/GLM-5.3-Flash'] as const
export type ZcodeOfmModel = (typeof ZCODE_OFM_MODELS)[number]

/** Wire protocol this route speaks. `openai-chat-completions` is the only OFM surface ZCode has. */
export const ZCODE_OFM_WIRE_PROTOCOL = 'chat'

export const ZCODE_OFM_REASONING_LEVELS = ['disabled', 'enabled'] as const
export type ZcodeOfmReasoningLevel = (typeof ZCODE_OFM_REASONING_LEVELS)[number]

/**
 * Used only when the caller expressed no reasoning choice.
 *
 * `enabled` never silently disables the thinking these models are used for, and it is
 * one of the two levels the official config declares. An explicit caller choice is
 * honored verbatim and is never rewritten onto this value.
 */
export const ZCODE_OFM_DEFAULT_REASONING_LEVEL: ZcodeOfmReasoningLevel = 'enabled'

export const OFM_RELAY_PLACEHOLDER_KEY = 'opl-ofm-relay-placeholder'

/** The relay binds loopback only; it is never reachable from another host. */
export const OFM_RELAY_HOST = '127.0.0.1'
/** Header carrying the per-session relay ticket. Not a credential. */
export const OFM_RELAY_TICKET_HEADER = 'x-opl-ofm-relay-ticket'
/** Upper bound on a buffered request body, so the relay cannot exhaust memory. */
export const OFM_RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024
/** Provider id used inside ZCode's own provider config for this route. */
export const OFM_ZCODE_PROVIDER_ID = 'our-free-model-zcode'
/** Display name for the provider entry the official CLI will show. */
export const OFM_ZCODE_PROVIDER_NAME = 'Our Free Model'

/**
 * Model properties for the GLM-5 family.
 *
 * Copied from the same official shipped `zcode-builtin.json` rule that declares the
 * reasoning levels (`contextWindow` 200000, text in / text out, tool calls), merged
 * with the shipped `.*` defaults for the remaining flags. They describe the model
 * family, not a measured GLM-5.3 serving profile, so nothing is inflated here.
 */
export const OFM_MODEL_PROPERTIES = {
  requiresMfjsToolSchema: false,
  contextWindow: 200000,
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: false,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: false,
} as const

/** Whether this run adapts `model` on this route. */
export function isZcodeOfmModel(model: string): boolean {
  return (ZCODE_OFM_MODELS as readonly string[]).includes(model)
}

/** Whether this run adapts the exact combination. */
export function isZcodeOfmRef(ref: { provider: string; model: string }): boolean {
  return ref.provider === ZCODE_OFM_PROVIDER_ID && isZcodeOfmModel(ref.model)
}

/**
 * Resolve the reasoning level a session may run with.
 *
 * A requested level the official config does not declare for these models is a
 * refusal, not something to clamp: `max` and `high` belong to a different model, and
 * silently running `enabled` instead would hide the difference.
 *
 * @param requested - the caller's choice; absent or blank selects the default.
 * @returns the level to pin, or undefined when the choice is not declared.
 */
export function zcodeOfmReasoningLevel(
  requested: string | undefined,
): ZcodeOfmReasoningLevel | undefined {
  const choice = typeof requested === 'string' ? requested.trim() : ''
  if (!choice) return ZCODE_OFM_DEFAULT_REASONING_LEVEL
  return (ZCODE_OFM_REASONING_LEVELS as readonly string[]).includes(choice)
    ? (choice as ZcodeOfmReasoningLevel)
    : undefined
}

/**
 * Personal provider config for the Our Free Model route.
 *
 * Shape is the official personal layer, verified against
 * `packages/provider/src/config/provider-data-schema.ts` at the pinned revision:
 * `providerRules` is an **array**, `modelConfigRules` carries **both**
 * `providerModelRules` and `manualProviderModelRules`, `builtinModelIds` is omitted
 * because the personal schema strips it, and there is **no `revision`** key because
 * the personal schema rejects it. `enabled: true` matters — the resolver compares
 * `modelConfig.enabled === true` strictly.
 *
 * `modelId` is the owner's catalog id on purpose: it is what the official CLI puts on
 * the wire, so Our Free Model receives the exact model it publishes.
 */
export function buildOfmPersonalProviderConfig(input: {
  baseUrl: string
  modelId: string
  reasoningLevel: ZcodeOfmReasoningLevel
  headers?: Record<string, string>
}): unknown {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [OFM_ZCODE_PROVIDER_ID],
      providerConfigRules: {
        providerRules: [
          {
            providerId: OFM_ZCODE_PROVIDER_ID,
            providerName: OFM_ZCODE_PROVIDER_NAME,
            enabled: true,
            config: {
              group: 'standard-personal',
              access: {
                type: 'api-key',
                // A fixed non-secret placeholder. The runtime sends this literal as the
                // Bearer token on every request, which is exactly why the relay must
                // replace it in memory rather than trust it.
                apiKey: OFM_RELAY_PLACEHOLDER_KEY,
                apiKeyManagementUrl: null,
              },
              api: {
                type: 'openai-chat-completions',
                baseUrl: input.baseUrl,
                ...(input.headers ? { headers: input.headers } : {}),
              },
              personalModelIds: [input.modelId],
              visibility: 'visible',
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: OFM_ZCODE_PROVIDER_ID,
            modelId: input.modelId,
            config: {
              enabled: true,
              properties: OFM_MODEL_PROPERTIES,
              optionSpecs: {
                // `map: '{}'` is the official default: the level is advertised and
                // pinned, but nothing unverifiable is injected into the request body.
                // Whether Our Free Model honours a GLM thinking toggle is the owner's
                // answer, not something this route guesses.
                reasoningLevel: { values: [...ZCODE_OFM_REASONING_LEVELS], map: '{}' },
                maxOutputTokens: { max: 64000 },
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: OFM_ZCODE_PROVIDER_ID,
        modelId: input.modelId,
        options: { reasoningLevel: input.reasoningLevel },
      },
    },
  }
}

export { buildBuiltinProviderConfig }

/**
 * The `model` selection accepted by `session/create` and `session/send`.
 *
 * `modelSelectionSchema` is strict and its `options` object allows only
 * `reasoningLevel`, so the level is always sent explicitly and nothing else is added.
 */
export function ofmModelSelection(
  modelId: string,
  reasoningLevel: ZcodeOfmReasoningLevel,
): { providerId: string; modelId: string; options: { reasoningLevel: ZcodeOfmReasoningLevel } } {
  return { providerId: OFM_ZCODE_PROVIDER_ID, modelId, options: { reasoningLevel } }
}

/**
 * Confirm the live session is bound to exactly the pinned model.
 *
 * This is the part the official runtime genuinely reads back. Verified against the real
 * ZCode CLI (bundle 0.16.9, release 3.14.3): `settings.model.current` is
 * `{ providerId, modelId }`, and `settings.mode.current` echoes the permission mode, so
 * provider, model and permission mode are all confirmable from the session snapshot.
 */
export function assertOfmModelIdentity(snapshot: unknown, modelId: string): void {
  const current = (snapshot as any)?.settings?.model?.current
  if (!current || typeof current !== 'object') throw Error('ZCode 未返回当前模型，无法确认路由')
  if (current.providerId !== OFM_ZCODE_PROVIDER_ID || current.modelId !== modelId)
    throw Error(
      `ZCode 会话绑定的是 ${String(current.providerId)}/${String(current.modelId)}，` +
        `与所选的 ${OFM_ZCODE_PROVIDER_ID}/${modelId} 不一致`,
    )
}

/**
 * Whether a live snapshot reports a resolved reasoning level at all.
 *
 * The CLI of record does not: `settings.model.current` carries only provider and model,
 * and the official `settings.thoughtLevel` block is not populated for a personal API-key
 * provider. This predicate exists so the route can tell "confirmed" from "never
 * reported" instead of guessing which one it is looking at.
 */
export function ofmReportsReasoningLevel(snapshot: unknown): boolean {
  const value = (snapshot as any)?.settings?.model?.current?.options?.reasoningLevel
  return typeof value === 'string' && value.length > 0
}

/**
 * Confirm the live session runs exactly the pinned model and reasoning level.
 *
 * Strict on purpose. A missing readback is a refusal, not a pass: the provider config
 * *declares* the available levels and the request *sent* names one; neither proves the
 * session is running it. Synthesising an `options` block here, or defaulting to the
 * requested value, would turn a declaration into an unverified claim.
 *
 * This is a conformance assertion, applied only to a snapshot that actually reports a
 * level. When the official runtime reports none, the route applies
 * {@link assertOfmModelIdentity} alone and advertises `reasoning: 'model-declared'`,
 * because there is no runtime readback to back a stronger claim.
 *
 * @param snapshot - the official session snapshot from create, resume or subscribe.
 * @param modelId - the exact catalog model the route pinned.
 * @param reasoningLevel - the exact level the route pinned.
 */
export function assertOfmModelSelection(
  snapshot: unknown,
  modelId: string,
  reasoningLevel: ZcodeOfmReasoningLevel,
): void {
  assertOfmModelIdentity(snapshot, modelId)
  const resolved = (snapshot as any).settings.model.current.options?.reasoningLevel
  if (resolved !== reasoningLevel)
    throw Error(
      resolved === undefined || resolved === null || resolved === ''
        ? 'ZCode 会话未回读推理档位，无法确认所选档位已生效'
        : `ZCode 会话的推理档位是 ${String(resolved)}，与所选的 ${reasoningLevel} 不一致`,
    )
}

/**
 * Pin Git Bash for the session through the official public channel.
 *
 * The official Bash provider silently falls back to `legacy-shell` (the system shell on
 * Windows) when it finds no Git Bash, so exporting `SHELL` alone does not prevent it —
 * the runtime makes the choice. The official protocol does expose a real selection: the
 * `integratedTerminalShell` field of the `session/requestRuntimePreferences` result, a
 * discriminated union whose `shell` member is
 * `{ mode: 'shell', dialect: 'cmd' | 'git-bash', id, label, path }`.
 *
 * That is the difference between hoping the shell is right and telling the engine which
 * shell to run. `mode: 'auto'` is never sent: `auto` is exactly the choice that defers to
 * the engine's own detection, including its legacy fallback.
 *
 * @param gitBash - an already-verified Git Bash executable path.
 * @returns the `integratedTerminalShell` value for the handshake.
 */
export function ofmShellSelection(gitBash: string) {
  return {
    mode: 'shell',
    dialect: 'git-bash',
    id: 'opl-git-bash',
    label: 'Git Bash',
    path: gitBash,
  }
}

/**
 * Prove a resolved route is the exact route this adapter may launch.
 *
 * The shared resolver already checks URL shape and protocol agreement; this repeats
 * the identity checks that belong to the adapter: the model must be the one that was
 * requested (no substitution), and the endpoint must be the owner's own loopback
 * lane. A missing key, an unknown model or a non-loopback endpoint is a refusal, and
 * there is no second route to fall back to.
 */
export function assertOfmRoute(
  route: ExternalModelRoute,
  requestedModel: string,
): ExternalModelRoute {
  if (route.model !== requestedModel)
    throw Error(`Our Free Model 返回的模型是 ${route.model}，与所选的 ${requestedModel} 不一致`)
  if (route.protocol !== ZCODE_OFM_WIRE_PROTOCOL)
    throw Error('Our Free Model 端点协议与 ZCode 不兼容')
  if (!route.apiKey) throw Error('Our Free Model 未提供可用凭据')
  const url = new URL(route.baseURL)
  const loopback =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  if (!loopback) throw Error('Our Free Model 外部执行端点不是本机转发通道')
  return route
}
