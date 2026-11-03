/**
 * Suite-owned Pi storage layout and the credential-blind files written into it.
 *
 * **Why the layout is what it is.** Pi resolves its storage from official environment
 * variables, confirmed against the shipped 1.2.0 bundle rather than assumed from docs:
 *
 * - `PI_CODING_AGENT_DIR` — the agent directory. A probe with this set to `<home>/pi/agent`
 *   caused `models.json` written *inside it* to load: `get_available_models` returned the
 *   declared rows, and `get_state().sessionFile` resolved under the sibling session
 *   directory. Pi therefore has no separate "config root" — `models.json` and
 *   `settings.json` live **in the agent directory**, which is the opposite of the layout the
 *   StepCode adapter had to work around.
 * - `PI_CODING_AGENT_SESSION_DIR` — session storage, and `--session-dir` on the argument
 *   vector, which the official docs give the highest precedence.
 *
 * **Nothing here writes the global user profile.** The real `~/.pi/agent` of the signed-in
 * user is never read or modified: the agent directory, session directory and scratch all
 * live under this session's own suite-owned home, and the launch uses the official
 * dedicated profile entry rather than repointing `HOME`.
 *
 * **The credential never reaches disk.** `models.json` references the key through the
 * official `$ENV_VAR` interpolation, and the value itself is supplied only through the
 * launch environment. The file therefore contains no secret, and no literal key is
 * written, logged, or placed in an argument vector.
 */
import { PI_PROVIDER, piLane, type PiThinkingLevelMap } from './pi-models.ts'

/** Official environment variable that redirects the agent directory. */
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR'
/** Official environment variable that redirects the session directory. */
export const PI_SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'
/**
 * Private launch variable holding the model credential for the child only.
 *
 * Named by the suite, never by the CLI: `models.json` refers to it through the official
 * `$ENV` interpolation, so the value stays in the process environment.
 */
export const PI_CREDENTIAL_ENV = 'OPL_PI_CREDENTIAL'

/** Files this suite owns inside the official storage layout. */
export interface PiStorage {
  /** Agent directory: `models.json` and `settings.json` load from here. */
  readonly agentDir: string
  /** Session storage root, also passed as `--session-dir`. */
  readonly sessionDir: string
  /** Where the bridge records `sessionId -> sessionFile` for `session/load`. */
  readonly sessionIndexDir: string
  /** Scratch directory used for the child process's `TEMP`/`TMP`. */
  readonly scratchDir: string
}

/**
 * Derive the official storage layout from the suite-owned session home.
 *
 * @param home - the suite-owned per-session directory.
 * @returns the directories, all inside {@link home}.
 */
export function piStorage(home: string): PiStorage {
  // The agent directory is `<home>/pi/agent`, so `models.json` and `settings.json` are
  // written next to each other there, as the official product expects.
  const agentDir = `${home}/pi/agent`
  return {
    agentDir,
    sessionDir: `${home}/pi/sessions`,
    sessionIndexDir: `${home}/pi/session-index`,
    scratchDir: `${home}/pi/tmp`,
  }
}

/** One provider entry as the official `models.json` schema expects it. */
export interface PiProviderEntry {
  readonly baseUrl: string
  readonly api: string
  readonly apiKey: string
  readonly models: readonly {
    id: string
    name: string
    /**
     * Whether this model exposes a reasoning tier.
     *
     * The field is load-bearing rather than cosmetic, confirmed by probe: a row declared
     * `reasoning: true` advertised the full `get_available_thinking_levels` vocabulary,
     * while a row without it advertised only `["off"]`. Declaring it wrongly silently
     * removes the thinking tier instead of failing loudly.
     */
    readonly reasoning?: boolean
    /** Official effort mapping; omitted levels retain Pi's documented defaults. */
    readonly thinkingLevelMap?: PiThinkingLevelMap
  }[]
}

/**
 * Build the `models.json` document for exactly the pinned lane.
 *
 * One provider, one model: the Pi catalog ids never share an entry, so a lane cannot
 * inherit another's base URL or model name.
 *
 * @param options - the lane identity, the resolved route, the official API name, and
 * whether the lane exposes a reasoning tier.
 * @returns the document to write to `<agentDir>/models.json`.
 */
export function buildPiModelsConfig(options: {
  provider: string
  model: string
  baseURL: string
  api: string
  reasoning?: boolean
}): Record<string, unknown> {
  const thinkingLevelMap =
    options.reasoning === true
      ? piLane({ provider: PI_PROVIDER, model: options.model })?.thinkingLevelMap
      : undefined
  const entry: PiProviderEntry = {
    baseUrl: options.baseURL,
    api: options.api,
    // Official `$ENV_VAR` interpolation: the key is read from the process environment at
    // request time, so this file holds no credential.
    apiKey: `$${PI_CREDENTIAL_ENV}`,
    models: [
      {
        id: options.model,
        name: options.model,
        ...(options.reasoning === true ? { reasoning: true } : {}),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      },
    ],
  }
  return { providers: { [options.provider]: entry } }
}

/**
 * Build the `settings.json` document that pins the shell.
 *
 * `shellPath` is the official key the runtime reads (`docs/settings.md`), and on native
 * Windows it is the first entry in the documented resolution order, so writing it here is
 * what makes the verified Git Bash the shell for **both** the model-facing `bash` tool and
 * the user's `!` commands — the official product resolves those two from one setting.
 *
 * @param shellPath - the verified Git-for-Windows bash, or `undefined` on POSIX hosts
 *   where the official CLI resolves its own shell and this key is not consulted.
 */
export function buildPiSettings(shellPath?: string): Record<string, unknown> {
  return shellPath ? { shellPath } : {}
}
