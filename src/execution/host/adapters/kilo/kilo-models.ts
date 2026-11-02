/**
 * The model surface this adapter is declared for, and the ACP config-option plumbing used
 * to pin it.
 *
 * The ids below express adaptation intent, not availability. Whether a model can be
 * reached is decided by the model-source plugin that owns the account and by that
 * plugin's live catalog; neither is inferred from these constants.
 *
 * Verified against the pinned official CLI (`@kilocode/cli@7.8.8`, plus
 * `@kilocode/cli-windows-x64@7.8.8`, both SHA-512 matched to the npm registry). Every item
 * was answered by the real binary over ACP:
 *
 * - `initialize` answers protocol version 1, `agentInfo` `Kilo` `7.8.8`, and
 *   `agentCapabilities.loadSession: true`, with `sessionCapabilities` for close/fork/list/
 *   resume.
 * - `session/new` advertises exactly three config options: `model` (category `model`),
 *   `effort` (category `thought_level`) and `mode` (category `mode`).
 * - `session/set_config_option` with `configId: "model"` writes the selection and returns
 *   the refreshed advertisement, so a read-back check is possible. A value outside the
 *   advertisement is refused with `-32602 model not found`, and the session keeps its
 *   previous model rather than falling back to something else.
 * - `session/load` succeeds but does **not** restore a previously pinned model: it comes
 *   back on the CLI's own default. The pinned model is therefore re-asserted after a load
 *   instead of being trusted from the session.
 * - `session/cancel` answers `-32601 "Method not found"`. Cancellation is not advertised.
 *
 * ## Reasoning effort: advertised but not usable
 *
 * The `effort` option is advertised, which is not the same as being able to select one.
 * The session default advertises a single value, `thinking`, and writing even that value is
 * refused with `-32602 effort not found`. Once any model this adapter declares is selected,
 * the option is dropped from `configOptions` altogether — what remains is `model` and
 * `mode` — and writes for `thinking`, `high` and `max` are each refused. No value named
 * `max` is advertised anywhere in the measured surface.
 *
 * The consequence is deliberate: this run's implementation tier is not portable to these
 * targets. Nothing here sends an effort, and an explicit effort request is refused rather
 * than silently dropped, so a caller who asked for `max` never silently runs at another
 * strength.
 *
 * ## Free and auto routes carry no invented underlying model
 *
 * `kilo-auto/free` is a routing entry, not a fixed model. This adapter pins and verifies
 * only the exact id the source published. It never resolves, guesses, or records what such
 * an entry might route to, and it never substitutes a concrete model for it.
 */
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Harness id; the adapter's `id`, and the key a source registers `supports` against. */
export const KILO_HARNESS = 'kilo'
/** Provider id of the model source that owns these models' accounts and channels. */
export const KILO_OFM_PROVIDER = 'our-free-model'
/**
 * Wire method that carries this route in the pinned CLI.
 *
 * Measured: with a custom route the CLI issues `POST {baseURL}/chat/completions` and asks
 * for `stream: true`, i.e. the provider it loads for a custom namespace is the
 * OpenAI-compatible Chat Completions client. `responses` and `messages` are therefore not
 * expressible here and are refused rather than approximated.
 */
export const KILO_PROTOCOL = 'chat' as const
/** Wire method that pins the session model over ACP. */
export const KILO_SET_CONFIG_OPTION = 'session/set_config_option'
/** Config id the CLI advertises for model selection. */
export const KILO_MODEL_OPTION = 'model'
/** Config id the CLI advertises for reasoning effort. */
export const KILO_EFFORT_OPTION = 'effort'

/**
 * The models this adaptation declares, each kept exactly as its source published it.
 *
 * OFM's own channel identity is preserved rather than normalised: a bare id and its
 * provider-qualified twin are different routes, and the `:free` and `/free` routing entries
 * stay distinct from any concrete model they may reach. Excluded models (GPT-OSS, Jev,
 * content-safety) are absent by decision, not by accident, and nothing here removes a model
 * from the owning plugin's catalog.
 */
export const KILO_OFM_MODELS: readonly string[] = [
  'inclusionai/ling-3.1-flash-1019-free',
  'dots-studio/dots-3-note-preview:free',
  'stealth/glyph-cluster',
  'kilo-auto/free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'reflection/beam-free',
  'xingchen-agi/xing4.0-29b-a4b:free',
  'recursive/flint-v1.0:free',
]

/** The declared models, as catalog entries an execution combination can bind. */
export const kiloModels = (): readonly ModelRef[] =>
  KILO_OFM_MODELS.map((model) => ({ provider: KILO_OFM_PROVIDER, model }))

/** True only for the exact provider/model pair this adapter declares. */
export const isKiloModel = (ref: ModelRef): boolean =>
  ref.provider === KILO_OFM_PROVIDER && KILO_OFM_MODELS.includes(ref.model)

/**
 * Models this run explicitly declines to adapt to Kilo.
 *
 * Each is present in the plugin's catalog or structurally valid, so catalog membership
 * alone would admit them; the exclusion is the decision, and it is refused rather than
 * downgraded. They remain available through the plugin's own native routes — this list
 * removes nothing from it.
 */
