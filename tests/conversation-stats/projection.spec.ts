import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry, {
  type ProjectionCheckpoint,
} from '@deepseek-ai/dsh-session-projection'
import * as plugin from '../../src/conversation-stats/host/index.ts'
import { conversationCountsProjection as projection } from '../../src/conversation-stats/host/projection.ts'
import { MESSAGE_EDIT_SOURCE } from '../../src/execution/contracts/message-edit.ts'

function history(publish: (session: Session, event: SessionEvent) => void = () => {}) {
  const session = Session.create(SessionId('conversation-counts'))
  function append<T extends Parameters<Session['append']>[0]>(
    type: T,
    data: Parameters<Session['append']>[1],
    ...options: unknown[]
  ) {
    // The fixture's typed helpers below supply each event's matching payload and surface intent.
    const event = (session.append as (...args: unknown[]) => SessionEvent)(type, data, ...options)
    publish(session, event)
    return event
  }
  function begin(turn: number, step = 1) {
    if (step === 1) append('turn/start', { turn })
    append('step/start', { turn, step })
    return { turn, step }
  }
  function user(text: string, rpcId?: string) {
    return append(
      'user/message',
      createUserMessage({
        source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }) },
        content: [{ type: 'text', text }],
      }),
      { surfaceOp: 'append' },
    )
  }
  function assistant(turn: number, step = 1, text = 'answer') {
    return append(
      'assistant/message',
      {
        turn,
        step,
        message: createAssistantMessage({
          source: { provider: 'test', model: 'fixture' },
          content: [{ type: 'text', text }],
        }),
        stream: [],
      },
      { surfaceOp: 'append' },
    )
  }
  function close(turn: number, step = 1) {
    append('step/end', { turn, step })
  }
  function end(turn: number) {
    append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  function marker(turn: number, start: number, end: number, requestId: string) {
    const replaced = session.surface.nodes.filter((seq) => Number(seq) >= start)
    const message = createSystemMessage('')
    return append(
      'system/message',
      {
        turn,
        step: 1,
        message: {
          ...message,
          source: {
            ...message.source,
            [MESSAGE_EDIT_SOURCE]: { version: 1, start, end, requestId, digest: 'a'.repeat(64) },
          },
        },
      },
      {
        surfaceOp: { op: 'replace', startSeq: replaced[0]!, endSeq: replaced.at(-1)! },
        sourceEventSeqs: replaced,
      },
    )
  }
  const events = () => session.snapshotEvents()
  const state = () =>
    events().reduce((value, event) => projection.apply(value, event), projection.init())
  const counts = () => projection.wire.view(state())
  append(
    'system/message',
    { turn: 0, step: 0, message: createSystemMessage('instructions') },
    { surfaceOp: 'append' },
  )
  return { session, append, begin, user, assistant, close, end, marker, events, state, counts }
}

