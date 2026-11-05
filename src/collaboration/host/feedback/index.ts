/**
 * Task feedback: durable registration of dispatched work, a model-free watcher
 * over the bound Sessions, and an outbox that hands one bounded completion
 * notification to the Session that dispatched the task.
 *
 * What this service promises, and what it does not:
 *
 * - A successful transport handoff is sent once; only a refused handoff is
 *   retried. A delivery id is stable per task state, acknowledgments only move
 *   forward, and a repeated notification is a no-op for the receiver. No
 *   exactly-once delivery is claimed, because no transport can make that promise.
 * - A claim has an explicit owner, generation, and lease. `receive` answers
 *   `review` for the first claim, `resume` to the consumer that owns an
 *   unfinished claim, `busy` to a different consumer while the owner's lease is
 *   live, and `skip` after consumption; `consume` rejects a generation the owner
 *   no longer holds. An expired or crashed consumer's claim is reclaimed by a
 *   new generation, which is how an interrupted review is taken over without
 *   racing the consumer that is still working.
 * - A failure recorded as the exact reasoning_text protocol condition gets at
 *   most a configured number of bounded automatic resumes. `resumeFailed`
 *   claims the delivery, verifies the failed turn is still the target, and
 *   submits one persisted user instruction whose request id makes a duplicate
 *   notification or crash replay a no-op; the budget lives on the original
 *   task, so a restart or a retry under a new task id cannot reset it.
 * - A task's state comes from the Session's own durable events. A registered
 *   process exiting is not a completion, and an unreachable Session is
 *   `disconnected`: the task keeps its place and is neither cancelled nor
 *   re-dispatched here.
 * - The watcher never involves a model. It is an event subscription; a caller
 *   whose Host exposes no subscription can bound its own `session.wait`
 *   long-poll instead, which observes the same durable facts.
 * - Only metadata, one summary line, and local evidence references leave this
 *   process. Session output is quoted as untrusted result data, never as an
 *   instruction for the receiver.
 * - This service never answers an approval. A pause is reported and the
 *   Session keeps waiting for its human. The report is structured rather than a
 *   bare state: a needs-input notification carries the bounded questions and
 *   their options, or the approval and its tool, together with the Session the
 *   answer belongs to, so a dispatcher relays the question to its operator
 *   instead of guessing an answer or resuming the Session itself.
 *
 * @module @deepseek-ai/dsh-api-task-feedback
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only bindings publish the Session event and Host service declarations this watcher consumes.
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '../../../execution/host/session-wait.ts'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionItem,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
import {
  taskFeedbackDomainSpec,
  type DeliveryRecordState,
  type NeedsInputNoticeState,
  type ReceiptRecordState,
  type TaskRecordState,
} from './spec.ts'
import { codexQueueWakeAdapter, composeDeliveryReview, unconnectedWakeAdapter } from './wake.ts'
import { DeliveryPump } from './delivery.ts'
import { ReceiptLedger } from './receipts.ts'
import {
  feedbackSessionFacts,
  type FeedbackApproval,
  type FeedbackSessionFacts,
} from './session-facts.ts'
import {
  OPEN_STATES,
  DEFAULT_NOTIFY_STATES,
  AUTO_RESUME_PROMPT,
  isReasoningTextProtocolFailure,
  unverifiedCompletionSummary,
  rootTaskIdOf,
  resumeRequestIdOf,
  questionObservationKey,
  boundedLine,
  boundedQuestions,
  isResumeInstruction,
  settledState,
  decideTransition,
  deliveryIdOf,
  projectReceipt,
  harnessTaskIdOf,
  harnessTaskStateOf,
  sameHarnessExecution,
  type TurnSettlement,
} from './state.ts'
import type {
  DeliveryRecord,
  DeliveryStage,
  HarnessExecution,
  HarnessPauseReport,
  HarnessStateReport,
  HarnessStateReportValue,
  HarnessTaskRegistration,
  TaskAckRequest,
  TaskAckValue,
  TaskConsumeRequest,
  TaskConsumeValue,
  TaskFlushValue,
  TaskLookupRequest,
  TaskReceipt,
  TaskReceiveRequest,
  TaskReceiveValue,
  TaskRecord,
  TaskRegistration,
  TaskRegistrationValue,
  TaskResumeAttempt,
  TaskResumeDecision,
  TaskResumeRequest,
  TaskResumeValue,
  TaskState,
  WakeAdapter,
  WakeStatus,
} from './types.ts'
import { NO_SESSION_TARGET_THREAD_ID } from './types.ts'
const sessionRequestId = <T extends string>(value: string) => value as T
const STAGE_ORDER: readonly DeliveryStage[] = [
  'enqueued',
  'delivered',
  'received',
  'review-started',
]

export type * from './types.ts'
export {
  codexQueueWakeAdapter,
  composeDeliveryReview,
  composeWakeMessage,
  unconnectedWakeAdapter,
  WAKE_UNCONNECTED_REASON,
} from './wake.ts'
export type { BoundedProcessResult, WakeCommand, WakeExecutionConfig } from './wake.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable task feedback registry and its notification outbox. */
    taskFeedback: TaskFeedbackService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'task-feedback/not-found': { readonly taskId: string }
    'task-feedback/delivery-not-found': { readonly taskId: string; readonly deliveryId: string }
    'task-feedback/receipt-not-found': { readonly taskId: string; readonly deliveryId: string }
    'task-feedback/stale-claim': {
      readonly taskId: string
      readonly deliveryId: string
      readonly claimEpoch: number
    }
    'task-feedback/resume-unavailable': { readonly taskId: string }
    'task-feedback/resume-submit-failed': { readonly taskId: string; readonly requestId: string }
  }
}

/** Deployment policy for the feedback loop. */
export interface Config {
  /** Cap on the summary line one delivery carries. */
  readonly summaryMaxChars: number
  /** Attempts one delivery may make before it stops being scheduled. */
  readonly maxDeliveryAttempts: number
  /** Base of the capped exponential retry delay, in milliseconds. */
  readonly retryBaseMs: number
  /** Upper bound on one retry delay, in milliseconds. */
  readonly retryMaxMs: number
  /**
   * Whether the service schedules delivery itself. A deployment that drives the
   * outbox from its own scheduler turns this off and calls `flush` instead.
   */
  readonly autoDeliver: boolean
  /** Maximum duration of one transport attempt. */
  readonly sendTimeoutMs: number
  /**
   * Task states that produce a notification. The default wakes the paid model
   * only for an outcome or a pause: `completed`, `failed`, `waiting_approval`,
   * and `waiting_input`. `queued`, `accepted`, `running`, `cancelled`, and
   * `disconnected` are observed but never notified unless a deployment adds
   * them here, because a progress state is not something a reviewer acts on.
   */
  readonly notifyStates: TaskState[]
  /** Transport used to reach the target Session. */
  readonly wakeTransport: 'unconnected' | 'codex-queue'
  /** Launch the codex executable directly, or inside a WSL distribution. */
  readonly wakeExecution: 'native' | 'wsl'
  /** Codex executable: an absolute path, or a name resolved through `PATH`. */
  readonly wakeExecutable: string
  /** WSL distribution the executable lives in; required by `wakeExecution: wsl`. */
  readonly wakeDistro: string
  /**
   * Automatic resumes one original dispatched task may submit. The count is
   * persisted on the task, so a restart or a retry registered under a new
   * task id cannot reset it. `0` disables automatic resume.
   */
  readonly maxAutoResumes: number
  /**
   * How long a receiver's claim stays live before another consumer may reclaim
   * an unfinished review. A consumer that presents its own identity again needs
   * no reclaim; a different consumer waits out the lease, which is how a
   * crashed receiver's claim is taken over without racing a working one.
   */
  readonly claimLeaseMs: number
  /** Cap on one question, option label, option description, or tool name a needs-input notice carries. */
  readonly needsInputMaxChars: number
  /** Cap on the questions one needs-input notice carries. */
  readonly needsInputMaxQuestions: number
  /** Cap on the options one question may carry. */
  readonly needsInputMaxOptions: number
}

/**
 * One dispatched task's follow-up notification outbox.
 *
 * Mount it where the dispatched Sessions run. A deployment whose transport
 * cannot reach a target leaves the default adapter in place: deliveries then
 * stay `enqueued` and `wake()` reports the missing capability instead of a
 * success.
 */
