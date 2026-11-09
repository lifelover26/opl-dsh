/**
 * The task feedback domain: the durable task registry and its notification
 * outbox.
 *
 * The outbox is a separate table rather than a field of the task so that a
 * notification survives independently of the task record's later updates, and
 * so `nextAttemptAt` can order retries without rewriting the task. Neither
 * table carries credentials or conversation text: a delivery payload holds the
 * task's own metadata plus a reference the reviewer reads itself.
 *
 * @module @deepseek-ai/dsh-api-task-feedback/spec
 */

import { z } from 'zod'
import { officialValidationSchema } from '../../../compat/host/validation-schema.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  DeliveryPayload,
  DeliveryStage,
  HarnessExecution,
  NeedsInputNotice,
  TaskExecution,
  TaskReceiptStatus,
  TaskState,
  TaskTarget,
} from './types.ts'

/** Session id at the durable boundary; branding has no runtime representation. */
const sessionId = z.string().transform((value) => value as SessionId)

/**
 * Session reference as one record stores it.
 *
 * Nullable because a combination execution has no DSH Session at all: storing a
 * combination session id here would make two different identities
 * indistinguishable to every reader of this table. Records an earlier build
 * wrote always named a DSH Session, so their value is unchanged.
 */
const optionalSessionId = sessionId.nullable().default(null)

/**
 * Which execution performs one task.
 *
 * The native marker is the default so a record an earlier build wrote — which
 * could only ever have been a DSH Session — reads as what it was, while a
 * combination record carries the exact session, combination, task, and
 * operation a reviewer needs to read the result itself.
 */
const taskExecution = z
  .union([
    z.object({ kind: z.literal('dsh-session') }),
    z.object({
      kind: z.literal('harness-session'),
      harnessSessionId: z.string().min(1),
      harnessRef: z.string().min(1),
      combination: z.string().min(1),
      taskId: z.string().min(1),
      operationId: z.string().min(1),
    }),
  ])
  .default({ kind: 'dsh-session' })

/** Every task state, for validating a stored record. */
const taskState = z.enum([
  'queued',
  'accepted',
  'running',
  'waiting_approval',
  'waiting_input',
  'completed',
  'failed',
  'cancelled',
  'disconnected',
])

/** Every delivery stage, for validating a stored record. */
const deliveryStage = z.enum(['enqueued', 'delivered', 'received', 'review-started'])

/** The explicit notification target. */
const taskTarget = z.object({
  kind: z.literal('codex-thread'),
  threadId: z.string().min(1),
})

/** Local references that let a reviewer read the evidence instead of receiving it. */
const taskEvidence = z.object({
  sessionId: optionalSessionId,
  turn: z.number().int().nonnegative().nullable(),
  seq: z.number().int().nonnegative().nullable(),
  eventSeqs: z.array(z.number().int().nonnegative()),
})

/** One bounded choice a needs-input pause offers, as stored. */
const needsInputOption = z.object({
  label: z.string(),
  description: z.string().nullable(),
})

/** One bounded question a needs-input pause asks, as stored. */
const needsInputQuestion = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().nullable(),
  options: z.array(needsInputOption),
  multiSelect: z.boolean(),
  intent: z.string().nullable(),
})

/**
 * The bounded pause a needs-input notification announces, as stored.
 *
 * The record carries the return location (`sessionId`, `turn`, `seq`) with the
 * pause identity, so a delivery rebuilt from durable state still says which
 * Session is waiting and never becomes an answer this service submits.
 */
const needsInputNotice = z.object({
  kind: z.enum(['question', 'approval']),
  sessionId: optionalSessionId,
  turn: z.number().int().nonnegative().nullable(),
  seq: z.number().int().nonnegative().nullable(),
  pauseId: z.string().min(1),
  questions: z.array(needsInputQuestion),
  approval: z
    .object({
      approvalId: z.string().min(1),
      toolName: z.string(),
    })
    .nullable(),
})

/**
 * The bounded pause as a durable record holds it.
 *
 * The stored collections are mutable, while the public `NeedsInputNotice` that
 * callers read declares them readonly. Internal producers return this durable
 * form so a pause can be stored on a task and copied into an outbox payload
 * without a shape conversion at either write.
 */
