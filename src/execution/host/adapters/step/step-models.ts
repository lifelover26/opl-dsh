/**
 * Official StepCode (`step`) model surface.
 *
 * StepCode ships **no ACP server**. Its machine interface is its own JSONL protocol
 * (`step --mode rpc`, see `packages/coding-agent/docs/rpc.md` in the official
 * repository), so this adapter pins the model, the thinking tier and the permission
 * tier over that RPC through `./step-bridge.ts`, which projects it onto the ACP
 * transport the host already drives. The official agent loop is never reimplemented:
 * `step` owns prompting, tool execution, context and session persistence.
 *
 * These ids name distinct entries in the `our-free-model` catalog: the anonymous lane
 * publishes `step-5-preview-free`, Kilo publishes `stepfun/step-5-preview-free`, and EAC
 * publishes `stepfun-ai/step-5-preview`. They are never merged or de-prefixed into one
 * another, and each keeps its own provider key in the generated provider config, so a
 * lane can be withdrawn or moved to another protocol without touching the other one.
 *
 * **No credential is named here.** The route — base URL, model, key, protocol — is
 * resolved by the model-source owner through `options.modelSources.resolve`, and this
 * module only checks that what came back still is the model the combination names.
 */
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Harness identity as it appears in the suite's Harness catalog. */
export const STEP_HARNESS = 'step-code'

/** Model provider owner that publishes the Step ids this harness can pin. */
export const STEP_PROVIDER = 'our-free-model'

/** Anonymous-lane catalog id. */
export const STEP_MODEL_FREE = 'step-5-preview-free'
/** Kilo-channel catalog id. A different lane, not a spelling of {@link STEP_MODEL_FREE}. */
export const STEP_MODEL_KILO = 'stepfun/step-5-preview-free'
/** EAC relay lane; distinct from both free-channel entries. */
export const STEP_MODEL_EAC = 'stepfun-ai/step-5-preview'

/**
 * Every catalog id this adapter is prepared to pin, in catalog order.
 *
 * Membership is necessary but not sufficient: {@link stepLane} still decides which
 * lane a reference belongs to, so two ids that share a family name can never be
 * resolved through one another's configuration.
 */
export const STEP_CODE_MODELS: readonly string[] = [
  STEP_MODEL_FREE,
  STEP_MODEL_KILO,
  STEP_MODEL_EAC,
]

/** One publishable lane, with the identity the generated config carries for it. */
export interface StepLane {
  /** Exact catalog id. Never derived from another id. */
  readonly model: string
  /** Provider key written into `models.json` for this lane alone. */
  readonly provider: string
}

/**
 * The wire protocol pinned for each lane.
 *
 * This is the **declared pairing**, and it is per lane on purpose: the anonymous lane and
 * the Kilo channel are different routes, and pinning one protocol for both would hide a
 * lane that changed. The model-source owner must resolve each lane under exactly the
 * protocol named here; a source that answers another one is refused rather than coerced,
 * because a different protocol is a different route.
 *
 * It is adaptation intent, not connectivity evidence: whether each lane actually serves
 * that protocol is proven by the owner's own resolution and by a real task, never here.
 */
const LANE_PROTOCOLS: Readonly<Record<string, StepProtocol>> = {
  [STEP_MODEL_FREE]: 'chat',
  [STEP_MODEL_KILO]: 'chat',
  [STEP_MODEL_EAC]: 'chat',
}

/** The protocol this harness pins for one lane, or `undefined` for an unknown id. */
export const stepLaneProtocol = (ref: ModelRef): StepProtocol | undefined => {
  const lane = stepLane(ref)
  return lane ? LANE_PROTOCOLS[lane.model] : undefined
}

/**
 * Whether a lane exposes a reasoning tier to the official CLI.
 *
 * This declaration is load-bearing. The official CLI derives its
 * `get_available_thinking_levels` advertisement from the model row's `reasoning` flag: a
 * row without it advertises only `["off"]`, which would remove the reasoning tier from
 * the product rather than fail. Declaring it here keeps the pairing explicit and lets a
 * lane that stops supporting reasoning be corrected in one place.
 */
const LANE_REASONING: Readonly<Record<string, boolean>> = {
  [STEP_MODEL_FREE]: true,
  [STEP_MODEL_KILO]: true,
  [STEP_MODEL_EAC]: false,
}

/** Whether the lane exposes a reasoning tier, or `undefined` for an unknown id. */
export const stepLaneReasoning = (ref: ModelRef): boolean | undefined => {
  const lane = stepLane(ref)
  return lane ? LANE_REASONING[lane.model] : undefined
}

