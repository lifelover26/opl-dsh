import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { feedbackSessionFacts } from '../../src/collaboration/host/feedback/session-facts.ts'
import { isReasoningTextProtocolFailure } from '../../src/collaboration/host/feedback/state.ts'

/** Events represent the durable official session log, without running a model. */
function fold(events: unknown[]) {
  return events.reduce<ReturnType<typeof feedbackSessionFacts.init>>(
    (state, event) => feedbackSessionFacts.apply(state, event as SessionEvent),
    feedbackSessionFacts.init(),
  )
}

describe('feedback session recovery facts', () => {
  it('retains each unanswered ask at its original position and drops decided or abandoned asks', () => {
    const events = [
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'approval/asked', seq: 2, data: { id: 'a', toolName: 'Bash' } },
      { type: 'approval/asked', seq: 3, data: { id: 'b', toolName: 'Read' } },
      { type: 'approval/decided', seq: 4, data: { id: 'a', outcome: 'allowed-once' } },
    ]
    expect(fold(events)).toMatchObject({
      pendingApprovals: { b: { seq: 3, toolName: 'Read' } },
      lastApprovalSeq: 4,
    })
    expect(
      fold([
        ...events,
        {
          type: 'turn/end',
          seq: 5,
          data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
        },
      ]).pendingApprovals,
    ).toEqual({})
  })

  it('refolds a version 2 approval cache from the durable log', async () => {
    const ctx = new Context()
    try {
      const registry = new SessionProjectionRegistry(ctx)
      const handle = await registry.register(feedbackSessionFacts)
      const session = Session.create(SessionId('feedback-cache'))
      session.append('turn/start', { turn: 1 })
      const ask = session.append('approval/asked', { id: ApprovalRequestId('a'), toolName: 'Bash' })
      const current = handle.stateOf(session)
      const old = {
        taskFeedbackFacts: {
          ...registry.checkpoint(session).taskFeedbackFacts!,
          ver: 2,
          val: { ...current, pendingApprovals: { a: true } },
        },
      }
      expect(registry.restoreFloor(old)).toBe(0)
      const restored = registry.restore(
        old,
        session.snapshotEvents(),
        SessionLogOffset(0),
        session.header,
        session.inheritedEventCount,
      )
      expect(restored.checkpoint.taskFeedbackFacts).toMatchObject({
        ver: 3,
        val: { pendingApprovals: { a: { seq: Number(ask.seq), toolName: 'Bash' } } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('binds an instruction queued between turns to the consuming turn and ignores duplicate request IDs', () => {
    const instruction = {
      type: 'user/message',
      seq: 12,
      data: { source: { kind: 'user', rpcId: 'task-feedback-resume:original:1' } },
    }
    const state = fold([
      instruction,
      { type: 'turn/start', seq: 13, data: { turn: 3 } },
      { ...instruction, seq: 14 },
      { type: 'turn/end', seq: 15, data: { turn: 3, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 16, data: { turn: 4 } },
    ])
    expect(state.instructions['task-feedback-resume:original:1']).toEqual({ seq: 12, turn: 3 })
    expect(state.pendingInstructions).toEqual([])
    expect(state.openTurn).toBe(4)
  })

  it('uses only the final assistant message for visible tool-syntax diagnostics', () => {
    const message = (seq: number, text: string) => ({
      type: 'assistant/message',
      seq,
      data: { turn: 2, message: { content: [{ type: 'text', text }] } },
    })
    const unexecuted = message(
      3,
      '<invoke name="search"><parameter name="q">example</parameter></invoke>',
    )
    expect(fold([unexecuted]).finalToolSyntax['2']).toEqual(['invoke-tag', 'parameter-tag'])
    expect(
      fold([unexecuted, message(8, 'Results verified from the tool output.')]).finalToolSyntax['2'],
    ).toEqual([])
  })

  it('admits only the exact provider protocol failure for automatic continuation', () => {
    const error = {
      code: 'INVALID_REQUEST',
      status: 400,
      message: 'reasoning_text must be passed back',
    }
    expect(isReasoningTextProtocolFailure({ kind: 'error', error } as never)).toBe(true)
    for (const changed of [
      { ...error, status: 503 },
      { ...error, code: 'UPSTREAM_ERROR' },
      { ...error, message: 'reasoning_text is mentioned here' },
    ])
      expect(isReasoningTextProtocolFailure({ kind: 'error', error: changed } as never)).toBe(false)
  })
})
