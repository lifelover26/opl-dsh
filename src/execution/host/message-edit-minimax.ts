/**
 * MiniMax Code edit driver.
 *
 * The candidate Runtime already exposes `opl/session/history/list` and
 * `opl/session/history/rewind` (OPL extension v1). This driver only reads and
 * rewinds conversation history; it never sends a prompt, writes a HarnessSession,
 * edits DSH history, touches files, or deletes old branches. An unknown vendor
 * outcome is thrown as `vendor-uncertain` and is never retried here.
 */
import { createHash } from 'node:crypto'

import type {
  ExternalEditBoundary,
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'

export const MINIMAX_HISTORY_META = 'opl/session-history'
export const MINIMAX_HISTORY_LIST = 'opl/session/history/list'
export const MINIMAX_HISTORY_REWIND = 'opl/session/history/rewind'

export const MINIMAX_EDIT_ERRORS = {
  unsupported: 'minimax-edit-unsupported',
  historyChanged: 'minimax-edit-history-changed',
  targetUnknown: 'minimax-edit-target-unknown',
  vendorRejected: 'minimax-edit-vendor-rejected',
  vendorUncertain: 'minimax-edit-vendor-uncertain',
  protocolInvalid: 'minimax-edit-protocol-invalid',
  aborted: 'minimax-edit-aborted',
} as const

export type MinimaxEditErrorCode = (typeof MINIMAX_EDIT_ERRORS)[keyof typeof MINIMAX_EDIT_ERRORS]

export class MinimaxEditError extends Error {
  constructor(readonly code: MinimaxEditErrorCode) {
    super(code)
    this.name = 'MinimaxEditError'
  }
}

interface MinimaxEntry {
  userMessageId: string
  contentHead?: string
  timestamp: number
  fileChangeCount: number
  assistantMessageId?: string
}

const sha256 = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const sessionIdOf = (context: ExternalEditContext): string => {
  const id = context.record.acpSessionId
  if (typeof id !== 'string' || !id) throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.unsupported)
  return id
}

const assertIdle = (context: ExternalEditContext): void => {
  if (context.signal.aborted) throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.aborted)
}

/**
 * Only the Runtime's own complete announcement opens the surface. A missing
 * method or an unexpected version is unsupported, never guessed from similar text.
 */
export function minimaxEditCapability(
  agent: Record<string, any> | undefined,
): { ready: true } | { ready: false; code: MinimaxEditErrorCode } {
  const announced = agent?._meta?.[MINIMAX_HISTORY_META]
  if (!isRecord(announced) || announced.version !== 1)
    return { ready: false, code: MINIMAX_EDIT_ERRORS.unsupported }
  const methods = Array.isArray(announced.methods) ? announced.methods : []
  if (!methods.includes(MINIMAX_HISTORY_LIST) || !methods.includes(MINIMAX_HISTORY_REWIND))
    return { ready: false, code: MINIMAX_EDIT_ERRORS.unsupported }
  return { ready: true }
}

function parseEntries(value: unknown, sessionId: string): MinimaxEntry[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries))
    throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
  if (value.sessionId !== sessionId) throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
  const entries: MinimaxEntry[] = []
  const ids = new Set<string>()
  for (const item of value.entries) {
    if (!isRecord(item) || typeof item.userMessageId !== 'string' || !item.userMessageId)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
    if (ids.has(item.userMessageId)) throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
    ids.add(item.userMessageId)
    if (typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp))
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
    if (
      item.fileChangeCount !== undefined &&
      (typeof item.fileChangeCount !== 'number' ||
        !Number.isFinite(item.fileChangeCount) ||
        item.fileChangeCount < 0)
    )
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
    if (item.contentHead !== undefined && typeof item.contentHead !== 'string')
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
    if (
      item.assistantMessageId !== undefined &&
      (typeof item.assistantMessageId !== 'string' || !item.assistantMessageId)
    )
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.protocolInvalid)
    entries.push({
      userMessageId: item.userMessageId,
      timestamp: item.timestamp,
      fileChangeCount: item.fileChangeCount ?? 0,
      ...(item.contentHead === undefined ? {} : { contentHead: item.contentHead }),
      ...(item.assistantMessageId === undefined
        ? {}
        : { assistantMessageId: item.assistantMessageId }),
    })
  }
  return entries
}

/** Compare retained facts, not just ids: a re-created message with the same id must not pass. */
function sameEntryFacts(left: MinimaxEntry, right: MinimaxEntry): boolean {
  return (
    left.timestamp === right.timestamp &&
    left.fileChangeCount === right.fileChangeCount &&
    left.contentHead === right.contentHead &&
    left.assistantMessageId === right.assistantMessageId
  )
}

/**
 * The token covers every vendor fact the list exposes. `contentHead` is included
 * only as a change detector; it is never exposed as exact boundary text.
 */
function tokenOf(sessionId: string, entries: readonly MinimaxEntry[]): string {
  return sha256({
    sessionId,
    entries: entries.map((entry) => ({
      id: entry.userMessageId,
      timestamp: entry.timestamp,
      fileChangeCount: entry.fileChangeCount,
      contentHead: entry.contentHead ?? null,
      assistantMessageId: entry.assistantMessageId ?? null,
    })),
  })
}

async function readHistory(context: ExternalEditContext): Promise<{
  history: ExternalEditHistory
  entries: MinimaxEntry[]
}> {
  const capability = minimaxEditCapability(context.snapshot().agent)
  if (!capability.ready) throw new MinimaxEditError(capability.code)
  const sessionId = sessionIdOf(context)
  assertIdle(context)
  let response: unknown
  try {
    response = await context.transport().request(MINIMAX_HISTORY_LIST, { sessionId }, 60_000)
  } catch {
    throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
  }
  assertIdle(context)
  const entries = parseEntries(response, sessionId)
  const boundaries: ExternalEditBoundary[] = entries.map((entry) => ({
    // `contentHead` is a summary, so it is deliberately not used as `text`.
    id: entry.userMessageId,
  }))
  return {
    history: { sessionId, token: tokenOf(sessionId, entries), boundaries },
    entries,
  }
}

