import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GROK_API_KEY_REF } from '../../../gateway/host/config.ts'
import { OPL_GATEWAY_INFERENCE_BASE_URL } from '../../../gateway/host/opl-credentials.ts'
import { resolveGatewayExecution } from '../../../gateway/host/execution-access.ts'
import { executablePath, commandLaunch } from '../harness-registry.ts'
import { systemEnvironment } from './environment.ts'
import { grokBashEnvironment } from './grok-bash.ts'
import { HarnessConfigurationError } from '../acp.ts'
import type { HarnessAdapter } from './types.ts'

/** Read the Grok ACP effort control without accepting unadvertised values. */
function configOption(
  options: unknown,
  id: string,
): { currentValue: string; values: string[] } | undefined {
  if (!Array.isArray(options)) return undefined
  const option = options.find((item) => item?.id === id && item.type === 'select')
  if (!option || typeof option.currentValue !== 'string' || !Array.isArray(option.options))
    return undefined
  return {
    currentValue: option.currentValue,
    values: option.options
      .map((item: { value?: unknown }) => item.value)
      .filter((value: unknown): value is string => typeof value === 'string'),
  }
}
/** GROK_CONFIG drops the model table. Use the documented independent GROK_HOME. */
export function grokConfiguration(baseURL = OPL_GATEWAY_INFERENCE_BASE_URL): string {
  return grokLegacyConfiguration(baseURL).replace(
    'supports_reasoning_effort = true\n',
    'supports_reasoning_effort = true\nreasoning_efforts = [{ value = "low" }, { value = "medium" }, { value = "high" }, { value = "xhigh" }]\n',
  )
}

/** Exact suite-owned layout preceding explicit model effort metadata. */
export function grokLegacyConfiguration(baseURL = OPL_GATEWAY_INFERENCE_BASE_URL): string {
  return `[cli]\nauto_update = false\n[models]\ndefault = "grok-4.7"\nweb_search = "grok-4.7"\n[model."grok-4.7"]\nmodel = "grok-4.7"\nname = "Grok 4.7"\nbase_url = ${JSON.stringify(baseURL)}\nenv_key = "${GROK_API_KEY_REF}"\napi_backend = "responses"\ncontext_window = 500000\nsupports_reasoning_effort = true\n[shell_environment_policy]\nexclude = ["OPL_GATEWAY_*", "DSH_*", "GROK_CONFIG*"]\n[compat.claude]\nskills = false\nrules = false\nmcps = false\nhooks = false\nsessions = false\n[compat.cursor]\nskills = false\nrules = false\nmcps = false\nhooks = false\n`
}

/** Exact marketplace initialization marker appended by Grok Build 1.0.46. */
const GROK_CLI_MARKER = '\n[marketplace]\ndefault_skills_installs_purged = true\n'

/**
 * The suite profile as it looks after the official CLI has started once.
 * @param baseURL - gateway inference base URL written into the file.
 * @returns the suite configuration plus the CLI-owned marker.
 */
export function grokConfigurationWithCliMarker(baseURL = OPL_GATEWAY_INFERENCE_BASE_URL): string {
  return `${grokConfiguration(baseURL)}${GROK_CLI_MARKER}`
}

/**
 * Accept the suite configuration with or without the CLI-owned initialization marker.
 * Matching files remain unchanged; any other bytes are preserved and refused.
 * Shell selection uses GROK_SHELL independently of this file.
 * @param baseURL - gateway inference base URL written into the file.
 * @returns the initial layout followed by the CLI-initialized layout.
 */
export function grokConfigLayouts(baseURL = OPL_GATEWAY_INFERENCE_BASE_URL): string[] {
  return [
    grokConfiguration(baseURL),
    grokConfigurationWithCliMarker(baseURL),
    grokLegacyConfiguration(baseURL),
    `${grokLegacyConfiguration(baseURL)}${GROK_CLI_MARKER}`,
  ]
}

