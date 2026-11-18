/** Official Qwen Code stdio ACP with an isolated exact-model OpenAI-compatible route. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HarnessConfigurationError } from '../../acp.ts'
import { commandLaunch, executablePath } from '../../harness-registry.ts'
import { systemEnvironment } from '../environment.ts'
import { acceptVisibleCliResult } from '../visible-result.ts'
import type { HarnessAdapter, AcpSessionSnapshot, AdapterLaunch } from '../types.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import {
  QWEN_ACP_MODEL,
  QWEN_CODE_HARNESS,
  QWEN_CODE_VERSION,
  QWEN_MODEL,
  isQwenModel,
} from './models.ts'
import { qwenShellEnvironment } from './shell.ts'
const exec = promisify(execFile)
const failure = (message: string) => new HarnessConfigurationError(`官方 Qwen Code：${message}`)

function assertRecord(record: HarnessSession): void {
  if (!isQwenModel(record.modelRef)) throw failure('模型与所选 OFM 组合不一致，未发送任务。')
  if (record.sandbox !== 'full-access')
    throw failure('此组合只支持完全权限，不提供工作目录隔离，未启动 CLI。')
  if (record.externalAutoReview) throw failure('此组合尚不支持 Auto Review，未启动 CLI。')
  if (record.reasoningEffort)
    throw failure('此 OFM 模型未确认推理档位，未发送任务；请使用模型默认设置。')
}

function option(config: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(config)) return undefined
  const matches = config.filter((item) => item && item.id === id && item.type === 'select')
  return matches.length === 1 ? matches[0] : undefined
}

/** Validate the source-bound model and permission readback before every prompt. */
export function assertQwenSession(snapshot: AcpSessionSnapshot): void {
  if (snapshot.session.models?.currentModelId !== QWEN_ACP_MODEL)
    throw failure('CLI 未确认所选 OFM 模型，未发送任务，不会改用其他模型。')
  if (snapshot.session.modes?.currentModeId !== 'yolo')
    throw failure('CLI 未确认完全权限模式，未发送任务。')
  const model = option(snapshot.configOptions, 'model')
  const mode = option(snapshot.configOptions, 'mode')
  const reasoning = option(snapshot.configOptions, 'reasoning_effort')
  if (model?.currentValue !== QWEN_ACP_MODEL || mode?.currentValue !== 'yolo')
    throw failure('CLI 的模型或权限设置已改变，未发送任务。')
  if (reasoning?.currentValue !== 'default')
    throw failure('CLI 未保持模型默认推理设置，未发送任务。')
}

/** Reject a same-name provider overridden by project settings before any prompt. */
export function assertQwenRoute(
  snapshot: AcpSessionSnapshot,
  launch: AdapterLaunch | undefined,
): void {
  const models: unknown = snapshot.session.models?.availableModels
  if (!launch?.env.OPENAI_BASE_URL || !Array.isArray(models) || models.length !== 1)
    throw failure('CLI 未确认唯一的来源接口，未发送任务。')
  const selected = models[0]
  const meta = selected?._meta
  if (
    selected?.modelId !== QWEN_ACP_MODEL ||
    meta?.baseModelId !== QWEN_MODEL ||
    meta?.authType !== 'openai' ||
    meta?.envKey !== 'OPENAI_API_KEY' ||
    meta?.baseUrl !== launch.env.OPENAI_BASE_URL
  )
    throw failure('CLI 的来源接口与所选 OFM 路由不一致，未发送任务。')
}

