/**
 * Official Pi Coding Agent (`pi`) model surface.
 *
 * Pi ships **no ACP server**. Its documented machine interface is `pi --mode rpc`
 * (official `docs/rpc.md`), a JSONL protocol keyed by a `type` discriminator, so
 * `./pi-bridge.ts` projects it onto the ACP transport the host already drives. The
 * official agent loop is never reimplemented: `pi` owns prompting, tool execution,
 * context management and session persistence.
 *
 * The ids below declare adapter support; the model-source owner decides live availability.
 * Each is a separate entry in the `our-free-model` catalog and stays separate here.
 * They are never merged, never de-prefixed into one another, and each keeps its own
 * provider key in the generated `models.json`, so one lane can be withdrawn or moved
 * to another protocol without touching another lane.
 *
 * **No credential is named here.** The route — base URL, model, key, protocol — is
 * resolved by the model-source owner through `options.modelSources.resolve`; this
 * module only checks that what came back is still the model the combination names.
 */
import type { ModelRef } from '../../../contracts/catalog.ts'

/** Harness identity as it appears in the suite's Harness catalog. */
export const PI_HARNESS = 'pi'

/** Model provider owner that publishes the Pi ids this harness can pin. */
export const PI_PROVIDER = 'our-free-model'

/** Catalog id: NVIDIA Nemotron 3 Nano Omni reasoning, free lane. */
export const PI_MODEL_NEMOTRON = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
/** Catalog id: Liquid AI LFM 2.5 2.6B, free lane. */
export const PI_MODEL_LFM = 'liquid/lfm-2.5-2.6b:free'
/** Catalog id: Thinking Machines Inkling Small, free lane. */
export const PI_MODEL_INKLING = 'thinkingmachines/inkling-small:free'
/** Catalog id: Thinking Machines Inkling, free lane, distinct from Inkling Small. */
export const PI_MODEL_INKLING_FULL = 'thinkingmachines/inkling:free'
/** Catalog id: Google Gemma 4 31B IT, free lane. */
export const PI_MODEL_GEMMA = 'google/gemma-4-31b-it:free'

/**
 * Every catalog id this adapter is prepared to pin, in catalog order.
 *
 * Membership is necessary but not sufficient: {@link piLane} still decides which lane a
 * reference belongs to, so two ids that share a family name can never be resolved
 * through one another's configuration.
 */
export const PI_CODE_MODELS: readonly string[] = [
  PI_MODEL_NEMOTRON,
  PI_MODEL_LFM,
  PI_MODEL_INKLING,
  PI_MODEL_INKLING_FULL,
  PI_MODEL_GEMMA,
]

/** Official Pi thinking levels mapped to provider values; `null` removes a level. */
export type PiThinkingLevelMap = Readonly<
  Partial<Record<(typeof PI_THINKING_LEVELS)[number], string | null>>
>

/** One publishable lane, with the identity the generated config carries for it. */
export interface PiLane {
  /** Exact catalog id. Never derived from another id. */
  readonly model: string
  /** Provider key written into `models.json` for this lane alone. */
  readonly provider: string
  /** Whether Pi offers its thinking selector or preserves the channel's default. */
  readonly thinking: 'cli-advertised' | 'upstream-default'
  /** Provider effort values applied through the official `models.json` field. */
  readonly thinkingLevelMap?: PiThinkingLevelMap
}

/**
 * Wire protocols this adapter can really drive.
 *
 * Each value maps onto a `models.json` `api` the official CLI implements, verified
 * against the shipped 1.2.0 bundle (`providers: { <key>: { api: "openai-completions" } }`
 * is accepted and enumerated by `get_available_models`), so advertising all three
 * describes this product's actual capability rather than a wish. The protocol a session
 * runs is still chosen by the source owner and pinned per combination — see
 * {@link piApiForProtocol}.
 */
export const PI_PROTOCOLS = ['chat', 'responses', 'messages'] as const
/** One wire protocol this adapter supports. */
export type PiProtocol = (typeof PI_PROTOCOLS)[number]

/** Narrow an untrusted protocol value to one this adapter can map onto Pi. */
export function isPiProtocol(value: unknown): value is PiProtocol {
  return typeof value === 'string' && (PI_PROTOCOLS as readonly string[]).includes(value)
}

/**
 * Translate a suite wire protocol into the official Pi provider `api`.
 *
 * @param protocol - the protocol the model source declared for this pairing.
 * @returns the `api` value written into `models.json`.
 * @throws Error for a protocol the official CLI has no provider API for. An unknown
 * protocol is refused rather than rounded to the nearest one, because a different
 * protocol is a different route.
 */
export function piApiForProtocol(protocol: string): string {
  switch (protocol) {
    case 'chat':
      return 'openai-completions'
    case 'responses':
      return 'openai-responses'
    case 'messages':
      return 'anthropic-messages'
    default:
      throw Error(
        `官方 Pi 不支持该协议（${protocol}）；已停止，未改用其他协议，也不会换成其他模型。`,
      )
  }
}

/**
 * The wire protocol pinned for each lane.
 *
 * This is the **declared pairing**, and it is per lane on purpose: the lanes are
 * different routes, and pinning one protocol for all of them would hide a lane that
 * changed. The model-source owner must resolve each lane under exactly the protocol
 * named here; a source that answers another one is refused rather than coerced.
 *
 * It is adaptation intent, not connectivity evidence: whether each lane actually serves
 * that protocol is proven by the owner's own resolution and by a real task, never here.
 */