export default class TaskFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessions', 'sessionProjections', 'agents', 'oplSessionWait']

  static Config: z<Partial<Config>, Config> = z.object({
    summaryMaxChars: z.number().step(1).min(1).default(500),
    maxDeliveryAttempts: z.number().step(1).min(1).default(5),
    retryBaseMs: z.number().step(1).min(1).default(1_000),
    retryMaxMs: z.number().step(1).min(1).default(60_000),
    autoDeliver: z.boolean().default(true),
    sendTimeoutMs: z.number().step(1).min(1).default(10_000),
    notifyStates: z
      .array(
        z.union([
          z.const('queued'),
          z.const('accepted'),
          z.const('running'),
          z.const('waiting_approval'),
          z.const('waiting_input'),
          z.const('completed'),
          z.const('failed'),
          z.const('cancelled'),
          z.const('disconnected'),
        ]),
      )
      .default([...DEFAULT_NOTIFY_STATES]),
    wakeTransport: z.union([z.const('unconnected'), z.const('codex-queue')]).default('unconnected'),
    wakeExecution: z.union([z.const('native'), z.const('wsl')]).default('native'),
    wakeExecutable: z.string().default(''),
    wakeDistro: z.string().default(''),
    maxAutoResumes: z.number().step(1).min(0).default(2),
    claimLeaseMs: z.number().step(1).min(1).default(600_000),
    needsInputMaxChars: z.number().step(1).min(1).default(500),
    needsInputMaxQuestions: z.number().step(1).min(1).default(8),
    needsInputMaxOptions: z.number().step(1).min(1).default(12),
  })

  private taskTable?: KvTable<string, TaskRecordState>
  private outboxTable?: KvTable<string, DeliveryRecordState>
  private receiptTable?: KvTable<string, ReceiptRecordState>
  private receiptLedger!: ReceiptLedger
  private sessionFacts!: ProjectionHandle<FeedbackSessionFacts>
  private counters?: DomainGlobal<{ deliveryCount: number }>
  /** Replaced from Config during init; the refusing default keeps `wake()` honest before then. */
  private adapter: WakeAdapter = unconnectedWakeAdapter()
  /** Durable writes the watcher started but has not finished. */
  private readonly writing = new Set<Promise<unknown>>()
  /** Authoritative in-memory task view; the write chain follows it. */
  private readonly live = new Map<string, TaskRecordState>()
  /**
   * Turn open on each Session, from the live event feed. It is how a submitted
   * resume instruction is bound to the turn that claimed it: the instruction is
   * recorded inside that turn, after its `turn/start`.
   */
  private readonly openTurns = new Map<string, number>()
  /** Stops observation before disposing the outbox pump and storage. */
  private closed = false
  private readonly stopping = new AbortController()
  private commits: Promise<unknown> = Promise.resolve()
  private deliveryPump!: DeliveryPump
  private writeFailure: unknown

  /** Serialize storage updates without holding the lock during transport. */
  private commit<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.commits.then(operation, operation)
    this.commits = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'taskFeedback')
  }

  /** Open the domain, install the model-free watcher, and recover prior state. */
  protected async [Service.init](): Promise<void> {
    this.sessionFacts = await this.ctx.sessionProjections.register(feedbackSessionFacts)
    const domain = await this.ctx.storageDomain.open(taskFeedbackDomainSpec)
    this.ctx.effect(
      () => async () => {
        await this.stopDelivery()
        await domain.close()
      },
      'taskFeedback.close',
    )
    this.taskTable = domain.table('tasks')
    this.outboxTable = domain.table('outbox')
    this.receiptTable = domain.table('receipts')
    this.receiptLedger = new ReceiptLedger(this.receiptTable, this.config.claimLeaseMs)
    for (const [taskId, record] of this.taskTable.entries()) this.live.set(taskId, record)
    this.counters = domain.global
    // Resolved before any transport attempt: a misconfigured entry fails the
    // load instead of silently refusing every delivery later.
    this.adapter = this.buildAdapter()
    this.deliveryPump = new DeliveryPump(
      this.requireOutbox(),
      this.config,
      this.adapter,
      () => this.prepareDeliveries(),
      (operation) => this.commit(operation),
      (message, error) => this.ctx.logger.warn(message, error),
    )
    this.ctx.effect(() => {
      const offEvents = this.ctx.on(
        'session/event',
        (session, event) => {
          this.observe(session, event)
        },
        { global: true },
      )
      // A Session attached after this Host started (a restored or seeded one)
      // publishes no per-event feed for the history it loads with, so its
      // recorded turn end has to be read from the attach edge itself.
      const offCreated = this.ctx.on(
        'session/created',
        (session: Session) => {
          this.reconcileAttached(session)
        },
        { global: true },
      )
      // Observation only: answering with `next()` leaves a composing
      // deployment's own answerer to handle the question untouched.
      const offQuestions = this.ctx.on(
        'user-questions/request',
        (request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>) => {
          this.observeQuestion(request.agent?.session, request.questions)
          return next()
        },
        { global: true },
      )
      return () => {
        offEvents()
        offCreated()
        offQuestions()
      }
    }, 'taskFeedback.watch()')
    // An upgraded deployment stops owing notifications for states the current
    // policy does not notify, so prior `running` entries are not re-attempted.
    await this.retireUnnotified()
    // Disposal cancels the pending wake-up and waits for the pass already
    // running, so an unload cannot leave a delivery half-attempted.
    await this.recover()
    // Recovery schedule: what the outbox still owes is attempted without an
    // external call, because the caller that dispatched the task may be waiting
    // for exactly that notification.
    this.deliveryPump.schedule(0)
  }

  /**
   * Resolve the configured wake transport, failing the load on a missing entry.
   * @returns the adapter built from Config.
   * @throws when `codex-queue` lacks an executable, or `wsl` lacks a distribution.
   */
  private buildAdapter(): WakeAdapter {
    if (this.config.wakeTransport === 'unconnected') return unconnectedWakeAdapter()
    const executable = this.config.wakeExecutable.trim()
    if (executable === '') {
      throw new Error('task-feedback: wakeExecutable is required when wakeTransport is codex-queue')
    }
    const distro = this.config.wakeDistro.trim()
    if (this.config.wakeExecution === 'wsl' && distro === '') {
      throw new Error('task-feedback: wakeDistro is required when wakeExecution is wsl')
    }
    if (this.config.wakeExecution === 'native' && distro !== '') {
      throw new Error('task-feedback: wakeDistro is only valid when wakeExecution is wsl')
    }
    return codexQueueWakeAdapter({
      execution: this.config.wakeExecution,
      executable,
      distro,
      timeoutMs: this.config.sendTimeoutMs,
    })
  }

  /**
   * Retire pending deliveries for states this policy does not notify.
   *
   * This is the upgrade path for an outbox an older build wrote: a `running`
   * entry that was never acknowledged stops being scheduled instead of being
   * re-sent at the next attempt. Retirement is not an acknowledgment, so the
   * delivery reports that it was retired rather than received.
   */
  private async retireUnnotified(): Promise<void> {
    for (const [deliveryId, record] of [...this.requireOutbox().entries()]) {
      if (record.retired || record.acknowledged) continue
      if (this.config.notifyStates.includes(record.payload.state)) continue
      await this.commit(async () => {
        const latest = this.requireOutbox().get(deliveryId)
        if (latest === undefined || latest.retired || latest.acknowledged) return
        if (this.config.notifyStates.includes(latest.payload.state)) return
        await this.requireOutbox().put(deliveryId, {
          ...latest,
          retired: true,
          nextAttemptAt: null,
          updatedAt: this.now(),
        })
      })
    }
  }

  /** Retire resolved pauses before transport, retaining accepted handoffs and receipts. */
  private async prepareDeliveries(): Promise<void> {
    await this.settled()
    await this.commit(async () => {
      const outbox = this.requireOutbox()
      for (const [deliveryId, stored] of outbox.entries()) {
        if (
          stored.stage !== 'enqueued' ||
          stored.acknowledged ||
          stored.retired ||
          this.deliveryPump.isSending(deliveryId)
        )
          continue
        const notice = stored.payload.needsInput
        if (notice === null) continue
        const task = this.live.get(stored.taskId)
        if (task === undefined) continue
        let resolved = ['completed', 'failed', 'cancelled'].includes(task.state)
        if (task.execution.kind === 'harness-session') {
          if (task.state !== 'disconnected')
            resolved ||= task.needsInput?.pauseId !== notice.pauseId
        } else {
          const session = this.boundSession(task)
          if (session !== undefined && notice.approval !== null && notice.seq !== null) {
            const facts = this.sessionFacts.stateOf(session)
            if (facts.lastApprovalSeq >= notice.seq) {
              resolved ||= !Object.hasOwn(facts.pendingApprovals, notice.approval.approvalId)
            }
          }
        }
        if (!resolved) continue
        await outbox.put(deliveryId, {
          ...stored,
          retired: true,
          nextAttemptAt: null,
          updatedAt: this.now(),
        })
      }
    })
  }

  /**
   * Install the transport that hands notifications to target Sessions.
   * @param adapter - the transport, replacing the refusing default.
   */
  setWakeAdapter(adapter: WakeAdapter): void {
    this.adapter = adapter
    this.deliveryPump?.setAdapter(adapter)
  }

  /**
   * Wait for every durable write the watcher has started.
   *
   * The watcher cannot be awaited from a Session event, so this is the point a
   * caller (or the flush below) observes a quiescent registry.
   * @returns nothing once no write is outstanding.
   */
  async settled(): Promise<void> {
    while (this.writing.size > 0) await Promise.allSettled([...this.writing])
    // oxlint-disable-next-line typescript/only-throw-error -- rethrows the write failure exactly as the durable layer raised it.
    if (this.writeFailure !== undefined) throw this.writeFailure
  }

  /**
   * Register one dispatched task, durably and idempotently.
   *
   * Re-registering the same `taskId` returns the stored task unchanged: the id
   * is the caller's idempotency key, so a retried dispatch never doubles a task
   * or its notifications.
   * @param request - identity, bound Session and turn, target, acceptance, and cursor.
   * @returns the stored task.
   * @throws RemoteError when the request cannot describe a watchable task.
   */
  @Remote('register')
  async register(request: TaskRegistration): Promise<TaskRegistrationValue> {
    this.requireRegistration(request)
    const existing = this.requireTasks().get(request.taskId)
    if (existing !== undefined) return { task: this.project(existing) }
    const session = this.ctx.sessions.get(request.sessionId)
    const now = this.now()
    const turn = request.turn ?? null
    const lineage = this.resolveLineage(request)
    // A task registered while its own turn is already open is running now, not
    // waiting for a turn that already started.
    const running = turn !== null && session !== undefined && this.openTurnOf(session) === turn
    const record: TaskRecordState = {
      taskId: request.taskId,
      sessionId: request.sessionId,
      execution: { kind: 'dsh-session' },
      turn,
      target: request.target,
      acceptance: request.acceptance,
      fromSeq: request.fromSeq ?? (session === undefined ? 0 : Number(session.seq)),
      state: session === undefined ? 'queued' : running ? 'running' : 'accepted',
      summary:
        session === undefined
          ? 'registered; the bound Session is not attached to this Host'
          : running
            ? `registered; turn ${String(turn)} is already open`
            : 'registered; waiting for the task turn',
      evidence: {
        sessionId: request.sessionId,
        turn: request.turn ?? null,
        seq: null,
        eventSeqs: [],
      },
      waitKey: null,
      needsInput: null,
      // A `turn: null` task settles on the first turn that ends after it was
      // registered; recording the end already on the log is what keeps a turn
      // that finished before registration from settling it later.
      lastEndTurnAtRegistration: turn === null ? this.lastEndTurnOf(session) : null,
      parentTaskId: lineage.parentTaskId,
      rootTaskId: lineage.rootTaskId,
      attempt: lineage.attempt,
      // An attempt added to an existing lineage mirrors the root's budget, so a
      // retried registration cannot reset what the original already spent.
      autoResumeCount: lineage.autoResumeCount,
      autoResumeLimit: lineage.autoResumeLimit,
      resumeEligible: false,
      leakedToolSyntax: null,
      resumeRequestId: null,
      resumeInstructionSeq: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.requireTasks().put(record.taskId, record)
    this.live.set(record.taskId, record)
    return { task: this.project(record) }
  }

  /**
   * Register one combination operation before its prompt is sent.
   *
   * This is the external-Harness entry point, and it is deliberately in-process
   * rather than a Remote: the execution service that owns the ACP child calls it
   * directly, and it must read back whether the registration landed before it
   * sends the prompt. The task's identity is derived from the execution
   * reference, so a retry of one operation is idempotent while a new instruction
   * registers a new task and its own deliveries. Nothing here fabricates a DSH
   * Session: a combination record stores `sessionId: null` and names the
   * combination session, its combination, task, and operation instead.
   * @param request - the combination execution, the reviewer to wake, and the acceptance bar.
   * @returns the stored task and its derived identity.
   * @throws RemoteError when the request cannot describe a watchable combination task.
   */
  async registerHarnessOperation(request: HarnessTaskRegistration): Promise<TaskRegistrationValue> {
    const execution = this.requireHarnessRegistration(request)
    const taskId = harnessTaskIdOf(execution)
    const existing = this.requireTasks().get(taskId)
    if (existing !== undefined) {
      if (
        !sameHarnessExecution(existing.execution, execution) ||
        existing.target.threadId !== request.target.threadId
      ) {
        throw new RemoteError(
          'gateway/bad-request',
          `task-feedback: task ${JSON.stringify(taskId)} already names another execution or reviewer`,
          {},
        )
      }
      return { task: this.project(existing) }
    }
    const timestamp = this.now()
    const record: TaskRecordState = {
      taskId,
      sessionId: null,
      execution,
      turn: null,
      target: request.target,
      acceptance: request.acceptance,
      fromSeq: 0,
      state: 'accepted',
      summary: 'registered; waiting for the combination turn to start',
      evidence: { sessionId: null, turn: null, seq: null, eventSeqs: [] },
      waitKey: null,
      needsInput: null,
      lastEndTurnAtRegistration: null,
      parentTaskId: null,
      rootTaskId: taskId,
      attempt: 1,
      // A combination execution has no DSH Session to submit an automatic resume
      // into, so its budget is zero by construction and `resumeFailed` refuses it.
      autoResumeCount: 0,
      autoResumeLimit: 0,
      resumeEligible: false,
      leakedToolSyntax: null,
      resumeRequestId: null,
      resumeInstructionSeq: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.requireTasks().put(record.taskId, record)
    this.live.set(record.taskId, record)
    return { task: this.project(record) }
  }

  /**
   * Fold one observed combination state into its registered task.
   *
   * The execution service calls this at the moment it observes the state — a
   * turn end, a paused approval, a question — so the notification is enqueued
   * from the observation itself and never from a poll. A terminal state is
   * written once, a waiting state keeps its own pause identity, and a replay of
   * the same observation changes nothing, so a duplicate report cannot produce a
   * second delivery for one outcome.
   * @param request - task identity, the observed state, its one-line summary, and any pause.
   * @returns the task and the delivery this state owes, when the state notifies.
   * @throws RemoteError when the task is unknown, is not a combination task, or a waiting state carries no pause identity.
   */
  async reportHarnessState(request: HarnessStateReport): Promise<HarnessStateReportValue> {
    const record = this.requireTask(request.taskId)
    if (record.execution.kind !== 'harness-session') {
      throw new RemoteError(
        'gateway/bad-request',
        `task-feedback: task ${JSON.stringify(request.taskId)} is not a combination execution`,
        {},
      )
    }
    const summary = boundedLine(request.summary, this.config.summaryMaxChars)
    const next = this.harnessTransition(record, request, summary)
    if (next !== undefined) {
      // The live view moves first, so two reports of one tick cannot both read
      // the state before the previous write landed.
      this.live.set(next.taskId, next)
      await this.commit(async () => {
        await this.requireTasks().put(next.taskId, next)
        await this.enqueue(next)
      })
    }
    const latest = this.live.get(record.taskId) ?? record
    return { task: this.project(latest), delivery: this.deliveryOf(latest) }
  }

  /**
   * The record one combination report decides, or undefined when it changes nothing.
   *
   * A waiting state must carry the pause identity the execution side observed:
   * without it there is no stable delivery id, and two distinct pauses would
   * collapse into one notification.
   * @param record - the stored combination task.
   * @param request - the report as the execution service sent it.
   * @param summary - the already bounded one-line summary.
   * @returns the record to publish, or undefined when the observation changes nothing.
   */
  private harnessTransition(
    record: TaskRecordState,
    request: HarnessStateReport,
    summary: string,
  ): TaskRecordState | undefined {
    const waiting = request.state === 'waiting_approval' || request.state === 'waiting_input'
    if (!waiting) {
      return decideTransition(record, this.now(), request.state, summary, undefined)
    }
    const pause = request.pause
    if (pause === undefined || pause.pauseId.trim() === '') {
      throw new RemoteError(
        'gateway/bad-request',
        `task-feedback: the ${request.state} report for ${JSON.stringify(record.taskId)} carries no pause identity`,
        {},
      )
    }
    const notice = this.harnessNotice(pause)
    // A pause's notice belongs to that pause alone, so it is written with the
    // waiting state and dropped by the transition that leaves it.
    return decideTransition(
      { ...record, needsInput: notice },
      this.now(),
      request.state,
      summary,
      undefined,
      notice.pauseId,
    )
  }

  /** The bounded pause notice of one combination pause, with no borrowed DSH Session. */
  private harnessNotice(pause: HarnessPauseReport): NeedsInputNoticeState {
    return {
      kind: pause.kind,
      sessionId: null,
      turn: null,
      seq: null,
      pauseId: pause.pauseId,
      questions: boundedQuestions(
        pause.kind === 'question' ? (pause.questions ?? []) : [],
        this.config.needsInputMaxQuestions,
        this.config.needsInputMaxOptions,
        this.config.needsInputMaxChars,
      ),
      approval:
        pause.kind === 'approval' && pause.approval
          ? {
              approvalId: pause.approval.approvalId,
              toolName: boundedLine(pause.approval.toolName, this.config.needsInputMaxChars),
            }
          : null,
    }
  }

  /** The delivery one stored task's current state owes, or null when it owes none. */
  private deliveryOf(record: TaskRecordState): DeliveryRecord | null {
    return this.requireOutbox().get(deliveryIdOf(record)) ?? null
  }

  /** Validate one combination registration before anything durable is written. */
  private requireHarnessRegistration(request: HarnessTaskRegistration): HarnessExecution {
    const bad = (message: string): never => {
      throw new RemoteError('gateway/bad-request', message, {})
    }
    const execution = request.execution
    if (execution?.kind !== 'harness-session')
      bad('task-feedback: a combination registration must name a harness execution')
    for (const [label, value] of [
      ['harnessSessionId', execution.harnessSessionId],
      ['harnessRef', execution.harnessRef],
      ['combination', execution.combination],
      ['taskId', execution.taskId],
      ['operationId', execution.operationId],
    ] as const) {
      if (typeof value !== 'string' || value.trim() === '' || value.length > 4096)
        bad(`task-feedback: execution.${label} must be a non-empty bounded string`)
    }
    if (request.target?.kind !== 'codex-thread')
      bad('task-feedback: only a Codex thread is addressable as a notification target')
    const threadId = request.target.threadId.trim()
    if (threadId === '')
      bad(
        'task-feedback: the target thread id must be supplied by the caller, never inferred from recent sessions',
      )
    if (threadId === NO_SESSION_TARGET_THREAD_ID)
      bad(
        `task-feedback: ${JSON.stringify(NO_SESSION_TARGET_THREAD_ID)} is not a Codex Session id; ` +
          'register the combination task from the Session that dispatched it',
      )
    if (request.acceptance.trim() === '')
      bad('task-feedback: acceptance criteria are required so the review has a stated bar')
    return execution
  }

  /**
   * Resolve the attempt lineage one registration declares.
   *
   * A retry registered under a new task id points at its parent or directly at
   * the original task, which is how the automatic-resume budget stays attached
   * to the original dispatch.
   */
  private resolveLineage(request: TaskRegistration): {
    parentTaskId: string | null
    rootTaskId: string
    attempt: number
    autoResumeCount: number
    autoResumeLimit: number
  } {
    const parentId = request.parentTaskId ?? request.rootTaskId
    if (parentId === undefined) {
      return {
        parentTaskId: null,
        rootTaskId: request.taskId,
        attempt: 1,
        autoResumeCount: 0,
        autoResumeLimit: this.config.maxAutoResumes,
      }
    }
    const parent = this.requireTasks().get(parentId)
    if (parent === undefined) {
      throw new RemoteError(
        'task-feedback/not-found',
        `no task ${JSON.stringify(parentId)} to attach retry ${JSON.stringify(request.taskId)} to`,
        { taskId: parentId },
      )
    }
    return {
      parentTaskId: request.parentTaskId ?? parent.taskId,
      rootTaskId: parent.rootTaskId ?? parent.taskId,
      attempt: parent.attempt + 1,
      autoResumeCount: this.admittedResumeCount(parent.rootTaskId ?? parent.taskId),
      autoResumeLimit: parent.autoResumeLimit,
    }
  }

  /**
   * Read one task.
   * @param request - the caller's task identity.
   * @returns the stored task.
   * @throws RemoteError when no such task is registered.
   */
  @Remote('task')
  task(request: TaskLookupRequest): TaskRecord {
    return this.project(this.requireTask(request.taskId))
  }

  /**
   * List every registered task in registration order.
   * @returns the stored tasks.
   */
  @Remote('tasks')
  tasks(): readonly TaskRecord[] {
    return [...this.live.values()].map((record) => this.project(record))
  }

  /**
   * List the notification outbox in insertion order.
   * @returns every stored delivery.
   */
  @Remote('outbox')
  deliveries(): readonly DeliveryRecord[] {
    return [...this.requireOutbox().entries()].map(([, record]) => record)
  }

  /**
   * Probe whether the configured wake executable can start.
   *
   * The status is the adapter's bounded probe result, not a configured
   * constant: an adapter that cannot start its executable reports
   * `not-connected` with what the probe observed. `executable-started` means
   * exactly that and no more: the probe cannot prove that a target thread exists
   * or that a queued message reaches it.
   * @returns the adapter identity, the probed status, and the observed detail.
   */
  @Remote('wake')
  async wake(): Promise<WakeStatus> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.config.sendTimeoutMs)
    timer.unref()
    try {
      const result = await this.adapter.probe(controller.signal)
      return result.started
        ? { adapter: this.adapter.id, status: 'executable-started', detail: result.detail }
        : { adapter: this.adapter.id, status: 'not-connected', reason: result.detail }
    } catch (error) {
      return {
        adapter: this.adapter.id,
        status: 'not-connected',
        reason: `wake probe failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Acknowledge one delivery at the stage the receiving Session reports.
   *
   * Acknowledging an earlier stage again, or acknowledging a delivery twice,
   * changes nothing: the stage is monotonic. This is delivery progress only;
   * the receiver's separate consumption ledger is what makes a repeated review
   * avoidable, so a receiver should claim through {@link receive} first.
   * @param request - delivery identity and the reported stage.
   * @returns the delivery as it now stands.
   * @throws RemoteError when the delivery is unknown or belongs to another task.
   */
  @Remote('ack')
  async ack(request: TaskAckRequest): Promise<TaskAckValue> {
    return this.commit(async () => {
      const value = await this.acknowledge(request)
      // Keep the consumption ledger consistent with an acknowledgment that did
      // not come through `receive`, so `consume` works on either path.
      if (!value.delivery.retired)
        await this.receiptLedger.recordReceipt(request.taskId, request.deliveryId, request.stage)
      return value
    })
  }

  /**
   * Claim one delivery for review, with an explicit owner and lease.
   *
   * This is the receiver's entry point. It durably records the claim and its
   * owner before the review starts and answers what to do with a message that
   * arrives again. A first claim asks for a review; a consumer that owns an
   * unfinished claim is answered `resume`; a different consumer facing a live
   * claim is answered `busy`, so it does not start a second review; a claim
   * whose lease expired is reclaimed by the new consumer, which is how a
   * crashed receiver's work is taken over. A finished claim is answered `skip`.
   * Duplicates are therefore decided from the durable ledger and its ownership,
   * never from whether a second message arrived.
   * @param request - the delivery and the receiving consumer's stable identity.
   * @returns the next action and the durable receipt behind it.
   * @throws RemoteError when the delivery is unknown, retired, or another task's.
   */
  @Remote('receive')
  async receive(request: TaskReceiveRequest): Promise<TaskReceiveValue> {
    return this.commit(async () => this.claim(request))
  }

  /**
   * List the receiver's consumption ledger.
   *
   * A receiver that restarts reads this to find claims it never finished:
   * every entry whose status is not `consumed` is a review still owed, and
   * re-claiming it answers `resume` rather than starting a second one.
   * @returns every receipt, in insertion order.
   */
  @Remote('receipts')
  receipts(): readonly TaskReceipt[] {
    return [...this.requireReceipts().entries()].map(([, record]) => projectReceipt(record))
  }

  /**
   * Mark one claimed delivery consumed after its review finished.
   *
   * This is the last step of the receiver's flow and the only state that makes
   * a repeated message answer `skip`. The claim generation is checked, so a
   * consumer whose claim was reclaimed by a newer owner cannot finish a review
   * that owner now holds.
   * @param request - the delivery whose review finished and the claim it was given.
   * @returns the receipt as it now stands.
   * @throws RemoteError when no claim exists, or the caller no longer owns it.
   */
  @Remote('consume')
  async consume(request: TaskConsumeRequest): Promise<TaskConsumeValue> {
    return this.commit(async () => ({
      receipt: projectReceipt(await this.receiptLedger.markConsumed(request)),
    }))
  }

  /**
   * Submit at most one bounded automatic resume for an eligible failure.
   *
   * One call performs the whole deterministic flow: claim the failure delivery,
   * confirm the failed turn is still the target, and either submit one durable
   * user instruction in the original Session or report why it must not. A
   * duplicate notification or a crash replay presents the same attempt and
   * request id, so at most one instruction is submitted per attempt.
   * @param request - the failure delivery and the receiving consumer's identity.
   * @returns the decision, why it was reached, and the new attempt when one was submitted.
   * @throws RemoteError when the delivery is unknown, or the resume surface is not mounted.
   */
  @Remote('resumeFailed')
  async resumeFailed(request: TaskResumeRequest): Promise<TaskResumeValue> {
    return this.commit(async () => this.resumeFailure(request))
  }

  /** Apply the receiver's claim inside the durable-update queue. */
  private async claim(request: TaskReceiveRequest): Promise<TaskReceiveValue> {
    const stored = this.requireDelivery(request)
    const receipts = this.requireReceipts()
    const existing = receipts.get(request.deliveryId)
    const now = Date.now()
    const consumerId = request.consumerId ?? this.mintConsumerId()
    if (existing === undefined) {
      const receipt = await this.receiptLedger.createClaim(stored, consumerId, now)
      const acknowledged = await this.acknowledge({
        taskId: request.taskId,
        deliveryId: request.deliveryId,
        stage: 'received',
      })
      return {
        action: 'review',
        receipt: projectReceipt(receipt),
        delivery: acknowledged.delivery,
        reviewInstructions: composeDeliveryReview(
          stored.payload,
          stored.deliveryId,
          this.config.summaryMaxChars,
        ),
      }
    }
    if (existing.status === 'consumed') {
      const acknowledged = await this.acknowledge({
        taskId: request.taskId,
        deliveryId: request.deliveryId,
        stage: 'review-started',
      })
      return {
        action: 'skip',
        receipt: projectReceipt(existing),
        delivery: acknowledged.delivery,
        reviewInstructions: null,
      }
    }
    // An ownerless receipt is one an `ack` path wrote; the first `receive`
    // adopts it instead of leaving the review unowned forever.
    const owned = existing.ownerId !== null
    const sameOwner =
      owned && request.consumerId !== undefined && existing.ownerId === request.consumerId
    const leaseLive = existing.leaseExpiresAt !== null && Date.parse(existing.leaseExpiresAt) > now
    if (sameOwner || !owned || !leaseLive) {
      const receipt = sameOwner
        ? await this.receiptLedger.refreshClaim(existing, now)
        : await this.receiptLedger.reclaimClaim(existing, consumerId, now)
      const acknowledged = await this.acknowledge({
        taskId: request.taskId,
        deliveryId: request.deliveryId,
        stage: existing.status === 'received' ? 'received' : 'review-started',
      })
      return {
        action: 'resume',
        receipt: projectReceipt(receipt),
        delivery: acknowledged.delivery,
        reviewInstructions: composeDeliveryReview(
          stored.payload,
          stored.deliveryId,
          this.config.summaryMaxChars,
        ),
      }
    }
    // Another consumer holds a live claim: repair the delivery stage only, and
    // never hand this message permission to work.
    const acknowledged = await this.acknowledge({
      taskId: request.taskId,
      deliveryId: request.deliveryId,
      stage: 'received',
    })
    return {
      action: 'busy',
      receipt: projectReceipt(existing),
      delivery: acknowledged.delivery,
      reviewInstructions: null,
    }
  }

  /** An owner identity for a consumer that did not name one. */
  private mintConsumerId(): string {
    return `ephemeral:${String(Date.now())}:${Math.random().toString(36).slice(2)}`
  }

  /** The stored delivery a claim names, or the named failure. */
  private requireDelivery(request: TaskReceiveRequest): DeliveryRecordState {
    const stored = this.requireOutbox().get(request.deliveryId)
    // A retired delivery was never handed to a receiver, so there is no claim
    // to make for it and no review to run.
    if (stored === undefined || stored.taskId !== request.taskId || stored.retired) {
      throw new RemoteError(
        'task-feedback/delivery-not-found',
        `no delivery ${JSON.stringify(request.deliveryId)} for task ${JSON.stringify(request.taskId)}`,
        { taskId: request.taskId, deliveryId: request.deliveryId },
      )
    }
    return stored
  }

  /**
   * The deterministic automatic-resume decision and submission.
   *
   * The failure delivery is claimed under the identity that already owns its
   * receipt when the caller did not name one, so claiming and recovery share one
   * consumer identity. An admitted attempt whose instruction already reached the
   * Session replays idempotently; one whose submission was never observed
   * re-validates the failure before submitting, so a stale admission cannot
   * append a continuation after a manual turn started. A fresh admission is
   * committed by the receipt write, which is also the budget ledger, so a lost
   * task-record write cannot make one attempt spend budget twice.
   */
  private async resumeFailure(request: TaskResumeRequest): Promise<TaskResumeValue> {
    const claimed = await this.claim(this.resumeClaimRequest(request))
    if (claimed.action === 'skip') {
      return this.resumeDecision('consumed', 'this delivery was already handled', claimed, null)
    }
    if (claimed.action === 'busy') {
      return this.resumeDecision(
        'busy',
        'another consumer holds a live claim on this delivery',
        claimed,
        null,
      )
    }
    const receipt = this.requireReceipts().get(request.deliveryId)
    if (receipt === undefined) throw new Error('task-feedback: the claim just created is missing')
    const task = this.requireTask(request.taskId)
    const delivery = this.requireOutbox().get(request.deliveryId)
    if (delivery === undefined) throw new Error('task-feedback: the claimed delivery is missing')
    const root = this.requireTasks().get(task.rootTaskId ?? task.taskId) ?? task
    if (receipt.resumeAttempt !== null) {
      // A submission already present in the Session log or its live inbox stands
      // even if a manual turn has since started, so replay it without
      // re-validating. An admission whose submission was never observed must
      // re-validate, because the failure may have been replaced meanwhile.
      if (this.instructionSubmitted(receipt)) {
        const attempt = await this.finishResumeAttempt(root, task, receipt)
        return this.resumeDecision(
          'resumed',
          `attempt ${String(receipt.resumeAttempt)} was already admitted for this delivery`,
          claimed,
          attempt,
        )
      }
      const replayRefusal = this.refuseResume(task, delivery)
      if (replayRefusal !== null)
        return this.resumeDecision(replayRefusal.decision, replayRefusal.reason, claimed, null)
      const attempt = await this.finishResumeAttempt(root, task, receipt)
      return this.resumeDecision(
        'resumed',
        `completed the admitted attempt ${String(attempt.attempt)}`,
        claimed,
        attempt,
      )
    }
    const refusal = this.refuseResume(task, delivery)
    if (refusal !== null)
      return this.resumeDecision(refusal.decision, refusal.reason, claimed, null)
    const rootTaskId = rootTaskIdOf(root)
    const used = this.admittedResumeCount(rootTaskId)
    if (used >= root.autoResumeLimit) {
      return this.resumeDecision(
        'budget-exhausted',
        `the original task already used ${String(used)} of ${String(root.autoResumeLimit)} automatic resumes`,
        claimed,
        null,
      )
    }
    const resumeIndex = used + 1
    // The observation point is captured before the instruction is submitted and
    // persisted with the admission, so a delayed registration observes the
    // resumed turn from here instead of from whatever cursor recovery runs at.
    const session = this.boundSession(task)
    const admittedReceipt: ReceiptRecordState = {
      ...receipt,
      resumeAttempt: resumeIndex,
      resumeRootTaskId: rootTaskId,
      resumeRequestId: resumeRequestIdOf(rootTaskId, resumeIndex),
      resumeTaskId: `${rootTaskId}#r${String(resumeIndex)}`,
      resumeFromSeq: session === undefined ? null : Number(session.seq),
      resumeLastEndTurnAtRegistration: this.lastEndTurnOf(session),
      resumeSubmitted: false,
      updatedAt: this.now(),
    }
    // This one write is the admission commit point and the budget entry. A
    // failure here admits nothing, so a replay retries the same index instead of
    // double-spending; a failure after it cannot lose the admission.
    await this.requireReceipts().put(admittedReceipt.deliveryId, admittedReceipt)
    const admittedRoot = await this.cacheResumeCount(root, resumeIndex)
    const attempt = await this.finishResumeAttempt(admittedRoot, task, admittedReceipt)
    return this.resumeDecision(
      'resumed',
      `submitted attempt ${String(attempt.attempt)} for the original task`,
      claimed,
      attempt,
    )
  }

  /**
   * The claim one resume presents: the caller's identity, or the identity a
   * receipt already records for this delivery.
   * @param request - the resume request as the receiver sent it.
   * @returns a claim request whose consumer identity matches the existing claim.
   */
  private resumeClaimRequest(request: TaskResumeRequest): TaskReceiveRequest {
    if (request.consumerId !== undefined) return request
    const owner = this.requireReceipts().get(request.deliveryId)?.ownerId
    return owner === null || owner === undefined ? request : { ...request, consumerId: owner }
  }

  /**
   * Automatic resumes the receipt ledger records for one original task.
   *
   * This is the authoritative budget read: each admitted failure delivery wrote
   * one receipt, so counting them cannot double-count an attempt whose task
   * record write was lost.
   * @param rootTaskId - original dispatched task whose admissions are counted.
   * @returns the number of admitted resume attempts.
   */
  private admittedResumeCount(rootTaskId: string): number {
    let count = 0
    for (const [, receipt] of this.requireReceipts().entries()) {
      if (receipt.resumeAttempt !== null && receipt.resumeRootTaskId === rootTaskId) count += 1
    }
    return count
  }

  /**
   * Whether an admitted instruction is already recorded in the Session or still
   * queued in its live Inbox.
   *
   * The durable `user/message` source echoes the submitted request id, and a
   * queued instruction carries it in the live Agent inbox; either is proof the
   * submission happened. Where the Session put that instruction is read from
   * the same history by `bindAttemptTurn`, which the recovery entry point uses
   * so the resumed turn is identified by its own instruction rather than by the
   * last turn end at recovery time.
   * @param receipt - the receipt holding the admitted attempt.
   * @returns whether the instruction was observed.
   */
  private instructionSubmitted(receipt: ReceiptRecordState): boolean {
    const requestId = receipt.resumeRequestId
    if (requestId === null) return receipt.resumeSubmitted
    const session = this.resumeSession(receipt)
    return (
      receipt.resumeSubmitted ||
      (session !== undefined && this.recordedResumeInstruction(session, requestId) !== undefined) ||
      this.inboxHoldsInstruction(receipt)
    )
  }

  /**
   * The DSH Session one native task is bound to, when this Host has it attached.
   *
   * A combination task has no DSH Session at all, so this answers undefined for
   * it instead of looking up an id it never had. Every caller that follows a
   * Session log goes through here, which is what keeps the two execution kinds
   * from being conflated at the one place it would matter.
   * @param record - the stored task.
   * @returns the attached Session, or undefined for a combination task or an unattached Session.
   */
  private boundSession(record: TaskRecordState): Session | undefined {
    return record.execution.kind === 'dsh-session' && record.sessionId !== null
      ? this.ctx.sessions.get(record.sessionId)
      : undefined
  }

  /** The Session one admitted receipt's instruction targets, when it is attached. */
  private resumeSession(receipt: ReceiptRecordState): Session | undefined {
    const task = this.requireTasks().get(receipt.taskId)
    return task === undefined ? undefined : this.boundSession(task)
  }

  /** Whether one submitted instruction is still queued in the Session's live Inbox. */
  private inboxHoldsInstruction(receipt: ReceiptRecordState): boolean {
    const requestId = receipt.resumeRequestId
    if (requestId === null) return false
    const session = this.resumeSession(receipt)
    if (session === undefined) return false
    const inbox = this.ctx.get('agents')?.get(session.id)?.inbox
    if (inbox === undefined) return false
    const matches = (message: {
      readonly source: { readonly kind: string; readonly rpcId?: string }
    }): boolean => message.source.kind === 'user' && message.source.rpcId === requestId
    return inbox.nextTurn.some(matches) || inbox.nextStep.some(matches)
  }

  /**
   * The turn one stored resume instruction was recorded in.
   *
   * The instruction is a real user message carrying the attempt's deterministic
   * request id, so this is what ties the attempt to the turn that consumed it,
   * never to whichever turn ended last. An instruction recorded between turns —
   * a prompt surface that writes the message before the loop claims it — belongs
   * to the first turn that starts after it.
   * @param session - the Session the instruction was submitted to.
   * @param requestId - deterministic instruction identity.
   * @returns the claiming turn, or undefined when the instruction is not recorded.
   */
  private recordedResumeInstruction(
    session: Session,
    requestId: string,
  ): { seq: number; turn: number | null } | undefined {
    const state = this.sessionFacts.stateOf(session)
    return state.instructions[requestId]
  }

  /**
   * Persist the root task's resume count as a readable cache of the receipt
   * ledger, which already committed the admission.
   *
   * A failed write is reported and otherwise ignored: the derived count stays
   * authoritative, so the admission is not lost and cannot be spent again.
   * @param root - the original task record before this admission.
   * @param count - the admitted-resume count after the receipt landed.
   * @returns the root record callers should read now.
   */
  private async cacheResumeCount(root: TaskRecordState, count: number): Promise<TaskRecordState> {
    const next: TaskRecordState = { ...root, autoResumeCount: count, updatedAt: this.now() }
    this.live.set(next.taskId, next)
    try {
      await this.requireTasks().put(next.taskId, next)
    } catch (error) {
      this.ctx.logger.warn(
        `task-feedback: the resume-count cache for ${JSON.stringify(next.taskId)} did not land; ` +
          `the receipt ledger remains authoritative: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return next
  }

  /** The attempt record one admitted receipt describes. */
  private attemptOf(receipt: ReceiptRecordState): TaskResumeAttempt {
    return {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- admission writes resumeTaskId with resumeAttempt and resumeRequestId.
      taskId: receipt.resumeTaskId!,
      attempt: (receipt.resumeAttempt ?? 0) + 1,
      // oxlint-disable-next-line typescript/no-non-null-assertion -- admission writes resumeRequestId with resumeAttempt and resumeTaskId.
      requestId: receipt.resumeRequestId!,
    }
  }

  /**
   * Register the follow-up task and submit the instruction once.
   *
   * The instruction carries a deterministic request id, so an attempt whose
   * submission was already observed skips the prompt. The admission persisted
   * the cursor and turn-end baseline it was observed from, so a registration
   * delayed past the resumed turn binds that turn through the instruction's own
   * recorded message and settles the task from the Session's recorded facts: a
   * completed, failed, paused, or still-open resumed turn is reported instead of
   * being read as pre-registration history. A failed submission still leaves no
   * task that would bind a later manual turn as the automatic resume.
   */
  private async finishResumeAttempt(
    root: TaskRecordState,
    source: TaskRecordState,
    receipt: ReceiptRecordState,
  ): Promise<TaskResumeAttempt> {
    const attempt = this.attemptOf(receipt)
    const session = this.boundSession(source)
    const observation = {
      fromSeq: receipt.resumeFromSeq ?? (session === undefined ? 0 : Number(session.seq)),
      lastEndTurnAtRegistration:
        receipt.resumeLastEndTurnAtRegistration ?? this.lastEndTurnOf(session),
    }
    const submitted = this.instructionSubmitted(receipt)
    if (!submitted) {
      const controller = this.ctx.get('sessionController')
      if (controller === undefined) {
        throw new RemoteError(
          'task-feedback/resume-unavailable',
          'automatic resume needs the Session controller, which this deployment does not mount',
          { taskId: source.taskId },
        )
      }
      // A combination task never reaches this point: `refuseResume` answers
      // `not-applicable` for it, because an automatic resume submits a real user
      // instruction into a DSH Session and a combination execution has none.
      if (session === undefined || source.sessionId === null) {
        throw new RemoteError(
          'task-feedback/resume-unavailable',
          `the bound Session ${JSON.stringify(source.sessionId)} is not attached to this Host`,
          { taskId: source.taskId },
        )
      }
      try {
        await controller.prompt(
          {
            // oxlint-disable-next-line typescript/no-non-null-assertion -- the admission that admitted this attempt wrote the instruction id.
            requestId: sessionRequestId<SessionRequestId>(receipt.resumeRequestId!),
            sessionId: source.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: AUTO_RESUME_PROMPT }],
          },
          this.stopping.signal,
        )
      } catch (error) {
        throw new RemoteError(
          'task-feedback/resume-submit-failed',
          `submitting the resume instruction failed: ${error instanceof Error ? error.message : String(error)}`,
          // oxlint-disable-next-line typescript/no-non-null-assertion -- same admitted receipt the prompt above used.
          { taskId: source.taskId, requestId: receipt.resumeRequestId! },
        )
      }
    }
    await this.ensureAttemptTask(root, source, receipt, observation)
    if (!receipt.resumeSubmitted) {
      const latest = this.requireReceipts().get(receipt.deliveryId) ?? receipt
      const submittedReceipt: ReceiptRecordState = {
        ...latest,
        resumeSubmitted: true,
        updatedAt: this.now(),
      }
      await this.requireReceipts().put(submittedReceipt.deliveryId, submittedReceipt)
    }
    return attempt
  }

  /**
   * Register the follow-up task once, bound to the turn that consumed its
   * instruction.
   *
   * Both the initial write after admission and a replay that finds the task
   * already present route through the same catch-up decision, so a record whose
   * instruction the Session already recorded but whose turn binding never
   * landed is rebound from that history and reported in the state it justifies.
   * The write happens inside the caller's serialized update, so it composes with
   * the admission instead of racing it.
   * @param root - original task whose budget and identity the attempt shares.
   * @param source - the failed task the attempt resumes.
   * @param receipt - the admitted receipt naming the attempt task.
   * @param observation - admission cursor and turn-end baseline persisted with the admission.
   */
  private async ensureAttemptTask(
    root: TaskRecordState,
    source: TaskRecordState,
    receipt: ReceiptRecordState,
    observation: { fromSeq: number; lastEndTurnAtRegistration: number | null },
  ): Promise<void> {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- called only for a receipt admission already wrote.
    const attemptTaskId = receipt.resumeTaskId!
    const session = this.boundSession(source)
    const existing = this.requireTasks().get(attemptTaskId)
    if (existing !== undefined) {
      // The task was registered without its turn binding, then the instruction
      // was consumed. Rebind from the instruction's own history and report
      // whatever that turn already did.
      const settled =
        session === undefined ? undefined : this.decideAttemptCatchUp(existing, session)
      if (settled === undefined) return
      this.live.set(settled.taskId, settled)
      await this.requireTasks().put(settled.taskId, settled)
      await this.enqueue(settled)
      return
    }
    const now = this.now()
    const accepted: TaskRecordState = {
      taskId: attemptTaskId,
      sessionId: source.sessionId,
      execution: { kind: 'dsh-session' },
      turn: null,
      target: source.target,
      acceptance: source.acceptance,
      fromSeq: observation.fromSeq,
      state: session === undefined ? 'disconnected' : 'accepted',
      summary: `automatic resume attempt ${String(receipt.resumeAttempt ?? 0)} for ${JSON.stringify(rootTaskIdOf(root))}; waiting for the resumed turn`,
      evidence: { sessionId: source.sessionId, turn: null, seq: null, eventSeqs: [] },
      waitKey: null,
      needsInput: null,
      lastEndTurnAtRegistration: observation.lastEndTurnAtRegistration,
      parentTaskId: source.taskId,
      rootTaskId: rootTaskIdOf(root),
      attempt: (receipt.resumeAttempt ?? 0) + 1,
      autoResumeCount: this.admittedResumeCount(rootTaskIdOf(root)),
      autoResumeLimit: root.autoResumeLimit,
      resumeEligible: false,
      leakedToolSyntax: null,
      resumeRequestId: receipt.resumeRequestId,
      resumeInstructionSeq: null,
      createdAt: now,
      updatedAt: now,
    }
    const record =
      (session === undefined ? undefined : this.decideAttemptCatchUp(accepted, session)) ?? accepted
    await this.requireTasks().put(record.taskId, record)
    this.live.set(record.taskId, record)
    await this.enqueue(record)
  }

  /**
   * The record that folds the facts one Session already recorded into an
   * attempt task, or undefined when those facts leave it unchanged.
   *
   * The attempt's own instruction is the only thing that identifies its turn,
   * so an attempt whose binding never landed is first rebound from the
   * Session's recorded history by request id; whichever turn happened to end
   * last, or a manual turn, is never substituted. The recorded turn's outcome
   * is then read from the projections the live watcher maintains, so a turn
   * that ended, failed, paused for an approval, or is still open is reported
   * exactly as the live feed would have reported it. A structured-question
   * pause has no Session event and is therefore only observable live; a turn
   * the projections can no longer place leaves the record unchanged.
   * @param record - the attempt task as just written or read.
   * @param session - the Session the attempt runs on.
   * @returns the record to publish, or undefined when nothing is decided yet.
   */
  private decideAttemptCatchUp(
    record: TaskRecordState,
    session: Session,
  ): TaskRecordState | undefined {
    const bound = this.bindAttemptTurn(record, session)
    if (bound === undefined) return undefined
    // A record rebound from history has to land even when its state was
    // already right, or the binding is lost again on the next restart.
    const rebound = bound === record ? undefined : bound
    if (bound.turn === null) return rebound
    const wait = this.ctx.oplSessionWait.stateOf(session)
    const closed = wait.closedTurns[String(bound.turn)]
    if (closed !== undefined) {
      return this.settleRecord(bound, session, bound.turn, closed, rebound)
    }
    if (this.openTurnOf(session) !== bound.turn) return rebound
    const pending = Object.entries(wait.pendingApprovals)
    const ask = pending[pending.length - 1]
    if (ask !== undefined) {
      return (
        decideTransition(
          bound,
          this.now(),
          'waiting_approval',
          `waiting for an approval on ${ask[1]}`,
          undefined,
          ask[0],
        ) ?? rebound
      )
    }
    return (
      decideTransition(
        bound,
        this.now(),
        'running',
        `turn ${String(bound.turn)} is already open`,
        undefined,
      ) ?? rebound
    )
  }

  /**
   * Bind an attempt task to the instruction the Session recorded for it, and to
   * the turn that consumed that instruction when one has.
   *
   * The instruction carries the attempt's deterministic request id, so the
   * Session's recorded history names the exact turn it was consumed in no
   * matter when the binding write is attempted. An instruction recorded before
   * any turn has claimed it still records its log position, which is what lets
   * the live watcher settle the first turn that ends after it. A record that
   * already names a turn is returned as is; a Session that has not recorded the
   * instruction leaves the record unbound.
   * @param record - the attempt task as just written or read.
   * @param session - the Session the attempt runs on.
   * @returns the record carrying what the Session recorded, or undefined when it cannot bind.
   */
  private bindAttemptTurn(record: TaskRecordState, session: Session): TaskRecordState | undefined {
    if (record.turn !== null) return record
    if (record.resumeRequestId === null) return undefined
    const recorded = this.recordedResumeInstruction(session, record.resumeRequestId)
    if (recorded === undefined) return undefined
    const resumeInstructionSeq = record.resumeInstructionSeq ?? recorded.seq
    if (recorded.turn === null && resumeInstructionSeq === record.resumeInstructionSeq)
      return undefined
    return { ...record, turn: recorded.turn, resumeInstructionSeq, updatedAt: this.now() }
  }

  /**
   * Why a failure may not be resumed, or null when it may.
   *
   * The check reads durable facts: the delivery must be this task's `failed`
   * outcome for the exact reasoning_text condition, the Session's last recorded
   * turn end must still be that failure, no newer turn may be open or queued,
   * and the task must still carry the same target.
   */
  private refuseResume(
    task: TaskRecordState,
    delivery: DeliveryRecordState,
  ): { decision: TaskResumeDecision; reason: string } | null {
    if (task.execution.kind === 'harness-session') {
      // The bounded automatic resume submits one persisted user instruction into
      // a DSH Session. A combination execution has none, and its own CLI owns
      // whether a failure may be retried, so this is not-applicable rather than
      // an attempt to drive another agent loop from here.
      return {
        decision: 'not-applicable',
        reason: 'a combination execution has no DSH Session to resume automatically',
      }
    }
    if (delivery.payload.state !== 'failed' || task.state !== 'failed') {
      return { decision: 'not-applicable', reason: 'the delivery is not a recorded task failure' }
    }
    if (!task.resumeEligible || !delivery.payload.resumeEligible) {
      return {
        decision: 'not-applicable',
        reason: 'the recorded failure is not the reasoning_text protocol condition',
      }
    }
    if (delivery.target.threadId !== task.target.threadId) {
      return {
        decision: 'superseded',
        reason: 'the notification target no longer matches the task target',
      }
    }
    const session = this.boundSession(task)
    if (session === undefined) {
      return { decision: 'superseded', reason: 'the bound Session is not attached to this Host' }
    }
    if (this.openTurnOf(session) !== null) {
      return { decision: 'running', reason: 'the Session already has an open turn' }
    }
    if (this.hasPendingInput(session.id)) {
      return {
        decision: 'superseded',
        reason: 'a newer user message is already queued for the Session',
      }
    }
    const wait = this.ctx.oplSessionWait.stateOf(session)
    const lastEnd = wait.lastEndReason
    if (!isReasoningTextProtocolFailure(lastEnd)) {
      return {
        decision: 'superseded',
        reason: 'the Session no longer records this failure as its last turn end',
      }
    }
    if (delivery.payload.turn !== null && wait.lastEndTurn !== delivery.payload.turn) {
      return { decision: 'superseded', reason: 'a newer turn already ended on the Session' }
    }
    return null
  }

  /** Whether the Session's live agent already holds queued input. */
  private hasPendingInput(sessionId: SessionId): boolean {
    const agent = this.ctx.get('agents')?.get(sessionId)
    if (agent === undefined) return false
    return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
  }

  /** One resume decision with its durable records. */
  private resumeDecision(
    decision: TaskResumeDecision,
    reason: string,
    claimed: TaskReceiveValue,
    attempt: TaskResumeAttempt | null,
  ): TaskResumeValue {
    return { decision, reason, receipt: claimed.receipt, delivery: claimed.delivery, attempt }
  }

  /** Apply an acknowledgement inside the durable-update queue. */
  private async acknowledge(request: TaskAckRequest): Promise<TaskAckValue> {
    const outbox = this.requireOutbox()
    const stored = outbox.get(request.deliveryId)
    if (stored === undefined || stored.taskId !== request.taskId) {
      throw new RemoteError(
        'task-feedback/delivery-not-found',
        `no delivery ${JSON.stringify(request.deliveryId)} for task ${JSON.stringify(request.taskId)}`,
        { taskId: request.taskId, deliveryId: request.deliveryId },
      )
    }
    // A retired delivery was never handed to the receiver, so an acknowledgment
    // cannot revive it; the record is returned unchanged and stays monotonic.
    if (stored.retired) return { delivery: stored }
    if (STAGE_ORDER.indexOf(request.stage) <= STAGE_ORDER.indexOf(stored.stage))
      return { delivery: stored }
    const next: DeliveryRecordState = {
      ...stored,
      stage: request.stage,
      acknowledged: true,
      nextAttemptAt: null,
      updatedAt: this.now(),
    }
    await outbox.put(request.deliveryId, next)
    return { delivery: next }
  }

  /**
   * Settle the watcher's writes, then attempt every due delivery once.
   *
   * A refused attempt is retried with a capped exponential delay until the
   * attempt budget is spent; an exhausted delivery stays pending and
   * unacknowledged, so nothing is dropped silently.
   * @returns how many were attempted, delivered, still pending, and exhausted.
   */
  @Remote('flush')
  async flush(): Promise<TaskFlushValue> {
    return this.deliveryPump.flush()
  }

  /** Wait for transport passes without introducing an arbitrary delay. */
  async idle(): Promise<void> {
    await this.deliveryPump?.idle()
  }

  /** Stop observation and transport, then drain writes before closing storage. */
  private async stopDelivery(): Promise<void> {
    this.closed = true
    this.stopping.abort()
    await this.deliveryPump?.stop()
    await Promise.allSettled([...this.writing])
    await this.commits
  }

  /** Validate a registration before anything durable is written. */
  private requireRegistration(request: TaskRegistration): void {
    const bad = (message: string): never => {
      throw new RemoteError('gateway/bad-request', message, {})
    }
    if (request.taskId.trim() === '') bad('task-feedback: taskId must be non-empty')
    if (request.target.threadId.trim() === '') {
      bad(
        'task-feedback: the target thread id must be supplied by the caller, never inferred from recent sessions',
      )
    }
    if (request.acceptance.trim() === '') {
      bad('task-feedback: acceptance criteria are required so the review has a stated bar')
    }
    if (request.turn !== undefined && (!Number.isSafeInteger(request.turn) || request.turn < 0)) {
      bad('task-feedback: turn must be a non-negative integer')
    }
    if (
      request.fromSeq !== undefined &&
      (!Number.isSafeInteger(request.fromSeq) || request.fromSeq < 0)
    ) {
      bad('task-feedback: fromSeq must be a non-negative integer')
    }
  }

  /**
   * Fold one committed Session event into every open task bound to that Session.
   * @param session - the Session the event committed on.
   * @param event - one committed Session event.
   */
  private observe(session: Session, event: SessionEvent): void {
    if (this.closed) return
    if (event.type === 'turn/start') this.openTurns.set(session.id, event.data.turn)
    else if (event.type === 'turn/end') {
      this.openTurns.delete(session.id)
      // A manual stop keeps pending inbox work for the next turn, so an
      // automatic resume that is still queued has to stand down before the
      // operator's own continuation claims it.
      if (event.data.reason.kind === 'aborted' && event.data.reason.reason.kind === 'user') {
        this.standDownQueuedResume(session)
      }
    }
    for (const record of this.boundTasks(session.id, event.seq))
      this.applyEvent(session, record, event)
  }

  /**
   * Withdraw a queued automatic resume when the operator stops the Session.
   *
   * The stop is `agent.cancel` with `keepInbox`, so an instruction that was
   * accepted but not yet claimed by a turn would otherwise start the operator's
   * next turn: the old delivery would append a continuation after a manual stop.
   * The instruction is removed from the live inbox and its attempt task is
   * reported `cancelled`, which is the explicit record of the stand-down. The
   * admission and the budget it spent are kept, so a replay re-validates against
   * the stopped Session and reports `superseded` instead of admitting a second
   * attempt.
   * @param session - the Session the operator stopped.
   */
  private standDownQueuedResume(session: Session): void {
    const inbox = this.ctx.get('agents')?.get(session.id)?.inbox
    if (inbox === undefined) return
    for (const [, receipt] of [...this.requireReceipts().entries()]) {
      if (receipt.resumeAttempt === null || receipt.resumeRequestId === null) continue
      const failed = this.live.get(receipt.taskId)
      if (failed === undefined || failed.sessionId !== session.id) continue
      const matches = (message: {
        readonly source: { readonly kind: string; readonly rpcId?: string }
      }): boolean =>
        message.source.kind === 'user' && message.source.rpcId === receipt.resumeRequestId
      const pending = inbox.nextTurn.find(matches) ?? inbox.nextStep.find(matches)
      const recorded = this.recordedResumeInstruction(session, receipt.resumeRequestId)
      // A recorded instruction with a turn was already claimed by that turn, and
      // one with no pending item and no between-turn record is gone; neither is
      // this service's to withdraw.
      if (pending === undefined && (recorded === undefined || recorded.turn !== null)) continue
      if (pending !== undefined) inbox.remove(pending.id)
      this.track(
        this.commit(async () => {
          const latest = this.requireReceipts().get(receipt.deliveryId) ?? receipt
          await this.requireReceipts().put(latest.deliveryId, {
            ...latest,
            resumeSubmitted: false,
            updatedAt: this.now(),
          })
        }),
      )
      const attemptId = receipt.resumeTaskId
      const attempt = attemptId === null ? undefined : this.live.get(attemptId)
      if (attempt === undefined) continue
      this.transition(
        attempt,
        'cancelled',
        'the operator stopped the Session; the queued automatic resume instruction was withdrawn',
        undefined,
      )
    }
  }

  /**
   * Fold one committed event into one task record.
   *
   * This is the single event-to-state rule set: live observation and the
   * recovery replay of an attempt that was registered late both run it, so a
   * turn that already ran settles the task exactly as the live feed would.
   * @param session - the Session the event committed on.
   * @param record - the task as last read.
   * @param event - one committed Session event.
   */
  private applyEvent(session: Session, record: TaskRecordState, event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        if (!this.matchesTurn(record, event.data.turn, event.seq)) return
        const turn = record.turn ?? event.data.turn
        this.transition({ ...record, turn }, 'running', `turn ${String(turn)} started`, event)
        return
      }
      case 'turn/end':
        if (!this.matchesTurn(record, event.data.turn, event.seq)) return
        this.settleTurn(record, session, event.data.turn, event.data.reason, event)
        return
      case 'approval/asked':
        if (this.awaitingResumeInstruction(record)) return
        if (record.turn !== null && this.openTurnOf(session) !== record.turn) return
        this.pauseForApproval(
          record,
          session,
          String(event.data.id),
          { seq: Number(event.seq), toolName: event.data.toolName },
          event,
        )
        return
      case 'approval/decided':
        if (this.awaitingResumeInstruction(record)) return
        if (record.turn !== null && this.openTurnOf(session) !== record.turn) return
        this.transition(record, 'running', this.summaryOfApproval(event.data.outcome), event)
        return
      case 'user/message': {
        // The instruction that claimed this turn is the only fact that binds an
        // attempt to it, so a manual turn can never be read as the resumed one.
        if (record.turn !== null || record.resumeRequestId === null) return
        if (!isResumeInstruction(event, record.resumeRequestId)) return
        const claimed = this.openTurns.get(session.id)
        if (claimed === undefined) return
        const boundTurn: TaskRecordState = {
          ...record,
          turn: claimed,
          resumeInstructionSeq: Number(event.seq),
        }
        this.transition(
          boundTurn,
          'running',
          `turn ${String(claimed)} claimed the automatic resume instruction`,
          event,
        )
        return
      }
      default:
        return
    }
  }

  /**
   * Record a Session asking its human a structured question.
   *
   * The request carries no Session event, so the pause is identified by the
   * cursor it was observed at plus the caller-provided question ids: one
   * request replayed at one cursor is one pause, while two different requests at
   * the same cursor are two. The notice it publishes carries the bounded
   * question text and options plus the Session the answer belongs to, which is
   * what lets a dispatcher relay the question instead of guessing an answer.
   * @param session - the Session whose agent asked, when it is attached.
   * @param questions - the request's questions, in caller order.
   */
  private observeQuestion(
    session: Session | undefined,
    questions: readonly AskUserQuestionItem[],
  ): void {
    if (this.closed || session === undefined) return
    const seq = Number(session.seq)
    const waitKey = questionObservationKey(seq, questions)
    const needsInput = this.questionNotice(session, seq, waitKey, questions)
    for (const record of this.boundTasks(session.id, seq)) {
      if (this.awaitingResumeInstruction(record)) continue
      if (record.turn !== null && this.openTurnOf(session) !== record.turn) continue
      this.transition(
        { ...record, evidence: { ...record.evidence, seq }, needsInput },
        'waiting_input',
        'the Session asked its human a question',
        undefined,
        waitKey,
      )
    }
  }

  /**
   * The bounded notice of one structured-question pause.
   *
   * The caller's supporting `detail` stays in the Session: this notice names
   * the questions, their options, and where the answer belongs, and a
   * dispatcher that needs the full text reads it there.
   * @param session - the Session whose agent asked.
   * @param seq - Session-log cursor the request was observed at.
   * @param pauseId - stable identity of the pause.
   * @param questions - the request's questions, in caller order.
   * @returns the bounded pause notice.
   */
  private questionNotice(
    session: Session,
    seq: number,
    pauseId: string,
    questions: readonly AskUserQuestionItem[],
  ): NeedsInputNoticeState {
    return {
      kind: 'question',
      sessionId: session.id,
      turn: this.openTurnOf(session),
      seq,
      pauseId,
      questions: boundedQuestions(
        questions,
        this.config.needsInputMaxQuestions,
        this.config.needsInputMaxOptions,
        this.config.needsInputMaxChars,
      ),
      approval: null,
    }
  }

  /**
   * Publish one unanswered approval using its original event position as the pause identity.
   * @param record - task tracking the approval's turn.
   * @param session - Session waiting for the decision.
   * @param approvalId - identity of the unanswered ask.
   * @param approval - recorded position and tool of the ask.
   * @param event - deciding event for live observation; absent during recovery.
   */
  private pauseForApproval(
    record: TaskRecordState,
    session: Session,
    approvalId: string,
    approval: FeedbackApproval,
    event?: SessionEvent<'approval/asked'>,
  ): void {
    this.transition(
      {
        ...record,
        evidence: { ...record.evidence, seq: approval.seq },
        needsInput: this.approvalNotice(session, approvalId, approval),
      },
      'waiting_approval',
      `waiting for an approval on ${approval.toolName}`,
      event,
      String(approval.seq),
    )
  }

  /**
   * The bounded notice of one approval pause.
   * @param session - the Session waiting for the decision.
   * @param approvalId - identity of the unanswered ask.
   * @param approval - recorded position and tool of the ask.
   * @returns the bounded pause notice.
   */
  private approvalNotice(
    session: Session,
    approvalId: string,
    approval: FeedbackApproval,
  ): NeedsInputNoticeState {
    return {
      kind: 'approval',
      sessionId: session.id,
      turn: this.openTurnOf(session),
      seq: approval.seq,
      pauseId: String(approval.seq),
      questions: [],
      approval: {
        approvalId,
        toolName: boundedLine(approval.toolName, this.config.needsInputMaxChars),
      },
    }
  }

  /** Every open task bound to one Session whose cursor the event has passed. */
  private boundTasks(sessionId: TaskRecordState['sessionId'], seq: number): TaskRecordState[] {
    return [...this.live.values()].filter(
      (record) =>
        record.sessionId === sessionId &&
        OPEN_STATES.includes(record.state) &&
        seq >= record.fromSeq,
    )
  }

  /** Whether a `turn/end` settles this task. */
  private matchesTurn(record: TaskRecordState, turn: number, seq: number): boolean {
    if (record.turn !== null) return record.turn === turn
    if (record.resumeRequestId === null) return seq >= record.fromSeq
    // An automatic-resume attempt settles only on the turn that consumed its
    // own instruction. Before that instruction is recorded, no turn may settle
    // it; afterwards the first turn to end is necessarily the one that claimed
    // it, because turns run one at a time and the instruction precedes them.
    const instructionSeq = record.resumeInstructionSeq
    return instructionSeq !== null && seq >= instructionSeq
  }

  /**
   * Whether this task tracks an automatic resume whose instruction has not been
   * observed in the Session yet.
   * @param record - the task as last read.
   * @returns true while the attempt awaits its own instruction.
   */
  private awaitingResumeInstruction(record: TaskRecordState): boolean {
    return record.resumeRequestId !== null && record.resumeInstructionSeq === null
  }

  /** The one-line summary of a decided approval. */
  private summaryOfApproval(outcome: ApprovalOutcome): string {
    return `the approval was ${outcome}`
  }

  /** The one-line summary of a recorded turn end. */
  private summaryOf(reason: TurnEndReason): string {
    switch (reason.kind) {
      case 'completed':
        return 'the turn completed'
      case 'aborted':
        return `the turn was cancelled (${reason.reason.kind})`
      case 'error':
        return `the turn failed: ${reason.error.message}`
      case 'blocked':
        return 'the turn ended before any step was entered'
      case 'max-tokens':
        return 'a step reached its output-token ceiling'
      case 'interrupted':
        return 'the turn was interrupted and closed after the fact'
      default:
        return `the turn ended for reason ${(reason as { kind: string }).kind}`
    }
  }

  /**
   * Move one task to a new state, durably, and enqueue its notification once.
   *
   * A terminal state is written once: a later event cannot rewrite a recorded
   * outcome, so a replay or a late event cannot turn a completed task into a
   * failed one.
   * @param record - the task as last read, with any turn this transition learns.
   * @param state - the state now observed.
   * @param summary - one line describing what was observed.
   * @param event - the event that decided the state, when one did.
   * @param waitKey - stable identity of this pause for a waiting state; absent otherwise.
   * @param resumeEligible - whether the observed failure matches the bounded automatic-resume condition.
   * @param leakedToolSyntax - tool-invocation markup found in a completed turn's visible text, when any.
   */
  private transition(
    record: TaskRecordState,
    state: TaskState,
    summary: string,
    event: SessionEvent | undefined,
    waitKey?: string,
    resumeEligible = false,
    leakedToolSyntax: readonly string[] | null = null,
  ): void {
    this.publish(
      decideTransition(
        record,
        this.now(),
        state,
        summary,
        event,
        waitKey,
        resumeEligible,
        leakedToolSyntax,
      ),
    )
  }

  /**
   * Settle one task from a turn end the Session recorded.
   *
   * Live observation and the recovery replays both route through here, so a
   * completed turn that already ran is reported exactly as the live feed would
   * report it.
   * @param record - the task as last read.
   * @param session - the Session the turn ran on.
   * @param turn - the turn the end belongs to.
   * @param reason - the recorded turn end.
   * @param event - the deciding event, absent when a recovery reads recorded history.
   */
  private settleTurn(
    record: TaskRecordState,
    session: Session,
    turn: number,
    reason: TurnEndReason,
    event: SessionEvent | undefined,
  ): void {
    const settlement = this.settlementOf(session, turn, reason)
    this.transition(
      record,
      settlement.state,
      settlement.summary,
      event,
      undefined,
      settlement.resumeEligible,
      settlement.leakedToolSyntax,
    )
  }

  /**
   * The record one recorded turn end settles a task into, or the caller's
   * fallback when the observation changes nothing.
   * @param record - the task as last read.
   * @param session - the Session the turn ran on.
   * @param turn - the turn the end belongs to.
   * @param reason - the recorded turn end.
   * @param fallback - the record to return when the end decides no change.
   * @returns the record to publish, or the fallback.
   */
  private settleRecord(
    record: TaskRecordState,
    session: Session,
    turn: number,
    reason: TurnEndReason,
    fallback: TaskRecordState | undefined,
  ): TaskRecordState | undefined {
    const settlement = this.settlementOf(session, turn, reason)
    return (
      decideTransition(
        record,
        this.now(),
        settlement.state,
        settlement.summary,
        undefined,
        undefined,
        settlement.resumeEligible,
        settlement.leakedToolSyntax,
      ) ?? fallback
    )
  }

  /**
   * What one recorded turn end settles: its state, its summary, and the facts a
   * delivery carries.
   *
   * A completed turn whose final visible text carries tool-invocation markup is
   * still `completed` as the loop recorded it, and its summary says the outcome
   * is unverified, so a notification never reads it as a business success. Such
   * a turn is not resume-eligible: only the exact reasoning_text failure is.
   * @param session - the Session the turn ran on.
   * @param turn - the turn the end belongs to.
   * @param reason - the recorded turn end.
   * @returns the settlement of that turn end.
   */
  private settlementOf(session: Session, turn: number, reason: TurnEndReason): TurnSettlement {
    const state = settledState(reason)
    const leaked = state === 'completed' ? this.completedTurnLeakage(session, turn) : []
    return {
      state,
      summary: leaked.length === 0 ? this.summaryOf(reason) : unverifiedCompletionSummary(leaked),
      resumeEligible: isReasoningTextProtocolFailure(reason),
      leakedToolSyntax: leaked.length === 0 ? null : leaked,
    }
  }

  /**
   * Tool-invocation markup the settling turn left in its visible text.
   *
   * Only the turn's last assistant message is read, from the end of the log
   * backwards: the loop ends a turn `completed` when that message requested no
   * tool call, so markup there is syntax that should have been a call. Reasoning
   * blocks, tool results, and earlier steps are never read, so a turn that
   * quoted the syntax and then called its tools normally is not flagged.
   * @param session - the Session the turn ran on.
   * @param turn - the turn whose last assistant message is read.
   * @returns the marker families found, empty when the turn left none.
   */
  private completedTurnLeakage(session: Session, turn: number): string[] {
    const state = this.sessionFacts.stateOf(session)
    return [...(state.finalToolSyntax[String(turn)] ?? [])]
  }

  /**
   * Publish one decided transition: the live view first, then the durable write
   * and its notification, on the serialized update chain.
   * @param next - the decided record, or undefined when nothing changed.
   */
  private publish(next: TaskRecordState | undefined): void {
    if (next === undefined) return
    // The live view moves first so several events of one tick cannot each read
    // the state before the last write landed.
    this.live.set(next.taskId, next)
    this.track(
      this.commit(async () => {
        await this.requireTasks().put(next.taskId, next)
        await this.enqueue(next)
      }),
    )
  }

  /** Track one durable write the watcher started. */
  private track(operation: Promise<unknown>): void {
    this.writing.add(operation)
    void operation.then(
      () => {
        this.writing.delete(operation)
      },
      (error: unknown) => {
        this.writing.delete(operation)
        this.writeFailure = error
        // Reported, never swallowed: a failed write must not read as a state
        // the task reached, and a caller awaiting `settled()` has to be able to
        // see that something did not land.
        this.ctx.logger.warn(
          `task-feedback: durable write failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    )
  }

  /** Enqueue one delivery per (task, state), once, when the state notifies. */
  private async enqueue(record: TaskRecordState): Promise<void> {
    if (!this.config.notifyStates.includes(record.state)) return
    const outbox = this.requireOutbox()
    const deliveryId = deliveryIdOf(record)
    if (outbox.get(deliveryId) !== undefined) return
    const payload: DeliveryRecordState['payload'] = {
      taskId: record.taskId,
      state: record.state,
      sessionId: record.execution.kind === 'dsh-session' ? record.sessionId : null,
      execution: { ...record.execution },
      turn: record.turn,
      summary: record.summary,
      evidence: { ...record.evidence, eventSeqs: [...record.evidence.eventSeqs] },
      acceptance: record.acceptance,
      resumeEligible: record.state === 'failed' && record.resumeEligible,
      leakedToolSyntax: record.leakedToolSyntax === null ? null : [...record.leakedToolSyntax],
      needsInput:
        record.needsInput === null
          ? null
          : {
              ...record.needsInput,
              questions: record.needsInput.questions.map((question) => ({
                ...question,
                options: question.options.map((option) => ({ ...option })),
              })),
              approval:
                record.needsInput.approval === null ? null : { ...record.needsInput.approval },
            },
    }
    const now = this.now()
    await outbox.put(deliveryId, {
      deliveryId,
      taskId: record.taskId,
      target: record.target,
      stage: 'enqueued',
      attempts: 0,
      nextAttemptAt: null,
      acknowledged: false,
      retired: false,
      payload,
      createdAt: now,
      updatedAt: now,
    })
    const counters = this.requireCounters()
    await counters.set({ deliveryCount: counters.get().deliveryCount + 1 })
    // Armed only after the record is durable: a pass waits for the watcher's
    // writes, so the wake-up cannot read an outbox that does not contain this
    // delivery yet.
    this.deliveryPump.schedule(0)
  }

  /**
   * Rebuild open tasks from durable state after a restart.
   *
   * A task whose Session is attached but whose turn already ended while this
   * Host was down settles from the recorded end, so a completion is not lost.
   * A task whose Session is not attached becomes `disconnected` and keeps its
   * place: this Host neither cancels nor re-dispatches it, and the notification
   * says which of those happened. A combination task has no DSH Session to
   * attach: its operation was in flight in another process, so the restart is
   * reported as `disconnected` — observed, never notified, and never resent as a
   * model prompt. The repair pass afterwards re-enqueues a notifying state whose
   * delivery never landed, which is the crash between the task write and the
   * outbox write, and that is what restores a pending notification.
   */
  private async recover(): Promise<void> {
    for (const record of [...this.live.values()]) {
      if (!OPEN_STATES.includes(record.state)) continue
      if (record.execution.kind === 'harness-session') {
        this.transition(
          record,
          harnessTaskStateOf('interrupted'),
          'the Host restarted while this combination operation was in flight; the combination record keeps its place and the instruction is not sent again',
          undefined,
        )
        continue
      }
      const session = this.boundSession(record)
      if (session === undefined) {
        this.transition(
          record,
          'disconnected',
          'the bound Session is not attached to this Host; the task keeps its place',
          undefined,
        )
        continue
      }
      // An automatic-resume attempt settles only on the turn its own
      // instruction was recorded in, so it is never settled by the last turn
      // that ended while this Host was down.
      if (this.settleRecordedCatchUp(record, session)) continue
      if (record.state === 'queued' || record.state === 'disconnected') {
        this.transition(record, 'accepted', 'recovered; waiting for the task turn', undefined)
      }
    }
    await this.settled()
    // Repair the split write: a task that reached a notifying state but whose
    // outbox insert did not land gets its delivery now. `enqueue` is a no-op
    // when the delivery already exists, so an acknowledged one is never re-sent.
    for (const record of [...this.live.values()]) await this.enqueue(record)
    await this.settled()
  }

  /**
   * Compensate tasks bound to a Session attached after this Host started.
   *
   * A seeded or restored Session loads its history without a per-event feed, so
   * this attach edge is the only point where a turn that already ended becomes
   * visible. Only open tasks bound to this exact Session are reconciled, and
   * each keeps its own turn and cursor match.
   * @param session - the Session just announced.
   */
  private reconcileAttached(session: Session): void {
    if (this.closed) return
    for (const record of [...this.live.values()]) {
      if (record.sessionId !== session.id || !OPEN_STATES.includes(record.state)) continue
      // An attempt waits for the turn that consumed its own instruction, so the
      // history loaded with this Session is folded in through that binding.
      if (this.settleRecordedCatchUp(record, session)) continue
      if (record.state === 'queued' || record.state === 'disconnected') {
        const running = record.turn !== null && this.openTurnOf(session) === record.turn
        this.transition(
          record,
          running ? 'running' : 'accepted',
          running
            ? `turn ${String(record.turn)} is already open`
            : 'recovered; waiting for the task turn',
          undefined,
        )
      }
    }
  }

  /**
   * Recover one open task's recorded outcome or pending approvals.
   *
   * An automatic-resume attempt settles only on the turn its own instruction
   * was recorded in; every other open task settles when the Session recorded a
   * matching turn end or reports an unanswered approval from its open turn.
   * Recovery and the attach edge share these recorded observations.
   * @param record - the open task being reconciled.
   * @param session - the attached Session whose recorded end is folded in.
   * @returns whether a recorded outcome or pause supersedes the caller's fallback.
   */
  private settleRecordedCatchUp(record: TaskRecordState, session: Session): boolean {
    if (record.resumeRequestId !== null) {
      this.publish(this.decideAttemptCatchUp(record, session))
      return true
    }
    const catchUp = this.recordedEnd(session, record)
    if (catchUp !== undefined) {
      this.settleTurn(record, session, catchUp.turn, catchUp.reason, undefined)
      return true
    }
    const turn = this.openTurnOf(session)
    if (turn === null || (record.turn !== null && record.turn !== turn)) return false
    const pending = Object.entries(this.sessionFacts.stateOf(session).pendingApprovals).sort(
      ([, left], [, right]) => left.seq - right.seq,
    )
    let paused = false
    for (const [approvalId, approval] of pending) {
      if (approval.seq < record.fromSeq) continue
      const current = this.live.get(record.taskId) ?? record
      this.pauseForApproval({ ...current, turn }, session, approvalId, approval)
      paused = true
    }
    return paused
  }

  /** The turn open on one Session, from the loop's boundary fold. */
  private openTurnOf(session: Session): number | null {
    const state = this.ctx.agents.turnBoundaryOf(session)
    if (state.openTurnStartSeq === null) return null
    return state.lastTurn
  }

  /** The last turn end already on one Session, or null when none ended yet. */
  private lastEndTurnOf(session: Session | undefined): number | null {
    if (session === undefined) return null
    return this.ctx.oplSessionWait.stateOf(session).lastEndTurn
  }

  /**
   * The turn end recorded while this Host was down, when the Session has one.
   *
   * A named turn matches by number, so an older turn can never settle it. An
   * unnamed turn matches only an end that came after registration, which is why
   * the baseline end is compared here. The turn number comes back with the
   * reason because a completed turn's visible text is read to tell a real
   * completion from one whose tool syntax never executed.
   * @param session - the Session whose recorded end is read.
   * @param record - the task whose turn and registration baseline decide the match.
   * @returns the turn and its recorded end, or undefined when no end matches.
   */
  private recordedEnd(
    session: Session,
    record: TaskRecordState,
  ): { turn: number; reason: TurnEndReason } | undefined {
    const state = this.ctx.oplSessionWait.stateOf(session)
    if (record.turn !== null) {
      const reason = state.closedTurns[String(record.turn)]
      return reason === undefined ? undefined : { turn: record.turn, reason }
    }
    if (state.lastEndTurn === null || state.lastEndTurn === record.lastEndTurnAtRegistration)
      return undefined
    const reason = state.lastEndReason
    return reason === null ? undefined : { turn: state.lastEndTurn, reason }
  }

  /** The stored task a caller named, or a named failure. */
  private requireTask(taskId: string): TaskRecordState {
    const record = this.live.get(taskId)
    if (record === undefined) {
      throw new RemoteError(
        'task-feedback/not-found',
        `no task ${JSON.stringify(taskId)} is registered`,
        { taskId },
      )
    }
    return record
  }

  /** The stored task as callers see it. */
  private project(record: TaskRecordState): TaskRecord {
    return {
      taskId: record.taskId,
      sessionId: record.execution.kind === 'dsh-session' ? record.sessionId : null,
      execution: { ...record.execution },
      turn: record.turn,
      target: record.target,
      acceptance: record.acceptance,
      fromSeq: record.fromSeq,
      state: record.state,
      summary: record.summary,
      evidence: { ...record.evidence, eventSeqs: [...record.evidence.eventSeqs] },
      parentTaskId: record.parentTaskId,
      rootTaskId: rootTaskIdOf(record),
      attempt: record.attempt,
      autoResumeCount: this.admittedResumeCount(rootTaskIdOf(record)),
      autoResumeLimit: record.autoResumeLimit,
      resumeEligible: record.state === 'failed' && record.resumeEligible,
      leakedToolSyntax: record.leakedToolSyntax === null ? null : [...record.leakedToolSyntax],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  private now(): string {
    return new Date().toISOString()
  }

  private requireTasks(): KvTable<string, TaskRecordState> {
    if (this.taskTable === undefined) throw new Error('task-feedback: the task table is not open')
    return this.taskTable
  }

  private requireOutbox(): KvTable<string, DeliveryRecordState> {
    if (this.outboxTable === undefined)
      throw new Error('task-feedback: the outbox table is not open')
    return this.outboxTable
  }

  private requireReceipts(): KvTable<string, ReceiptRecordState> {
    if (this.receiptTable === undefined)
      throw new Error('task-feedback: the receipt table is not open')
    return this.receiptTable
  }

  private requireCounters(): DomainGlobal<{ deliveryCount: number }> {
    if (this.counters === undefined)
      throw new Error('task-feedback: the domain global record is not open')
    return this.counters
  }
}