/** A failed native input is eligible only when the complete stored history matches. */
function failedInput(
  context: ExternalEditContext,
  history: ExternalEditHistory,
): string | undefined {
  const turns = context.record.turns
  const last = turns.at(-1)
  const inputId = last?.native?.userMessageId
  if (
    last?.state !== 'failed' ||
    !inputId ||
    turns.some(
      (turn) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.state),
    ) ||
    turns.length !== history.boundaries.length ||
    turns.some((turn, index) => turn.native?.userMessageId !== history.boundaries[index]?.id)
  )
    return undefined
  return inputId
}

/** ACP load can omit its requested id; an explicit conflicting id must still fail. */
function assertSameSession(context: ExternalEditContext, sessionId: string): void {
  const loadedSessionId = context.snapshot().session?.sessionId
  if (
    sessionIdOf(context) !== sessionId ||
    (loadedSessionId !== undefined && loadedSessionId !== sessionId)
  )
    throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.historyChanged)
}

export const minimaxMessageEditDriver: ExternalMessageEditDriver = {
  async read(context) {
    const { history } = await readHistory(context)
    const inputId = failedInput(context, history)
    if (!inputId) return history
    // A failed RPC alone does not establish that the native prompt has stopped.
    try {
      await context.disconnect()
    } catch {
      assertIdle(context)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    }
    assertIdle(context)
    if (sessionIdOf(context) !== history.sessionId || failedInput(context, history) !== inputId)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.historyChanged)
    try {
      await context.reconnect(history.sessionId)
    } catch {
      assertIdle(context)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    }
    assertIdle(context)
    assertSameSession(context, history.sessionId)
    const after = (await readHistory(context)).history
    const confirmed = (await readHistory(context)).history
    assertSameSession(context, history.sessionId)
    if (
      history.token !== after.token ||
      after.token !== confirmed.token ||
      failedInput(context, confirmed) !== inputId
    )
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.historyChanged)
    assertIdle(context)
    return { ...confirmed, settledInputId: inputId }
  },

  async rewind(context, input): Promise<ExternalEditResult> {
    assertIdle(context)
    const { history, entries } = await readHistory(context)
    if (history.sessionId !== input.expected.sessionId)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.historyChanged)
    if (history.token !== input.expected.token)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.historyChanged)
    if (
      input.expected.boundaries.length !== entries.length ||
      input.expected.boundaries.some(
        (boundary, index) => boundary.id !== entries[index]!.userMessageId,
      )
    )
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.historyChanged)
    const targetIndex = entries.findIndex((entry) => entry.userMessageId === input.targetId)
    if (targetIndex < 0) throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.targetUnknown)
    const target = entries[targetIndex]!
    const expectedTarget = input.expected.boundaries.find(
      (boundary) => boundary.id === input.targetId,
    )
    if (!expectedTarget) throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.targetUnknown)
    assertIdle(context)
    let result: unknown
    try {
      result = await context.transport().request(
        MINIMAX_HISTORY_REWIND,
        {
          sessionId: history.sessionId,
          userMessageId: target.userMessageId,
          clientRequestId: input.operationId,
          // Conversation only: files are never reverted.
          rewindTurnDiff: false,
        },
        60_000,
      )
    } catch {
      // The mutation may or may not have happened. Never inspect the target and
      // never retry here; the shared owner's persisted invoking state blocks sends.
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    }
    if (
      !isRecord(result) ||
      result.version !== 1 ||
      result.rewound !== true ||
      result.sessionId !== history.sessionId ||
      result.userMessageId !== target.userMessageId ||
      result.clientRequestId !== input.operationId ||
      !Array.isArray(result.deletedMessageIds)
    )
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    const deleted = result.deletedMessageIds.filter(
      (item): item is string => typeof item === 'string',
    )
    const retainedEntries = entries.slice(0, targetIndex)
    if (
      !deleted.includes(target.userMessageId) ||
      deleted.some((id) => retainedEntries.some((entry) => entry.userMessageId === id))
    )
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    // A post-rewind read is verification, not a retry. If it fails, the mutation
    // already happened and the outcome is unknown to this driver.
    let after: { history: ExternalEditHistory; entries: MinimaxEntry[] }
    try {
      after = await readHistory(context)
    } catch {
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    }
    // Exact full retained history, not a prefix slice: the target and every later
    // message must be gone, and retained facts (timestamp/file-change/assistant id)
    // must be unchanged.
    if (after.history.sessionId !== history.sessionId)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    if (after.entries.length !== retainedEntries.length)
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    for (let index = 0; index < retainedEntries.length; index += 1) {
      const expectedEntry = retainedEntries[index]!
      const actual = after.entries[index]!
      if (
        actual.userMessageId !== expectedEntry.userMessageId ||
        !sameEntryFacts(actual, expectedEntry)
      )
        throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    }
    if (after.entries.some((entry) => entry.userMessageId === target.userMessageId))
      throw new MinimaxEditError(MINIMAX_EDIT_ERRORS.vendorUncertain)
    return {
      sessionId: after.history.sessionId,
      retained: retainedEntries.map((entry) => ({
        previousId: entry.userMessageId,
        nextId: entry.userMessageId,
      })),
    }
  },
}

/** Factory alias for adapter registration. */
export function createMinimaxMessageEditDriver(): ExternalMessageEditDriver {
  return minimaxMessageEditDriver
}
