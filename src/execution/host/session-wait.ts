import type {} from '@deepseek-ai/dsh-user-approval'
/**
 * Event-driven waiting for one Session to reach a terminal state.
 *
 * A caller that wants to know "has this Session finished, failed, been
 * cancelled, or stopped for input?" must not poll the log. Every one of those
 * facts is already published: `turn/end` is a durable Session event carrying a
 * `TurnEndReason`, and the approval audit pair (`approval/asked` /
 * `approval/decided`) brackets the one interactive pause a tool call can enter.
 *
 * The wait observes those facts through a Session projection, and resolves the
 * instant the live `session/event` feed delivers the one it is waiting for.
 * Reading the position it starts from goes through the same projection rather
 * than a synchronous scan of the event log: a synchronous historical read is
 * prohibited for new code because it makes behavior depend on the whole event
 * sequence staying resident in memory.
 *
 * The wait is a pure observer: it appends nothing, holds no service, and
 * resolves exactly once. Caller cancellation removes the listeners and rejects.
 *
 * @module @deepseek-ai/dsh-session-controller/wait
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { officialValidationSchema } from '../../compat/host/validation-schema.ts'
import type { SessionWaitOutcome, SessionWaitRequest, SessionWaitValue } from '../contracts/wait.ts'

/** Projection key carrying the facts one wait needs. */
export const SESSION_WAIT_PROJECTION_KEY = 'sessionWait'

/** Folded facts about one Session's turn and approval position. */
export interface SessionWaitState {
  /** Turn number of the last `turn/end`, or null before any turn ends. */
  readonly lastEndTurn: number | null
  /** Reason recorded by the last `turn/end`, or null before any turn ends. */
  readonly lastEndReason: TurnEndReason | null
  /** Turn recorded by the last `turn/end` the client asked about, keyed by turn number. */
  readonly closedTurns: Readonly<Record<string, TurnEndReason>>
  /**
   * Approval requests the open turn is still waiting on, with the tool each
   * concerns. A turn that ends abandons its unanswered asks — the ask belongs
   * to that turn's tool call, and the approval audit pair is only closed from
   * inside the turn — so only the open turn's asks appear here.
   */
  readonly pendingApprovals: Readonly<Record<string, string>>
}

const turnEndReasonSchema: z.ZodType<TurnEndReason> = z.custom<TurnEndReason>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string',
)

const sessionWaitSchema: z.ZodType<SessionWaitState> = z.object({
  lastEndTurn: z.number().int().nonnegative().nullable(),
  lastEndReason: turnEndReasonSchema.nullable(),
  // Keys are turn numbers as strings because projection state must be plain
  // JSON, and a JSON object has no numeric keys.
  closedTurns: z.record(z.string(), turnEndReasonSchema),
  pendingApprovals: z.record(z.string(), z.string()),
})

/** Ready read access to the Host's turn and approval facts. */
export type SessionWaitReader = Pick<ProjectionHandle<SessionWaitState>, 'stateOf'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ready wait facts, owned by the execution plugin. */
    oplSessionWait: SessionWaitReader
  }
}

/** The wait fold: every fact a wait settles on, maintained as events commit. */
export const sessionWaitProjectionDefinition = {
  key: SESSION_WAIT_PROJECTION_KEY,
  // Version 2 clears a closed turn's unanswered asks. Version 1 kept an ask
  // from a cancelled turn pending forever, which made every later wait report
  // `needs-input` for an approval the Session had already abandoned.
  stateVersion: 2,
  stateSchema: officialValidationSchema(sessionWaitSchema),
  init: () => ({
    lastEndTurn: null,
    lastEndReason: null,
    closedTurns: {},
    pendingApprovals: {},
  }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/end':
        // A cancelled turn leaves its ask unanswered on the log, because the
        // audit pair can only be closed from inside the turn that asked. The
        // entry belongs to the turn, so closing the turn drops it: an orphan
        // must not make the next turn's wait report `needs-input` forever.
        return {
          ...state,
          lastEndTurn: event.data.turn,
          lastEndReason: event.data.reason,
          closedTurns: { ...state.closedTurns, [String(event.data.turn)]: event.data.reason },
          pendingApprovals: {},
        }
      case 'approval/asked':
        return {
          ...state,
          pendingApprovals: { ...state.pendingApprovals, [event.data.id]: event.data.toolName },
        }
      case 'approval/decided': {
        if (!(event.data.id in state.pendingApprovals)) return state
        const { [event.data.id]: _decided, ...remaining } = state.pendingApprovals
        return { ...state, pendingApprovals: remaining }
      }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<typeof SESSION_WAIT_PROJECTION_KEY, SessionWaitState>

/**
 * Register the wait fold and publish its reader once registration is ready.
 * @param ctx - Host context owning the projection registry.
 * @returns once dependent consumers may read the wait facts.
 */
export async function installSessionWaitProjection(ctx: Context): Promise<void> {
  const handle = await ctx.sessionProjections.register(sessionWaitProjectionDefinition)
  const reader: SessionWaitReader = { stateOf: (session) => handle.stateOf(session) }
  ctx.provide('oplSessionWait', reader)
}

/**
 * Map a durable turn-end reason onto the wait vocabulary.
 *
 * `blocked` (pre-step rejected every claimed message) and `max-tokens` (a step
 * hit its output ceiling) settle as `failed`: the turn ended without
 * completing, and neither is a cancellation. `interrupted` is written only by
 * crash repair on a stored log, so a live wait rarely sees it, but it maps for
 * callers waiting on a resumed Session.
 * @param reason - the `turn/end` reason recorded by the loop.
 * @returns the wait outcome for that reason.
 */
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
      // Merge-extensible union: a plugin that adds a `TurnEndReasonMap` variant
      // makes its turns look unsettled rather than silently successful.
      return {
        kind: 'failed',
        message: `the turn ended for an unrecognized reason: ${(reason as { kind: string }).kind}`,
      }
  }
}

