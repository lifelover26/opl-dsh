import { fileURLToPath } from 'node:url'
import { executablePath } from '../../harness-registry.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { systemEnvironment } from '../environment.ts'
import { assertKimiAcpVersion, kimiBashEnvironment } from './kimi-bash.ts'
import { kimiPermissionPlan } from './kimi-permissions.ts'
import {
  KIMI_ENV_MODEL_ALIAS,
  KIMI_HARNESS,
  KIMI_MODE_OPTION,
  KIMI_MODEL_OPTION,
  KIMI_PROTOCOL,
  KIMI_PROTOCOLS,
  KIMI_PROVIDER,
  KIMI_ROUTE_ENV,
  KIMI_THINKING_OPTION,
  isKimiCodeModel,
  kimiProviderType,
  kimiThinkingValue,
} from './kimi-models.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { ExternalModelSources } from '../../model-sources.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  HarnessAdapter,
} from '../types.ts'

const SET_CONFIG_OPTION = 'session/set_config_option'

interface AcpConfigOption {
  readonly currentValue: string
  readonly values: readonly string[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Read one `select` config option out of an advertised `configOptions` array. */
export function kimiConfigOption(configOptions: unknown, id: string): AcpConfigOption | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const raw of configOptions) {
    const option = raw as Record<string, any> | null
    if (!option || typeof option !== 'object' || option.id !== id) continue
    const values = Array.isArray(option.options)
      ? option.options.map((entry: any) => text(entry?.value)).filter((v: string) => v.length > 0)
      : []
    return { currentValue: text(option.currentValue), values }
  }
  return undefined
}

/**
 * Fail closed without quoting agent-controlled text, which can carry account material.
 * Only this suite's own requested value is named.
 */
function kimiFailure(message: string): HarnessConfigurationError {
  return new HarnessConfigurationError(`官方 Kimi Code：${message}已停止，未发送任务。`)
}

/** Require the advertisement to carry one option and to report the pinned value. */
function assertPinned(configId: string, value: string, configOptions: unknown): void {
  const option = kimiConfigOption(configOptions, configId)
  if (!option) throw kimiFailure(`会话未广告 ${configId}，无法确认取值 ${value}，已停止。`)
  if (option.currentValue !== value)
    throw kimiFailure(`会话 ${configId} 与要求的 ${value} 不一致，未发送任何任务。`)
}

/** Require the advertisement to offer a value before writing it. */
function assertAdvertised(configId: string, value: string, configOptions: unknown): void {
  const option = kimiConfigOption(configOptions, configId)
  if (!option) throw kimiFailure(`未广告 ${configId} 配置项，无法确认所需取值 ${value}。`)
  if (!option.values.includes(value))
    throw kimiFailure(`广告的 ${configId} 不含所需取值 ${value}，未发送任何任务。`)
}

function kimiSessionId(record: { acpSessionId?: string }, snapshot: AcpSessionSnapshot): string {
  const id = text(snapshot.session?.sessionId) || text(record.acpSessionId)
  if (!id) throw kimiFailure('未返回会话 ID，无法固定模型与权限。')
  return id
}

async function applyOption(
  acp: AcpRequestSurface,
  sessionId: string,
  configId: string,
  value: string,
): Promise<unknown> {
  let result: Record<string, any>
  try {
    result = (await acp.request(SET_CONFIG_OPTION, { sessionId, configId, value })) as Record<
      string,
      any
    >
  } catch {
    throw kimiFailure(`拒绝设置 ${configId}=${value}（官方 CLI 未接受该配置）。`)
  }
  return result?.configOptions
}

/**
 * Every pinned value checked against one advertisement. Called once after the final write
 * as well as around each write, so a value changed underneath an earlier write cannot pass
 * unnoticed just because the last write succeeded.
 */
function assertAllPinned(
  pinned: readonly { configId: string; value: string }[],
  configOptions: unknown,
): void {
  for (const { configId, value } of pinned) assertPinned(configId, value, configOptions)
}

/**
 * Re-resolve the route and require the same one.
 *
 * Complements the lease: the lease covers registration lifetime and the declared pairing,
 * while this catches a live route that changed underneath an earlier await. Neither alone
 * is sufficient — an unregister followed by a re-register of the *same source object*
 * keeps object identity but invalidates the captured registration, and a route swap under
 * a live registration leaves the lease satisfied.
 */