const LANE_PROTOCOLS: Readonly<Record<string, PiProtocol>> = {
  [PI_MODEL_NEMOTRON]: 'chat',
  [PI_MODEL_LFM]: 'chat',
  [PI_MODEL_INKLING]: 'chat',
  [PI_MODEL_INKLING_FULL]: 'chat',
  [PI_MODEL_GEMMA]: 'chat',
}

/** The protocol this harness pins for one lane, or `undefined` for an unknown id. */
export const piLaneProtocol = (ref: ModelRef): PiProtocol | undefined => {
  const lane = piLane(ref)
  return lane ? LANE_PROTOCOLS[lane.model] : undefined
}

/**
 * Whether a lane exposes a reasoning tier to the official CLI.
 *
 * This declaration is load-bearing rather than cosmetic, and the mechanism was confirmed
 * against the shipped 1.2.0 bundle: the `reasoning` flag on a `models.json` row is what
 * the runtime uses to build its `get_available_thinking_levels` advertisement. A probe row
 * declared `reasoning: true` advertised `["off","minimal","low","medium","high"]`, while a
 * row without the flag advertised only `["off"]`. Declaring it wrongly therefore *silently
 * removes* the thinking tier from the product instead of failing loudly, so it is declared
 * per lane here and still re-validated against the live advertisement at run time.
 */
const LANE_REASONING: Readonly<Record<string, boolean>> = {
  [PI_MODEL_NEMOTRON]: true,
  [PI_MODEL_LFM]: false,
  [PI_MODEL_INKLING]: false,
  [PI_MODEL_INKLING_FULL]: true,
  [PI_MODEL_GEMMA]: false,
}

/** Whether the lane exposes a reasoning tier, or `undefined` for an unknown id. */
export const piLaneReasoning = (ref: ModelRef): boolean | undefined => {
  const lane = piLane(ref)
  return lane ? LANE_REASONING[lane.model] : undefined
}

/** Each exact id has its own provider entry and thinking declaration. */
const LANES: readonly PiLane[] = [
  { model: PI_MODEL_NEMOTRON, provider: 'opl-pi-nemotron-lane', thinking: 'cli-advertised' },
  { model: PI_MODEL_LFM, provider: 'opl-pi-lfm-lane', thinking: 'cli-advertised' },
  { model: PI_MODEL_INKLING, provider: 'opl-pi-inkling-lane', thinking: 'cli-advertised' },
  {
    model: PI_MODEL_INKLING_FULL,
    provider: 'opl-pi-inkling-full-lane',
    thinking: 'cli-advertised',
    thinkingLevelMap: { off: 'none', max: 'max' },
  },
  {
    model: PI_MODEL_GEMMA,
    provider: 'opl-pi-gemma-lane',
    thinking: 'upstream-default',
  },
]

/**
 * Resolve the lane a model reference names, or `undefined` when it names none.
 *
 * The catalog exposes a channel-qualified form for lane-scoped models
 * (`<channel>::<id>`), matching how the host addresses Gateway channels elsewhere, so
 * the trailing segment is compared against the exact lane id. The `::` split is
 * positional only: it does not normalise, alias or merge the ids.
 *
 * @param ref - the model reference carried by the session record.
 * @returns the matching lane, or `undefined` for an id this adapter does not pin.
 */
export function piLane(ref: ModelRef): PiLane | undefined {
  if (ref.provider !== PI_PROVIDER) return undefined
  const id = ref.model.includes('::') ? ref.model.slice(ref.model.lastIndexOf('::') + 2) : ref.model
  return LANES.find((lane) => lane.model === id)
}

/**
 * Whether this adapter handles the given model reference.
 *
 * Both halves must match: the owner that published the id, and an id this adapter knows
 * how to pin. A Pi-shaped id from a different owner is not absorbed.
 */
export const isPiCodeModel = (ref: ModelRef): boolean => piLane(ref) !== undefined

/** The wire model id this session must run: the lane's exact catalog id. */
export const piWireModel = (ref: ModelRef): string => piLane(ref)!.model

/** Model references this adapter contributes to the catalog, in catalog order. */
export const piCodeModels = (): readonly ModelRef[] =>
  PI_CODE_MODELS.map((model) => ({ provider: PI_PROVIDER, model }))

/** ACP `configOptions` id carrying the selectable model. */
export const PI_MODEL_OPTION = 'model'
/** ACP `configOptions` id carrying the reasoning tier. */
export const PI_THINKING_OPTION = 'thinking'
/** ACP `configOptions` id carrying the permission tier. */
export const PI_PERMISSION_OPTION = 'permission'

/**
 * The reasoning vocabulary the official CLI documents for `set_thinking_level`
 * (`--thinking`, `set_thinking_level`).
 *
 * This is a vocabulary, not a grant. `xhigh` and `max` are exposed only by models whose
 * own catalog row supports them, so a value here is a *request* that must still be found
 * in the live `get_available_thinking_levels` advertisement before it is written. Carrying
 * a tier from another model onto one that never advertised it is refused, never
 * approximated.
 */
export const PI_THINKING_LEVELS = [
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
 * An absent choice returns `undefined`, which the adapter reads as "write nothing and keep
 * the CLI's own default". An explicit choice is returned verbatim for the caller to
 * validate against the live advertisement; this function never picks a default and never
 * maps one model's tier name onto another.
 */
export function piThinkingValue(requested?: string): string | undefined {
  const choice = typeof requested === 'string' ? requested.trim() : ''
  return choice.length > 0 ? choice : undefined
}
