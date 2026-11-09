/** Durable session facts used by feedback recovery. No task writes or notifications. */
import { z as stateSchema } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { officialValidationSchema } from '../../../compat/host/validation-schema.ts'

/**
 * Build the pattern for one tool-invocation tag name, in either spelling an
 * endpoint emits: the bare tag and the DSML wrapper around it.
 * @param names - alternation of wire tag names this family covers.
 * @returns the pattern matching either spelling.
 */
function toolTag(names: string): RegExp {
  return new RegExp(`<\\s*\\/?\\s*(?:[｜|]\\s*DSML\\s*[｜|]\\s*)?(?:${names})\\b`, 'i')
}

/**
 * Tool-invocation markup a model can leave in visible text when its structured
 * call never formed.
 *
 * Only tool-invocation syntax counts. A `thinking` delimiter in visible text is
 * a symptom the wire diagnostic reports, but it does not falsify a completion
 * the way an invocation nothing executed does, and an ordinary answer quoting
 * prose is not a candidate at all. The turn's own last assistant message is the
 * only text read, so markup mentioned in an earlier step of a turn that went on
 * to call tools normally cannot mark that turn's outcome.
 */
const LEAKED_TOOL_SYNTAX_FAMILIES: readonly {
  readonly family: string
  readonly pattern: RegExp
}[] = [
  { family: 'dsml', pattern: /[｜|]\s*DSML\s*[｜|]/i },
  { family: 'invoke-tag', pattern: toolTag('invoke') },
  { family: 'parameter-tag', pattern: toolTag('parameter') },
  { family: 'tool-calls-tag', pattern: toolTag('tool_calls?|function_calls?|calls') },
]

/**
 * Tool-invocation families present in one assistant message's visible text.
 * @param content - the message content blocks as recorded.
 * @returns the stable family names found, in declaration order and without duplicates.
 */
function leakedToolSyntaxFamilies(
  content: SessionEvent<'assistant/message'>['data']['message']['content'],
): string[] {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return LEAKED_TOOL_SYNTAX_FAMILIES.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.family,
  )
}

/** Original log position and tool of one unanswered approval. */
export interface FeedbackApproval {
  readonly seq: number
  readonly toolName: string
}

/** Recorded request identities, pending approvals, and final visible diagnostics. */
export interface FeedbackSessionFacts {
  readonly openTurn: number | null
  readonly pendingInstructions: readonly string[]
  readonly instructions: Readonly<
    Record<string, { readonly seq: number; readonly turn: number | null }>
  >
  readonly finalToolSyntax: Readonly<Record<string, readonly string[]>>
  readonly pendingApprovals: Readonly<Record<string, FeedbackApproval>>
  readonly lastApprovalSeq: number
}

export const feedbackSessionFacts: ProjectionDefinition<'taskFeedbackFacts', FeedbackSessionFacts> =
  {
    key: 'taskFeedbackFacts',
    stateVersion: 3,
    stateSchema: officialValidationSchema(
      stateSchema.object({
        openTurn: stateSchema.number().int().nonnegative().nullable(),
        pendingInstructions: stateSchema.array(stateSchema.string()),
        instructions: stateSchema.record(
          stateSchema.string(),
          stateSchema.object({
            seq: stateSchema.number().int().nonnegative(),
            turn: stateSchema.number().int().nonnegative().nullable(),
          }),
        ),
        finalToolSyntax: stateSchema.record(
          stateSchema.string(),
          stateSchema.array(stateSchema.string()),
        ),
        pendingApprovals: stateSchema.record(
          stateSchema.string(),
          stateSchema.object({
            seq: stateSchema.number().int().nonnegative(),
            toolName: stateSchema.string(),
          }),
        ),
        lastApprovalSeq: stateSchema.number().int().nonnegative(),
      }),
    ),
    init: (): FeedbackSessionFacts => ({
      openTurn: null,
      pendingInstructions: [],
      instructions: {},
      finalToolSyntax: {},
      pendingApprovals: {},
      lastApprovalSeq: 0,
    }),
    apply: (state: FeedbackSessionFacts, event: SessionEvent): FeedbackSessionFacts => {
      switch (event.type) {
        case 'turn/start': {
          const instructions = { ...state.instructions }
          for (const requestId of state.pendingInstructions) {
            const instruction = instructions[requestId]
            if (instruction !== undefined)
              instructions[requestId] = { ...instruction, turn: event.data.turn }
          }
          return { ...state, openTurn: event.data.turn, instructions, pendingInstructions: [] }
        }
        case 'turn/end':
          return { ...state, openTurn: null, pendingApprovals: {} }
        case 'approval/asked':
          return {
            ...state,
            pendingApprovals: {
              ...state.pendingApprovals,
              [event.data.id]: { seq: Number(event.seq), toolName: event.data.toolName },
            },
            lastApprovalSeq: Number(event.seq),
          }
        case 'approval/decided': {
          const pendingApprovals = { ...state.pendingApprovals }
          delete pendingApprovals[event.data.id]
          return { ...state, pendingApprovals, lastApprovalSeq: Number(event.seq) }
        }
        case 'user/message': {
          const source = event.data.source
          if (
            source.kind !== 'user' ||
            !('rpcId' in source) ||
            !source.rpcId.startsWith('task-feedback-resume:')
          )
            return state
          if (Object.hasOwn(state.instructions, source.rpcId)) return state
          return {
            ...state,
            instructions: {
              ...state.instructions,
              [source.rpcId]: { seq: Number(event.seq), turn: state.openTurn },
            },
            pendingInstructions:
              state.openTurn === null
                ? [...state.pendingInstructions, source.rpcId]
                : state.pendingInstructions,
          }
        }
        case 'assistant/message':
          return {
            ...state,
            finalToolSyntax: {
              ...state.finalToolSyntax,
              [String(event.data.turn)]: leakedToolSyntaxFamilies(event.data.message.content),
            },
          }
        default:
          return state
      }
    },
  }