/** Official `--sandbox` profiles used by this adapter, from the 1.0.46 profile table. */
export type GrokSandboxProfile = 'off' | 'workspace' | 'read-only'
/** Official `--permission-mode` values, as enumerated by the CLI itself. */
export type GrokPermissionMode = 'default' | 'bypassPermissions'

export interface GrokPermissionPlan {
  /** Value passed to the official `--sandbox` flag. */
  sandbox: GrokSandboxProfile
  /** Value passed to the official `--permission-mode` flag. */
  permissionMode: GrokPermissionMode
  /**
   * What the plan says about filesystem isolation.
   *
   * `none` means no sandbox is requested at all, which is the honest description
   * of full access. `unverified` means a built-in profile is requested but this
   * suite has **not** verified that the CLI enforces it: the official
   * documentation states that a built-in profile which fails to apply only warns
   * and continues without enforcement, so a requested profile is not proof of a
   * sandbox. Only Windows, where a write outside the profile was measured to
   * succeed, is refused outright.
   */
  isolation: 'none' | 'unverified'
}

/**
 * Map an OPL permission tier onto the official Grok Build arguments.
 *
 * The vocabulary is the CLI's own, not an assumption. `--permission-mode
 * --help` on the installed 1.0.46 prints
 * `[possible values: default, acceptEdits, auto, dontAsk, bypassPermissions,
 * plan]`, and passing anything else fails with `invalid value ... for
 * '--permission-mode <MODE>'`. The built-in sandbox profiles are `off`
 * (default), `workspace`, `devbox`, `read-only` and `strict`; `full-access` is
 * **not** one of them, so it is mapped to `off` plus `bypassPermissions`
 * instead of being passed through as an unknown profile name.
 *
 * Restricted tiers pass the built-in profile through, which is the behaviour
 * this adapter had before, and the CLI ignores an unknown profile name rather
 * than rejecting it, so nothing here widens them. What they do **not** carry is
 * a guarantee: the official documentation states that a built-in profile which
 * fails to apply warns and continues without enforcement, and the suite has not
 * measured enforcement on macOS or Linux. Only Windows is refused outright,
 * because there a write outside the profile was measured to succeed
 * (`--sandbox read-only`, write landed outside the workspace).
 * @param tier - the requested OPL permission tier.
 * @param platform - host platform, overridable for tests.
 * @returns the official arguments to launch with.
 * @throws HarnessConfigurationError for a tier this host cannot honour.
 */
export function grokPermissionPlan(
  tier: string,
  platform: NodeJS.Platform = process.platform,
): GrokPermissionPlan {
  if (tier === 'full-access')
    return { sandbox: 'off', permissionMode: 'bypassPermissions', isolation: 'none' }
  if (tier !== 'workspace' && tier !== 'read-only')
    throw new HarnessConfigurationError(
      `Grok 不支持的权限档位：${tier}。未启动 Grok，未降级为更宽松的权限。`,
    )
  if (platform === 'win32')
    throw new HarnessConfigurationError(
      `Grok Build 在 Windows 上没有可执行的沙箱后端（官方仅提供 Linux Landlock 与 macOS Seatbelt）。实测 ${tier} 档在本机不会拦截写入，套件不会把它当作已隔离。请显式授权 full-access（沙箱关闭且不再询问），或改在 macOS/Linux 上运行受限任务；未启动 Grok，未把 ${tier} 自动扩大为完整权限。`,
    )
  return {
    sandbox: tier === 'workspace' ? 'workspace' : 'read-only',
    permissionMode: 'default',
    isolation: 'unverified',
  }
}

