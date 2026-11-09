import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { GATEWAY_GROUPS, type GatewayGroupId } from '../contracts/groups.ts'
/** Local activation is separate from upstream authorization and stored credentials. */
export function gatewayGroupEnabled(ctx: Context, id: GatewayGroupId): boolean {
  const value = ctx
    .get('settings')
    ?.describe({ redactSecrets: true })
    .find((item) => item.ns === 'opl-suite')?.value as
    { gatewayGroups?: Record<string, boolean> } | undefined
  // Preserve existing routes on upgrade; new optional groups require activation.
  // Preserve the historical activation of existing paid routes. The default
  // DeepSeek model is independent of the OpenAI-protocol route; its duplicate
  // projection is filtered at model-catalog import until the user selects it.
  return value?.gatewayGroups?.[id] ?? id !== 'kiro'
}
export async function setGatewayGroupEnabled(ctx: Context, id: unknown, enabled: unknown) {
  if (!GATEWAY_GROUPS.some((group) => group.id === id) || typeof enabled !== 'boolean')
    throw Error('分组设置无效')
  const settings = ctx.settings
    .describe({ redactSecrets: true })
    .find((item) => item.ns === 'opl-suite')
  if (!settings) throw Error('设置服务未就绪')
  await ctx.settings.mutate(
    'opl-suite',
    [{ op: 'set', path: ['gatewayGroups', id as string], value: enabled }],
    settings.revision,
  )
  return ctx.oplGatewayAccount.refresh()
}
