import type { Context } from '@deepseek-ai/cordis'
import type { HarnessSession } from '../../contracts/sessions.ts'
import type { ModelRef } from '../../contracts/catalog.ts'
import type { CodexGitBashRuntime } from '../../contracts/codex-runtime.ts'
import type { HarnessCapabilities } from '../../contracts/capabilities.ts'
import type { ExternalModelSources } from '../model-sources.ts'
export interface AdapterOptions {
  home: string
  codexRuntime?: CodexGitBashRuntime
  modelSources?: ExternalModelSources
  command?: string
  prefix?: string[]
  resolveKey?: () => Promise<string | undefined>
  grokCommand: string
  nativeBridgePath: string
  /** Dedicated ACP projection for the official ZCode app-server protocol. */
}
export interface AdapterLaunch {
  home: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Resolved source explicitly supports image input; absence refuses image prompts. */
  promptImageSupport?: boolean
  /** Private bridge requests explicitly bound by this adapter, never a generic credential API. */
  clientRequests?: ReadonlyMap<string, () => Promise<unknown>>
  /**
   * Hand the argument vector to the OS verbatim. Required for `cmd.exe` wrappers:
   * Node's default Windows escaping turns the quotes around a script path into
   * `\"`, which cmd.exe reads as literal backslashes and never resolves.
   */
  windowsVerbatimArguments?: boolean
}
/** Ordered, resolved ACP input; image URIs are references, never instructions to read a file. */
export type AcpPromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      readonly data: string
      readonly mimeType: string
      readonly uri?: string
    }
/** The subset of the ACP transport an adapter may drive to pin its session. */
export interface AcpRequestSurface {
  request(method: string, params: object, timeoutMs?: number): Promise<unknown>
}
export interface AcpSessionSnapshot {
  /** Result of `initialize`, used for capability and version diagnostics. */
  readonly agent: Record<string, any>
  /** Result of `session/new` or `session/load`. */
  readonly session: Record<string, any>
  /** Most recently advertised config options, including `config_option_update`. */
  readonly configOptions: unknown
}
export interface AcpSessionConfigureResult {
  /** Config options advertised after pinning; the caller keeps them for later checks. */
  configOptions?: unknown
}
/**
 * What one settled turn actually produced, as observed on this turn alone.
 *
 * Only this round's own observations are exposed. A provider's error text is
 * deliberately absent: a transport that reports `end_turn` for a request the
 * model never answered reports no text either, so nothing here can be mistaken
 * for a recovered upstream error.
 */
export interface HarnessTurnOutcome {
  /** The transport's own `session/prompt` stop reason, verbatim. */
  readonly stopReason: string
  /**
   * Body text this turn delivered. Reasoning is excluded by construction, so a
   * turn that only thought reads as empty body rather than as an answer.
   */
  readonly text: string
  /** Tool calls this turn reported, each with the status it ended in. */
  readonly tools: readonly { readonly status: string }[]
}
export interface HarnessResultVerdict {
  readonly accepted: boolean
  /**
   * Why a reported success was refused. This is shown to the user, so it must
   * describe what this suite observed rather than repeat provider diagnostics
   * that may carry arbitrary content.
   */
  readonly reason?: string
}
export interface HarnessAdapter {
  id: string
  capabilities: HarnessCapabilities
  transport: 'dsh' | 'acp'
  /** Refuse a prompt that produces no ACP progress within this interval. */
  promptProgressTimeoutMs?: number
  matches(ref: ModelRef): boolean
  /** CLI-local model identity for ACP readback; defaults to the provider's wire model ID. */
  acpModelId?(ref: ModelRef): string
  available(ctx: Context, options: AdapterOptions): Promise<{ available: boolean; reason?: string }>
  prepare?(ctx: Context, record: HarnessSession, options: AdapterOptions): Promise<AdapterLaunch>
  /**
   * Pin the combination's fixed model and reasoning parameters over ACP. Runs after
   * `session/new` or `session/load` and before any prompt is sent. An adapter must
   * throw when the agent does not advertise the required values: a silent downgrade
   * to a different model or effort is never acceptable.
   */
  configureSession?(
    acp: AcpRequestSurface,
    record: HarnessSession,
    snapshot: AcpSessionSnapshot,
  ): Promise<AcpSessionConfigureResult | void>
  /**
   * Re-check the pinned parameters against the latest advertised options without
   * writing. Runs before every prompt so a session that drifted fails closed.
   */
  verifySession?(record: HarnessSession, snapshot: AcpSessionSnapshot): void
  /** Refuse unsupported prompt content before the shared transport sends session/prompt. */
  verifyPrompt?(
    record: HarnessSession,
    snapshot: AcpSessionSnapshot,
    prompt: readonly AcpPromptPart[],
  ): void
  /**
   * Adjudicate one turn whose stop reason the transport mapped to success.
   *
   * `run` calls this after `session/prompt` settles and before the terminal turn
   * state is committed, and only when that mapping produced a completion. A
   * transport may report `end_turn` for a request that produced nothing at all;
   * adapters may supply a specific refusal. Without a verdict, the shared check
   * requires body text or a completed tool result. Cancellation is never routed here.
   */
  acceptResult?(outcome: HarnessTurnOutcome): HarnessResultVerdict | void
}
