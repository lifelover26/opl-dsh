/** Match official user events to vendor input identities without text or position inference. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HarnessSession } from '../contracts/sessions.ts'
import type { ExternalEditHistory, ExternalEditResult } from './message-edit-driver.ts'
import { readNativeUserMessages, turnRequestIds } from './stop-edit-native.ts'
import { validateExternalEditResult, type ExternalEditIntent } from './message-edit-external.ts'

export interface ExternalEditChoice {
  seq: number
  text: string
  boundaryId: string
  turnIndex: number
}

/** An allocated prefix with no admitted replacement can be resumed by a new explicit edit. */
export function externalPreparedChoice(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  if (
    intent?.phase !== 'ready' ||
    !intent.result ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    record.turns.length !== intent.result.retained.length ||
    record.turns.some(
      (turn, index) => turn.native?.userMessageId !== intent.result!.retained[index]?.nextId,
    )
  )
    return
  const users = readNativeUserMessages(events)
  if (users.some((message) => message.rpcId === intent.requestId)) return
  const active = users.filter((message) => activeSeqs.has(message.seq))
  // Older journals lack the native target. A sole visible input and a confirmed empty
  // vendor prefix need no identity mapping or further rewind to start that input afresh.
  if (
    intent.targetSeq === undefined &&
    (intent.result.retained.length ||
      intent.expected.boundaries.length !== 1 ||
      active.length !== 1)
  )
    return
  const matches = active.filter(
    (message) =>
      (intent.targetSeq === undefined || message.seq === intent.targetSeq) &&
      !message.attachments.length,
  )
  return matches.length === 1 ? { seq: matches[0]!.seq, text: matches[0]!.text } : undefined
}

/** An empty fork with no vendor send can be replaced explicitly even if its file was never created. */
export function externalUnsentEmptyChoice(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  const turn = record.turns[0]
  if (
    !intent?.result?.ephemeral ||
    intent.phase !== 'admitting' ||
    intent.result.retained.length ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    record.turns.length !== 1 ||
    !turn ||
    turn.state !== 'failed' ||
    turn.native?.userMessageId ||
    turn.operationId !== 'message-edit:' + intent.requestId
  )
    return
  const messages = readNativeUserMessages(events).filter(
    (message) =>
      activeSeqs.has(message.seq) &&
      (turn.native?.officialSeq === undefined || message.seq === turn.native.officialSeq) &&
      message.rpcId === intent.requestId &&
      !message.attachments.length,
  )
  return messages.length === 1 ? { seq: messages[0]!.seq, text: messages[0]!.text } : undefined
}

/** Recover a terminal external failure from the exact persisted vendor input identity. */
export function externalTerminalFailureChoice(
  record: HarnessSession,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  const turn = record.turns.at(-1)
  if (
    !intent?.result ||
    intent.phase !== 'settled' ||
    intent.recordId !== record.id ||
    intent.sessionId !== record.nativeSessionId ||
    intent.result.sessionId !== record.acpSessionId ||
    !turn ||
    turn.state !== 'failed' ||
    turn.stopReason !== 'error_response' ||
    !turn.native?.userMessageId ||
    turn.operationId !== 'message-edit:' + intent.requestId
  )
    return
  const matches = readNativeUserMessages(events).filter(
    (message) =>
      activeSeqs.has(message.seq) &&
      message.rpcId === intent.requestId &&
      (turn.native?.officialSeq === undefined || message.seq === turn.native.officialSeq) &&
      !message.attachments.length,
  )
  return matches.length === 1 ? { seq: matches[0]!.seq, text: matches[0]!.text } : undefined
}

