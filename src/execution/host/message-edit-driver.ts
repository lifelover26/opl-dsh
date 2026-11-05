/** Vendor history operations used by the shared same-conversation edit transaction. */
import type { HarnessSession } from '../contracts/sessions.ts'
import type { AcpRequestSurface, AcpSessionSnapshot, AdapterLaunch } from './adapters/types.ts'
import type { HarnessStatistics } from '../contracts/usage.ts'

/** A real user input in the active vendor history, never a text-derived identity. */
export interface ExternalEditBoundary {
  id: string
  /** Optional statistics for this exact native user input, read in the same control lifecycle. */
  statistics?: HarnessStatistics
  /** Exact text when supplied by the public protocol; summaries must not populate this. */
  text?: string
  /** Vendor-specific restriction for this boundary. */
  unavailableReason?: string
}

/** Read-only history observation; its token covers the vendor facts used for mutation. */
export interface ExternalEditHistory {
  sessionId: string
  token: string
  boundaries: ExternalEditBoundary[]
  /** Latest input with a verified terminal reply or owned engine exit and stable idle history. */
  settledInputId?: string
}

/** Shared owner supplies transport lifecycle and retains all record/prompt ownership. */
export interface ExternalEditContext {
  readonly record: Readonly<HarnessSession>
  readonly launch: AdapterLaunch
  readonly signal: AbortSignal
  transport(): AcpRequestSurface
  snapshot(): AcpSessionSnapshot
  /** Stop this record's idle connection; never changes its persisted binding. */
  disconnect(): Promise<void>
  /** Reconnect the specified vendor identity and verify the original route/permissions. */
  reconnect(sessionId: string): Promise<void>
  /** Replay into a separate observation, preserving configured MCP servers and the stored turns. */
  replayHistory?(): Promise<ExternalEditHistory>
}

/** Exact retained user-boundary correspondence after a vendor changes history. */
export interface ExternalEditResult {
  sessionId: string
  retained: { previousId: string; nextId: string }[]
  /** The new empty session is already active and need not support loading before its first prompt. */
  ephemeral?: boolean
}

/**
 * A driver never sends the replacement prompt, writes HarnessSession records, or edits DSH history.
 * The shared owner journals invocation before rewind and blocks all sends on uncertain outcomes.
 */
export interface ExternalMessageEditDriver {
  /** Read the current active user boundaries, refusing an unverified capability. */
  read(context: ExternalEditContext): Promise<ExternalEditHistory>
  /**
   * Exclude target and its tail without reverting files or deleting old branches.
   * Revalidate expected history immediately before mutation. Throw on uncertain results;
   * callers must not interpret an exception as proof the vendor was unchanged.
   */
  rewind(
    context: ExternalEditContext,
    input: { operationId: string; targetId: string; expected: ExternalEditHistory },
  ): Promise<ExternalEditResult>
}
