/**
 * Official StepCode adapter surface.
 *
 * Everything this harness contributes to the suite is exported here, so the shared
 * adapter registry, the suite catalog and the model source owner can consume it without
 * reaching into the module layout. Nothing in this directory touches the official
 * application, a shared contract, or a user's credentials.
 *
 * Integration for the packager is additive and consists of:
 *
 * - adding {@link stepCodeAdapter} — or {@link createStepCodeAdapter} with an explicit
 *   bridge path — to the adapter registry and to the harness list used for
 *   default-harness resolution;
 * - letting the model source owner call {@link registerStepCodeSource} so the
 *   `our-free-model` provider authorizes this pairing;
 * - advertising the harness through the existing execution-engine entry, which already
 *   discovers installed CLIs — no new settings page, credential store, or navigation
 *   item is required.
 *
 * The bridge is a separate build entry (`step-bridge.ts` → `package/lib/step-bridge.mjs`),
 * mirroring how the official ZCode bridge is built, because it runs as its own process
 * and must not share the Host's context.
 */
export {
  stepCodeAdapter,
  createStepCodeAdapter,
  stepConfigOption,
  resolveStepRoute,
} from './step.ts'
export {
  STEP_HARNESS,
  STEP_PROVIDER,
  STEP_PROTOCOLS,
  STEP_CODE_MODELS,
  STEP_MODEL_FREE,
  STEP_MODEL_KILO,
  STEP_MODEL_EAC,
  STEP_MODEL_OPTION,
  STEP_THINKING_OPTION,
  STEP_PERMISSION_OPTION,
  STEP_THINKING_LEVELS,
  isStepCodeModel,
  isStepProtocol,
  stepApiForProtocol,
  stepCodeModels,
  stepLane,
  stepLaneProtocol,
  stepThinkingValue,
  stepWireModel,
  type StepLane,
  type StepProtocol,
} from './step-models.ts'
export {
  STEP_PRESETS,
  STEP_PERMISSIONS,
  STEP_PERMISSION_PRESET_ENV,
  stepPermissionPlan,
  isStepPreset,
  type StepIsolation,
  type StepPermissionPlan,
  type StepPreset,
} from './step-permissions.ts'
export {
  STEP_SHELL_PATH_ENV,
  stepBashEnvironment,
  stepShellCandidateProblem,
  type StepShell,
} from './step-bash.ts'
export {
  STEP_AGENT_DIR_ENV,
  STEP_SESSION_DIR_ENV,
  STEP_CREDENTIAL_ENV,
  stepStorage,
  buildStepModelsConfig,
  buildStepSettings,
  type StepStorage,
} from './step-config.ts'
export {
  createStepCodeSource,
  assertStepRouteForPairing,
  registerStepCodeSource,
  type StepSourceAnswer,
  type StepSourceOwner,
} from './step-source.ts'
