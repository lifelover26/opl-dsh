/** Count closed steps over the durable log while excluding admitted message-edit ranges. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ConversationCounts } from '../contracts/index.ts'
import { messageEditMarker } from '../../execution/contracts/message-edit.ts'
import { officialValidationSchema } from '../../compat/host/validation-schema.ts'

interface ClosedStep {
  readonly seq: number
  readonly turn: number
}

interface PendingEdit {
  readonly start: number
  readonly end: number
  readonly requestId: string
}

interface ConversationCountsState {
  readonly counts: ConversationCounts
  readonly closedSteps: readonly ClosedStep[]
  /** The official request hook logs the marker before the replacement user message. */
  readonly pendingEdits: readonly PendingEdit[]
}

const countsSchema: z.ZodType<ConversationCounts> = z.strictObject({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
})

const stateSchema: z.ZodType<ConversationCountsState> = z
  .strictObject({
    counts: countsSchema,
    closedSteps: z.array(
      z.strictObject({
        seq: z.number().int().nonnegative(),
        turn: z.number().int().nonnegative(),
      }),
    ),
    pendingEdits: z.array(
      z
        .strictObject({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          requestId: z.string().min(1),
        })
        .refine((edit) => edit.end >= edit.start, 'Edit range ends before it starts'),
    ),
  })
  .superRefine((state, context) => {
    const turns = new Set(state.closedSteps.map((step) => step.turn)).size
    if (state.counts.steps !== state.closedSteps.length || state.counts.turns !== turns)
      context.addIssue({ code: 'custom', message: 'Counts differ from retained closed steps' })
    if (
      state.closedSteps.some(
        (step, index) =>
          index > 0 &&
          (step.seq <= state.closedSteps[index - 1]!.seq ||
            step.turn < state.closedSteps[index - 1]!.turn),
      )
    )
      context.addIssue({ code: 'custom', message: 'Closed steps are out of order' })
    if (
      new Set(state.pendingEdits.map((edit) => edit.requestId)).size !== state.pendingEdits.length
    )
      context.addIssue({ code: 'custom', message: 'Pending edit request identities repeat' })
  })

/**
 * Whole-log current-history counts, with the official closed-step counting semantics.
 *
 * Only an identified replacement `user/message` activates its preceding edit marker.
 * Compaction and transcript paging never remove counted steps.
 */
export const conversationCountsProjection = {
  key: 'oplConversationCounts',
  stateVersion: 1,
  stateSchema: officialValidationSchema(stateSchema),
  init: (): ConversationCountsState => ({
    counts: { turns: 0, steps: 0 },
    closedSteps: [],
    pendingEdits: [],
  }),
  apply(state, event) {
    switch (event.type) {
      case 'step/end':
        return {
          ...state,
          counts: {
            turns:
              state.counts.turns + (state.closedSteps.at(-1)?.turn === event.data.turn ? 0 : 1),
            steps: state.counts.steps + 1,
          },
          closedSteps: [...state.closedSteps, { seq: Number(event.seq), turn: event.data.turn }],
        }
      case 'system/message': {
        const marker = messageEditMarker(event.data.message.source)
        if (marker === undefined) return state
        return {
          ...state,
          pendingEdits: [
            ...state.pendingEdits.filter((edit) => edit.requestId !== marker.requestId),
            { start: marker.start, end: marker.end, requestId: marker.requestId },
          ],
        }
      }
      case 'user/message': {
        const source = event.data.source
        if (!('rpcId' in source)) return state
        const edit = state.pendingEdits.find((candidate) => candidate.requestId === source.rpcId)
        if (edit === undefined) return state
        const closedSteps = state.closedSteps.filter(
          (step) => step.seq < edit.start || step.seq > edit.end,
        )
        return {
          counts:
            closedSteps.length === state.closedSteps.length
              ? state.counts
              : {
                  turns: new Set(closedSteps.map((step) => step.turn)).size,
                  steps: closedSteps.length,
                },
          closedSteps,
          pendingEdits: state.pendingEdits.filter((candidate) => candidate !== edit),
        }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: officialValidationSchema(countsSchema),
    view: (state) => state.counts,
  },
} satisfies ProjectionDefinition<'oplConversationCounts', ConversationCountsState>
