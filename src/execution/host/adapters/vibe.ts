/** Official Mistral Vibe ACP with an exact OFM relay model and a suite-owned profile. */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { HarnessConfigurationError } from '../acp.ts'
import { commandLaunch, executablePath } from '../harness-registry.ts'
import type { ModelRef } from '../../contracts/catalog.ts'
import type { HarnessSession } from '../../contracts/sessions.ts'
import { systemEnvironment } from './environment.ts'
import { openCodeShellBinding } from './opencode/opencode-shell.ts'
import { acceptVisibleCliResult } from './visible-result.ts'
import type { AcpSessionSnapshot, HarnessAdapter } from './types.ts'

const exec = promisify(execFile)
export const VIBE_MODEL = 'mistralai/mistral-large-4-1t-a52b'
export const VIBE_ALIAS = 'opl-eac-mistral-large-4'
export const VIBE_CREDENTIAL = 'OPL_VIBE_CREDENTIAL'
const MODE = 'auto-approve'

/** Only the registered EAC lane uses this adapter; vendor names do not authorize routes. */
export const isVibeModel = (ref: ModelRef): boolean =>
  ref.provider === 'our-free-model' && ref.model === VIBE_MODEL

/** TOML strings use JSON-compatible basic string escaping. Credentials stay in the child env. */
export function vibeConfig(baseURL: string): string {
  return [
    `active_model = ${JSON.stringify(VIBE_ALIAS)}`,
    `default_agent = ${JSON.stringify(MODE)}`,
    'enable_telemetry = false',
    'enable_mcp = true',
    'enable_connectors = false',
    'api_retry_max_elapsed_time = 0',
    `allowed_models = [${JSON.stringify(VIBE_MODEL)}]`,
    '[[providers]]',
    'name = "opl-ofm"',
    `api_base = ${JSON.stringify(baseURL)}`,
    `api_key_env_var = ${JSON.stringify(VIBE_CREDENTIAL)}`,
    'api_style = "openai"',
    '[[models]]',
    `name = ${JSON.stringify(VIBE_MODEL)}`,
    'provider = "opl-ofm"',
    `alias = ${JSON.stringify(VIBE_ALIAS)}`,
    // Empty levels mean no thinking control in Vibe; omitting `thinking` leaves the wire unset.
    'thinking_levels = []',
    '',
  ].join('\n')
}

type Option = { currentValue?: unknown; options?: { value?: unknown; description?: unknown }[] }
function option(config: unknown, id: string): Option | undefined {
  if (!Array.isArray(config)) return undefined
  return config.find((item) => item?.id === id && item?.type === 'select') as Option | undefined
}
const failure = (message: string) => new HarnessConfigurationError(`官方 Mistral Vibe：${message}`)

function assertRecord(record: HarnessSession): void {
  if (!isVibeModel(record.modelRef)) throw failure('模型与所选 EAC 组合不一致，未发送任务。')
  if (record.sandbox !== 'full-access')
    throw failure('此组合只支持显式授权的 full-access，不提供工作目录沙箱，未启动 CLI。')
  if (record.reasoningEffort)
    throw failure('EAC 此模型未确认支持推理档位，未发送任务。请清除旧档位后重试。')
}

function assertModel(config: unknown, pinned: boolean): void {
  const model = option(config, 'model')
  if (!model?.options?.some((item) => item.value === VIBE_ALIAS && item.description === VIBE_MODEL))
    throw failure('CLI 未广告所选 EAC 模型，未发送任务，不会改用内置模型。')
  if (pinned && model.currentValue !== VIBE_ALIAS) throw failure('CLI 当前模型已改变，未发送任务。')
}

function assertMode(snapshot: AcpSessionSnapshot): void {
  if (
    option(snapshot.configOptions, 'mode')?.currentValue !== MODE ||
    snapshot.session.modes?.currentModeId !== MODE
  )
    throw failure('CLI 未确认本轮的完全访问模式，未发送任务。')
  const thinking = option(snapshot.configOptions, 'thinking')
  if (thinking && thinking.currentValue !== 'off')
    throw failure('CLI 恢复了未经确认的推理档位，未发送任务。')
}

export const vibeAdapter: HarnessAdapter = {
  id: 'vibe',
  transport: 'acp',
  acpModelId: () => VIBE_ALIAS,
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
  matches: isVibeModel,
  async available(_ctx, options) {
    return (await executablePath(options.command || 'vibe-acp', 'vibe'))
      ? { available: true }
      : {
          available: false,
          reason:
            '未找到官方 Mistral Vibe ACP。请安装官方 Vibe 3.0.4，并在执行引擎登记 vibe-acp 的路径。',
        }
  },
  async prepare(_ctx, record, options) {
    assertRecord(record)
    const sources = options.modelSources
    if (!sources) throw failure('模型来源未注册，未启动 CLI。')
    const lease = sources.lease('vibe', record.modelRef)
    const route = await sources.resolve('vibe', record.modelRef, 'chat')
    if (route.model !== VIBE_MODEL) throw failure('来源返回了不同模型，未启动 CLI。')
    const path = await executablePath(options.command || 'vibe-acp', 'vibe')
    if (!path) throw failure('未找到 vibe-acp，未启动 CLI。')
    const versionLaunch = commandLaunch(path, [...(options.prefix ?? []), '--version'])
    const version = await exec(versionLaunch.command, versionLaunch.args, {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
      windowsVerbatimArguments: versionLaunch.windowsVerbatimArguments,
    })
    if (!/^(?:vibe-acp(?:\.exe)?\s+)?3\.0\.4$/.test(version.stdout.trim()))
      throw failure('当前仅验证过官方 Vibe 3.0.4，请使用该版本后重新检测。')
    const env = systemEnvironment()
    // Vibe's Windows shell resolver takes the first non-WSL Bash from PATH.
    const binding = await openCodeShellBinding(env)
    const shell = binding.config.shell
    const home = join(options.home, 'vibe')
    const temporary = join(options.home, 'temp')
    await mkdir(home, { recursive: true })
    await mkdir(temporary, { recursive: true })
    lease.assertCurrent()
    await writeFile(join(home, 'config.toml'), vibeConfig(route.baseURL), { mode: 0o600 })
    lease.assertCurrent()
    const launch = commandLaunch(path, options.prefix ?? [])
    return {
      home: options.home,
      command: launch.command,
      args: launch.args,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: {
        ...env,
        ...(shell ? { PATH: `${dirname(shell)}${delimiter}${env.PATH ?? ''}` } : {}),
        VIBE_HOME: home,
        [VIBE_CREDENTIAL]: route.apiKey,
        TEMP: temporary,
        TMP: temporary,
      },
    }
  },
  async configureSession(acp, record, snapshot) {
    assertRecord(record)
    assertModel(snapshot.configOptions, false)
    assertMode(snapshot)
    const sessionId = snapshot.session.sessionId || record.acpSessionId
    if (typeof sessionId !== 'string' || !sessionId) throw failure('CLI 未返回会话 ID。')
    const result = (await acp.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: VIBE_ALIAS,
    })) as { configOptions?: unknown }
    assertModel(result.configOptions, true)
    assertMode({ ...snapshot, configOptions: result.configOptions })
    return { configOptions: result.configOptions }
  },
  verifySession(record, snapshot) {
    assertRecord(record)
    assertModel(snapshot.configOptions, true)
    assertMode(snapshot)
  },
  acceptResult: acceptVisibleCliResult,
}
