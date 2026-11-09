/**
 * The durable per-review record.
 *
 * A review must leave reconstructible facts behind: the exact request that was
 * sent, the identity of the pending call, the authorization it was read from,
 * the reviewer and configuration that were selected, and the fixed outcome.
 * Those facts are written *before* the model request and again when it settles;
 * a record that cannot be committed stops the call instead of authorizing it.
 *
 * The record is **not** a Session event. `Session.append` copies only
 * `surfaceOp`/`sourceEventSeqs` into the frozen event envelope, so it cannot set
 * `SessionEvent.ignorable`, and `dsh-session-persistence` refuses to interpret a
 * stored log containing a type outside the generated core set unless that
 * marker is present. An OPL review event written through `append` would leave
 * the user's Session unrestorable.
 *
 * It is instead one table of a declared storage domain: the official
 * schema-validated, per-domain-serialized KV layer, whose `put` resolves only
 * after the backend committed the record. Nothing here is an authorization
 * source: authority is read from the original Session log, never inferred from
 * a review record.
 */
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
} from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { officialValidationSchema } from '../../compat/host/validation-schema.ts'

/** Domain name; the official unit-name grammar allows no hyphen. */
export const AUTO_REVIEW_DOMAIN = 'opl_auto_review'
/** Table holding one record per review phase. */
export const AUTO_REVIEW_TABLE = 'reviews'

const routeSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
})

const pendingSchema = z.strictObject({
  turn: z.number().int(),
  /**
   * The native step that owns the call. Absent for an external-Harness
   * permission ask, which has no native step at all — recorded as absent rather
   * than as an invented zero.
   */
  step: z.number().int().optional(),
  /**
   * The Harness turn's stable operation identity. Written for an
   * external-Harness permission ask only, where the numeric index alone is not
   * the turn's identity.
   */
  turnId: z.string().optional(),
  callId: z.string(),
  rootCallId: z.string(),
  mode: z.enum(['native', 'ptc-inner', 'external-approval']),
  name: z.string(),
})

