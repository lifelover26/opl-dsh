/**
 * Suite-owned StepCode storage layout and the credential-blind files written into it.
 *
 * **Why the layout is what it is.** StepCode resolves its storage from two official
 * environment variables, and this was confirmed against the shipped `step.exe` 0.1.4
 * rather than assumed from the source tree:
 *
 * - `STEP_CODING_AGENT_DIR` — the agent directory (sessions, extensions, skills).
 * - the **Step config root**, which is `dirname(STEP_CODING_AGENT_DIR)`, holding
 *   `models.json`, `config.toml` and `auth.json`. `resolveStepConfigRoot()` documents
 *   these as "next to the agent directory, not inside it", and the probe confirms it:
 *   with `STEP_CODING_AGENT_DIR=<dir>/agent`, the binary creates `config.toml`,
 *   `auth.json` and `models-store.json` in `<dir>`, and a `models.json` written into
 *   `<dir>/agent` is **silently ignored** (`get_available_models` returns `[]`).
 *
 * That silent ignore is the reason this module exists: putting the provider file in the
 * obvious place produces a CLI that starts, reports no models, and only fails later.
 *
 * **Nothing here writes the global user profile.** The agent dir, config root and
 * session dir are all under the suite's own per-session home, so the real
 * `~/.stepcode` of the signed-in user is never read or modified.
 *
 * **The credential never reaches disk.** `models.json` references the key through the
 * official `$ENV_VAR` interpolation, and the value itself is supplied only through the
 * launch environment. The file therefore contains no secret, and no literal key is
 * written, logged, or placed in an argument vector.
 */

/** Environment variable that redirects the official agent directory. */
export const STEP_AGENT_DIR_ENV = 'STEP_CODING_AGENT_DIR'
/** Environment variable that redirects the official session directory. */
export const STEP_SESSION_DIR_ENV = 'STEP_CODING_AGENT_SESSION_DIR'
/**
 * Environment variable that redirects the official product storage root.
 *
 * This is what keeps `HOME` out of the launch entirely. The official CLI resolves its
 * storage root as `STEPCODE_STORAGE_ROOT_DIR || join(HOME, configDir)`, so without this
 * variable the anonymous install id and telemetry events land in the signed-in user's
 * real `~/.stepcode`. The agent directory already redirects `config.toml`, `auth.json`
 * and `models.json` (its config root is the agent directory's parent) and the session
 * variable redirects history, so together these three cover every path the product
 * owns.
 */
export const STEP_STORAGE_ROOT_ENV = 'STEPCODE_STORAGE_ROOT_DIR'
/**
 * Private launch variable holding the model credential for the child only.
 *
 * Named by the suite, never by the CLI: `models.json` refers to it through the
 * official `$ENV` interpolation, so the value stays in the process environment.
 */
export const STEP_CREDENTIAL_ENV = 'OPL_STEP_CREDENTIAL'

/** Files this suite owns inside the official storage layout. */
export interface StepStorage {
  /** Agent directory (`sessions/`, `extensions/`, `skills/`, `trust.json`). */
  readonly agentDir: string
  /** Config root: the parent of {@link agentDir}, where `models.json` actually loads from. */
  readonly configRoot: string
  /** Session storage root. */
  readonly sessionDir: string
  /**
   * Product storage root (`device-id`, telemetry). Redirected through its own official
   * variable so the launch never has to claim `HOME`.
   */
  readonly storageRoot: string
  /** Where the bridge records `sessionId -> sessionFile` for `session/load`. */
  readonly sessionIndexDir: string
}

/**
 * Derive the official storage layout from the suite-owned session home.
 *
 * Every directory is inside {@link home}, and each one is redirected through the
 * official variable that governs it. Nothing here relies on `HOME`, and no user profile
 * path is read or written.
 *
 * @param home - the suite-owned per-session directory.
 * @returns the directories, all inside {@link home}.
 */
export function stepStorage(home: string): StepStorage {
  // The agent directory is `<home>/step/agent`, so the Step config root the official
  // product derives from it is `<home>/step`.
  const agentDir = `${home}/step/agent`
  return {
    agentDir,
    configRoot: `${home}/step`,
    sessionDir: `${home}/step/sessions`,
    // One directory per session, so two concurrent suites never share a device id.
    storageRoot: `${home}/step/storage`,
    sessionIndexDir: `${home}/step/session-index`,
  }
}

/** One provider entry as the official `models.json` schema expects it. */
export interface StepProviderEntry {
  readonly baseUrl: string
  readonly api: string
  readonly apiKey: string
  readonly models: readonly {
    id: string
    name: string
    /**
     * Whether this model exposes a reasoning tier.
     *
     * The field is load-bearing rather than cosmetic: an official probe with
     * `reasoning: false` advertised only `["off"]` from `get_available_thinking_levels`,
     * while `reasoning: true` advertised the full vocabulary. Declaring it wrongly
     * therefore silently removes the thinking tier instead of failing loudly.
     */
    readonly reasoning?: boolean
    /** Source-configured context budget, when the model source reports one. */
    readonly contextWindow?: number
  }[]
}

/**
 * Build the `models.json` document for exactly the pinned lane.
 *
 * One provider, one model: the two Step catalog ids never share an entry, so a lane
 * cannot inherit the other's base URL or model name.
 *
 * @param options - the lane identity, the resolved route, the official API name, and
 * whether the lane exposes a reasoning tier.
 * @returns the document to write to `<configRoot>/models.json`.
 */
export function buildStepModelsConfig(options: {
  provider: string
  model: string
  baseURL: string
  api: string
  reasoning?: boolean
  contextWindow?: number
}): Record<string, unknown> {
  const entry: StepProviderEntry = {
    baseUrl: options.baseURL,
    api: options.api,
    // Official `$ENV_VAR` interpolation: the key is read from the process environment at
    // request time, so this file holds no credential.
    apiKey: `$${STEP_CREDENTIAL_ENV}`,
    models: [
      {
        id: options.model,
        name: options.model,
        ...(options.reasoning === true ? { reasoning: true } : {}),
        ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
      },
    ],
  }
  return { providers: { [options.provider]: entry } }
}

/**
 * Build the `settings.json` document that pins the shell.
 *
 * `shellPath` is the official key the runtime reads
 * (`SettingsManager.getShellPath()` → `getShellConfig(customShellPath)`). Writing it
 * explicitly is what makes the verified Git Bash the only shell this session can use.
 *
 * @param shellPath - the verified Git-for-Windows bash, or `undefined` on POSIX hosts
 *   where the official CLI resolves its own shell and this key would be ignored.
 */
export function buildStepSettings(shellPath?: string): Record<string, unknown> {
  return shellPath ? { shellPath } : {}
}
