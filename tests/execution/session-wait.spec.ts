import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import {
  installSessionWaitProjection,
  sessionWaitProjectionDefinition,
  waitForSession,
} from '../../src/execution/host/session-wait.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

async function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  vi.spyOn(ctx.sessionProjections, 'stateOf').mockImplementation(() => {
    throw Error('A domain reader must use its ready projection handle')
  })
  const session = ctx.sessions.create(SessionId('wait-session'))
  const mount = () =>
    ctx.plugin({ inject: ['sessionProjections'], apply: installSessionWaitProjection })
  const wait = (signal = new AbortController().signal, turn?: number) =>
    waitForSession(ctx, { sessionId: session.id, ...(turn === undefined ? {} : { turn }) }, signal)
  return { ctx, session, mount, wait }
}

describe('ready session wait projections', () => {
  it('publishes its reader after registration and includes events committed during startup', async () => {
    const f = await fixture()
    const registering = vi.spyOn(f.ctx.sessionProjections, 'register')
    const mounting = f.mount()
    await Promise.resolve()
    expect(registering).toHaveBeenCalledWith(sessionWaitProjectionDefinition)
    expect(f.ctx.get('oplSessionWait')).toBeUndefined()
    f.session.append('turn/start', { turn: 1 })
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await mounting
    expect(f.ctx.oplSessionWait.stateOf(f.session).lastEndTurn).toBe(1)
    await expect(f.wait()).resolves.toEqual({ turn: 1, outcome: { kind: 'completed' } })
  })

  it('propagates registration failure without publishing a reader', async () => {
    const f = await fixture()
    await f.ctx.sessionProjections.register({ ...sessionWaitProjectionDefinition, stateVersion: 3 })
    await expect(f.mount()).rejects.toThrow('already registered at stateVersion 3')
    expect(f.ctx.get('oplSessionWait')).toBeUndefined()
  })

  it('releases a registration when its owner unloads before the handoff is ready', async () => {
    const f = await fixture()
    const mounting = f.mount()
    await Promise.resolve()
    await mounting.dispose()
    await mounting
    expect(f.ctx.get('oplSessionWait')).toBeUndefined()
    expect(f.ctx.sessionProjections.checkpoint(f.session)).not.toHaveProperty('sessionWait')
  })

  it('names a missing reader before subscribing and removes it when its owner unloads', async () => {
    const f = await fixture()
    const subscriptions = vi.spyOn(f.ctx, 'on')
    await expect(f.wait()).rejects.toThrow('"sessionWait" projection is not mounted')
    expect(subscriptions).not.toHaveBeenCalled()
    const mounted = await f.mount()
    await mounted.dispose()
    expect(f.ctx.get('oplSessionWait')).toBeUndefined()
    await expect(f.wait()).rejects.toThrow('"sessionWait" projection is not mounted')
  })

  it('releases event, idle, and caller-abort listeners when a live wait is cancelled', async () => {
    const f = await fixture()
    await f.mount()
    f.session.append('turn/start', { turn: 1 })
    const listenerCount = (event: string) => f.ctx.events._hooks[event]?.length ?? 0
    const before = [listenerCount('session/event'), listenerCount('agent/status')]
    const cancellation = new AbortController()
    const removeAbort = vi.spyOn(cancellation.signal, 'removeEventListener')
    const waiting = f.wait(cancellation.signal)
    expect(listenerCount('session/event')).toBe(before[0]! + 1)
    expect(listenerCount('agent/status')).toBe(before[1]! + 1)
    const rejected = expect(waiting).rejects.toThrow('the wait was cancelled')
    cancellation.abort()
    await rejected
    expect([listenerCount('session/event'), listenerCount('agent/status')]).toEqual(before)
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(f.wait()).resolves.toEqual({ turn: 1, outcome: { kind: 'completed' } })
  })

  it('reads pending approvals and clears an abandoned approval when its turn is cancelled', async () => {
    const f = await fixture()
    await f.mount()
    f.ctx.provide('approval', {})
    f.session.append('turn/start', { turn: 1 })
    f.session.append('approval/asked', { id: ApprovalRequestId('ask-1'), toolName: 'Bash' })
    await expect(f.wait()).resolves.toEqual({
      turn: 1,
      outcome: {
        kind: 'needs-input',
        request: { sessionId: f.session.id, approvalId: 'ask-1', toolName: 'Bash' },
      },
    })
    f.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    await expect(f.wait()).resolves.toEqual({
      turn: 1,
      outcome: { kind: 'cancelled', cause: 'user' },
    })
    f.session.append('turn/start', { turn: 2 })
    const waiting = f.wait()
    f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect(waiting).resolves.toEqual({ turn: 2, outcome: { kind: 'completed' } })
  })

  it('restores an exact failed turn after a later turn completes', async () => {
    const f = await fixture()
    f.session.append('turn/start', { turn: 1 })
    f.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'PROVIDER', message: 'failed request' } },
    })
    f.session.append('turn/start', { turn: 2 })
    f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await f.mount()
    await expect(f.wait(undefined, 1)).resolves.toEqual({
      turn: 1,
      outcome: { kind: 'failed', code: 'PROVIDER', message: 'failed request' },
    })
    await expect(f.wait()).resolves.toEqual({ turn: 2, outcome: { kind: 'completed' } })
  })

  it('waits for an active driver between turns and settles when that driver reaches idle', async () => {
    const f = await fixture()
    await f.mount()
    let status: Agent['status'] = 'running'
    // The loop driver is outside this observer test; its registry and durable turn reader are real.
    const agent = {
      session: f.session,
      get status() {
        return status
      },
    } as Agent
    vi.spyOn(f.ctx.agents, 'get').mockReturnValue(agent)
    const waiting = f.wait(undefined, 1)
    status = 'idle'
    f.ctx.emit('agent/status', { agent, status })
    await expect(waiting).resolves.toEqual({
      turn: 1,
      outcome: {
        kind: 'failed',
        message: 'turn 1 was never opened before the Session settled',
      },
    })
  })
})