const beginRecordSchema = z.strictObject({
  kind: z.literal('begin'),
  seq: z.number().int(),
  record: z.string(),
  at: z.string(),
  policyVersion: z.string(),
  sessionId: z.string(),
  selectionRevision: z.string(),
  reviewer: z.strictObject({
    mode: z.enum(['current', 'fixed', 'decision']),
    /**
     * Which rule of the route policy chose this route: the user's own fixed
     * selection, the dedicated OpenAI reviewer the policy prefers for a native
     * OpenAI/Codex route, or the Session's own route. Written by these builds
     * only, so stored records from before the policy validate without it.
     */
    source: z.enum(['fixed', 'decision-model', 'native-auto-review', 'session']).optional(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().nullable(),
    timeoutMs: z.number().int(),
    maxOutputTokens: z.number().int(),
  }),
  pending: pendingSchema,
  authorization: z.strictObject({
    preset: z.string(),
    sandbox: z.string(),
    approval: z.string(),
    surfaceLength: z.number().int(),
    sessionRoute: routeSchema,
  }),
  request: z.strictObject({
    system: z.string(),
    messages: z.string(),
  }),
})

const resultRecordSchema = z.strictObject({
  kind: z.literal('result'),
  seq: z.number().int(),
  record: z.string(),
  at: z.string(),
  policyVersion: z.string(),
  sessionId: z.string(),
  pending: pendingSchema,
  /**
   * What the reviewer decided. `none` means no decision was produced at all
   * (timeout, transport failure, unparsable answer), which is materially
   * different from a reviewer that explicitly denied.
   */
  reviewer: z.enum(['allow', 'deny', 'none']),
  /**
   * What the gate actually returned to the pipeline. This is the execution
   * eligibility, not the reviewer's opinion: an `allow` the facts outran is
   * recorded as `stale`, never as an executed `allow`.
   */
  status: z.enum(['allow', 'ask', 'deny', 'stale', 'cancel']),
  /** Record this one amends, when a late change invalidated an earlier outcome. */
  supersedes: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  decision: z.enum(['allow', 'deny']).optional(),
  reason: z.string().optional(),
})

/** Every durable review record this service writes. */
export const reviewRecordSchema = z.discriminatedUnion('kind', [
  beginRecordSchema,
  resultRecordSchema,
])

/** One durable review record. */
export type ReviewRecord = z.infer<typeof reviewRecordSchema>

/** The declared domain: one record per review phase, keyed by its own identity. */
export const autoReviewDomainSpec = defineDomain({
  name: AUTO_REVIEW_DOMAIN,
  version: 1,
  layout: 'per-record',
  tables: {
    reviews: domainTable<string, ReviewRecord>(officialValidationSchema(reviewRecordSchema)),
  },
})

/**
 * The key one record is stored under.
 *
 * A real backing store accepts only `^[a-zA-Z0-9_-]+$` control keys, so the
 * identity is encoded rather than concatenated: `sessionId`, `callId` and
 * `kind` may carry separators (a PTC call id contains colons) and an ISO
 * timestamp can never be a key at all. base64url is injective and deterministic
 * — the same review phase always maps to the same key — while the complete
 * identity stays readable in the record's own `sessionId`, `pending` and `seq`
 * fields. The sequence keeps an amended outcome from overwriting the outcome it
 * supersedes.
 * @param record - the record to key.
 * @returns a control-key-safe, collision-free key.
 */
export function reviewRecordKey(record: ReviewRecord): string {
  const identity = [record.sessionId, record.pending.callId, record.kind, String(record.seq)].join(
    '\u0000',
  )
  return Buffer.from(identity, 'utf8').toString('base64url')
}

/** One durable record sink. */
export interface ReviewLedger {
  /** Commit one complete record; rejection means the record was not committed. */
  append(record: ReviewRecord): Promise<void>
}

/** Resolve the mounted domain facility, or undefined when none is composed. */
export type DomainFacilityLookup = () => DomainFacility | undefined

/** A ledger that can also release its domain handle. */
export interface ClosableReviewLedger extends ReviewLedger {
  close(): Promise<void>
}

/**
 * Build the storage-domain ledger.
 *
 * The domain is opened on first use and its handle is retained until
 * {@link ClosableReviewLedger.close}. Ownership covers the whole lifetime:
 *
 *  - an `open` still in flight when `close` begins is awaited, and the handle it
 *    yields is closed — a close never drops the ownership of a pending open;
 *  - appends already running are drained before the handle is closed;
 *  - an open failure leaves no handle behind and never re-opens after a close;
 *  - `close` is idempotent and concurrent closes share one completion;
 *  - every `append` after `close` is rejected outright.
 *
 * An open failure rejects the review that needed it rather than degrading to an
 * in-memory record.
 * @param lookup - resolves the mounted domain facility.
 * @returns the sink and its closable domain handle.
 */
export function createDomainLedger(lookup: DomainFacilityLookup): ClosableReviewLedger {
  let opening: Promise<Domain<typeof autoReviewDomainSpec>> | undefined
  let current: Domain<typeof autoReviewDomainSpec> | undefined
  let closing: Promise<void> | undefined
  let closed = false
  let failed = false
  const running = new Set<Promise<void>>()

  const open = async (): Promise<Domain<typeof autoReviewDomainSpec>> => {
    if (closed) throw new Error('auto-review: the review ledger is closed')
    // A failed open is terminal: the ledger never re-opens behind a caller's
    // back, so an unavailable backend cannot be retried into a partial record.
    if (failed) throw new Error('auto-review: the review ledger could not be opened')
    if (opening !== undefined) return await opening
    const pending = (async () => {
      const facility = lookup()
      if (facility === undefined)
        throw new Error('auto-review: no storage domain facility is mounted')
      // Ownership of this handle is only taken once it exists; a close that
      // began earlier still reaches it through `opening`.
      return await facility.open(autoReviewDomainSpec)
    })()
    opening = pending
    try {
      const domain = await pending
      current = domain
      return domain
    } catch (error) {
      opening = undefined
      current = undefined
      failed = true
      throw error
    }
  }

  return {
    async append(record: ReviewRecord): Promise<void> {
      if (closed) throw new Error('auto-review: the review ledger is closed')
      const work = (async () => {
        const domain = await open()
        await domain.table(AUTO_REVIEW_TABLE).put(reviewRecordKey(record), record)
      })()
      const tracked = work.then(
        () => undefined,
        () => undefined,
      )
      running.add(tracked)
      try {
        await work
      } finally {
        running.delete(tracked)
      }
    },
    async close(): Promise<void> {
      closing ??= (async () => {
        closed = true
        // A pending open started before this close still owns a handle that has
        // to be closed, not forgotten.
        const pending = opening
        if (pending !== undefined) {
          try {
            await pending
          } catch {
            // The open failed: it produced no handle to release.
          }
        }
        await Promise.allSettled([...running])
        const domain = current
        current = undefined
        opening = undefined
        if (domain !== undefined) await domain.close()
      })()
      return await closing
    },
  }
}
