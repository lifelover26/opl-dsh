import { invokeHostRemote } from '../../compat/host/remote-invocation.ts'
/** First-run completion belongs to the Host; the desktop and browser share this channel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LoginChoice } from '../../suite/config.ts'
import type {} from '../../gateway/host/account-service.ts'

import type { SetupStatus } from '../contracts.ts'
export async function officialProvider(ctx: Context): Promise<string | undefined> {
  const account = (await invokeHostRemote(ctx, {
    namespace: 'account',
    method: 'getState',
    args: {},
  })) as { status?: string }
  if (account.status === 'credential-stored') return 'deepseek-account'
  const value = ctx.settings.describe().find((item) => item.ns === 'llm-deepseek')?.value as
    { apiKeyEnv?: string } | undefined
  if (value?.apiKeyEnv && (await ctx.credentials.resolve(credentialRef(value.apiKeyEnv))))
    return 'deepseek-official'
  return undefined
}
export async function setupStatus(ctx: Context): Promise<SetupStatus> {
  const settings = ctx.settings.describe().find((item) => item.ns === 'opl-suite')?.value as
    { loginChoice?: LoginChoice; setupCompleted?: boolean } | undefined
  const gateway = await ctx.get('oplGatewayAccount')?.status()
  const account = (await invokeHostRemote(ctx, {
    namespace: 'account',
    method: 'getState',
    args: {},
  })) as { attempt?: { phase?: string } }
  const provider = await officialProvider(ctx)
  return {
    completed: settings?.setupCompleted === true,
    choice: settings?.loginChoice ?? 'undecided',
    gatewayReady:
      gateway?.groups?.some((group) => group.state === 'ready') ?? gateway?.keyReady ?? false,
    ...(provider ? { officialProvider: provider } : {}),
    ...(account.attempt?.phase ? { officialPhase: account.attempt.phase } : {}),
  }
}
export async function finishSetup(
  ctx: Context,
  choice: Exclude<LoginChoice, 'undecided'>,
): Promise<void> {
  if (choice !== 'later') {
    const provider = choice === 'gateway' ? 'opl-gateway' : await officialProvider(ctx)
    if (!provider || (choice === 'gateway' && !(await setupStatus(ctx)).gatewayReady))
      throw new Error('账户尚未就绪，请先完成登录。')
    const model = (await ctx.llm.listModels(provider))[0]
    if (!model) throw new Error('账户暂无可用模型，请稍后重试。')
    await ctx.agentDefaultModel.saveSelection({ provider, model: model.id })
  }
  await ctx.settings.update('opl-suite', { loginChoice: choice, setupCompleted: true })
}