export const qwenCodeAdapter: HarnessAdapter = {
  id: QWEN_CODE_HARNESS,
  transport: 'acp',
  acpModelId: () => QWEN_ACP_MODEL,
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: ['chat'],
    customEndpoint: true,
    permissions: ['full-access'],
    sessionLoad: true,
    cancel: true,
    reasoning: 'none',
    autoReview: 'unsupported',
  },
  matches: isQwenModel,
  async available(_ctx, options) {
    return (await executablePath(options.command || 'qwen', QWEN_CODE_HARNESS))
      ? { available: true }
      : { available: false, reason: '未找到官方 Qwen Code，请安装并登记 qwen 程序路径。' }
  },
  async prepare(_ctx, record, options) {
    assertRecord(record)
    const sources = options.modelSources
    if (!sources) throw failure('OFM 模型来源未就绪，未启动 CLI。')
    const lease = sources.lease(QWEN_CODE_HARNESS, record.modelRef)
    const route = await sources.resolve(QWEN_CODE_HARNESS, record.modelRef, 'chat')
    if (route.model !== QWEN_MODEL) throw failure('来源返回了不同模型，未启动 CLI。')
    const path = await executablePath(options.command || 'qwen', QWEN_CODE_HARNESS)
    if (!path) throw failure('未找到官方 qwen 程序，未启动 CLI。')
    const check = commandLaunch(path, [...(options.prefix ?? []), '--version'])
    let version: string
    try {
      version = (
        await exec(check.command, check.args, {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 4096,
          windowsVerbatimArguments: check.windowsVerbatimArguments,
        })
      ).stdout.trim()
    } catch {
      throw failure('版本检测未完成，未启动 CLI。')
    }
    if (version !== QWEN_CODE_VERSION)
      throw failure(`当前适配已验证 Qwen Code ${QWEN_CODE_VERSION}，检测版本不匹配，未启动 CLI。`)
    let env: NodeJS.ProcessEnv
    try {
      env = await qwenShellEnvironment(systemEnvironment())
    } catch {
      throw failure('Git Bash 检测未完成，未启动 CLI。')
    }
    const home = join(options.home, 'qwen')
    await mkdir(home, { recursive: true })
    lease.assertCurrent()
    // Keys remain in the selected process environment, never this profile file.
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        model: { name: QWEN_MODEL },
        modelProviders: {
          openai: [
            {
              id: QWEN_MODEL,
              envKey: 'OPENAI_API_KEY',
              baseUrl: route.baseURL,
              generationConfig: {
                contextWindowSize: route.contextWindow ?? 128000,
                modalities: {},
              },
            },
          ],
        },
        tools: { approvalMode: 'yolo' },
        telemetry: { enabled: false },
      }) + '\n',
      { mode: 0o600 },
    )
    lease.assertCurrent()
    const launch = commandLaunch(path, [
      ...(options.prefix ?? []),
      '--acp',
      '--auth-type',
      'openai',
      '--model',
      QWEN_MODEL,
      '--approval-mode',
      'yolo',
      '--extensions',
      'none',
    ])
    return {
      home: options.home,
      // Qwen hashes ACP cwd verbatim when restoring its normalized Windows records.
      acpCwd: process.platform === 'win32' ? win32.normalize(record.cwd) : record.cwd,
      command: launch.command,
      args: launch.args,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: {
        ...env,
        QWEN_HOME: home,
        OPENAI_API_KEY: route.apiKey,
        OPENAI_BASE_URL: route.baseURL,
      },
      promptImageSupport: false,
    }
  },
  async authenticate(acp, _record, agent) {
    const methods: unknown = agent.authMethods
    if (!Array.isArray(methods) || !methods.some((item) => item?.id === 'openai'))
      throw failure('CLI 未广告 OpenAI 兼容接口认证，未发送任务。')
    try {
      await acp.request('authenticate', { methodId: 'openai' })
    } catch {
      throw failure('OpenAI 兼容接口认证失败，未发送任务。')
    }
  },
  async configureSession(_acp, record, snapshot, launch) {
    assertRecord(record)
    assertQwenSession(snapshot)
    assertQwenRoute(snapshot, launch)
    return { modelId: QWEN_ACP_MODEL, configOptions: snapshot.configOptions }
  },
  verifySession(record, snapshot) {
    assertRecord(record)
    assertQwenSession(snapshot)
  },
  verifyPrompt(_record, _snapshot, prompt) {
    if (prompt.some((part) => part.type !== 'text'))
      throw failure('此 OFM 路线尚未确认图片输入，未发送任务。')
  },
  acceptResult: acceptVisibleCliResult,
}
