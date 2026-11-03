/**
 * Official Pi Coding Agent adapter surface.
 *
 * Everything this harness contributes to the suite is exported here, so the shared adapter
 * registry, the suite catalog and the model source owner can consume it without reaching
 * into the module layout. Nothing in this directory touches the official application, a
 * shared contract, or a user's credentials.
 *
 * Integration for the packager is additive and consists of:
 *
 * - adding {@link piAdapter} — or {@link createPiAdapter} with an explicit bridge path — to
 *   the adapter registry and to the harness list used for default-harness resolution;
 * - letting the model source owner authorize this pairing on the `our-free-model` provider,
 *   using the registry's public interface rather than a private local source;
 * - advertising the harness through the existing execution-engine entry, which already
 *   discovers installed CLIs — no new settings page, credential store, or navigation item is
 *   required.
 *
 * The bridge is a separate build entry (`pi-bridge.ts` → `package/lib/pi-bridge.mjs`),
 * mirroring how the other external bridges are built, because it runs as its own process
 * and must not share the Host's context.
 */
export { piAdapter, createPiAdapter, piConfigOption, resolvePiRoute } from './pi.ts'
export {
  PI_HARNESS,
  PI_PROVIDER,
  PI_PROTOCOLS,
  PI_CODE_MODELS,
  PI_MODEL_NEMOTRON,
  PI_MODEL_LFM,
  PI_MODEL_INKLING,
  PI_MODEL_INKLING_FULL,
  PI_MODEL_GEMMA,
  PI_MODEL_OPTION,
  PI_THINKING_OPTION,
  PI_PERMISSION_OPTION,
  PI_THINKING_LEVELS,
  isPiCodeModel,
  isPiProtocol,
  piApiForProtocol,
  piCodeModels,
  piLane,
  piLaneProtocol,
  piLaneReasoning,
  piThinkingValue,
  piWireModel,
  type PiLane,
  type PiProtocol,
  type PiThinkingLevelMap,
} from './pi-models.ts'
export {
  PI_PERMISSIONS,
  piPermissionPlan,
  type PiIsolation,
  type PiPermissionPlan,
} from './pi-permissions.ts'
export {
  PI_SHELL_PATH_ENV,
  piBashEnvironment,
  piShellCandidateProblem,
  type PiShell,
} from './pi-bash.ts'
export {
  PI_AGENT_DIR_ENV,
  PI_SESSION_DIR_ENV,
  PI_CREDENTIAL_ENV,
  piStorage,
  buildPiModelsConfig,
  buildPiSettings,
  type PiStorage,
} from './pi-config.ts'
export {
  createPiSource,
  registerPiSource,
  type PiSourceAnswer,
  type PiSourceOwner,
} from './pi-source.ts'
