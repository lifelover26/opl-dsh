/**
 * The model surface this adapter is declared for, and the ACP config-option plumbing
 * used to pin it.
 *
 * The ids below express adaptation intent, not availability. Whether a model can be
 * reached is decided by the model-source plugin that owns the account and by the
 * plugin's live catalog; neither is inferred from these constants.
 *
 * Verified against the pinned official CLI (`opencode-ai@1.19.0`,
 * `opencode-windows-x64@1.19.0`, both SHA-512 matched to the npm registry):
 * `session/new` advertises a `model` select, `session/set_config_option` writes it, and
 * the refreshed advertisement reports it back. Bare ids, ids containing `/`, ids
 * containing `/` more than once, and ids containing `:` were each pinned and read back
 * unchanged by the real binary.
 *
 * The free-directory ids added below were read from the OpenCode directory itself on
 * 2026-10-17: the model/endpoint table and free-model list on `https://opencode.ai/docs/zen`,
 * the live listing at `https://opencode.ai/inference/v1/models`, and the pinned CLI's own
 * `opencode` provider catalog. Every added id is served by that directory on OpenAI Chat
 * Completions, the one protocol the pinned CLI bridges for this route. A directory entry is
 * a declaration of intent and of the wire shape only: it is evidence of neither a credential
 * nor a successful call, and availability stays the owning plugin's live answer.
 *
 * `exo-free` and `ll-alpha-free` are in the same directory but are deliberately **not**
 * declared here. The owning OFM plugin publishes no usable `our-free-model` lane for
 * them, so no exact provider/model combination exists for DSH to bind, pin, or verify: a
 * directory id is not a combination, and inventing one would be guessing availability.
 * They are recorded in `ofm-source/selection-policy.ts` and refused rather than
 * approximated.
 *
 * `big-pickle` was declared on 2026-10-19 after that same owner began publishing it as an
 * available `our-free-model` lane; the official OpenCode/Zen directory serves it on the
 * same Chat Completions surface, so the adapter pins the official `opencode/big-pickle`
 * wire value instead of refusing it. The id and attribution stay OFM's.
 */
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Harness id; the adapter's `id`, and the key a source registers `supports` against. */
export const OPENCODE_HARNESS = 'opencode'
/** Provider id of the model source that owns these models' accounts and channels. */
export const OPENCODE_OFM_PROVIDER = 'our-free-model'
/** OPL Gateway provider used by the Gemini combinations below. */
export const OPENCODE_GATEWAY_PROVIDER = 'opl-gateway'
/** Gateway model ids this OpenCode route intentionally exposes. */
export const OPENCODE_GATEWAY_GEMINI_MODELS: readonly string[] = [
  'gemini-4-argon',
  'gemini-3.8-flash',
  'gemini-3.1-pro',
]
/**
 * Wire method that selects the model in this CLI.
 *
 * The pinned CLI bridges exactly one provider SDK for a custom route,
 * `@ai-sdk/openai-compatible`, which speaks OpenAI Chat Completions. `responses` and
 * `messages` are therefore not expressible here and are refused rather than approximated.
 */
export const OPENCODE_PROTOCOL = 'chat' as const
/** Wire method that pins the session model over ACP. */
export const OPENCODE_SET_CONFIG_OPTION = 'session/set_config_option'
/** Config id the CLI advertises for model selection. */
export const OPENCODE_MODEL_OPTION = 'model'

/**
 * The models this adaptation declares, each kept exactly as its source published it.
 *
 * OFM's own channel identity is preserved rather than normalised: a bare id and its
 * provider-qualified twin are different routes, and the `free` virtual entries stay
 * distinct from the concrete models they may route to. Excluded models (GPT-OSS, Jev,
 * content-safety) are absent by decision, not by accident, and nothing here removes a
 * model from the owning plugin's catalog.
 */
export const OPENCODE_OFM_MODELS: readonly string[] = [
  'cat-jam-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.3-contributor-free',
  'ling-3.1-flash-free',
  'inclusionai/ling-3.1-flash',
  'longcat-2.5-preview-free',
  'cohere/north-mini-code:free',
  'nemotron-3.5-lightning-free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'deepseek-v4.1-flash-free',
  'space-bunny-free',
  'minimax-m3.1-flash-free',
  'minimax/minimax-m3.1-flash:free',
  'minimaxai/minimax-m3.1-flash',
  'openrouter/free',
  // Bare OpenCode free-directory lanes this round could actually pair: both are published
  // by the owning OFM plugin's live free lane *and* present in the official OpenCode
  // catalog, on Chat Completions. Each stays a distinct route — the bare
  // `nemotron-3.5-super-vl-free` is not folded into, or substituted by, the qualified
  // `nvidia/nemotron-3.5-super-vl:free` OFM channel route above — and nothing here adds
  // or removes anything from the owning plugin's catalog.
  'beam-free',
  'nemotron-3.5-super-vl-free',
  'glm-5.3-flash-free',
  // The owning plugin publishes `big-pickle` as an available `our-free-model` lane and
  // the official OpenCode/Zen directory serves it on Chat Completions. It keeps that
  // exact id here; the harness pins the directory's own `opencode/big-pickle` value and
  // never maps it to a self-built endpoint or another model.
  'big-pickle',
  // This id goes through the OFM route, distinct from OpenCode's own free endpoint.
  'flint-40b-free',
  // EAC publishes this qualified id; it uses OFM forwarding, not the bare free lane.
  'opencode/glm-5.3-flash-free',
  'opencode/deepseek-v4.1-flash-free',
]

