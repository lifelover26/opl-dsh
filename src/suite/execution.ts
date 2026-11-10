import { executionLimitsSchema } from './config.ts'
import { installNativeProgressGuard } from '../execution/host/native-progress-guard.ts'
import type { ProgressWatchdogLimits } from '../execution/host/progress-watchdog.ts'
import { installExternalCodex } from '../collaboration/host/external-codex.ts'
import { installLegacyHarnessChannel } from '../compat/host/legacy-channel.ts'
import { ExecutionService } from '../execution/host/service.ts'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Context } from '@deepseek-ai/cordis'
import { createHarnessService } from '../execution/host/harness.ts'
import { installConversationRequest } from '../execution/host/conversation-request.ts'
import { MiniMaxCodeModelAdapter } from '../execution/host/adapters/minimax-models.ts'
import { MINIMAX_CODE_PROVIDER } from '../execution/host/adapters/minimax.ts'
import { installCollaborationTools } from '../collaboration/host/tools.ts'
import { installPermissionMemory } from '../compat/host/permission-memory.ts'
import { installComputerUse } from '../computer-use/host/index.ts'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { AutoReviewMaintenance } from '../auto-review/contracts/maintenance.ts'
import { EXTERNAL_REVIEW_BINDING_SERVICE } from '../auto-review/host/index.ts'
import { createOfmOwnerApiReader } from '../execution/host/ofm-owner-api.ts'
import {
  applyOfmModelSource,
  createOfmApiConnection,
  OFM_PROVIDER,
} from '../execution/host/ofm-source/index.ts'
import z from '@deepseek-ai/schemastery'
import { installUpdateRuntime } from '../updates/host/runtime-admission.ts'

export interface Config {
  executionLimits: ProgressWatchdogLimits
  ofmConnectionTimeoutMs: number
}
export const Config = z.object({
  executionLimits: executionLimitsSchema,
  ofmConnectionTimeoutMs: z.number().step(1).min(100).max(120_000).default(10_000),
})

export const inject = [
  'llm',
  'typertGateway',
  'sessions',
  'agents',
  'sessionProjections',
  'connection',
  'webServer',
  'settings',
  'credentials',
  'agentDefaultModel',
  'workspaceRegistry',
  'permissionPresets',
  'sessionController',
  'sandboxPolicy',
  'approval',
]
/** Keep admission, model selection, tools and permissions in the official Host.
 * @param ctx - Official Host context.
 * @returns once execution consumers are ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.effect(() => installPermissionMemory(ctx))
  const ofmOwner = createOfmOwnerApiReader(ctx, config.ofmConnectionTimeoutMs)
  const harness = createHarnessService(ctx, {
    readOfm: () => ofmOwner.read('/summary'),
  })
  const updateRuntime = installUpdateRuntime(ctx, harness)
  ctx.provide('oplUpdateRuntime', updateRuntime)
  harness.configureProgressLimits(config.executionLimits)
  ctx.provide('oplExternalModelSources', harness.modelSources)
  applyOfmModelSource(ctx, {
    providers: [OFM_PROVIDER],
    connection: createOfmApiConnection(async (request) => {
      if (request.url !== '/api/our-free-model/clients') throw Error('OFM 连接读取路径无效')
      return { status: 200, body: await ofmOwner.read('/clients') }
    }, ''),
  })
  const reviewerMaintenance: AutoReviewMaintenance = {
    change: (operation) => harness.changeReviewerSettings(operation),
  }
  ctx.provide('oplAutoReviewMaintenance', reviewerMaintenance)
  // Bind an external-Harness permission ask to the live ACP connection record.
  // The binding is all-or-nothing: without the exact action, turn, connection
  // generation and authorization the port returns null, and the Auto Review
  // bridge then leaves the ask to the ordinary human approval chain.
  ctx.provide(EXTERNAL_REVIEW_BINDING_SERVICE, {
    bind: (agent: { session: { id: string } }, request: { callId?: string }) =>
      harness.externalApprovalBinding(agent.session.id, request.callId),
  })
  // Apply model defaults on official/custom routes before the request is logged.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter')
      await harness.claimMessageEdit(payload.agent, decision.messages, payload.turn, payload.step)
    return decision
  })
  installConversationRequest(ctx, harness)
  ctx.on('llm/stream', (options, next) => harness.conversationStream(options, next))
  installNativeProgressGuard(
    ctx,
    () => harness.executionLimits(),
    (options) => !options.purpose,
  )
  // Register the official MiniMax Code account models through the public LLM extension
  // point. Without this the two models exist in the execution catalog but the official
  // session controller cannot list or select them, so no message would ever route.
  ctx.llm.registerAdapter([MINIMAX_CODE_PROVIDER], new MiniMaxCodeModelAdapter())
  new ExecutionService(ctx, harness)
  ctx.effect(() => async () => {
    await harness.dispose()
    updateRuntime.drained('harness')
  })
  installCollaborationTools(ctx, harness)
  installComputerUse(ctx)
  installLegacyHarnessChannel(ctx)
  installExternalCodex(ctx, harness)
}