/**
 * Wait for one Session to reach a terminal state, without polling.
 *
 * Waits on the turn that is open when the call arrives, or on the exact turn
 * named by `request.turn`. It settles on the matching `turn/end` (completed,
 * failed, or cancelled) or on a pending approval (`needs-input`), whichever
 * comes first.
 *
 * The Session counts as still working only while an active driver can publish
 * another fact: a turn is open, or the Agent's driver is running. A merely
 * registered Agent does not, because it stays registered while idle after its
 * last turn and will not open another one unless new input wakes it. A Session
 * that has settled reports its recorded outcome instead of waiting forever:
 * its last `turn/end` when there is one, `completed` when it never ran, and a
 * failed outcome for a named turn an idle Session can no longer open.
 *
 * @param ctx - Host context carrying the Session log, agents, and projections.
 * @param request - Session identity and optional exact turn number.
 * @param signal - caller lifetime; abort rejects the wait.
 * @returns the observed outcome and the turn it belongs to.
 * @throws when the described Session is not attached to this Host, when the
 *   wait fold is not mounted, or when the caller aborts.
 */
export function waitForSession(
  ctx: Context,
  request: SessionWaitRequest,
  signal: AbortSignal,
): Promise<SessionWaitValue> {
  const session = ctx.sessions.get(request.sessionId)
  if (session === undefined) {
    return Promise.reject(
      new Error(
        `session.wait: Session ${JSON.stringify(request.sessionId)} is not attached to this Host`,
      ),
    )
  }
  const reader: SessionWaitReader | undefined = ctx.get('oplSessionWait')
  if (reader === undefined) {
    return Promise.reject(
      new Error(
        `session.wait: the ${JSON.stringify(SESSION_WAIT_PROJECTION_KEY)} projection is not mounted on this Host`,
      ),
    )
  }
  return new SessionWait(ctx, session, request.turn, reader).run(signal)
}

/** Listener bookkeeping for one wait; resolves once and never re-subscribes. */
class SessionWait {
  private readonly settlement = Promise.withResolvers<SessionWaitValue>()
  private settled = false

  constructor(
    private readonly ctx: Context,
    private readonly session: Session,
    private readonly requestedTurn: number | undefined,
    private readonly reader: SessionWaitReader,
  ) {}

