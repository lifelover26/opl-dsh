/** StepCode edits use the bridge's verified native fork; record ownership and replacement prompts stay in Host. */
import { STEP_HARNESS } from './adapters/step/step-models.ts'
import type {
  ExternalEditBoundary,
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'
import {
  ExternalMessageEditError,
  type ExternalMessageEditFailure,
} from './message-edit-opencode-common.ts'

const READ = 'opl/edit/read'
const REWIND = 'opl/edit/rewind'
const READ_TIMEOUT_MS = 20_000
const REWIND_TIMEOUT_MS = 60_000
const FAILURES = new Set<ExternalMessageEditFailure>([
  'unsupported',
  'busy',
  'aborted',
  'stale',
  'history-changed',
  'target-unknown',
  'target-unavailable',
  'control-unavailable',
  'fork-rejected',
  'uncertain',
  'protocol',
])

const fail = (code: ExternalMessageEditFailure) => new ExternalMessageEditError(code)

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) throw fail('protocol')
  return value
}

function ensureActive(context: ExternalEditContext): void {
  if (context.signal.aborted) throw fail('aborted')
}

/** Harness identity alone cannot establish that an older bridge implements the edit methods. */
function ensureSession(context: ExternalEditContext): string {
  ensureActive(context)
  if (context.record.harnessRef !== STEP_HARNESS) throw fail('unsupported')
  const capability = object(object(object(context.snapshot().agent).agentCapabilities)._meta)
  const edit = object(capability['opl/message-edit'])
  if (
    edit.version !== 1 ||
    !Array.isArray(edit.methods) ||
    ![READ, REWIND].every((method) => (edit.methods as unknown[]).includes(method))
  )
    throw fail('unsupported')
  const sessionId = context.record.acpSessionId
  if (!sessionId) throw fail('stale')
  return sessionId
}

function successfulReply(value: unknown, mutating = false): Record<string, unknown> {
  const reply = object(value)
  if (reply.ok !== true) {
    const code = reply.code as ExternalMessageEditFailure
    if (mutating && (reply.ok !== false || !FAILURES.has(code))) throw fail('uncertain')
    throw fail(FAILURES.has(code) ? code : 'protocol')
  }
  return reply
}

function boundaries(value: unknown): ExternalEditBoundary[] {
  if (!Array.isArray(value)) throw fail('protocol')
  const ids = new Set<string>()
  return value.map((raw) => {
    const entry = object(raw)
    const id = requiredString(entry.id)
    if (ids.has(id)) throw fail('protocol')
    ids.add(id)
    if (entry.text !== undefined && typeof entry.text !== 'string') throw fail('protocol')
    if (entry.unavailableReason !== undefined && typeof entry.unavailableReason !== 'string')
      throw fail('protocol')
    return {
      id,
      ...(typeof entry.text === 'string' ? { text: entry.text } : {}),
      ...(typeof entry.unavailableReason === 'string'
        ? { unavailableReason: entry.unavailableReason }
        : {}),
    }
  })
}

async function request(
  context: ExternalEditContext,
  method: string,
  params: Record<string, unknown>,
  mutating: boolean,
): Promise<unknown> {
  ensureActive(context)
  try {
    return await context
      .transport()
      .request(method, params, mutating ? REWIND_TIMEOUT_MS : READ_TIMEOUT_MS)
  } catch (error) {
    // Once a fork request crossed the transport, cancellation or loss of its reply says nothing about its effect.
    if (mutating) throw fail('uncertain')
    if (context.signal.aborted) throw fail('aborted')
    throw fail('control-unavailable')
  }
}

/** The stored native ids must account for the whole failed turn and its retained prefix. */
function failedInput(
  context: ExternalEditContext,
  history: ExternalEditHistory,
): string | undefined {
  const turns = context.record.turns
  const last = turns.at(-1)
  const id = last?.native?.userMessageId
  if (
    !last ||
    !['failed', 'cancelled'].includes(last.state) ||
    !id ||
    turns.some((turn) => !['completed', 'failed', 'cancelled'].includes(turn.state)) ||
    turns.length !== history.boundaries.length ||
    turns.some((turn, index) => turn.native?.userMessageId !== history.boundaries[index]?.id)
  )
    return
  return id
}