describe('current conversation counts', () => {
  it('counts closed steps, including failure without an assistant, and excludes open or rejected turns', () => {
    const h = history()
    expect(h.counts()).toEqual({ turns: 0, steps: 0 })
    h.begin(1)
    h.user('request')
    h.assistant(1)
    h.assistant(1, 1, 'external tool presentation')
    expect(h.counts()).toEqual({ turns: 0, steps: 0 })
    h.close(1)
    h.begin(1, 2)
    h.close(1, 2)
    h.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'TEST', message: 'failed' } },
    })
    h.append('turn/start', { turn: 2 })
    h.end(2)
    h.begin(3)
    expect(h.counts()).toEqual({ turns: 1, steps: 2 })
    h.close(3)
    h.append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'legacy' } } })
    expect(h.counts()).toEqual({ turns: 2, steps: 3 })
  })

  it.each(['native-request', 'opl-external-exact-operation-id'])(
    'removes the replaced tail only after durable admission of %s',
    (requestId) => {
      const h = history()
      h.begin(1)
      h.user('retained')
      h.close(1)
      h.begin(1, 2)
      h.close(1, 2)
      h.end(1)
      h.begin(2)
      const target = h.user('replaced')
      h.close(2)
      h.begin(2, 2)
      h.close(2, 2)
      h.end(2)
      h.begin(3)
      h.user('later')
      h.close(3)
      h.end(3)
      const head = Number(h.session.seq) - 1
      h.begin(4)
      h.marker(4, Number(target.seq), head, requestId)
      expect(h.counts()).toEqual({ turns: 3, steps: 5 })
      h.user('replacement', requestId)
      expect(h.counts()).toEqual({ turns: 1, steps: 2 })
      h.close(4)
      expect(h.counts()).toEqual({ turns: 2, steps: 3 })
    },
  )

  it('resets the retained count after editing the first message, before the new step closes', () => {
    const h = history()
    h.begin(1)
    const first = h.user('first')
    h.close(1)
    h.end(1)
    const head = Number(h.session.seq) - 1
    h.begin(2)
    h.marker(2, Number(first.seq), head, 'replace-first')
    expect(h.counts()).toEqual({ turns: 1, steps: 1 })
    h.user('new first', 'replace-first')
    expect(h.counts()).toEqual({ turns: 0, steps: 0 })
    h.close(2)
    expect(h.counts()).toEqual({ turns: 1, steps: 1 })
  })

  it('retains earlier closed steps in a turn when editing a later steering message', () => {
    const h = history()
    h.begin(1)
    h.user('initial')
    h.assistant(1)
    h.close(1)
    h.begin(1, 2)
    const target = h.user('steering')
    h.close(1, 2)
    h.end(1)
    const head = Number(h.session.seq) - 1
    h.begin(2)
    h.marker(2, Number(target.seq), head, 'replace-steering')
    h.user('replacement', 'replace-steering')
    expect(h.counts()).toEqual({ turns: 1, steps: 1 })
    h.close(2)
    expect(h.counts()).toEqual({ turns: 2, steps: 2 })
  })

  it('does not restore previously removed steps when edits overlap or replace an edited message', () => {
    const h = history()
    h.begin(1)
    const first = h.user('first')
    h.close(1)
    h.end(1)
    h.begin(2)
    const second = h.user('second')
    h.close(2)
    h.end(2)
    let head = Number(h.session.seq) - 1
    h.begin(3)
    h.marker(3, Number(second.seq), head, 'edit-second')
    const replacement = h.user('second edited', 'edit-second')
    h.close(3)
    h.end(3)
    head = Number(h.session.seq) - 1
    h.begin(4)
    h.marker(4, Number(replacement.seq), head, 'edit-replacement')
    h.user('second edited again', 'edit-replacement')
    h.close(4)
    h.end(4)
    expect(h.counts()).toEqual({ turns: 2, steps: 2 })
    head = Number(h.session.seq) - 1
    h.begin(5)
    h.marker(5, Number(first.seq), head, 'edit-earlier')
    h.user('new history', 'edit-earlier')
    expect(h.counts()).toEqual({ turns: 0, steps: 0 })
    h.close(5)
    expect(h.counts()).toEqual({ turns: 1, steps: 1 })
  })

  it('keeps history for an unadmitted edit and counts its failed step without an assistant', () => {
    const h = history()
    h.begin(1)
    const target = h.user('same text')
    h.close(1)
    h.end(1)
    const head = Number(h.session.seq) - 1
    h.begin(2)
    h.marker(2, Number(target.seq), head, 'pending-edit')
    h.user('same text', 'different-request')
    h.close(2)
    h.append('turn/end', {
      turn: 2,
      reason: { kind: 'error', error: { code: 'PREPARE', message: 'failed' } },
    })
    expect(h.counts()).toEqual({ turns: 2, steps: 2 })
    h.begin(3)
    h.user('replacement', 'pending-edit')
    expect(h.counts()).toEqual({ turns: 1, steps: 1 })
    h.close(3)
    expect(h.counts()).toEqual({ turns: 2, steps: 2 })
  })

  it('ignores ordinary compaction and invalid edit metadata', () => {
    const h = history()
    h.begin(1)
    const target = h.user('request')
    h.assistant(1)
    h.close(1)
    h.end(1)
    const replaced = h.session.surface.nodes.filter((seq) => Number(seq) >= target.seq)
    h.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage('summary') },
      {
        surfaceOp: { op: 'replace', startSeq: replaced[0]!, endSeq: replaced.at(-1)! },
        sourceEventSeqs: replaced,
      },
    )
    const system = createSystemMessage('oplMessageEdit request text is not metadata')
    h.append(
      'system/message',
      {
        turn: 1,
        step: 1,
        message: {
          ...system,
          source: {
            ...system.source,
            [MESSAGE_EDIT_SOURCE]: {
              version: 1,
              start: target.seq,
              end: h.session.seq,
              requestId: 'invalid',
              digest: 'bad',
            },
          },
        },
      },
      { surfaceOp: 'append' },
    )
    h.user('request', 'invalid')
    expect(h.counts()).toEqual({ turns: 1, steps: 1 })
  })

  it('rejects inconsistent persisted counts and invalid ordering or pending identities', () => {
    const h = history()
    h.begin(1)
    h.user('request')
    h.close(1)
    const state = h.state()
    expect(projection.stateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true)
    for (const invalid of [
      { ...state, counts: { turns: 0, steps: 0 } },
      {
        ...state,
        closedSteps: [...state.closedSteps, ...state.closedSteps],
        counts: { turns: 1, steps: 2 },
      },
      { ...state, pendingEdits: [{ start: 9, end: 1, requestId: 'invalid' }] },
      {
        ...state,
        pendingEdits: [
          { start: 1, end: 9, requestId: 'same' },
          { start: 1, end: 9, requestId: 'same' },
        ],
      },
    ])
      expect(projection.stateSchema.safeParse(invalid).success).toBe(false)
  })
})

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function registry() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const projections = new SessionProjectionRegistry(ctx)
  const fork = await ctx.plugin(plugin)
  return { ctx, projections, fork }
}

