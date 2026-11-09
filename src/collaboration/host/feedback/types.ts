/**
 * Vocabulary of the task feedback loop: what one dispatched task is, how its
 * state is reported, and how a completion notification travels to the Session
 * that dispatched it.
 *
 * The states separate facts a dispatcher acts on differently. A process that
 * exits is not a finished task, and a transiently unreachable Session is not a
 * failed one, so `disconnected` never settles a task and `cancelled` is
 * reserved for the turn the Session itself recorded as aborted.
 *
 * @module @deepseek-ai/dsh-task-feedback/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

/** Stable identity of one dispatched task, minted by the dispatching caller. */
export type TaskId = string & { readonly __taskId?: unique symbol }

/**
 * Target thread the dispatcher substitutes when it has no real Codex Session id.
 *
 * It names no Session at all, so a delivery addressed to it can never wake a
 * reviewer. A new external dispatch that carries it is refused at the execution
 * entry before any prompt is sent, a combination registration that carries it is
 * refused instead of being queued as if it were deliverable, and a record an
 * earlier build already wrote with it stays readable: its card reports the
 * missing reviewer instead of claiming a handoff.
 */
export const NO_SESSION_TARGET_THREAD_ID = 'manual'

/**
 * Where one dispatched task stands.
 *
 * `queued` and `accepted` differ by what this Host can already observe:
 * `queued` means the registration is durable but the bound Session is not
 * attached here, `accepted` means it is attached and simply has not opened the
 * task's turn yet.
 */
export type TaskState =
  | 'queued'
  | 'accepted'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'disconnected'

/** The states after which no further observation changes a task. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed', 'cancelled']

/**
 * How far the receiving Session has consumed one delivery.
 *
 * This is the receiver's own ledger, separate from the sender's {@link DeliveryStage}:
 * a delivery can be acknowledged (`received`) while its review is still
 * outstanding, so consumption needs its own durable record to tell a duplicate
 * message from an interrupted one.
 */
export type TaskReceiptStatus = 'received' | 'review-started' | 'consumed'

/**
 * Durable record of one receiver's consumption of a delivery.
 *
 * Ownership is explicit: `ownerId` names the consumer that holds the claim,
 * `claimEpoch` increases every time ownership is transferred, and
 * `leaseExpiresAt` is when a claim by another consumer may be reclaimed. An
 * older owner's `claimEpoch` no longer matches after a transfer, so it cannot
 * finish a review a newer owner now holds.
 */
export interface TaskReceipt {
  readonly deliveryId: string
  readonly taskId: string
  readonly status: TaskReceiptStatus
  /** Consumer holding the claim, or null on a receipt an older build wrote. */
  readonly ownerId: string | null
  /** Ownership generation; increases on each transfer, so a stale owner is detectable. */
  readonly claimEpoch: number
  /** When the current claim may be reclaimed by another consumer. */
  readonly leaseExpiresAt: string | null
  /** When the receiver first claimed the delivery. */
  readonly claimedAt: string
  readonly updatedAt: string
}

/**
 * What a receiving Session must do with a delivery it was handed.
 *
 * `busy` is the concurrency guard: another consumer holds a live claim, so this
 * message must not start a second review. It is distinct from `resume`, which a
 * consumer that owns (or has reclaimed) the claim receives to continue one
 * review.
 */
export type TaskReceiveAction = 'review' | 'resume' | 'busy' | 'skip'

/** Claim one delivery for review, idempotently. */
export interface TaskReceiveRequest {
  readonly taskId: string
  readonly deliveryId: string
  /**
   * Stable identity of the receiving consumer. A consumer that passes the same
   * id after a restart owns its previous claim and is answered `resume`; a
   * consumer that passes a different id while another claim is live is answered
   * `busy`. Omission gives each call an ephemeral owner, so a duplicate waits
   * for the lease to expire before it can reclaim the review.
   */
  readonly consumerId?: string
}

/** The receiver's next action plus the receipt that records the claim. */
export interface TaskReceiveValue {
  /**
   * `review` when this call created the claim and the review has not started;
   * `resume` when this consumer owns an unfinished claim, so it continues that
   * one review instead of starting a second; `busy` when another consumer holds
   * a live claim and this message must not start work; `skip` when the review
   * already finished and a repeated message must not repeat it.
   */
  readonly action: TaskReceiveAction
  readonly receipt: TaskReceipt
  readonly delivery: DeliveryRecord
  /** Full review instructions for `review`/`resume`; null for `busy`/`skip`. */
  readonly reviewInstructions: string | null
}

