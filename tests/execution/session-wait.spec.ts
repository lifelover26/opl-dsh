import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionController,
  SessionEventFrame,
  SessionPageRequest,
  SessionState,
  SessionWaitValue as OfficialWaitValue,
} from '@deepseek-ai/dsh-api-session-controller'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { readSessionTurnEnd, waitForSession } from '../../src/execution/host/session-wait.ts'
import { sessionHistoryFixture } from '../fixtures/session-controller.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('official-wait'))
  let running = false
  let pendingInput: SessionState['pendingInput'] = []
  const state = vi.fn(async (): Promise<SessionState> => ({
    cursor: Number(session.seq) - 1,
    active: true,
    running,
    queue: [],
    pendingInput,
  }))
  const wait = vi.fn(async (): Promise<OfficialWaitValue> => ({
    reason: pendingInput.length > 0 ? 'input-required' : 'idle',
    state: await state(),
    output: { records: [], truncated: false },
  }))
  const events = vi.fn(sessionHistoryFixture(ctx).events)
  const observeEvent = vi.fn(async function* (
    _request: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<SessionEventFrame> {
    const queue: SessionEvent[] = []
    let changed = Promise.withResolvers<void>()
    const notify = () => changed.resolve()
    const off = ctx.on('session/event', (source, event) => {
      if (source !== session) return
      queue.push(event)
      notify()
    })
    signal.addEventListener('abort', notify, { once: true })
    try {
      yield { type: 'ready' }
      while (!signal.aborted) {
        const event = queue.shift()
        if (event !== undefined) {
          yield {
            type: 'event',
            event: event as unknown as Extract<SessionEventFrame, { type: 'event' }>['event'],
          }
          continue
        }
        await changed.promise
        changed = Promise.withResolvers<void>()
      }
    } finally {
      off()
      signal.removeEventListener('abort', notify)
    }
  })
  ctx.provide('sessionController', {
    state,
    wait,
    events,
    observeEvent,
  } as unknown as SessionController)
  const waitFor = (turn?: number, signal = new AbortController().signal) =>
    waitForSession(ctx, { sessionId: session.id, ...(turn === undefined ? {} : { turn }) }, signal)
  return {
    ctx,
    session,
    state,
    wait,
    events,
    observeEvent,
    waitFor,
    setRunning(value: boolean) {
      running = value
    },
    setPending(value: SessionState['pendingInput']) {
      pendingInput = value
    },
  }
}

