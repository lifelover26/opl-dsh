/** Permission access for the control bridge over the official preset service. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { z } from 'zod'

const permissionRequest = z.object({
  sessionId: z.string().min(1),
  preset: z.string().min(1).optional(),
})

/** Read or explicitly change an idle Session; never approve a pending tool request. */
export async function sessionPermissions(ctx: Context, input: unknown, change: boolean) {
  const request = permissionRequest.parse(input)
  if (change && !request.preset) throw Error('selectPermissions requires preset')
  const owner = ctx.get('permissionPresets')
  if (!owner) throw Error('Official permission preset service is unavailable')
  if (change) owner.resolve(request.preset!)
  const resolved = await ctx.sessionController.resolveAgent(request.sessionId as SessionId)
  if ('error' in resolved) throw resolved.error
  const { agent } = resolved
  const session = agent.session
  const turn = ctx.agents.turnBoundaryOf(session)
  const running = agent.status === 'running' || turn.openTurnStartSeq !== null
  if (change) {
    if (running) throw Error('session/permissions-busy: permission changes require an idle Session')
    owner.set(session, request.preset!)
  }
  const permission = {
    sessionId: session.id,
    preset: owner.current(session),
    sandbox: ctx.sandboxPolicy.resolve({ session }).mode,
    approval: ctx.approval.overrideOf(session) ?? ctx.approval.config.policy ?? 'ask',
    available: owner.names,
    defaultPreset: owner.defaultPreset,
    running,
    turn: turn.openTurnStartSeq === null ? null : turn.lastTurn,
  }
  return change ? { permissions: permission, appliesFrom: 'next-confined-call' } : permission
}