/** Mark one claimed delivery consumed after the review finished. */
export interface TaskConsumeRequest {
  readonly taskId: string
  readonly deliveryId: string
  /** The ownership generation the consumer was given by `receive`. */
  readonly claimEpoch: number
  /** The consumer that holds the claim; checked when supplied. */
  readonly consumerId?: string
}

/** The receipt as it now stands. */
export interface TaskConsumeValue {
  readonly receipt: TaskReceipt
}

/**
 * Ask for one bounded automatic resume of a failure that cannot be retried as
 * the same request.
 *
 * `resumeFailed` is the deterministic receiver operation: one call claims the
 * delivery, verifies the failed turn is still the target, and either submits
 * one persisted user resume instruction in the original Session or reports why
 * it must not. A receiver never composes that instruction itself.
 */
export interface TaskResumeRequest {
  readonly taskId: string
  readonly deliveryId: string
  /**
   * Stable identity of the receiving consumer. A consumer that passes the same
   * id after a restart continues its own claim. Omission continues the claim
   * already recorded for this delivery when one exists, so the receiver that
   * claimed through `receive` may run `resumeFailed` without repeating its id;
   * with no recorded claim, omission mints an ephemeral owner.
   */
  readonly consumerId?: string
}

/**
 * What one automatic-resume request decided.
 *
 * `not-applicable` is a failure outside the reasoning_text protocol condition,
 * `superseded` means a newer turn, message, or target replaced the failed one,
 * `running` means the Session is already working, `budget-exhausted` means the
 * original task spent its configured resume budget, `busy` means another
 * consumer holds a live claim, `consumed` means this delivery was already
 * handled, and `resumed` means one new attempt was submitted and registered.
 */
export type TaskResumeDecision =
  'not-applicable' | 'superseded' | 'running' | 'budget-exhausted' | 'busy' | 'consumed' | 'resumed'

/** The new attempt one resume submitted, when it submitted one. */
export interface TaskResumeAttempt {
  /** The registered follow-up task that tracks the new turn. */
  readonly taskId: string
  /** One-based attempt number within the original dispatched task. */
  readonly attempt: number
  /** Durable identity of the submitted user instruction, so a replay cannot submit it twice. */
  readonly requestId: string
}

/** One automatic-resume decision plus the durable records behind it. */
export interface TaskResumeValue {
  readonly decision: TaskResumeDecision
  /** Reads as observed evidence: why the decision was reached. */
  readonly reason: string
  readonly receipt: TaskReceipt
  readonly delivery: DeliveryRecord
  readonly attempt: TaskResumeAttempt | null
}

/**
 * Where a dispatched notification stands.
 *
 * The stages are separate facts, not one progress bar: `enqueued` is durable
 * locally, `delivered` is the wake adapter accepting the handoff, `received`
 * is the target Session acknowledging it, and `review-started` is the target
 * reporting that it began its follow-up turn. An HTTP-level acceptance proves
 * `delivered` only.
 */
export type DeliveryStage = 'enqueued' | 'delivered' | 'received' | 'review-started'

/** The Session that should be woken with a dispatched task's outcome. */
export interface TaskTarget {
  /** Only Codex threads are addressable today; the field is explicit so a wrong target fails loud. */
  readonly kind: 'codex-thread'
  /** The caller's own thread identity. Never inferred from recent sessions. */
  readonly threadId: string
}

/**
 * What performs one dispatched task.
 *
 * The two kinds are separate because their identities are: a native task is
 * observed through one DSH Session's durable event feed, while a combination
 * task runs in an execution Harness session whose ACP identity is not a DSH
 * Session id at all. Naming the kind is what keeps a reader from addressing a
 * combination through a DSH Session id, or a native task through a combination
 * session id, and it is why a record carries `sessionId: null` for the second
 * kind instead of a borrowed id.
 */
export type TaskExecution =
  | { readonly kind: 'dsh-session' }
  | {
      readonly kind: 'harness-session'
      /** Execution Harness session identity (`harness-…`); never a DSH Session id. */
      readonly harnessSessionId: string
      /** Official Harness that owns the agent loop: `codex`, `claude`, `grok-build`, `minimax-code`, `dsh`. */
      readonly harnessRef: string
      /** Exact model + Harness combination the operation ran under. */
      readonly combination: string
      /** Dispatcher task identity shared by every operation of one assignment. */
      readonly taskId: string
      /** Operation (one combination turn) this task tracks; a new instruction uses a new one. */
      readonly operationId: string
    }

/** The combination execution reference alone, when a caller already knows the kind. */
export type HarnessExecution = Extract<TaskExecution, { readonly kind: 'harness-session' }>

