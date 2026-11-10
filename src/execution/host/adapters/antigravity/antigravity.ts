/** Official Antigravity ACP adapter for the OPL Gateway native Gemini route. */
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { HarnessConfigurationError } from '../../acp.ts'
import { executablePath } from '../../harness-registry.ts'
import { systemEnvironment } from '../environment.ts'
import { resolveNativeGitBash } from '../native-bash.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  HarnessAdapter,
} from '../types.ts'
import {
  ANTIGRAVITY_HARNESS,
  ANTIGRAVITY_MODEL_OPTION,
  ANTIGRAVITY_THINKING_OPTION,
  antigravityConfigOption,
  antigravityThinking,
  antigravityWireModel,
  isAntigravityGatewayModel,
} from './models.ts'

function version(snapshot: AcpSessionSnapshot): string {
  const reported: unknown = snapshot.agent.agentInfo?.version
  return typeof reported === 'string' &&
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(reported) &&
    reported.length <= 64
    ? reported
    : '未知版本'
}

function failure(message: string, snapshot: AcpSessionSnapshot): Error {
  return new HarnessConfigurationError(`Antigravity（agy ${version(snapshot)}）${message}`)
}

function expected(record: HarnessSession): { model: string; thinking: string } {
  const model = antigravityWireModel(record.modelRef)
  const thinking = antigravityThinking(record.reasoningEffort)
  if (!model) throw new HarnessConfigurationError('此模型尚未适配 Antigravity，未发送任务。')
  if (!thinking)
    throw new HarnessConfigurationError(
      '当前 Antigravity Gemini 组合只支持 low、medium、high 推理档位，未发送任务。',
    )
  return { model, thinking }
}

function offered(options: unknown, id: string, value: string, snapshot: AcpSessionSnapshot): void {
  const option = antigravityConfigOption(options, id)
  if (!option || !option.values.includes(value))
    throw failure(`未广告要求的 ${id}=${value}，已停止，未发送任务。`, snapshot)
}

function pinned(options: unknown, id: string, value: string, snapshot: AcpSessionSnapshot): void {
  offered(options, id, value, snapshot)
  if (antigravityConfigOption(options, id)!.currentValue !== value)
    throw failure(`未确认所选的 ${id}=${value}，已停止，未发送任务。`, snapshot)
}

async function configure(
  acp: AcpRequestSurface,
  sessionId: string,
  id: string,
  value: string,
  snapshot: AcpSessionSnapshot,
): Promise<unknown> {
  let result: unknown
  try {
    result = await acp.request('session/set_config_option', { sessionId, configId: id, value })
  } catch {
    throw failure(`拒绝应用 ${id}=${value}，已停止，未发送任务。`, snapshot)
  }
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).configOptions
    : undefined
}