export const KILO_EXCLUDED_MODELS: readonly string[] = [
  'openai/gpt-oss-20b',
  'jev-1.13-free',
  'nvidia/nemotron-3.5-content-safety:free',
]

/** Whether a model is excluded by name for this run. */
export const isExcludedKiloModel = (model: string): boolean => KILO_EXCLUDED_MODELS.includes(model)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** One advertised `select` config option, reduced to the values this adapter compares. */
export interface KiloSelectOption {
  readonly currentValue: string
  readonly values: readonly string[]
}

/**
 * Read one `select` config option out of an advertised `configOptions` array.
 *
 * Anything that is not a well-formed option is treated as absent, so a malformed or
 * unexpected advertisement fails the pinning checks instead of passing them.
 */
export function kiloConfigOption(configOptions: unknown, id: string): KiloSelectOption | undefined {
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
 * What the pinned CLI does with the `effort` option, measured rather than assumed.
 *
 * Exported so capabilities, diagnostics and tests all describe the same measured
 * behaviour instead of each asserting something slightly different.
 */
export const KILO_EFFORT_FACTS = {
  /** The session default advertises an `effort` config option. */
  advertisesEffortOptionOnDefault: true,
  /** Its category is `thought_level`. */
  category: 'thought_level',
  /**
   * Its only advertised value on the default is `thinking`.
   *
   * Measured: with the CLI's own default model selected, `effort` offers exactly this one
   * value — and writing even that value is refused.
   */
  defaultValues: ['thinking'],
  /**
   * Once any model this adapter declares is selected, the option is dropped from the
   * advertisement entirely: `configOptions` then carries only `model` and `mode`. It is not
   * an option with no values; it is absent.
   */
  advertisesEffortOptionForDeclaredModels: false,
  /** Every write measured was refused with `-32602 effort not found`. */
  writable: false,
  /** No value named `max` was advertised for any measured model. */
  advertisesMax: false,
} as const

/**
 * Check that a session *offers* the pinned model, without requiring it to be selected yet.
 *
 * A new and a restored session both come back on the CLI's own default model, so before the
 * pin is written the only honest question is whether the exact value is available to
 * select. Demanding that it already be `currentValue` would make every fresh or restored
 * session unusable, and would confuse "not chosen yet" with "drifted away".
 *
 * @throws when the option is missing or the value is not offered.
 */
export function assertKiloModelOffered(
  modelValue: string,
  configOptions: unknown,
  describe: (message: string) => Error,
): KiloSelectOption {
  const option = kiloConfigOption(configOptions, KILO_MODEL_OPTION)
  if (!option) throw describe('当前会话未广告模型配置项，无法确认目标模型，已停止。')
  if (!option.values.includes(modelValue))
    throw describe(`官方 Kilo 未广告要求的模型 ${modelValue}，已停止，不会改用其他模型。`)
  return option
}

/**
 * Check a pinned model against an advertisement.
 *
 * The exact value this suite constructed is compared, never a parsed or normalised form.
 * Kilo's own catalog uses `provider/model`, so a model id may itself contain `/` and `:` —
 * all declared ids were pinned and read back unchanged by the real binary. Splitting
 * or normalising such an id could silently accept a different model; exact comparison is the
 * only check that cannot.
 *
 * This is the strict gate: the value must be offered *and* currently selected. It runs on
 * the read-back after a write and before every prompt, so a session that drifted fails
 * closed instead of quietly running another model.
 *
 * @throws when the option is missing, the value is not offered, or the session reports
 * something other than the pinned value.
 */
export function assertKiloModelPinned(
  modelValue: string,
  configOptions: unknown,
  describe: (message: string) => Error,
): KiloSelectOption {
  const option = assertKiloModelOffered(modelValue, configOptions, describe)
  if (option.currentValue !== modelValue)
    throw describe(`会话当前模型与要求的 ${modelValue} 不一致，已停止，未发送任何任务。`)
  return option
}

/**
 * Refuse a reasoning effort the target cannot express.
 *
 * The CLI advertises an `effort` option only while its own default model is selected, and
 * even that single advertised value cannot be written. For the models this adapter declares
 * the option is not advertised at all. A caller who explicitly chose a tier must therefore
 * be told the request is not being honoured, instead of running at an unstated strength.
 * `max` is this run's own implementation tier and is not portable to these targets:
 * nothing here maps it onto a value the CLI does not advertise.
 *
 * @throws a controlled configuration error when any effort was requested.
 */
export function assertNoKiloEffort(effort: unknown, describe: (message: string) => Error): void {
  const requested = text(effort).trim()
  if (!requested) return
  const selectable = KILO_EFFORT_FACTS.advertisesEffortOptionForDeclaredModels
  throw describe(
    selectable
      ? `官方 Kilo 未能写入所选的推理档位 ${requested}，已停止，未发送任何任务，不会改用其他模型或档位。`
      : `官方 Kilo 对本组合声明的模型未广告任何推理档位，无法应用所选的 ${requested}。已停止，未发送任何任务，不会静默降级到其他档位，也不会把本套件的 max 档位套用到未广告该档位的模型。`,
  )
}
