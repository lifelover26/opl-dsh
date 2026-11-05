/** Bounded, secret-free catalog observations for this process, keyed by account group. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { GatewayGroupId } from '../contracts/groups.ts'
import type { GatewayCatalogStatus, GatewayModelDiagnostic } from '../contracts/models.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A model-listing failure containing no response body, endpoint, or credentials. */
    'opl-gateway/model-discovery': { group: GatewayGroupId; diagnostic: GatewayModelDiagnostic }
  }
}

const observations = new WeakMap<object, Map<GatewayGroupId, GatewayCatalogStatus>>()

/** Latest listing observation; a stored key alone never marks a catalog ready. */
export function gatewayCatalogStatus(ctx: Context, group: GatewayGroupId): GatewayCatalogStatus {
  return observations.get(ctx.root ?? ctx)?.get(group) ?? { state: 'unverified' }
}

/** Record at most one observation per declared group, without keeping model data or auth. */
export function setGatewayCatalogStatus(
  ctx: Context,
  group: GatewayGroupId,
  status: GatewayCatalogStatus,
): void {
  const owner = ctx.root ?? ctx
  let groups = observations.get(owner)
  if (!groups) observations.set(owner, (groups = new Map()))
  groups.set(group, status)
}

/** Remove observations when switching accounts or signing out. */
export function clearGatewayCatalogStatus(ctx: Context): void {
  observations.delete(ctx.root ?? ctx)
}

/** Remote failures expose only a fixed diagnostic, never the upstream error or its causes. */
export class GatewayModelDiscoveryError extends RemoteError<'opl-gateway/model-discovery'> {
  constructor(
    group: GatewayGroupId,
    name: string,
    readonly diagnostic: GatewayModelDiagnostic,
  ) {
    super('opl-gateway/model-discovery', `${name}：${diagnostic.message}`, { group, diagnostic })
  }
}

/** Fixed messages keep untrusted response bodies, URLs, and credential values out of UI/logs. */
export function gatewayModelDiagnostic(
  code: GatewayModelDiagnostic['code'],
  status?: number,
): GatewayModelDiagnostic {
  const messages: Record<GatewayModelDiagnostic['code'], string> = {
    disabled: '此分组未激活，请在网关账户中激活后重试。',
    missing_credentials: '此分组凭据未就绪，请在网关账户中刷新凭据。',
    invalid_credentials: '此渠道的凭据格式无效，请在凭据管理中检查。',
    authentication: '目录服务拒绝此渠道的凭据或权限，请刷新账号并检查分组授权。',
    http: '目录服务返回 HTTP 错误，请稍后重试并检查此渠道的推理地址。',
    network:
      '无法连接目录服务，请检查网络和推理地址。原生 DSH 的代理可在其主目录 .env 中配置 HTTPS_PROXY/HTTP_PROXY，修改后需重启；执行引擎代理仅影响 CLI 子进程。',
    timeout:
      '目录请求超时，请检查网络与代理。原生 DSH 从其主目录 .env 读取代理配置，修改后需重启。',
    service_unavailable: '官方模型发现或设置服务未就绪，请检查插件启动错误。',
    configuration: '此渠道的协议、推理地址或凭据引用配置无效，请在模型供应商配置中检查。',
    settings_conflict: '模型配置已被其他操作修改，本次自动更新已停止，请重新打开模型页后重试。',
    invalid_response: '目录服务未返回可读取的模型列表，请重试或手动配置模型。',
    discovery_failed: '目录获取失败，请重试或手动配置模型。',
  }
  const observed = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined
  return {
    code,
    message: messages[code] + (observed === undefined ? '' : ` (HTTP ${observed})`),
    ...(observed === undefined ? {} : { status: observed }),
  }
}

/**
 * Classify only bounded status/code observations. Upstream messages are never
 * returned; the installed discovery adapter encodes HTTP status in a fixed suffix.
 */
export function diagnoseGatewayModelFailure(
  error: unknown,
  signal?: AbortSignal,
): GatewayModelDiagnostic {
  if (error instanceof GatewayModelDiscoveryError) return error.diagnostic
  if (signal?.aborted && signal.reason?.name === 'TimeoutError')
    return gatewayModelDiagnostic('timeout')
  let current: unknown = error
  let network = false
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const failure = current as { code?: unknown; name?: unknown; status?: unknown; cause?: unknown }
    const code = typeof failure.code === 'string' ? failure.code : ''
    if (
      [
        'ETIMEDOUT',
        'ESOCKETTIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
      ].includes(code) ||
      failure.name === 'TimeoutError'
    )
      return gatewayModelDiagnostic('timeout')
    if (code === 'MISSING_CREDENTIAL') return gatewayModelDiagnostic('missing_credentials')
    if (code === 'INVALID_CREDENTIAL') return gatewayModelDiagnostic('invalid_credentials')
    if (code === 'NO_DISCOVERY') return gatewayModelDiagnostic('service_unavailable')
    if (code === 'SETTINGS_CONFLICT') return gatewayModelDiagnostic('settings_conflict')
    if (['INVALID_DISCOVERY', 'DISCOVERY_UNSUPPORTED'].includes(code))
      return gatewayModelDiagnostic('configuration')
    const encodedStatus =
      current instanceof Error
        ? /\banswered ([1-5]\d\d)(?:; check the API key)?$/u.exec(current.message.slice(-100))?.[1]
        : undefined
    const status = typeof failure.status === 'number' ? failure.status : Number(encodedStatus)
    if (Number.isInteger(status) && status >= 100 && status <= 599)
      return gatewayModelDiagnostic(
        status === 401 || status === 403 ? 'authentication' : 'http',
        status,
      )
    if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'UND_ERR_SOCKET',
      ].includes(code) ||
      failure.name === 'TypeError'
    )
      network = true
    if (current instanceof SyntaxError) return gatewayModelDiagnostic('invalid_response')
    current = failure.cause
  }
  if (network) return gatewayModelDiagnostic('network')
  if (error instanceof Error && 'code' in error && error.code === 'DISCOVERY_FAILED')
    return gatewayModelDiagnostic('invalid_response')
  return gatewayModelDiagnostic('discovery_failed')
}