/** Pin the selected native route; the bridge retains the official agent loop and tools. */
export const antigravityAdapter: HarnessAdapter = {
  id: ANTIGRAVITY_HARNESS,
  transport: 'acp',
  acpModelId: (ref) => antigravityWireModel(ref) ?? ref.model,
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: ['gemini-native'],
    customEndpoint: true,
    permissions: ['full-access'],
    sessionLoad: true,
    cancel: true,
    reasoning: 'cli-advertised',
    autoReview: 'unsupported',
  },
  matches: isAntigravityGatewayModel,
  async available(_ctx, options) {
    const path = await executablePath(options.command || 'agy', ANTIGRAVITY_HARNESS)
    return path
      ? { available: true }
      : { available: false, reason: '未找到官方 Antigravity CLI，请在执行引擎安装或登记程序路径。' }
  },
  async authenticate(acp, _record, agent) {
    const snapshot: AcpSessionSnapshot = { agent, session: {}, configOptions: undefined }
    const methods: unknown = agent.authMethods
    if (
      !Array.isArray(methods) ||
      !methods.some(
        (method: unknown) =>
          method &&
          typeof method === 'object' &&
          !Array.isArray(method) &&
          (method as Record<string, unknown>).id === 'gemini-api-key',
      )
    )
      throw failure('未广告 Gemini API Key 认证，未登录 Google 账号，也未发送任务。', snapshot)
    try {
      await acp.request('authenticate', { methodId: 'gemini-api-key' })
    } catch {
      throw failure('Gemini API Key 认证失败，未登录 Google 账号，也未发送任务。', snapshot)
    }
  },
  async prepare(_ctx, record, options) {
    if (record.sandbox !== 'full-access')
      throw new HarnessConfigurationError(
        '当前 Antigravity 组合只支持完全权限，未启动 CLI；工作目录不代表沙箱隔离。',
      )
    if (record.externalAutoReview)
      throw new HarnessConfigurationError('当前 Antigravity 组合不支持 Auto Review，未启动 CLI。')
    const selection = expected(record)
    if (!options.modelSources)
      throw new HarnessConfigurationError('OPL Gateway Gemini 原生模型来源未就绪，未启动 CLI。')
    const route = await options.modelSources.resolve(
      ANTIGRAVITY_HARNESS,
      record.modelRef,
      'gemini-native',
    )
    if (route.model !== selection.model || route.protocol !== 'gemini-native')
      throw new HarnessConfigurationError('模型来源返回了不同的 Gemini 模型或协议，未启动 CLI。')
    const path = await executablePath(options.command || 'agy', ANTIGRAVITY_HARNESS)
    if (!path) throw new HarnessConfigurationError('未找到官方 Antigravity CLI，无法启动此组合。')
    const env = systemEnvironment()
    const bash = process.platform === 'win32' ? resolveNativeGitBash({ env }) : undefined
    if (process.platform === 'win32' && !bash)
      throw new HarnessConfigurationError('Antigravity 需要 Git for Windows Bash，未启动 CLI。')
    const profile = join(
      options.home,
      ANTIGRAVITY_HARNESS,
      createHash('sha256').update(record.id).digest('hex'),
    )
    return {
      home: options.home,
      command: process.execPath,
      args: [
        '--expose-internals',
        join(dirname(options.nativeBridgePath), 'antigravity-bridge.mjs'),
      ],
      promptImageSupport: route.imageInput === true,
      env: {
        ...env,
        ...(process.platform === 'win32' && process.env.PATHEXT
          ? { PATHEXT: process.env.PATHEXT }
          : {}),
        ELECTRON_RUN_AS_NODE: '1',
        OPL_AGY_COMMAND: path,
        OPL_AGY_ARGS: JSON.stringify(options.prefix ?? []),
        OPL_AGY_ROUTE: JSON.stringify(route),
        OPL_AGY_PROFILE: profile,
        OPL_AGY_WORKSPACE: record.cwd,
        OPL_AGY_NODE: process.execPath,
        ...(bash ? { OPL_AGY_GIT_BASH: bash } : {}),
      },
    }
  },
  async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
    const { model, thinking } = expected(record)
    const sessionId: unknown = snapshot.session.sessionId ?? record.acpSessionId
    if (typeof sessionId !== 'string' || !sessionId)
      throw failure('没有返回会话 ID，无法固定模型，未发送任务。', snapshot)
    offered(snapshot.configOptions, ANTIGRAVITY_MODEL_OPTION, model, snapshot)
    // Changing the model changes the thinking menu, so its advertisement is read again.
    const modelOptions = await configure(acp, sessionId, ANTIGRAVITY_MODEL_OPTION, model, snapshot)
    pinned(modelOptions, ANTIGRAVITY_MODEL_OPTION, model, snapshot)
    offered(modelOptions, ANTIGRAVITY_THINKING_OPTION, thinking, snapshot)
    const configOptions = await configure(
      acp,
      sessionId,
      ANTIGRAVITY_THINKING_OPTION,
      thinking,
      snapshot,
    )
    pinned(configOptions, ANTIGRAVITY_MODEL_OPTION, model, snapshot)
    pinned(configOptions, ANTIGRAVITY_THINKING_OPTION, thinking, snapshot)
    return { configOptions, modelId: model }
  },
  verifySession(record, snapshot) {
    const { model, thinking } = expected(record)
    pinned(snapshot.configOptions, ANTIGRAVITY_MODEL_OPTION, model, snapshot)
    pinned(snapshot.configOptions, ANTIGRAVITY_THINKING_OPTION, thinking, snapshot)
  },
  verifyPrompt(_record, snapshot, prompt) {
    if (
      prompt.some((part) => part.type === 'image') &&
      snapshot.agent.agentCapabilities?.promptCapabilities?.image !== true
    )
      throw failure('未声明图片输入能力，未发送任务。', snapshot)
  },
  acceptResult(outcome) {
    if (outcome.text.trim() === '⚠ Agent execution terminated due to error.')
      return { accepted: false, reason: 'Antigravity 报告执行错误，本轮未正常完成。' }
  },
}