/** Lane identities remain distinct in generated provider configuration. */
const LANES: readonly StepLane[] = [
  { model: STEP_MODEL_FREE, provider: 'opl-step-free-lane' },
  { model: STEP_MODEL_KILO, provider: 'opl-step-kilo-lane' },
  { model: STEP_MODEL_EAC, provider: 'opl-step-eac-lane' },
]

/**
 * Wire protocols this adapter can really drive.
 *
 * Each value maps onto a `models.json` `api` the official CLI implements
 * (`openai-completions`, `openai-responses`, `anthropic-messages`), so advertising all
 * three describes this product's actual capability rather than a wish. The protocol a
 * session runs is still chosen by the source owner and pinned per combination — see
 * {@link stepApiForProtocol}.
 */
export const STEP_PROTOCOLS = ['chat', 'responses', 'messages'] as const
/** One wire protocol this adapter supports. */
export type StepProtocol = (typeof STEP_PROTOCOLS)[number]

/** Narrow an untrusted protocol value to one this adapter can map onto StepCode. */
export function isStepProtocol(value: unknown): value is StepProtocol {
  return typeof value === 'string' && (STEP_PROTOCOLS as readonly string[]).includes(value)
}

/**
 * Translate a suite wire protocol into the official StepCode provider `api`.
 *
 * @param protocol - the protocol the model source declared for this pairing.
 * @returns the `api` value written into `models.json`.
 * @throws HarnessConfigurationError for a protocol the official CLI has no provider
 * API for. An unknown protocol is refused rather than rounded to the nearest one.
 */
export function stepApiForProtocol(protocol: string): string {
  switch (protocol) {
    case 'chat':
      return 'openai-completions'
    case 'responses':
      return 'openai-responses'
    case 'messages':
      return 'anthropic-messages'
    default:
      throw Error(
        `官方 StepCode 不支持该协议（${protocol}）；已停止，未改用其他协议，也不会换成其他模型。`,
      )
  }
}

/**
 * Resolve the lane a model reference names, or `undefined` when it names none.
 *
 * The catalog exposes a channel-qualified form for lane-scoped models
 * (`<channel>::<id>`), matching how the host addresses Gateway channels elsewhere, so
 * the trailing segment is compared against the exact lane id. The `::` split is
 * positional only: it does not normalise, alias or merge lane ids.
 *
 * @param ref - the model reference carried by the session record.
 * @returns the matching lane, or `undefined` for an id this adapter does not pin.
 */
export function stepLane(ref: ModelRef): StepLane | undefined {
  if (ref.provider !== STEP_PROVIDER) return undefined
  const id = ref.model.includes('::') ? ref.model.slice(ref.model.lastIndexOf('::') + 2) : ref.model
  return LANES.find((lane) => lane.model === id)
}

/**
 * Whether this adapter handles the given model reference.
 *
 * Both halves must match: the owner that published the id, and an id this adapter
 * knows how to pin. A Step-shaped id from a different owner is not absorbed.
 */
export const isStepCodeModel = (ref: ModelRef): boolean => stepLane(ref) !== undefined

/** The wire model id this session must run: the lane's exact catalog id. */
export const stepWireModel = (ref: ModelRef): string => stepLane(ref)!.model

/** Model references this adapter contributes to the catalog, in catalog order. */
export const stepCodeModels = (): readonly ModelRef[] =>
  STEP_CODE_MODELS.map((model) => ({ provider: STEP_PROVIDER, model }))

/** ACP `configOptions` id carrying the selectable model. */
export const STEP_MODEL_OPTION = 'model'
/** ACP `configOptions` id carrying the reasoning tier. */
export const STEP_THINKING_OPTION = 'thinking'
/** ACP `configOptions` id carrying the permission tier. */
export const STEP_PERMISSION_OPTION = 'permission'

/**
 * The reasoning vocabulary the official CLI documents for `set_thinking_level`.
 *
 * This is a vocabulary, not a grant. `xhigh` and `max` are exposed only by models
 * whose own catalog row supports them, so a value here is a *request* that must still
 * be found in the live `get_available_thinking_levels` advertisement before it is
 * written. Carrying a tier from another provider onto a model that never advertised it
 * is refused, never approximated.
 */
export const STEP_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/**
 * Resolve the reasoning tier a caller asked for, without inventing one.
 *
 * An absent choice returns `undefined`, which the adapter reads as "write nothing and
 * keep the CLI's own default". An explicit choice is returned verbatim for the caller
 * to validate against the live advertisement; this function never picks a default and
 * never maps one provider's tier name onto another.
 */
export function stepThinkingValue(requested?: string): string | undefined {
  const choice = typeof requested === 'string' ? requested.trim() : ''
  return choice.length > 0 ? choice : undefined
}