async function assertRouteStillCurrent(
  sources: ExternalModelSources,
  ref: ModelRef,
  protocol: 'chat' | typeof KIMI_PROTOCOL,
  expected: { model: string; baseURL: string; apiKey: string },
): Promise<void> {
  let current
  try {
    current = await sources.resolve(KIMI_HARNESS, ref, protocol)
  } catch {
    throw kimiFailure('模型来源在启动前被替换或卸载，已停止，未启动 CLI。')
  }
  if (
    current.model !== expected.model ||
    current.baseURL !== expected.baseURL ||
    current.apiKey !== expected.apiKey ||
    current.protocol !== protocol
  )
    throw kimiFailure('模型来源在启动前变更，未使用过期路由启动，已停止。')
}

/** Run the lease check as a controlled refusal instead of propagating the shared error. */
function assertLeaseCurrent(assertCurrent: () => void): void {
  try {
    assertCurrent()
  } catch {
    throw kimiFailure('模型来源注册已失效（可能已注销后重新注册），已停止，未启动 CLI。')
  }
}

export const kimiCodeAdapter: HarnessAdapter = {
  id: KIMI_HARNESS,
  transport: 'acp',
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: [...KIMI_PROTOCOLS],
    // The CLI accepts a caller-supplied endpoint through its documented model
    // environment, so a source may legitimately bring its own route for this harness.
    customEndpoint: true,
    permissions: ['read-only', 'full-access'],
    sessionLoad: true,
    cancel: true,
    reasoning: 'cli-advertised',
    autoReview: 'unsupported',
  },
  matches: isKimiCodeModel,
  async available(_ctx, options) {
    const path = await executablePath(options.command || 'kimi', KIMI_HARNESS)
    if (!path)
      return { available: false, reason: '未找到官方 Kimi Code CLI（kimi）。请先安装官方客户端。' }
    try {
      await kimiBashEnvironment(systemEnvironment())
    } catch (error) {
      return { available: false, reason: (error as Error).message }
    }
    return { available: true }
  },
  async prepare(ctx, record, options) {
    // Checked first: an unsupported tier must leave no state behind and must not reach
    // the credential path at all.
    const permissions = kimiPermissionPlan(record.sandbox)
    if (!isKimiCodeModel(record.modelRef))
      throw new HarnessConfigurationError(
        '此模型不属于官方 Kimi Code 可服务的组合；已停止，未启动 CLI。',
      )
    const sources = options.modelSources
    if (!sources)
      throw new HarnessConfigurationError(
        `模型来源 ${KIMI_PROVIDER} 尚未注册到执行引擎，无法确认此组合的路由；已停止，未启动 CLI。`,
      )
    const ref = record.modelRef
    // Captured before any await, so an unregister/re-register of the same source object
    // during preparation invalidates this request instead of being accepted.
    const lease = sources.lease(KIMI_HARNESS, ref)
    const protocol = KIMI_PROTOCOL
    const route = await sources.resolve(KIMI_HARNESS, ref, protocol)
    // The source authorizes this combination; it may not redirect it to another model.
    if (!route.model || route.model !== ref.model)
      throw kimiFailure('模型来源解析出的模型与所选组合不一致，未改用该模型，已停止。')
    const providerType = kimiProviderType(route.protocol)
    if (!providerType)
      throw new HarnessConfigurationError(
        `官方 Kimi Code 无法表达协议 ${route.protocol}；已停止，未启动 CLI，未改用其他协议。`,
      )
    const path = await executablePath(options.command || 'kimi', KIMI_HARNESS)
    if (!path) throw Error('未找到官方 Kimi Code CLI（kimi），无法启动此组合')

    assertLeaseCurrent(lease.assertCurrent)
    await assertRouteStillCurrent(sources, ref, protocol, route)

    const env = await kimiBashEnvironment(systemEnvironment())
    // Final gate, after the last await that can outlive the registration.
    assertLeaseCurrent(lease.assertCurrent)
    await assertRouteStillCurrent(sources, ref, protocol, route)

    const bridge = fileURLToPath(new URL('./kimi-error-bridge.mjs', import.meta.url))
    return {
      home: options.home,
      command: process.execPath,
      args: [bridge],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        OPL_KIMI_COMMAND: path,
        OPL_KIMI_ARGS: JSON.stringify([...(options.prefix ?? []), 'acp']),
        [KIMI_ROUTE_ENV.model]: route.model,
        [KIMI_ROUTE_ENV.apiKey]: route.apiKey,
        [KIMI_ROUTE_ENV.baseUrl]: route.baseURL,
        [KIMI_ROUTE_ENV.providerType]: providerType,
        // The suite's own runtime root, so the child neither reads nor writes a Moonshot
        // account profile and needs no `kimi --login`.
        [KIMI_ROUTE_ENV.home]: options.home,
      },
    }
  },
  async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
    assertKimiAcpVersion(snapshot)
    const sessionId = kimiSessionId(record, snapshot)
    const thinking = kimiThinkingValue(record.reasoningEffort)
    const { mode } = kimiPermissionPlan(record.sandbox)
    const pinned: { configId: string; value: string }[] = [
      { configId: KIMI_MODEL_OPTION, value: KIMI_ENV_MODEL_ALIAS },
      { configId: KIMI_MODE_OPTION, value: mode },
      ...(thinking === undefined ? [] : [{ configId: KIMI_THINKING_OPTION, value: thinking }]),
    ]
    // When the agent advertises anything, every requested value must be offered before a
    // single write happens.
    if (snapshot.configOptions !== undefined)
      for (const item of pinned) assertAdvertised(item.configId, item.value, snapshot.configOptions)

    // Model first: the `thinking` arm only exists once the model that owns it is chosen.
    let configOptions = await applyOption(acp, sessionId, KIMI_MODEL_OPTION, KIMI_ENV_MODEL_ALIAS)
    assertPinned(KIMI_MODEL_OPTION, KIMI_ENV_MODEL_ALIAS, configOptions)

    if (thinking !== undefined) {
      const option = kimiConfigOption(configOptions, KIMI_THINKING_OPTION)
      if (!option)
        throw kimiFailure(
          `所选模型未广告 ${KIMI_THINKING_OPTION}，无法设置 ${thinking}；不会改用其他档位。`,
        )
      if (!option.values.includes(thinking))
        throw kimiFailure(`广告的 ${KIMI_THINKING_OPTION} 不含所选取值 ${thinking}。`)
      if (option.currentValue !== thinking)
        configOptions = await applyOption(acp, sessionId, KIMI_THINKING_OPTION, thinking)
      assertPinned(KIMI_THINKING_OPTION, thinking, configOptions)
    }

    const modeOption = kimiConfigOption(configOptions, KIMI_MODE_OPTION)
    if (!modeOption) throw kimiFailure(`未广告 ${KIMI_MODE_OPTION} 配置项，无法确认权限档位。`)
    if (!modeOption.values.includes(mode))
      throw kimiFailure(`广告的 ${KIMI_MODE_OPTION} 不含所需取值 ${mode}。`)
    if (modeOption.currentValue !== mode)
      configOptions = await applyOption(acp, sessionId, KIMI_MODE_OPTION, mode)

    // Re-check every pinned value against the advertisement produced by the last write,
    // not just the one that was written last.
    assertAllPinned(pinned, configOptions)
    return { configOptions }
  },
  verifySession(record, snapshot) {
    assertKimiAcpVersion(snapshot)
    // A snapshot without an advertisement proves nothing, so it is a failure rather than
    // a skipped check.
    if (snapshot.configOptions === undefined)
      throw kimiFailure('会话缺少 configOptions 广告，无法确认模型与权限，已停止。')
    const thinking = kimiThinkingValue(record.reasoningEffort)
    const { mode } = kimiPermissionPlan(record.sandbox)
    assertAllPinned(
      [
        { configId: KIMI_MODEL_OPTION, value: KIMI_ENV_MODEL_ALIAS },
        { configId: KIMI_MODE_OPTION, value: mode },
        ...(thinking === undefined ? [] : [{ configId: KIMI_THINKING_OPTION, value: thinking }]),
      ],
      snapshot.configOptions,
    )
  },
}
