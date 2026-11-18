/** Host-only Gateway access: executors never inspect account storage or provider settings. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { GATEWAY_ANTIGRAVITY_GEMINI_MODELS } from '../../shared/models.ts'
import { GATEWAY_GROUPS } from '../contracts/groups.ts'
import { gatewayGroupEnabled } from './group-settings.ts'
import { gatewayInferenceBaseURL, OPL_GATEWAY_GEMINI_NATIVE_BASE_URL } from './protocol.ts'
import { DEFAULT_MODELS, toAdapterConfig } from './config.ts'
import type { ModelDraft } from '../contracts/models.ts'

export { gatewayModelSettings } from './model-settings.ts'
export { internalGatewayProvider } from '../contracts/groups.ts'

const NATIVE_GEMINI_MODELS = new Set(GATEWAY_ANTIGRAVITY_GEMINI_MODELS.map((id) => `gemini::${id}`))
const GEMINI_GROUP = GATEWAY_GROUPS.find((group) => group.id === 'gemini')!

type ProviderProfiles = {
  providers?: Record<
    string,
    { baseURL?: string; api?: string; apiKeyEnv?: string; models?: ModelDraft[] }
  >
}

function gatewayProviderProfiles(
  settings: ReturnType<Context['settings']['describe']> | undefined,
) {
  return (settings?.find((item) => item.ns === 'llm-pi-ai')?.value as ProviderProfiles | undefined)
    ?.providers
}

function hasNativeGeminiEndpoint(api: string, baseURL?: string): boolean {
  const chat = 'openai-completions'
  const defaultURL = gatewayInferenceBaseURL(chat)
  return api === chat && (baseURL ?? defaultURL).replace(/\/+$/u, '') === defaultURL
}

/** A custom Gemini Chat endpoint has no implied native counterpart. */
export function gatewayGeminiNativeEndpointConfigured(ctx: Context): boolean {
  const profile = gatewayProviderProfiles(ctx.get('settings')?.describe())?.[GEMINI_GROUP.provider]
  return hasNativeGeminiEndpoint(profile?.api ?? GEMINI_GROUP.api, profile?.baseURL)
}

/**
 * Resolve the Gateway's native Gemini endpoint using its existing group credential.
 * Only the bundle-owned Chat endpoint has a known native counterpart; custom
 * endpoints must not be rewritten by deleting a path segment.
 */
export async function resolveGatewayGeminiExecution(
  ctx: Context,
  ref: { provider: string; model: string },
): Promise<Awaited<ReturnType<typeof resolveGatewayExecution>>> {
  if (ref.provider !== 'opl-gateway' || !NATIVE_GEMINI_MODELS.has(ref.model))
    throw Error('此模型尚未适配 Gemini 原生接口')
  const route = await resolveGatewayExecution(ctx, ref)
  if (!hasNativeGeminiEndpoint(route.api, route.baseURL))
    throw Error('自定义 Gemini 地址未声明原生接口；请保留 OpenCode 组合或恢复 OPL 默认地址')
  return { ...route, baseURL: OPL_GATEWAY_GEMINI_NATIVE_BASE_URL, api: 'gemini-native' }
}

export async function resolveGatewayExecution(
  ctx: Context,
  ref: { provider: string; model: string },
  resolveKey?: () => Promise<string | undefined>,
): Promise<{
  baseURL: string
  model: string
  apiKey: string
  credential: string
  api: string
  imageInput: boolean
  /** Capacity declared by this exact source model, never inferred from its name. */
  contextWindow?: number
}> {
  if (ref.provider !== 'opl-gateway') throw Error('模型不属于 OPL Gateway')
  const separator = ref.model.indexOf('::')
  const id = separator < 0 ? 'deepseek' : ref.model.slice(0, separator)
  const group = GATEWAY_GROUPS.find((item) => item.id === id)
  if (!group || !gatewayGroupEnabled(ctx, group.id)) throw Error('此分组已停用，请在账号页激活')
  const settings = ctx.get('settings')?.describe()
  const suite = settings?.find((item) => item.ns === 'opl-suite')?.value as
    { gateway?: { baseURL?: string; apiKeyEnv?: string; models?: ModelDraft[] } } | undefined
  const providers = gatewayProviderProfiles(settings)
  const profile = group.id === 'deepseek' ? suite?.gateway : providers?.[group.provider]
  const deepseek = group.id === 'deepseek' ? toAdapterConfig(suite?.gateway ?? {}) : undefined
  const api = group.id === 'deepseek' ? group.api : (providers?.[group.provider]?.api ?? group.api)
  const credential = (deepseek ? deepseek.apiKeyEnv : profile?.apiKeyEnv) ?? group.credential
  const key = resolveKey
    ? await resolveKey()
    : (await ctx.credentials.resolve(credentialRef(credential)))?.value
  if (!key) throw Error('所选渠道凭据未就绪，请在网关账户（OPL Gateway）页面刷新账号')
  const baseURL = (deepseek ? deepseek.baseURL : profile?.baseURL) ?? gatewayInferenceBaseURL(api)
  const model = separator < 0 ? ref.model : ref.model.slice(separator + 2)
  const configured = (profile?.models ?? (group.id === 'deepseek' ? DEFAULT_MODELS : [])).find(
    (item) => item.id === model,
  )
  const input =
    configured &&
    (group.id === 'deepseek'
      ? configured.inputModalities
      : 'input' in configured
        ? configured.input
        : undefined)
  let imageInput = Array.isArray(input) && input.includes('image')
  let contextWindow = configured?.contextWindow
  const llm = ctx.get('llm')
  if (
    (!Array.isArray(input) || input.length === 0) &&
    llm?.listProviders().some((provider) => provider.id === group.provider)
  ) {
    const info = await llm.resolveModelInfo(group.provider, model)
    imageInput = info.inputModalities?.includes('image') ?? false
    contextWindow ??= info.context?.contextWindow
  }
  return {
    baseURL,
    model,
    apiKey: key,
    credential,
    api,
    imageInput,
    ...(typeof contextWindow === 'number' &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0
      ? { contextWindow }
      : {}),
  }
}