export type NeedsInputNoticeState = z.infer<typeof needsInputNotice>

/** Bounded delivery body: metadata, one summary line, and references. */
const deliveryPayload = z.object({
  taskId: z.string().min(1),
  state: taskState,
  sessionId: optionalSessionId,
  // Absent on records an earlier build wrote; those were DSH Sessions.
  execution: taskExecution,
  turn: z.number().int().nonnegative().nullable(),
  summary: z.string(),
  evidence: taskEvidence,
  acceptance: z.string(),
  // Absent on records an earlier build wrote; those were never resume-eligible.
  resumeEligible: z.boolean().default(false),
  // Absent on records an earlier build wrote; those predate the marker check.
  leakedToolSyntax: z.array(z.string()).nullable().default(null),
  // Absent on records an earlier build wrote; those predate the structured pause.
  needsInput: needsInputNotice.nullable().default(null),
})

/**
 * Durable shape of one dispatched task.
 */
export const taskRecord = z.object({
  taskId: z.string().min(1),
  sessionId: optionalSessionId,
  /**
   * Which execution performs this task: the DSH Session named above, or a
   * combination execution named in full. A reader learns the kind here instead
   * of inferring it from a session id that may not be one.
   */
  execution: taskExecution,
  turn: z.number().int().nonnegative().nullable(),
  target: taskTarget,
  acceptance: z.string(),
  fromSeq: z.number().int().nonnegative(),
  state: taskState,
  summary: z.string(),
  evidence: taskEvidence,
  /**
   * Stable identity of the pause this record reports, when it is a waiting
   * state: the deciding event position for an approval, the cursor plus the
   * asked question ids for a structured question. It is what separates two
   * distinct pauses at one log cursor from a replay of one.
   */
  waitKey: z.string().nullable().default(null),
  /**
   * The bounded pause this task waits in, present exactly while `state` is a
   * waiting state and cleared by the transition that leaves one. It is stored
   * with the task so a delivery rebuilt from durable state — the repair of a
   * crash between the task write and the outbox write — still carries what was
   * asked and where the answer belongs.
   */
  needsInput: needsInputNotice.nullable().default(null),
  /**
   * Turn that had already ended when a `turn: null` task was registered.
   * Recovery compares against it so a turn that ended before the task existed
   * cannot settle it. Null means no turn had ended then, or the bound Session
   * was not attached and the task observes the whole log.
   */
  lastEndTurnAtRegistration: z.number().int().nonnegative().nullable().default(null),
  /** The attempt this task resumes, absent on the original dispatch. */
  parentTaskId: z.string().nullable().default(null),
  /**
   * Original dispatched task whose automatic-resume budget this attempt shares;
   * null on a record an earlier build wrote, where the task is its own root.
   */
  rootTaskId: z.string().min(1).nullable().default(null),
  /** One-based attempt number within the root task. */
  attempt: z.number().int().positive().default(1),
  /** Automatic resumes already admitted for the root task. */
  autoResumeCount: z.number().int().nonnegative().default(0),
  /** Automatic-resume ceiling captured when the root task was registered. */
  autoResumeLimit: z.number().int().nonnegative().default(0),
  /** Whether the recorded failure matches the bounded automatic-resume condition. */
  resumeEligible: z.boolean().default(false),
  /**
   * Tool-invocation markup the settling turn left in its visible text, or null
   * when it carried none.
   */
  leakedToolSyntax: z.array(z.string()).nullable().default(null),
  /**
   * Deterministic identity of the automatic-resume instruction this task
   * tracks; null for an ordinary task. Until that exact instruction is observed
   * in the Session, no turn may settle this task, so a manual turn cannot be
   * mistaken for the resumed one.
   */
  resumeRequestId: z.string().nullable().default(null),
  /**
   * Session log position of {@link resumeRequestId}'s recorded user message,
   * once observed. A prompt surface that records the instruction before any
   * turn claims it leaves the turn unknown; the first turn to end after this
   * position is then the resumed one, because turns run one at a time and the
   * instruction precedes them.
   */
  resumeInstructionSeq: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored task record. */
export type TaskRecordState = z.infer<typeof taskRecord>

/** Durable shape of one outbox entry. */
export const deliveryRecord = z.object({
  deliveryId: z.string().min(1),
  taskId: z.string().min(1),
  target: taskTarget,
  stage: deliveryStage,
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().nullable(),
  acknowledged: z.boolean(),
  // Absent on records an earlier build wrote; those were never retired.
  retired: z.boolean().default(false),
  payload: deliveryPayload,
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored outbox entry. */
export type DeliveryRecordState = z.infer<typeof deliveryRecord>

/** Every receiver consumption status, for validating a stored receipt. */
const receiptStatus = z.enum(['received', 'review-started', 'consumed'])

/**
 * Durable shape of one receiver's consumption ledger entry.
 *
 * The resume fields make one automatic resume per failure delivery idempotent:
 * the attempt, its instruction id, and the follow-up task are recorded before
 * submission, so a duplicate notification or a crash replay presents the same
 * instruction instead of admitting a second one.
 */
export const receiptRecord = z.object({
  deliveryId: z.string().min(1),
  taskId: z.string().min(1),
  status: receiptStatus,
  // Absent on records an earlier build wrote; those had no explicit owner.
  ownerId: z.string().nullable().default(null),
  claimEpoch: z.number().int().nonnegative().default(0),
  leaseExpiresAt: z.string().nullable().default(null),
  /** One-based resume number this failure delivery admitted, when it did. */
  resumeAttempt: z.number().int().positive().nullable().default(null),
  /**
   * Original dispatched task whose budget the admission spent; null until a
   * resume is admitted. This is the key that makes the receipt table the
   * authoritative budget ledger, so a lost task-record write can never let one
   * attempt spend budget twice.
   */
  resumeRootTaskId: z.string().nullable().default(null),
  /** Durable instruction id submitted for {@link resumeAttempt}. */
  resumeRequestId: z.string().nullable().default(null),
  /** Follow-up task registered to track the resumed turn. */
  resumeTaskId: z.string().nullable().default(null),
  /**
   * Session cursor captured before the instruction was submitted. A delayed
   * registration observes the resumed turn from this position instead of from
   * whatever cursor recovery happens to run at, so a turn that already ran is
   * not mistaken for pre-registration history.
   */
  resumeFromSeq: z.number().int().nonnegative().nullable().default(null),
  /**
   * Turn that had already ended when the instruction was admitted. A
   * `turn: null` attempt settles on the first turn ending after this baseline,
   * so an earlier turn cannot settle it and the current last end at recovery
   * time is never used as the baseline.
   */
  resumeLastEndTurnAtRegistration: z.number().int().nonnegative().nullable().default(null),
  /** Whether the instruction was accepted by the Session prompt surface. */
  resumeSubmitted: z.boolean().default(false),
  claimedAt: z.string(),
  updatedAt: z.string(),
})

/** One stored receiver receipt. */
export type ReceiptRecordState = z.infer<typeof receiptRecord>

/**
 * The task feedback domain: one `tasks` table keyed by task id (the caller's
 * idempotency key), one `outbox` table keyed by delivery id, and one `receipts`
 * table keyed by delivery id for the receiving side's own consumption ledger.
 * The global record carries the durable counters a restart must not reset.
 */
export const taskFeedbackDomainSpec = defineDomain({
  name: 'task_feedback',
  version: 1,
  global: {
    schema: officialValidationSchema(
      z.object({
        /** Deliveries ever enqueued, so a delivery id stays unique across restarts. */
        deliveryCount: z.number().int().nonnegative(),
      }),
    ),
    initial: { deliveryCount: 0 },
  },
  tables: {
    tasks: domainTable<string, TaskRecordState>(officialValidationSchema(taskRecord)),
    outbox: domainTable<string, DeliveryRecordState>(officialValidationSchema(deliveryRecord)),
    receipts: domainTable<string, ReceiptRecordState>(officialValidationSchema(receiptRecord)),
  },
})

/** Re-exported so callers of this module do not reach into the types module for the vocabulary. */
export type {
  DeliveryPayload,
  DeliveryStage,
  HarnessExecution,
  NeedsInputNotice,
  TaskExecution,
  TaskReceiptStatus,
  TaskState,
  TaskTarget,
}
