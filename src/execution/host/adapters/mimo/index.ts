/**
 * Public entry for the official MiMo Code (`mimo`) adaptation.
 *
 * The suite's shared adapter index is owned elsewhere; this module exports the adapter
 * and a small factory so wiring it in is a single, reviewable change that does not fork
 * any shared registry, catalog, or settings surface. Credentials stay with the model
 * source, the program stays with the execution engine, and the binding stays with the
 * execution combination — no new provider page, navigation entry, or duplicate config
 * is introduced here.
 */
import type { HarnessAdapter } from '../types.ts'
import { mimoCodeAdapter } from './mimo.ts'

export {
  mimoCodeAdapter,
  mimoCodeLaunch,
  mimoCodePath,
  mimoProfileHome,
  acceptMimoTurnResult,
  MIMO_CODE_HARNESS,
  MIMO_OFM_PROVIDER,
  MIMO_OFM_MODEL,
  MIMO_AMD_MODEL,
  MIMO_OFM_MODELS,
} from './mimo.ts'
export {
  buildMimoRouteConfig,
  mimoModelValue,
  MIMO_ROUTE_PROVIDER_ID,
  MIMO_SUPPORTED_PROTOCOLS,
} from './mimo-route.ts'
export {
  mimoConfigOption,
  mimoCodeModels,
  isMimoCodeModel,
  assertMimoModelPinned,
  MIMO_MODEL_OPTION,
  MIMO_SET_CONFIG_OPTION,
} from './mimo-models.ts'
export {
  mimoShellEnvironment,
  mimoShellSelectionAccepts,
  verifyMimoGitBash,
  sameShellFile,
  MIMO_SHELL_FACTS,
  MIMO_SHELL_VARIABLE,
  MIMO_GIT_BASH_VARIABLE,
} from './mimo-shell.ts'

/**
 * Append the adapter to an existing registry without mutating the caller's array.
 *
 * Idempotent by adapter id, so re-running registration during plugin reload cannot
 * register the same harness twice.
 *
 * @param adapters - the suite's current adapter registry.
 * @returns a new registry including this adapter exactly once.
 */
export function withMimoAdapter(
  adapters: readonly HarnessAdapter[] = [],
): readonly HarnessAdapter[] {
  if (adapters.some((adapter) => adapter.id === mimoCodeAdapter.id)) return adapters
  return [...adapters, mimoCodeAdapter]
}