/** The declared models, as catalog entries an execution combination can bind. */
export const openCodeModels = (): readonly ModelRef[] =>
  OPENCODE_OFM_MODELS.map((model) => ({ provider: OPENCODE_OFM_PROVIDER, model }))

/** True only for the exact provider/model pair this adapter declares. */
export const isOpenCodeModel = (ref: ModelRef): boolean =>
  ref.provider === OPENCODE_OFM_PROVIDER && OPENCODE_OFM_MODELS.includes(ref.model)

/**
 * Match only the three Gemini ids in the OPL Gateway Gemini group.
 *
 * Gateway references carry the group prefix (`gemini::<id>`); the prefix is
 * resolved by the Gateway execution owner and is never sent to OpenCode.
 */
export const isOpenCodeGatewayGeminiModel = (ref: ModelRef): boolean =>
  ref.provider === OPENCODE_GATEWAY_PROVIDER &&
  ref.model.startsWith('gemini::') &&
  OPENCODE_GATEWAY_GEMINI_MODELS.includes(ref.model.slice('gemini::'.length))

/** The model id OpenCode must send for an exact supported reference. */
export const openCodeWireModel = (ref: ModelRef): string | undefined => {
  if (isOpenCodeModel(ref)) return ref.model
  if (isOpenCodeGatewayGeminiModel(ref)) return ref.model.slice('gemini::'.length)
  return undefined
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** One advertised `select` config option, reduced to the values this adapter compares. */
export interface OpenCodeSelectOption {
  readonly currentValue: string
  readonly values: readonly string[]
}

/**
 * Read one `select` config option out of an advertised `configOptions` array.
 * Anything that is not a well-formed option is treated as absent, so a malformed or
 * unexpected advertisement fails the pinning checks instead of passing them.
 */
export function openCodeConfigOption(
  configOptions: unknown,
  id: string,
): OpenCodeSelectOption | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const raw of configOptions) {
    const option = raw as Record<string, any> | null
    if (!option || typeof option !== 'object' || option.id !== id) continue
    const values = Array.isArray(option.options)
      ? option.options
          .map((entry: any) => text(entry?.value))
          .filter((value: string) => value.length > 0)
      : []
    return { currentValue: text(option.currentValue), values }
  }
  return undefined
}

/**
 * Check that a session *offers* the pinned model, without requiring it to be selected yet.
 *
 * A new and a restored session both come back on the CLI's own default model — this was
 * measured on `opencode-ai@1.19.0`, where `session/load` did not restore a previously
 * pinned value either. So before the pin is written, the only honest question is whether
 * the exact value is available to select. Demanding that it already be `currentValue`
 * would make every fresh or restored session unusable, and would confuse "not chosen yet"
 * with "drifted away".
 *
 * @throws when the option is missing or the value is not offered.
 */
export function assertOpenCodeModelOffered(
  modelValue: string,
  configOptions: unknown,
  describe: (message: string) => Error,
): OpenCodeSelectOption {
  const option = openCodeConfigOption(configOptions, OPENCODE_MODEL_OPTION)
  if (!option) throw describe('当前会话未广告模型配置项，无法确认目标模型，已停止。')
  if (!option.values.includes(modelValue))
    throw describe(`官方 OpenCode 未广告要求的模型 ${modelValue}，已停止，不会改用其他模型。`)
  return option
}

/**
 * Check a pinned model against an advertisement.
 *
 * The exact value this suite constructed is compared, never a parsed or normalised form.
 * OpenCode's own catalog uses `provider/model`, so a model id may itself contain `/` and
 * `:`; splitting or normalising it could silently accept a different model. Exact
 * comparison is the only check that cannot do that.
 *
 * This is the strict gate: the value must be offered *and* currently selected. It runs on
 * the read-back after a write and before every prompt, so a session that drifted fails
 * closed instead of quietly running another model.
 *
 * @throws when the option is missing, the value is not offered, or the session reports
 * something other than the pinned value.
 */
export function assertOpenCodeModelPinned(
  modelValue: string,
  configOptions: unknown,
  describe: (message: string) => Error,
): OpenCodeSelectOption {
  const option = assertOpenCodeModelOffered(modelValue, configOptions, describe)
  if (option.currentValue !== modelValue)
    throw describe(`会话当前模型与要求的 ${modelValue} 不一致，已停止，未发送任何任务。`)
  return option
}