  /** Subscribe, evaluate the current position, and stay until a terminal fact. */
  run(signal: AbortSignal): Promise<SessionWaitValue> {
    if (signal.aborted) return Promise.reject(abortedError())
    const disposeEvent = this.ctx.on('session/event', (session, event) => {
      if (session === this.session) this.observe(event)
    })
    // A driver that reaches idle has published its last fact for this activity:
    // either a `turn/end`, or nothing at all when the session stopped before
    // opening a turn. Both are terminal, and without this the wait would keep
    // holding a subscription that no further event can ever settle.
    const disposeStatus = this.ctx.on('agent/status', ({ agent, status }) => {
      if (agent.session !== this.session || status !== 'idle') return
      this.evaluate()
    })
    const onAbort = (): void => {
      if (this.settled) return
      this.settled = true
      this.settlement.reject(abortedError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void this.settlement.promise
      .finally(() => {
        disposeEvent()
        disposeStatus()
        signal.removeEventListener('abort', onAbort)
      })
      .catch(() => {})
    this.evaluate()
    return this.settlement.promise
  }

  /** Fold one committed Session event into the wait state. */
  private observe(event: SessionEvent): void {
    if (this.settled) return
    switch (event.type) {
      case 'turn/end':
        if (!this.matchesTargetTurn(event.data.turn)) return
        this.resolve(event.data.turn, outcomeOfTurnEnd(event.data.reason))
        return
      case 'approval/asked':
        // The fold records it, but a wait already subscribed sees the event
        // directly, so the ask is reported without re-reading projection state.
        if (this.ctx.get('approval') === undefined) return
        this.resolve(this.currentTurn(), this.needsInput(event.data.id, event.data.toolName))
        return
      default:
        return
    }
  }

  /**
   * Decide whether this wait is already satisfied.
   *
   * Runs after subscribing and again whenever the driver reaches idle, so a
   * fact committed between the caller's decision to wait and this subscription
   * is still observed exactly once.
   */
  private evaluate(): void {
    if (this.settled) return
    const state = this.state()
    if (this.openTurn() !== undefined) {
      this.reportPendingApproval(state)
      return
    }
    if (this.requestedTurn !== undefined) {
      const key = String(this.requestedTurn)
      if (Object.hasOwn(state.closedTurns, key)) {
        this.resolve(this.requestedTurn, outcomeOfTurnEnd(state.closedTurns[key] as TurnEndReason))
        return
      }
      const awaited = this.requestedTurn > (state.lastEndTurn ?? 0)
      // An awaited turn still ahead of the log is coming only while a driver is
      // active to open it.
      if (awaited && this.driverRunning()) return
      this.resolve(this.requestedTurn, {
        kind: 'failed',
        message: awaited
          ? `turn ${String(this.requestedTurn)} was never opened before the Session settled`
          : `turn ${String(this.requestedTurn)} has no recorded end`,
      })
      return
    }
    if (this.driverRunning()) return
    this.settleFromRecorded(state)
  }

  /**
   * Report what the Session last recorded.
   * @param state - folded wait facts for this Session.
   */
  private settleFromRecorded(state: SessionWaitState): void {
    if (state.lastEndTurn !== null && state.lastEndReason !== null) {
      this.resolve(state.lastEndTurn, outcomeOfTurnEnd(state.lastEndReason))
      return
    }
    this.resolve(0, { kind: 'completed' })
  }

  /**
   * Whether an active driver can still publish a terminal fact for this Session.
   *
   * A registered Agent is not enough. It stays registered while idle after its
   * last turn, and an idle driver opens no further turn unless new input wakes
   * it, so waiting on registration alone leaves a wait issued after the final
   * turn with no event that could ever settle it — the state a parent reaches
   * once its last child or subtask has finished. A driver is `running` from the
   * moment waking input reaches it until it converges, which is also why a wait
   * issued straight after a prompt still observes that prompt's turn.
   * @returns true while this Session has an active driver.
   */
  private driverRunning(): boolean {
    return this.agent()?.status === 'running'
  }

  /** Resolve `needs-input` now when an approval is already pending. */
  private reportPendingApproval(state: SessionWaitState): void {
    if (this.ctx.get('approval') === undefined) return
    // Only undecided asks remain in the fold, so its last key is the newest
    // pending ask, which is the one a decision has to address.
    const pendingAsk = Object.keys(state.pendingApprovals).at(-1)
    if (pendingAsk === undefined) return
    this.resolve(
      this.currentTurn(),
      this.needsInput(pendingAsk, state.pendingApprovals[pendingAsk] as string),
    )
  }

  /** The `needs-input` outcome describing one pending approval. */
  private needsInput(approvalId: string, toolName: string): SessionWaitOutcome {
    return {
      kind: 'needs-input',
      request: {
        sessionId: this.session.id,
        approvalId,
        toolName,
      },
    }
  }

  /** The folded wait facts for this Session. */
  private state(): SessionWaitState {
    return this.reader.stateOf(this.session)
  }

  /** Whether a `turn/end` number is the one being awaited. */
  private matchesTargetTurn(turn: number): boolean {
    return this.requestedTurn === undefined || this.requestedTurn === turn
  }

  /** The turn an observation belongs to. */
  private currentTurn(): number {
    return this.requestedTurn ?? this.openTurn() ?? 0
  }

  /** The currently open turn number, from the loop's boundary projection. */
  private openTurn(): number | undefined {
    const state = this.ctx.agents.turnBoundaryOf(this.session)
    if (state.openTurnStartSeq === null) return undefined
    return state.lastTurn
  }

  /** The live Agent driving this Session, when there is one. */
  private agent(): Agent | undefined {
    const agent = this.ctx.agents.get(this.session.id)
    return agent?.session === this.session ? agent : undefined
  }

  private resolve(turn: number, outcome: SessionWaitOutcome): void {
    if (this.settled) return
    this.settled = true
    this.settlement.resolve({ turn, outcome })
  }
}

/** The stable failure a cancelled wait reports. */
function abortedError(): Error {
  return new Error('session.wait: the wait was cancelled')
}
