/** Picker policy for OFM lanes rejected by their required official client. */
import type { ModelRef } from '../../contracts/catalog.ts'
import { OFM_PROVIDER, OFM_PROVIDERS, isExcludedOfmModel, isOfmVirtualModelId } from './provider.ts'

/** OFM lanes still absent or incomplete in the official OpenCode directory. */
export const OFM_CLIENT_REJECTED_MODELS: readonly string[] = [
  'muse-spark-1.2-contributor-free',
  'step-5-preview-free',
]

/** Hide only the named OFM lanes, without changing another provider's same-named model. */
export function isHiddenOfmSelection(ref: ModelRef): boolean {
  return (
    OFM_PROVIDERS.includes(ref.provider) &&
    (isExcludedOfmModel(ref.model) ||
      isOfmVirtualModelId(ref.model) ||
      OFM_CLIENT_REJECTED_MODELS.includes(ref.model))
  )
}

/** No default CLI setup when every supported lane is excluded from the picker. */
export const OFM_INACTIVE_DEFAULT_HARNESSES: readonly string[] = ['mimo-code', 'muse-code']

/**
 * OFM-discovered identities routed through the official CLI's own `opencode` free provider.
 *
 * Every entry is a bare id the OpenCode directory itself serves as `opencode/<id>` on its
 * Chat Completions endpoint, so the agent loop can use the CLI's built-in free provider
 * instead of an OPL-configured route. The provider reference stays `our-free-model`: the
 * owning plugin remains the source of discovery, account and update, and this list only
 * decides which of its lanes are addressed by that wire value.
 *
 * Each id must also be declared in the OpenCode adapter's own model surface; the adapter
 * tests assert that containment, so a lane can never be routed here while the harness
 * refuses to pin it. `beam-free` and `nemotron-3.5-super-vl-free` were added on 2026-10-17
 * from the owning plugin's live free lane plus the official directory; the directory
 * listing is a declaration, not proof of a call.
 *
 * `big-pickle` was added on 2026-10-19: the owning plugin's live catalog now publishes it
 * as an exact `our-free-model` lane with `availability: "available"` and route
 * `our-free-model`, and the official OpenCode/Zen directory serves the same id on its
 * OpenAI-compatible Chat Completions surface. It keeps its real id and OFM attribution;
 * this list only selects the official `opencode/big-pickle` wire value.
 */
export const OFM_OPENCODE_OFFICIAL_FREE_MODELS: readonly string[] = [
  'cat-jam-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.3-contributor-free',
  'longcat-2.5-free',
  'nemotron-3.5-lightning-free',
  'longcat-2.5-preview-free',
  'iceman-free',
  'inkling-2-small-free',
  'deepseek-v4.1-flash-free',
  'space-bunny-free',
  'minimax-m3.1-flash-free',
  'beam-free',
  'nemotron-3.5-super-vl-free',
  'glm-5.3-flash-free',
  'big-pickle',
  'flint-40b-free',
]

/**
 * OpenCode-directory ids with no usable `our-free-model` lane, refused rather than
 * approximated.
 *
 * Both exist in the official OpenCode directory, but neither is a lane the owning plugin
 * currently serves: `ll-alpha-free` is refused upstream for any client that is not
 * OpenCode itself, and `exo-free` has no live free lane. A directory id is not a
 * provider/model combination, so nothing may be inferred about endpoint, credential or
 * availability. They are named so the refusal is a recorded decision that a later
 * directory refresh cannot quietly undo.
 *
 * `big-pickle` was removed from this list on 2026-10-19, when the owning plugin began
 * publishing it as an available `our-free-model` lane; it now routes through
 * {@link OFM_OPENCODE_OFFICIAL_FREE_MODELS} instead of being refused.
 */
export const OFM_OPENCODE_DIRECTORY_ONLY_MODELS: readonly string[] = ['exo-free', 'll-alpha-free']

/**
 * The `opencode/<id>` wire value for an exact built-in-free-provider lane.
 *
 * An excluded id is never routed, and neither is a directory-only id: the exclusion and
 * the absence of a usable owning lane are the decisions, and a directory refresh must not
 * be able to reintroduce either through this mapping. A qualified id such as
 * `nvidia/nemotron-3.5-super-vl:free` is a different route and deliberately answers
 * `undefined`, so it keeps using its own channel instead of being silently rewritten into
 * the bare free lane.
 */
export function officialOpenCodeModel(ref: ModelRef): string | undefined {
  if (ref.provider !== OFM_PROVIDER) return undefined
  if (isExcludedOfmModel(ref.model)) return undefined
  if (OFM_OPENCODE_DIRECTORY_ONLY_MODELS.includes(ref.model)) return undefined
  return OFM_OPENCODE_OFFICIAL_FREE_MODELS.includes(ref.model) ? 'opencode/' + ref.model : undefined
}