/** Confirm a failed replacement using its journal, official request and complete vendor prefix. */
export function externalEditRecovery(
  record: HarnessSession,
  history: ExternalEditHistory,
  intent: ExternalEditIntent | undefined,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { kind: 'settled' } | { kind: 'unsent'; choice: { seq: number; text: string } } | undefined {
  if (
    !intent?.result ||
    intent.sessionId !== record.nativeSessionId ||
    intent.recordId !== record.id ||
    intent.result.sessionId !== record.acpSessionId ||
    history.sessionId !== record.acpSessionId
  )
    return
  const turn = record.turns.at(-1)
  if (
    !turn ||
    !['failed', 'cancelled'].includes(turn.state) ||
    turn.operationId !== 'message-edit:' + intent.requestId ||
    record.turns.length !== intent.result.retained.length + 1
  )
    return
  const messages = readNativeUserMessages(events).filter(
    (message) =>
      activeSeqs.has(message.seq) &&
      message.seq === turn.native?.officialSeq &&
      message.rpcId === intent.requestId &&
      !message.attachments.length,
  )
  if (messages.length !== 1) return
  const prefix = record.turns.slice(0, -1).map((item) => item.native?.userMessageId)
  if (
    prefix.some((id, index) => !id || id !== intent.result!.retained[index]?.nextId) ||
    new Set(history.boundaries.map((item) => item.id)).size !== history.boundaries.length ||
    prefix.some((id, index) => id !== history.boundaries[index]?.id)
  )
    return
  if (
    ['admitting', 'settled'].includes(intent.phase) &&
    !turn.native?.userMessageId &&
    history.boundaries.length === prefix.length
  )
    return { kind: 'unsent', choice: { seq: messages[0]!.seq, text: messages[0]!.text } }
  const inputId = turn.native?.userMessageId
  if (
    ['prompting', 'settled'].includes(intent.phase) &&
    !inputId &&
    !prefix.length &&
    history.boundaries.length === 1 &&
    history.settledInputId === history.boundaries[0]!.id
  )
    return { kind: 'settled' }
  if (
    ['prompting', 'settled'].includes(intent.phase) &&
    inputId &&
    history.boundaries.length === prefix.length + 1 &&
    history.boundaries.at(-1)?.id === inputId &&
    (turn.stopReason === 'error_response' || history.settledInputId === inputId)
  )
    return { kind: 'settled' }
}

/** Only exact, unique identities present in both active histories can be edited. */
export function externalEditChoices(
  record: HarnessSession,
  history: ExternalEditHistory,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): ExternalEditChoice[] {
  if (record.acpSessionId !== history.sessionId) return []
  const boundaries = new Map(history.boundaries.map((boundary) => [boundary.id, boundary]))
  if (boundaries.size !== history.boundaries.length) return []
  const messages = readNativeUserMessages(events).filter((message) => activeSeqs.has(message.seq))
  const nativeIds = record.turns.map((turn) => turn.native?.userMessageId).filter(Boolean)
  if (new Set(nativeIds).size !== nativeIds.length) return []
  const choices: ExternalEditChoice[] = []
  for (const [turnIndex, turn] of record.turns.entries()) {
    const id = turn.native?.userMessageId
    const boundary = id ? boundaries.get(id) : undefined
    if (!boundary || boundary.unavailableReason) continue
    if (
      history.boundaries[turnIndex]?.id !== id ||
      record.turns
        .slice(0, turnIndex)
        .some(
          (prior, index) =>
            !prior.native?.userMessageId ||
            prior.native.userMessageId !== history.boundaries[index]?.id,
        )
    )
      continue
    const requestIds = turnRequestIds(record, turn)
    const matches = messages.filter((message) =>
      turn.native?.officialSeq !== undefined
        ? message.seq === turn.native.officialSeq
        : message.rpcId !== undefined && requestIds.includes(message.rpcId),
    )
    if (matches.length !== 1) continue
    const message = matches[0]!
    if (message.attachments.length) continue
    choices.push({ seq: message.seq, text: message.text, boundaryId: boundary.id, turnIndex })
  }
  const counts = new Map<number, number>()
  for (const choice of choices) counts.set(choice.seq, (counts.get(choice.seq) ?? 0) + 1)
  return choices.filter((choice) => counts.get(choice.seq) === 1)
}

/** Display saved exact input identities without launching a CLI or admitting a model request. */
export function externalRecordedChoices(
  record: HarnessSession,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): ExternalEditChoice[] {
  return externalEditChoices(
    record,
    {
      sessionId: record.acpSessionId,
      token: 'recorded-inputs',
      boundaries: record.turns.flatMap((turn) =>
        turn.native?.userMessageId ? [{ id: turn.native.userMessageId }] : [],
      ),
    },
    events,
    activeSeqs,
  )
}

/** An unbound first input can start a fresh vendor session because it retains no vendor prefix. */
export function externalFreshFirstChoice(
  record: HarnessSession,
  events: readonly SessionEvent[],
  activeSeqs: ReadonlySet<number>,
): { seq: number; text: string } | undefined {
  const turn = record.turns[0]
  if (!record.acpSessionId || !turn || turn.native?.userMessageId) return
  const messages = readNativeUserMessages(events).filter((message) => activeSeqs.has(message.seq))
  const first = messages[0]
  if (!first || first.attachments.length) return
  const matches = messages.filter((message) =>
    turn.native?.officialSeq !== undefined
      ? message.seq === turn.native.officialSeq
      : message.rpcId !== undefined && turnRequestIds(record, turn).includes(message.rpcId),
  )
  if (matches.length !== 1 || matches[0]!.seq !== first.seq) return
  return { seq: first.seq, text: first.text }
}

/** Prepare a new binding in memory; the owner persists it only after the vendor result journal. */
export function externalEditedRecord(
  record: HarnessSession,
  history: ExternalEditHistory,
  targetId: string,
  result: ExternalEditResult,
): HarnessSession {
  validateExternalEditResult(history, targetId, result)
  const target = record.turns.findIndex((turn) => turn.native?.userMessageId === targetId)
  if (target < 0 || record.acpSessionId !== history.sessionId)
    throw Error('编辑目标未绑定到当前会话')
  const retained = record.turns.slice(0, target)
  if (
    retained.length !== result.retained.length ||
    retained.some(
      (turn, index) => turn.native?.userMessageId !== result.retained[index]!.previousId,
    )
  )
    throw Error('编辑后的轮次映射不一致')
  const next = structuredClone(record)
  next.acpSessionId = result.sessionId
  next.turns = structuredClone(retained).map((turn, index) => ({
    ...turn,
    native: { ...turn.native, userMessageId: result.retained[index]!.nextId },
  }))
  return next
}
