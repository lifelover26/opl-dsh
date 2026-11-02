/**
 * Pairing policy for the original `dsh-our-free-model` plugin, pinned at the
 * revision the installer installs (v2.1.0, `7e3a1da5`).
 *
 * The plugin owns its catalog, channels, rotation chain, credentials and updater.
 * This records which provider routes it publishes and which Harness may run which
 * model on them; it reads none of the plugin's own state.
 */

import type { ModelRef } from '../../contracts/catalog.ts'

/** Provider routes the plugin registers with the official LLM registry. */
export const OFM_PROVIDER = 'our-free-model'
export const OFM_REGION_PROVIDER = 'our-free-model-region'
export const OFM_PROVIDERS: readonly string[] = [OFM_PROVIDER, OFM_REGION_PROVIDER]

export type OfmWireProtocol = 'responses' | 'messages' | 'chat'

/**
 * Wire protocol per Harness, taken from each Harness's own declaration rather
 * than guessed. The plugin's forward listener serves all three surfaces, so the
 * protocol is a property of the Harness speaking to it, not of the model.
 * {@link ofmProtocol} takes a configured declaration for a Harness an adapter
 * adds later, which is why an unregistered adapter is not a permanent limit.
 */
export const OFM_HARNESS_PROTOCOLS: Readonly<Record<string, OfmWireProtocol>> = {
  codex: 'responses',
  claude: 'messages',
  kimi: 'messages',
  'kimi-code': 'messages',
  mimo: 'chat',
  'mimo-code': 'chat',
  pool: 'chat',
  zcode: 'chat',
  'step-code': 'chat',
  'muse-code': 'responses',
  opencode: 'chat',
  pi: 'chat',
  kilo: 'chat',
  vibe: 'chat',
}

/** Harness alias so a CLI id and its adapter id resolve to one protocol. */
const HARNESS_ALIASES: Readonly<Record<string, string>> = {
  'kimi-code': 'kimi',
  'mimo-code': 'mimo',
}

/** Resolve the protocol a Harness declares, honouring a configured override. */
export function ofmProtocol(
  harness: string,
  configured?: Readonly<Record<string, OfmWireProtocol>>,
): OfmWireProtocol | undefined {
  return configured?.[harness] ?? OFM_HARNESS_PROTOCOLS[harness]
}

/**
 * Models this run explicitly excludes. Each is either present in the plugin's
 * live catalog or structurally valid, so catalog membership alone would admit
 * them; the exclusion is the decision, and it is refused rather than downgraded.
 */
export const OFM_EXCLUDED_MODELS: readonly string[] = [
  'jev-1.13-free',
  'nvidia/nemotron-3.5-content-safety:free',
]

/**
 * Exact OFM model assignments per Harness. An empty set disables the Harness
 * for this source; protocol support alone does not establish an adaptation.
 */
export const OFM_PINNED_HARNESS_MODELS: Readonly<Record<string, readonly string[]>> = {
  codex: ['openai/gpt-oss-20b'],
  claude: [],
  vibe: ['mistralai/mistral-large-4-1t-a52b'],
  kimi: ['moonshotai/kimi-k2.6', 'moonshotai/kimi-k3'],
  mimo: ['mimo-v2.6-flash-free'],
  pool: ['poolside/laguna-s-2.1:free', 'poolside/laguna-xs-2.1:free'],
  zcode: ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash'],
  'step-code': ['step-5-preview-free', 'stepfun/step-5-preview-free', 'stepfun-ai/step-5-preview'],
  'muse-code': ['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'],
  opencode: [
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
    'beam-free',
    'nemotron-3.5-super-vl-free',
    'glm-5.3-flash-free',
    'opencode/glm-5.3-flash-free',
    'opencode/deepseek-v4.1-flash-free',
    'deepseek-v4.1-flash-free',
    'space-bunny-free',
    'minimax-m3.1-flash-free',
    'minimax/minimax-m3.1-flash:free',
    'minimaxai/minimax-m3.1-flash',
    'openrouter/free',
    'big-pickle',
    'flint-40b-free',
  ],
  pi: [
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'liquid/lfm-2.5-2.6b:free',
    'thinkingmachines/inkling-small:free',
  ],
  kilo: [
    'inclusionai/ling-3.1-flash-1019-free',
    'dots-studio/dots-3-note-preview:free',
    'stealth/glyph-cluster',
    'kilo-auto/free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'reflection/beam-free',
    'xingchen-agi/xing4.0-29b-a4b:free',
    'recursive/flint-v1.0:free',
  ],
}

/** The canonical harness key a Harness id maps to for pinning lookups. */
export const ofmHarnessKey = (harness: string): string => HARNESS_ALIASES[harness] ?? harness

/** Structural check only. Whether the model exists is the owner's answer. */
export function isUsableOfmModelId(model: string): boolean {
  return typeof model === 'string' && model.trim() !== '' && !/[\r\n\0]/.test(model)
}

/** Whether a model is excluded by name for this run. */
export function isExcludedOfmModel(model: string): boolean {
  return OFM_EXCLUDED_MODELS.includes(model)
}

/** Whether a model reference belongs to an OFM route that is excluded from DSH. */
export function isExcludedOfmRef(ref: ModelRef): boolean {
  return OFM_PROVIDERS.includes(ref.provider) && isExcludedOfmModel(ref.model)
}

/**
 * Whether this Harness pins `model` exactly. An unpinned Harness returns true so
 * its validity rests on the owning plugin's live catalog instead.
 */
export function ofmHarnessPinsModel(harness: string, model: string): boolean {
  const pinned = OFM_PINNED_HARNESS_MODELS[ofmHarnessKey(harness)]
  return pinned === undefined || pinned.includes(model)
}