describe('official projection lifecycle', () => {
  it('publishes count changes only and refolds the log after plugin disposal and reload', async () => {
    const r = await registry()
    const changes: unknown[] = []
    r.projections.onChanged((_session, key, value) => {
      if (key === 'oplConversationCounts') changes.push(value)
    })
    const h = history((session, event) => r.ctx.emit('session/event', session, event))
    expect(r.projections.snapshot(h.session).values.oplConversationCounts).toEqual({
      turns: 0,
      steps: 0,
    })
    h.begin(1)
    const target = h.user('first')
    h.close(1)
    h.end(1)
    const head = Number(h.session.seq) - 1
    h.begin(2)
    h.marker(2, Number(target.seq), head, 'accepted-edit')
    expect(changes).toEqual([{ turns: 1, steps: 1 }])
    h.user('replacement', 'accepted-edit')
    h.close(2)
    expect(changes).toEqual([
      { turns: 1, steps: 1 },
      { turns: 0, steps: 0 },
      { turns: 1, steps: 1 },
    ])
    await r.fork.dispose()
    expect(r.projections.snapshot(h.session).values).not.toHaveProperty('oplConversationCounts')
    h.begin(2, 2)
    h.close(2, 2)
    expect(changes).toHaveLength(3)
    await r.ctx.plugin(plugin)
    expect(r.projections.snapshot(h.session).values.oplConversationCounts).toEqual({
      turns: 1,
      steps: 2,
    })
  })

  it('restores a pending edit across a JSON checkpoint and folds only the durable tail', async () => {
    const { projections } = await registry()
    const h = history()
    h.begin(1)
    const target = h.user('original')
    h.close(1)
    h.end(1)
    const head = Number(h.session.seq) - 1
    h.begin(2)
    h.marker(2, Number(target.seq), head, 'checkpoint-edit')
    const checkpoint = JSON.parse(
      JSON.stringify(projections.checkpoint(h.session)),
    ) as ProjectionCheckpoint
    expect(projections.viewCheckpoint(checkpoint).oplConversationCounts).toEqual({
      turns: 1,
      steps: 1,
    })
    h.user('replacement', 'checkpoint-edit')
    h.close(2)
    h.end(2)
    const floor = projections.restoreFloor(checkpoint)!
    const restored = projections.restore(
      checkpoint,
      h.events().filter((event) => Number(event.seq) >= floor),
      floor,
      h.session.header,
      h.session.inheritedEventCount,
    )
    expect(restored.snapshot.values.oplConversationCounts).toEqual({ turns: 1, steps: 1 })
    expect(restored.snapshot.values.oplConversationCounts).toEqual(h.counts())
    expect(projections.viewCheckpoint(restored.checkpoint).oplConversationCounts).toEqual(
      h.counts(),
    )
    expect(projections.snapshot(h.session).values.oplConversationCounts).toEqual(h.counts())
  })

  it('requires full-log replay for absent or old-version state and rejects a corrupt cached count', async () => {
    const { projections } = await registry()
    const h = history()
    h.begin(1)
    h.user('retained')
    h.close(1)
    h.end(1)
    const checkpoint = projections.checkpoint(h.session)
    const row = checkpoint.oplConversationCounts!
    const old = { oplConversationCounts: { ...row, ver: row.ver - 1 } }
    expect(projections.viewCheckpoint(old)).not.toHaveProperty('oplConversationCounts')
    for (const seed of [{}, old]) {
      expect(projections.restoreFloor(seed)).toBe(0)
      const restored = projections.restore(
        seed,
        h.events(),
        SessionLogOffset(0),
        h.session.header,
        SessionLogOffset(h.events().length),
      )
      expect(restored.snapshot.values.oplConversationCounts).toEqual({ turns: 1, steps: 1 })
    }
    const corrupt = {
      oplConversationCounts: { ...row, val: { ...h.state(), counts: { turns: 99, steps: 99 } } },
    }
    expect(projections.viewCheckpoint(corrupt)).not.toHaveProperty('oplConversationCounts')
    expect(() =>
      projections.restore(
        corrupt,
        h.events(),
        SessionLogOffset(0),
        h.session.header,
        h.session.inheritedEventCount,
      ),
    ).toThrow('Counts differ')
  })
})