/** One dispatch registration, exactly as the caller supplied it. */
export interface TaskRegistration {
  /** Stable caller-minted identity; re-registering the same id is idempotent. */
  readonly taskId: string
  /** The DSH Session performing the dispatched work. */
  readonly sessionId: SessionId
  /** Exact turn to settle on; omission settles on the first turn that ends after registration. */
  readonly turn?: number
  /** Session receiving the completion notification. */
  readonly target: TaskTarget
  /** What the dispatcher will check when it reviews the result. */
  readonly acceptance: string
  /** Event cursor to observe from; omission starts at the Session's current position. */
  readonly fromSeq?: number
  /**
   * The attempt this task resumes, when a dispatcher registers a retry under a
   * new id. The original task id also supplies the automatic-resume budget, so
   * a retried dispatch cannot reset it.
   */
  readonly parentTaskId?: string
  /** Original dispatched task whose automatic-resume budget this retry shares. */
  readonly rootTaskId?: string
}

/**
 * One combination operation the execution service registers before its prompt.
 *
 * Registration is durable and idempotent, and it happens before the prompt is
 * sent: a turn that completes or pauses immediately afterwards must still find
 * its registration waiting, which is the only way a fast outcome cannot be lost.
 * The task identity is derived from the execution reference, so a retry of one
 * operation lands on the same task while a new instruction — a new operation —
 * gets its own, and an old `completed` can never stand in for a newer turn.
 */
export interface HarnessTaskRegistration {
  /** The combination execution that performs the work. */
  readonly execution: HarnessExecution
  /** Reviewer that must be told the outcome; never the no-session placeholder. */
  readonly target: TaskTarget
  /** What the reviewer will check when it verifies the result. */
  readonly acceptance: string
}

/**
 * The states a combination execution reports.
 *
 * `interrupted` is not one of them: the execution service reports the task
 * state it can justify, and a Host restart that left an operation unfinished
 * maps onto `disconnected`, which this policy never notifies because no outcome
 * was observed.
 */
export type HarnessReportState = Extract<
  TaskState,
  | 'accepted'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'disconnected'
>

/**
 * The bounded pause one waiting state reports.
 *
 * The pause identity is the caller's, because only the execution side knows
 * which approval or which question it is looking at: one pause stays one
 * delivery while a replay carries the same id, and a second pause of the same
 * kind is a second delivery.
 */
export interface HarnessPauseReport {
  /** Which interactive seam paused: a structured question or a tool approval. */
  readonly kind: 'question' | 'approval'
  /** Stable identity of this pause within the operation. */
  readonly pauseId: string
  /** The questions asked, exactly as the execution side observed them; bounded here. */
  readonly questions?: readonly AskUserQuestionItem[]
  /** Approval identity and tool name, for an approval pause. */
  readonly approval?: { readonly approvalId: string; readonly toolName: string } | null
}

/** One observed combination state, exactly as the execution service saw it. */
export interface HarnessStateReport {
  /** Feedback task identity returned by {@link HarnessTaskRegistration}. */
  readonly taskId: string
  /** State as observed, never a state the caller wishes for. */
  readonly state: HarnessReportState
  /** One line describing what was observed; the reviewer reads the session for detail. */
  readonly summary: string
  /** The pause a waiting state is in; required for a waiting state, absent otherwise. */
  readonly pause?: HarnessPauseReport
}

/** The state a report settled, plus the delivery it owes when the state notifies. */
export interface HarnessStateReportValue {
  readonly task: TaskRecord
  /** The delivery this state owes, or null when the state does not notify. */
  readonly delivery: DeliveryRecord | null
}

/** Local evidence a reviewer can read back, instead of a copied transcript. */
export interface TaskEvidence {
  /** Session log the evidence belongs to; null for a combination execution, which has no DSH Session. */
  readonly sessionId: SessionId | null
  /** Turn the task settled on, once one was observed. */
  readonly turn: number | null
  /** Session log sequence the task settled at. */
  readonly seq: number | null
  /** Session log positions of the events that decided the state. */
  readonly eventSeqs: readonly number[]
}

