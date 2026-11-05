import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { sessionPermissions } from '../../src/compat/host/session-permissions.ts'
function fixture(running = false) {
  const session = { id: 's1' }
  const owner = {
    current: vi.fn(() => 'workspace-write'),
    resolve: vi.fn((name: string) => {
      if (name !== 'danger-full-access') throw Error('unknown preset')
    }),
    set: vi.fn(),
    names: ['workspace-write', 'danger-full-access'],
    defaultPreset: 'workspace-write',
  }
  const ctx = {
    get: () => owner,
    sessionController: {
      resolveAgent: vi.fn(async () => ({
        agent: { session, status: running ? 'running' : 'idle' },
      })),
    },
    agents: { turnBoundaryOf: () => ({ openTurnStartSeq: running ? 1 : null, lastTurn: 1 }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { overrideOf: () => 'ask', config: {} },
  }
  return { ctx: ctx as unknown as Context, owner, session }
}
it('reads effective official permissions and switches an idle session through its owner', async () => {
  const { ctx, owner, session } = fixture()
  expect(await sessionPermissions(ctx, { sessionId: 's1' }, false)).toMatchObject({
    preset: 'workspace-write',
    sandbox: 'workspace-write',
    approval: 'ask',
    running: false,
  })
  await sessionPermissions(ctx, { sessionId: 's1', preset: 'danger-full-access' }, true)
  expect(owner.set).toHaveBeenCalledWith(session, 'danger-full-access')
})
it('rejects changes during execution and rejects unknown or missing presets before writing', async () => {
  const { ctx, owner } = fixture(true)
  await expect(
    sessionPermissions(ctx, { sessionId: 's1', preset: 'danger-full-access' }, true),
  ).rejects.toThrow('permissions-busy')
  await expect(sessionPermissions(ctx, { sessionId: 's1', preset: 'bad' }, true)).rejects.toThrow(
    'unknown preset',
  )
  await expect(sessionPermissions(ctx, { sessionId: 's1' }, true)).rejects.toThrow(
    'requires preset',
  )
  expect(owner.set).not.toHaveBeenCalled()
})

it('uses the official open turn even when the resolved driver is idle', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('permissions-session'))
    const { owner } = fixture()
    ctx.provide('permissionPresets', owner)
    ctx.provide('sessionController', {
      resolveAgent: async () => ({ agent: { session, status: 'idle' } }),
    })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
    ctx.provide('approval', { overrideOf: () => 'ask', config: {} })
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockImplementation(() => {
      throw Error('Turn positions belong to the official agent service')
    })
    session.append('turn/start', { turn: 4 })
    await expect(sessionPermissions(ctx, { sessionId: session.id }, false)).resolves.toMatchObject({
      running: true,
      turn: 4,
    })
    await expect(
      sessionPermissions(ctx, { sessionId: session.id, preset: 'danger-full-access' }, true),
    ).rejects.toThrow('permissions-busy')
    expect(owner.set).not.toHaveBeenCalled()
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
    await sessionPermissions(ctx, { sessionId: session.id, preset: 'danger-full-access' }, true)
    expect(owner.set).toHaveBeenCalledWith(session, 'danger-full-access')
  } finally {
    await ctx.fiber.dispose()
  }
})