async function readHistory(
  context: ExternalEditContext,
  sessionId: string,
): Promise<ExternalEditHistory> {
  const reply = successfulReply(await request(context, READ, { sessionId }, false))
  if (requiredString(reply.sessionId) !== sessionId) throw fail('stale')
  const values = boundaries(reply.boundaries)
  if (
    reply.settledInputId !== undefined &&
    (typeof reply.settledInputId !== 'string' || reply.settledInputId !== values.at(-1)?.id)
  )
    throw fail('protocol')
  ensureActive(context)
  return {
    sessionId,
    token: requiredString(reply.token),
    boundaries: values,
    ...(typeof reply.settledInputId === 'string' ? { settledInputId: reply.settledInputId } : {}),
  }
}

/**
 * Return a driver for StepCode's live RPC bridge.
 *
 * @returns Read and rewind operations; a lazy first-message identity reports `ephemeral`
 * until the shared owner sends a replacement and the native CLI persists its file.
 */
export function stepMessageEditDriver(): ExternalMessageEditDriver {
  return {
    async read(context): Promise<ExternalEditHistory> {
      const sessionId = ensureSession(context)
      const history = await readHistory(context, sessionId)
      const inputId = failedInput(context, history)
      if (history.settledInputId || !inputId) return history

      // A terminated Step process can leave a durable user input without any assistant
      // entry. Await its owned exit and reload before treating that exact input as settled.
      try {
        await context.disconnect()
      } catch (error) {
        ensureActive(context)
        throw fail('control-unavailable')
      }
      ensureActive(context)
      try {
        await context.reconnect(sessionId)
      } catch (error) {
        ensureActive(context)
        throw fail('control-unavailable')
      }
      if (ensureSession(context) !== sessionId) throw fail('stale')
      const after = await readHistory(context, sessionId)
      const confirmed = await readHistory(context, sessionId)
      if (history.token !== after.token || after.token !== confirmed.token)
        throw fail('history-changed')
      if (failedInput(context, confirmed) !== inputId) throw fail('stale')
      ensureActive(context)
      return { ...confirmed, settledInputId: inputId }
    },

    async rewind(context, input): Promise<ExternalEditResult> {
      const sessionId = ensureSession(context)
      if (!input.operationId || !input.targetId) throw fail('target-unknown')
      if (input.expected.sessionId !== sessionId || !input.expected.token) throw fail('stale')
      const target = input.expected.boundaries.findIndex((entry) => entry.id === input.targetId)
      if (target < 0) throw fail('target-unknown')
      if (input.expected.boundaries[target]?.unavailableReason) throw fail('target-unavailable')
      const value = await request(
        context,
        REWIND,
        {
          sessionId,
          operationId: input.operationId,
          targetId: input.targetId,
          expectedToken: input.expected.token,
        },
        true,
      )
      if (context.signal.aborted) throw fail('uncertain')
      const reply = successfulReply(value, true)
      try {
        if (context.signal.aborted) throw fail('uncertain')
        const nextId = requiredString(reply.sessionId)
        if (
          nextId === sessionId ||
          !Array.isArray(reply.retained) ||
          reply.retained.length !== target
        )
          throw fail('uncertain')
        const retained = reply.retained.map((raw, index) => {
          const entry = object(raw)
          const expected = input.expected.boundaries[index]!.id
          if (entry.previousId !== expected || entry.nextId !== expected) throw fail('uncertain')
          return { previousId: expected, nextId: expected }
        })
        if (reply.ephemeral !== undefined && typeof reply.ephemeral !== 'boolean')
          throw fail('uncertain')
        if (reply.ephemeral === true && target !== 0) throw fail('uncertain')
        return {
          sessionId: nextId,
          retained,
          ...(reply.ephemeral === true ? { ephemeral: true } : {}),
        }
      } catch (error) {
        throw fail('uncertain')
      }
    },
  }
}
