/** Compatibility results over the official DSH Session Controller. */
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController, SessionState } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionWaitOutcome, SessionWaitRequest, SessionWaitValue } from '../contracts/wait.ts'

/** The official owner is required; an unavailable controller never implies completion. */
function controllerOf(ctx: Context): SessionController {
  const controller = ctx.get('sessionController')
  if (controller === undefined)
    throw new Error('session.wait: the official Session Controller is not mounted on this Host')
  return controller
}

/**
 * Read newest events first at one fixed official history cut. Older pages keep
 * that cut, so concurrent appends cannot shift or duplicate the traversal.
 */
async function* recordedEvents(
  ctx: Context,
  sessionId: SessionId,
  signal: AbortSignal,
  throughSeq?: number,
): AsyncGenerator<SessionEvent> {
  const controller = controllerOf(ctx)
  let cut = throughSeq
  let beforeSeq: number | undefined
  for (;;) {
    const page = await controller.events(
      {
        address: { kind: 'session', sessionId },
        ...(cut === undefined ? {} : { throughSeq: cut }),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: 100,
      },
      signal,
    )
    cut ??= page.cursor
    for (let index = page.records.length - 1; index >= 0; index -= 1)
      yield page.records[index]!.event as unknown as SessionEvent
    if (!page.hasMore) return
    const next = page.records[0]?.event.seq
    if (next === undefined || next === beforeSeq)
      throw new Error('session.wait: the official history page did not advance')
    beforeSeq = next
  }
}

/**
 * Read one exact turn end, or the latest end when no turn is supplied. This is
 * a passive official history read and also works for cold persisted Sessions.
 */
export async function readSessionTurnEnd(
  ctx: Context,
  sessionId: SessionId,
  signal: AbortSignal,
  turn?: number,
  throughSeq?: number,
): Promise<SessionEvent<'turn/end'> | undefined> {
  for await (const event of recordedEvents(ctx, sessionId, signal, throughSeq)) {
    if (event.type === 'turn/end' && (turn === undefined || event.data.turn === turn)) return event
  }
  return undefined
}

/** Map durable end reasons without replacing DSH's lifecycle decisions. */
export function outcomeOfTurnEnd(reason: TurnEndReason): SessionWaitOutcome {
  switch (reason.kind) {
    case 'completed':
      return { kind: 'completed' }
    case 'error':
      return { kind: 'failed', message: reason.error.message, code: reason.error.code }
    case 'aborted':
      return { kind: 'cancelled', cause: reason.reason.kind }
    case 'blocked':
      return { kind: 'failed', message: 'the turn ended before any step was entered' }
    case 'max-tokens':
      return { kind: 'failed', message: 'a step reached its output-token ceiling' }
    case 'interrupted':
      return { kind: 'failed', message: 'the turn was interrupted and closed after the fact' }
    default:
      return {
        kind: 'failed',
        message: `the turn ended for an unrecognized reason: ${(reason as { kind: string }).kind}`,
      }
  }
}

function resultOfEnd(event: SessionEvent<'turn/end'>): SessionWaitValue {
  return { turn: event.data.turn, outcome: outcomeOfTurnEnd(event.data.reason) }
}

async function latestTurnPosition(
  ctx: Context,
  sessionId: SessionId,
  signal: AbortSignal,
  throughSeq: number,
): Promise<{ start?: SessionEvent<'turn/start'>; end?: SessionEvent<'turn/end'> }> {
  let start: SessionEvent<'turn/start'> | undefined
  let end: SessionEvent<'turn/end'> | undefined
  for await (const event of recordedEvents(ctx, sessionId, signal, throughSeq)) {
    if (event.type === 'turn/end' && end === undefined) end = event
    if (event.type === 'turn/start' && start === undefined) start = event
    if (start !== undefined && end !== undefined) break
  }
  return { ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }
}