/** One dispatched task as this Host reports it. */
export interface TaskRecord {
  readonly taskId: string
  /** The DSH Session performing the task, or null when a combination execution performs it. */
  readonly sessionId: SessionId | null
  /** Which execution performs this task, so no reader has to guess from the fields above. */
  readonly execution: TaskExecution
  readonly turn: number | null
  readonly target: TaskTarget
  readonly acceptance: string
  readonly fromSeq: number
  readonly state: TaskState
  /** Short result summary: a terminal outcome or the pause a Session is in. */
  readonly summary: string
  readonly evidence: TaskEvidence
  /** The attempt this task resumes, or null for the original dispatch. */
  readonly parentTaskId: string | null
  /** Original dispatched task whose automatic-resume budget this attempt shares. */
  readonly rootTaskId: string
  /** One-based attempt number within {@link rootTaskId}. */
  readonly attempt: number
  /**
   * Automatic resumes already admitted for {@link rootTaskId}, derived from the
   * receiver's receipt ledger rather than written independently, so one
   * admission cannot be counted twice.
   */
  readonly autoResumeCount: number
  /** Automatic-resume ceiling this task was registered under. */
  readonly autoResumeLimit: number
  /** Whether the recorded failure matches the bounded automatic-resume condition. */
  readonly resumeEligible: boolean
  /**
   * Tool-invocation markup the settling turn left in its visible text, or null
   * when its last assistant message carried none.
   *
   * A turn ends `completed` when its last assistant message requested no tool
   * call. Markup there means the model wrote an invocation as prose and nothing
   * executed it, so this record reports `completed` as the loop's own fact while
   * the field says the business outcome is unverified. It is never a reason to
   * resume automatically: only {@link resumeEligible} admits that.
   */
  readonly leakedToolSyntax: readonly string[] | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One pending or acknowledged notification. */
export interface DeliveryRecord {
  readonly deliveryId: string
  readonly taskId: string
  readonly target: TaskTarget
  readonly stage: DeliveryStage
  /** Attempts the wake adapter has seen, including the ones it refused. */
  readonly attempts: number
  /** Earliest time the next attempt may run, as an ISO-8601 string. */
  readonly nextAttemptAt: string | null
  /** Whether the target acknowledged at least one stage of this delivery. */
  readonly acknowledged: boolean
  /**
   * Whether this delivery was retired without ever reaching its target.
   *
   * Retirement suppresses unsent resolved pauses and states the current policy
   * does not notify. Accepted transport handoffs remain claimable. A retired delivery is never sent again and never claimed as
   * acknowledged.
   */
  readonly retired: boolean
  readonly payload: DeliveryPayload
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * One bounded choice a needs-input pause offers its human.
 *
 * Both fields are collapsed to one line and capped, because this text is
 * written by a caller and read by the receiving model.
 */
export interface NeedsInputOption {
  /** User-facing label. */
  readonly label: string
  /** Supporting context, or null when the caller offered none. */
  readonly description: string | null
}

/** One bounded question a needs-input pause asks, exactly as the caller asked it. */
export interface NeedsInputQuestion {
  /** Caller-provided question id, echoed in the answer. */
  readonly id: string
  /** The question to display, bounded to one line. */
  readonly question: string
  /** Short heading, or null. */
  readonly header: string | null
  /** Offered choices, bounded in count and text; empty asks for free-form input. */
  readonly options: readonly NeedsInputOption[]
  /** Whether more than one option may be selected. */
  readonly multiSelect: boolean
  /** Presentation intent tag the caller declared, or null. */
  readonly intent: string | null
}

/**
 * The bounded pause a needs-input notification announces, and where its answer
 * belongs.
 *
 * This is metadata about a pause, never the human's answer: the service reports
 * that a Session is waiting and where, so the dispatcher can relay the question
 * to its operator. Nothing in this service answers a question or decides an
 * approval, and the receiving Session is never resumed from here.
 */
export interface NeedsInputNotice {
  /** Which interactive seam paused: a structured question or a tool approval. */
  readonly kind: 'question' | 'approval'
  /**
   * DSH Session holding the pause. This is the return location: the answer is
   * given there by a human, and a dispatcher hands the question back to its
   * operator instead of submitting one itself. Null when a combination
   * execution holds the pause, which has no DSH Session: the delivery's
   * {@link DeliveryPayload.execution} names the combination session instead.
   */
  readonly sessionId: SessionId | null
  /** Turn the pause belongs to, or null when the Session had none open. */
  readonly turn: number | null
  /** Session-log cursor the pause was observed at, or null when unknown. */
  readonly seq: number | null
  /**
   * Stable identity of this pause, also the delivery id's suffix: the deciding
   * event position for an approval, the cursor plus the asked question ids for a
   * question. A replay of one pause carries the same value, which is what keeps
   * it one delivery.
   */
  readonly pauseId: string
  /** The questions asked, in caller order and bounded; empty for an approval. */
  readonly questions: readonly NeedsInputQuestion[]
  /** Approval identity and tool name, or null for a structured question. */
  readonly approval: { readonly approvalId: string; readonly toolName: string } | null
}

/** The bounded body a wake adapter may carry. Metadata and references only. */
export interface DeliveryPayload {
  readonly taskId: string
  readonly state: TaskState
  /** The DSH Session the task ran in, or null for a combination execution. */
  readonly sessionId: SessionId | null
  /** Which execution produced this outcome, so the reading instruction is exact. */
  readonly execution: TaskExecution
  readonly turn: number | null
  /** One short line: the outcome, never the model's transcript. */
  readonly summary: string
  /** Local reference the reviewer reads itself. */
  readonly evidence: TaskEvidence
  readonly acceptance: string
  /**
   * The bounded pause this delivery announces when the task is waiting for its
   * human, or null for every other state. Absent on records an earlier build
   * wrote, which predate the structured pause.
   */
  readonly needsInput: NeedsInputNotice | null
  /**
   * Whether the recorded failure matches the reasoning_text protocol condition
   * the bounded automatic resume handles. Only this exact failure is eligible;
   * the notification offers the resume operation only when it is true.
   */
  readonly resumeEligible: boolean
  /**
   * Tool-invocation markup found in the settling turn's visible text, or null
   * when it carried none. A non-null value means the notification's `completed`
   * state is the loop's own fact and the business outcome is unverified.
   */
  readonly leakedToolSyntax: readonly string[] | null
}

/** One adapter's answer to a delivery attempt. */
export interface WakeSendResult {
  /** Whether the adapter took responsibility for handing the message to the target. */
  readonly accepted: boolean
  /** Why the adapter accepted or refused; reported, never interpreted as a task outcome. */
  readonly detail: string
}

/** Registration response: the task exactly as this Host now holds it. */
export interface TaskRegistrationValue {
  readonly task: TaskRecord
}

/** One task lookup request. */
export interface TaskLookupRequest {
  readonly taskId: string
}

/** Acknowledgment of one delivered notification. */
export interface TaskAckRequest {
  readonly taskId: string
  readonly deliveryId: string
  /**
   * Stage the receiving Session reports: `received` when it took the
   * notification, `review-started` when it began its follow-up turn. A
   * transport-level acceptance is never one of these.
   */
  readonly stage: Extract<DeliveryStage, 'received' | 'review-started'>
}

/** Acknowledgment response with the delivery as it now stands. */
export interface TaskAckValue {
  readonly delivery: DeliveryRecord
}

/** One flush attempt's outcome. */
export interface TaskFlushValue {
  readonly attempted: number
  readonly delivered: number
  readonly pending: number
  /** Deliveries that exhausted their bounded retries and stay pending unacknowledged. */
  readonly exhausted: number
}

/**
 * What a wake probe established, and why not when it established nothing.
 *
 * `executable-started` is the strongest fact a probe can produce here: the
 * configured executable ran. It is not a claim that the target thread exists or
 * that a queued message reaches it, so a caller must not read it as a connected
 * delivery channel.
 */
export interface WakeStatus {
  readonly adapter: string
  readonly status: 'executable-started' | 'not-connected'
  /** Detail of the probe that decided the status, so a caller reads the observed fact. */
  readonly detail?: string
  /** Present when the configured executable could not start, so a caller learns the missing capability. */
  readonly reason?: string
}

/** One executable probe's result. */
export interface WakeProbeResult {
  /** Whether the configured executable started. */
  readonly started: boolean
  /** What the probe observed, reported either way. */
  readonly detail: string
}

/** What a wake adapter receives for one attempt. */
export interface WakeDelivery {
  readonly deliveryId: string
  readonly threadId: string
  /** Neutral instruction framing, with the task data quoted as untrusted result text. */
  readonly message: string
}

/**
 * One transport that can hand a completion notification to a Codex Session.
 *
 * The deployment installs an adapter; the receiver's own acknowledgment is the
 * only thing that advances a delivery past `delivered`. An adapter must be able
 * to answer a bounded probe of its own executable, so `wake()` reports an
 * observed fact rather than a configured constant; that probe cannot prove a
 * target thread or a delivery channel.
 */
export interface WakeAdapter {
  /** Stable identifier reported to callers. */
  readonly id: string
  /**
   * Attempt one handoff.
   * @param delivery - the bounded notification to hand over.
   * @param signal - cancellation on timeout or disposal; transports must honor it.
   * @returns whether the adapter accepted it, with the reason either way.
   */
  send(delivery: WakeDelivery, signal?: AbortSignal): Promise<WakeSendResult>
  /**
   * Observe whether the transport's configured executable can start.
   * @param signal - cancellation on timeout or disposal; transports must honor it.
   * @returns whether the executable started, with what the probe observed.
   */
  probe(signal?: AbortSignal): Promise<WakeProbeResult>
}