export const grokAdapter: HarnessAdapter = {
  id: 'grok-build',
  transport: 'acp',
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: ['responses'],
    customEndpoint: false,
    permissions:
      process.platform === 'win32' ? ['full-access'] : ['read-only', 'workspace', 'full-access'],
    sessionLoad: true,
    cancel: true,
    reasoning: 'cli-advertised',
    autoReview: 'unsupported',
  },
  matches: (ref) => ref.provider === 'opl-gateway' && ref.model === 'grok::grok-4.7',
  verifyPrompt(_record, snapshot, prompt) {
    if (
      prompt.some((part) => part.type === 'image') &&
      snapshot.agent?.agentCapabilities?.promptCapabilities?.image !== true
    )
      throw new HarnessConfigurationError('当前 Grok CLI 未声明图片输入能力；未发送提示词。')
  },
  async configureSession(acp, record, snapshot) {
    const effort = record.reasoningEffort ?? 'high'
    if (!['low', 'medium', 'high', 'xhigh'].includes(effort))
      throw new HarnessConfigurationError('Grok 4.7 不支持所选推理档位；未发送提示词。')
    const option = configOption(snapshot.configOptions, 'reasoning_effort')
    if (!option?.values.includes(effort))
      throw new HarnessConfigurationError('Grok CLI 未提供所选推理档位；未发送提示词。')
    if (option.currentValue === effort) return { configOptions: snapshot.configOptions }
    const result = (await acp.request('session/set_config_option', {
      sessionId: record.acpSessionId,
      configId: 'reasoning_effort',
      value: effort,
    })) as { configOptions?: unknown }
    if (configOption(result.configOptions, 'reasoning_effort')?.currentValue !== effort)
      throw new HarnessConfigurationError('Grok CLI 推理档位回读不一致；未发送提示词。')
    return { configOptions: result.configOptions }
  },
  async available(ctx, options) {
    if (!(await executablePath(options.command || options.grokCommand)))
      return { available: false, reason: '未找到官方 Grok Build CLI' }
    try {
      await resolveGatewayExecution(
        ctx,
        { provider: 'opl-gateway', model: 'grok::grok-4.7' },
        options.resolveKey,
      )
      return { available: true }
    } catch {
      return { available: false, reason: 'Grok 分组凭据未就绪或已停用' }
    }
  },
  async prepare(ctx, record, options) {
    // Resolved first, before any credential lookup and before the profile is
    // written: a request this host cannot honour must leave no state behind and
    // must not touch the credential path at all.
    const permissions = grokPermissionPlan(record.sandbox)
    const command = await executablePath(options.command || options.grokCommand, 'grok-build')
    if (!command) throw Error('未找到官方 Grok Build CLI')
    const route = options.modelSources
      ? await options.modelSources.resolve('grok-build', record.modelRef, 'responses')
      : await resolveGatewayExecution(ctx, record.modelRef, options.resolveKey)
    const key = route.apiKey
    const home = join(options.home, 'harnesses', 'grok-build')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const config = join(home, 'config.toml'),
      bytes = grokConfiguration(route.baseURL)
    const current = await readFile(config, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (current !== undefined && !grokConfigLayouts(route.baseURL).includes(current))
      throw Error('套件的 Grok 配置已被修改，已保留，请核对后再启动')
    // Preserve the CLI-owned marker after initialization.
    if (current === undefined) await writeFile(config, bytes, { mode: 0o600, flag: 'wx' })
    else if (
      current === grokLegacyConfiguration(route.baseURL) ||
      current === `${grokLegacyConfiguration(route.baseURL)}${GROK_CLI_MARKER}`
    )
      await writeFile(
        config,
        current.endsWith(GROK_CLI_MARKER) ? grokConfigurationWithCliMarker(route.baseURL) : bytes,
        { mode: 0o600 },
      )
    const launch = commandLaunch(command, [
      ...(options.prefix ?? []),
      '--cwd',
      record.cwd,
      '--model',
      'grok-4.7',
      '--sandbox',
      permissions.sandbox,
      '--permission-mode',
      permissions.permissionMode,
      'agent',
      '--no-leader',
      'stdio',
    ])
    // Pinned before launch: the CLI resolves the tool shell when it first runs a
    // command, and an unusable backend is refused here rather than silently
    // running on PowerShell.
    const env = await grokBashEnvironment(systemEnvironment())
    return {
      home,
      ...launch,
      promptImageSupport: route.imageInput === true,
      env: {
        ...env,
        GROK_HOME: home,
        [GROK_API_KEY_REF]: key,
        GROK_DEFAULT_SELECTED_PERMISSION: 'allow_once',
      },
    }
  },
}