/** A working official wait remains pending until its caller releases it. */
function pendingWait(_request: unknown, signal: AbortSignal): Promise<OfficialWaitValue> {
  return new Promise((_resolve, reject) => {
    signal.throwIfAborted()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

describe('official Session Controller wait compatibility', () => {
  it('returns the exact historical failed turn after a later successful turn, including cold history', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    f.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'PROVIDER', message: 'failed request' } },
    })
    f.session.append('turn/start', { turn: 2 })
    f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const read = f.events.getMockImplementation()!
    // The official owner can read an unattached Session; OPL does not require a live Agent.
    vi.spyOn(f.ctx.sessions, 'get').mockReturnValue(undefined)
    f.events.mockImplementation((request, signal) => {
      const get = vi.mocked(f.ctx.sessions.get)
      get.mockReturnValueOnce(f.session)
      return read(request, signal)
    })
    await expect(f.waitFor(1)).resolves.toEqual({
      turn: 1,
      outcome: { kind: 'failed', code: 'PROVIDER', message: 'failed request' },
    })
    expect(f.wait).not.toHaveBeenCalled()
    expect(f.events).toHaveBeenCalledWith(
      expect.objectContaining({ throughSeq: Number(f.session.seq) - 1 }),
      expect.any(AbortSignal),
    )
  })

  it('settles from a matching official event while the driver and its later work remain active', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    f.setRunning(true)
    f.wait.mockImplementation(pendingWait as typeof f.wait)
    const waiting = f.waitFor(1)
    await vi.waitFor(() => expect(f.wait).toHaveBeenCalledOnce())
    const officialSignal = (f.wait.mock.calls[0] as unknown as [unknown, AbortSignal])[1]
    f.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    f.session.append('turn/start', { turn: 2 })
    await expect(waiting).resolves.toEqual({
      turn: 1,
      outcome: { kind: 'cancelled', cause: 'user' },
    })
    expect(officialSignal.aborted).toBe(true)
  })

  it('does not lose a terminal event committed during its initial state read', async () => {
    const f = await fixture()
    const read = f.state.getMockImplementation()!
    f.state.mockImplementationOnce(async () => {
      f.session.append('turn/start', { turn: 1 })
      f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return read()
    })
    await expect(f.waitFor()).resolves.toEqual({ turn: 1, outcome: { kind: 'completed' } })
  })

  it('retains the pending approval identity, while questions do not invent one', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    f.session.append('approval/asked', { id: ApprovalRequestId('old'), toolName: 'Read' })
    f.session.append('approval/asked', { id: ApprovalRequestId('pending'), toolName: 'Bash' })
    f.session.append('approval/decided', { id: ApprovalRequestId('old'), outcome: 'allowed-once' })
    f.setPending(['approval'])
    await expect(f.waitFor()).resolves.toEqual({
      turn: 1,
      outcome: {
        kind: 'needs-input',
        request: { sessionId: f.session.id, approvalId: 'pending', toolName: 'Bash' },
      },
    })
    f.setPending(['question'])
    await expect(f.waitFor()).resolves.toEqual({
      turn: 1,
      outcome: { kind: 'needs-input', request: { sessionId: f.session.id } },
    })
  })

  it('does not report an older completed turn when the current turn has no end', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    f.session.append('turn/start', { turn: 2 })
    await expect(f.waitFor()).resolves.toEqual({
      turn: 2,
      outcome: { kind: 'failed', message: 'turn 2 settled without a recorded end' },
    })
    await expect(f.waitFor(3)).resolves.toEqual({
      turn: 3,
      outcome: { kind: 'failed', message: 'turn 3 was never opened before the Session settled' },
    })
  })

  it('continues official bounded timeouts and maps only a recorded end as completion', async () => {
    const f = await fixture()
    f.wait.mockImplementationOnce(async () => ({
      reason: 'timeout',
      state: await f.state(),
      output: { records: [], truncated: false },
    }))
    await expect(f.waitFor()).resolves.toEqual({ turn: 0, outcome: { kind: 'completed' } })
    expect(f.wait).toHaveBeenCalledTimes(2)
  })

  it('cancels the official wait and event observation without cancelling execution', async () => {
    const f = await fixture()
    const before = f.ctx.events._hooks['session/event']?.length ?? 0
    f.wait.mockImplementation(pendingWait as typeof f.wait)
    const cancellation = new AbortController()
    const waiting = f.waitFor(undefined, cancellation.signal)
    const rejected = expect(waiting).rejects.toThrow('the wait was cancelled')
    await vi.waitFor(() => expect(f.wait).toHaveBeenCalledOnce())
    cancellation.abort()
    await rejected
    expect(f.ctx.events._hooks['session/event']?.length ?? 0).toBe(before)
    expect(f.session.seq).toBe(0)
  })

  it('keeps one fixed cut and exclusive page boundary when reading older official history', async () => {
    const f = await fixture()
    f.events.mockImplementation(async (request: SessionPageRequest) => {
      if (request.beforeSeq === undefined)
        return {
          cursor: 5,
          hasMore: true,
          records: [
            { type: 'event', event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 3 } } },
          ],
        }
      return {
        cursor: 5,
        hasMore: false,
        records: [
          {
            type: 'event',
            event: {
              type: 'turn/end',
              seq: 3,
              time: 1,
              data: { turn: 2, reason: { kind: 'completed' } },
            },
          },
        ],
      }
    })
    await expect(
      readSessionTurnEnd(f.ctx, f.session.id, new AbortController().signal, 2),
    ).resolves.toMatchObject({ data: { turn: 2 } })
    expect(f.events.mock.calls[1]?.[0]).toMatchObject({ beforeSeq: 4, throughSeq: 5 })
  })
})