/** The Controller confirms the pause; history adds the optional approval identity. */
async function inputRequired(
  ctx: Context,
  request: SessionWaitRequest,
  state: SessionState,
  signal: AbortSignal,
): Promise<SessionWaitValue> {
  const position = await latestTurnPosition(ctx, request.sessionId, signal, state.cursor)
  const turn = request.turn ?? position.start?.data.turn ?? position.end?.data.turn ?? 0
  const base = { sessionId: request.sessionId }
  if (state.pendingInput.includes('approval')) {
    const decided = new Set<string>()
    for await (const event of recordedEvents(ctx, request.sessionId, signal, state.cursor)) {
      if (event.type === 'turn/end' || event.type === 'turn/start') break
      if (event.type === 'approval/decided') decided.add(event.data.id)
      if (event.type === 'approval/asked' && !decided.has(event.data.id))
        return {
          turn,
          outcome: {
            kind: 'needs-input',
            request: { ...base, approvalId: event.data.id, toolName: event.data.toolName },
          },
        }
    }
  }
  return { turn, outcome: { kind: 'needs-input', request: base } }
}

/**
 * Official wait owns quiescence and pending input; its event stream preserves
 * OPL's exact-turn completion contract even while a later queued turn runs.
 * No OPL projection, Session listener, or execution state is maintained here.
 */
export async function waitForSession(
  ctx: Context,
  request: SessionWaitRequest,
  signal: AbortSignal,
): Promise<SessionWaitValue> {
  if (signal.aborted) throw abortedError()
  const controller = controllerOf(ctx)
  const lifetime = new AbortController()
  const combined = AbortSignal.any([signal, lifetime.signal])
  const events = controller
    .observeEvent({ address: { kind: 'session', sessionId: request.sessionId } }, combined)
    [Symbol.asyncIterator]()
  const pending: Promise<SessionWaitValue>[] = []
  try {
    // Arm official observation before the historical read closes the startup gap.
    const opening = await events.next()
    if (opening.done || opening.value.type !== 'ready')
      throw new Error('session.wait: the official event observation did not become ready')
    const state = await controller.state({ sessionId: request.sessionId }, combined)
    if (request.turn !== undefined) {
      const ended = await readSessionTurnEnd(
        ctx,
        request.sessionId,
        combined,
        request.turn,
        state.cursor,
      )
      if (ended !== undefined) return resultOfEnd(ended)
    }
    pending.push(
      (async () => {
        for (;;) {
          const next = await events.next()
          if (next.done) throw new Error('session.wait: the official event observation ended')
          if (next.value.type !== 'event') continue
          const event = next.value.event as unknown as SessionEvent
          if (
            event.type === 'turn/end' &&
            (request.turn === undefined || request.turn === event.data.turn)
          )
            return resultOfEnd(event)
        }
      })(),
    )
    pending.push(
      (async () => {
        for (;;) {
          const stopped = await controller.wait({ sessionId: request.sessionId }, combined)
          if (stopped.reason === 'timeout') continue
          if (stopped.reason === 'input-required')
            return inputRequired(ctx, request, stopped.state, combined)
          const position = await latestTurnPosition(
            ctx,
            request.sessionId,
            combined,
            stopped.state.cursor,
          )
          const lastTurn = position.start?.data.turn ?? position.end?.data.turn ?? 0
          const turn = request.turn ?? lastTurn
          if (turn === 0 && request.turn === undefined)
            return { turn: 0, outcome: { kind: 'completed' } }
          if (
            request.turn === undefined &&
            position.start !== undefined &&
            (position.end === undefined || position.end.data.turn < position.start.data.turn)
          )
            return {
              turn,
              outcome: {
                kind: 'failed',
                message: `turn ${String(turn)} settled without a recorded end`,
              },
            }
          const ended =
            request.turn === undefined
              ? position.end
              : await readSessionTurnEnd(
                  ctx,
                  request.sessionId,
                  combined,
                  request.turn,
                  stopped.state.cursor,
                )
          if (ended !== undefined) return resultOfEnd(ended)
          return {
            turn,
            outcome: {
              kind: 'failed',
              message:
                turn > lastTurn
                  ? `turn ${String(turn)} was never opened before the Session settled`
                  : `turn ${String(turn)} has no recorded end`,
            },
          }
        }
      })(),
    )
    return await Promise.race(pending)
  } catch (error) {
    if (signal.aborted) throw abortedError()
    throw error
  } finally {
    lifetime.abort()
    await Promise.allSettled(pending)
    await events.return?.()
  }
}

function abortedError(): Error {
  return new Error('session.wait: the wait was cancelled')
}
