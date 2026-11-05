import { officialOpenCodeModel } from '../../ofm-source/selection-policy.ts'
/**
 * Official OpenCode CLI (`opencode`) adapter for explicit model-source routes.
 *
 * The CLI runs its own agent loop over ACP; this adapter contributes only protocol,
 * permission, and pinning rules, exactly as the other external harnesses do. It never
 * implements a loop of its own and never guesses work the public interface already owns.
 *
 * Authentication is not the official OpenCode account: OFM credentials are supplied by the
 * registered source, while OPL Gateway credentials are resolved by the Gateway owner. Both
 * routes reach this adapter only as a resolved route. Nothing here reads, copies, or logs the
 * key, and the key is never written to a file, a profile, or a repository path.
 *
 * ## What the official CLI genuinely offers, as measured on `opencode-ai@1.19.0`
 *
 * Every item below was answered by the real pinned binary over ACP, not inferred from
 * documentation. "Advertised" and "implemented" turned out to differ, which is why each
 * capability is stated from its measured answer:
 *
 *  - `initialize` returns protocol version 1 and `agentCapabilities.loadSession: true`;
 *    `agentInfo` reports `OpenCode` `1.19.0`.
 *  - `session/new` and `session/load` both succeed, but **`session/load` does not restore
 *    a previously pinned model** — it comes back advertising the CLI's own default. The
 *    pinned model is therefore re-asserted after a load, not trusted from the session.
 *  - `session/set_config_option` with `configId: "model"` writes the selection and returns
 *    the refreshed advertisement, which is what makes a read-back check possible.
 *  - `session/cancel` answers `-32601 "Method not found"`. Cancellation is **not**
 *    advertised; a task that needs a cancelled turn must be refused or handled by the
 *    caller, never silently left to time out.
 *  - The only advertised session options are `model` and `mode` (`build`/`plan`). There is
 *    no reasoning/effort option, so no effort is ever sent and an explicit request for one
 *    is refused rather than ignored.
 *  - With the CLI's own `permission` table set to `ask`, tool decisions arrive as a real
 *    `session/request_permission` request carrying `once`/`always`/`reject`, and refusing
 *    one makes the tool call fail. With no such table, a `write` tool runs with no request
 *    at all. Permission handling is therefore a *client relay*, not a sandbox.
 *
 * Because a permission relay cannot confine the agent to a directory, restricted
 * sandboxes are refused rather than approximated: the combination declares only
 * `full-access`, and no working-directory isolation is claimed.
 */
import { join } from 'node:path'
import { commandLaunch, executablePath } from '../../harness-registry.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import { resolveGatewayExecution } from '../../../../gateway/host/execution-access.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import { systemEnvironment } from '../environment.ts'
import { fullAccessCliConfig } from '../full-access-config.ts'
import { chatToolCompatibilityLaunch } from '../chat-tool-launch.ts'
import { openCodeShellBinding, withOpenCodeShell } from './opencode-shell.ts'
import {
  buildOpenCodeRouteConfig,
  openCodeModelValue,
  OPENCODE_SUPPORTED_PROTOCOLS,
} from './opencode-route.ts'
import {
  assertOpenCodeModelOffered,
  assertOpenCodeModelPinned,
  isOpenCodeGatewayGeminiModel,
  isOpenCodeModel,
  openCodeWireModel,
  OPENCODE_GATEWAY_GEMINI_MODELS,
  OPENCODE_HARNESS,
  OPENCODE_MODEL_OPTION,
  OPENCODE_SET_CONFIG_OPTION,
} from './opencode-models.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  HarnessAdapter,
} from '../types.ts'

export {
  OPENCODE_HARNESS,
  OPENCODE_GATEWAY_PROVIDER,
  OPENCODE_GATEWAY_GEMINI_MODELS,
  OPENCODE_OFM_PROVIDER,
  OPENCODE_OFM_MODELS,
  isOpenCodeGatewayGeminiModel,
  openCodeWireModel,
} from './opencode-models.ts'
export {
  OPENCODE_ROUTE_PROVIDER_ID,
  OPENCODE_SUPPORTED_PROTOCOLS,
  buildOpenCodeRouteConfig,
  openCodeModelValue,
} from './opencode-route.ts'
export { OPENCODE_SHELL_FACTS, openCodeShellBinding } from './opencode-shell.ts'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const version = (snapshot: AcpSessionSnapshot): string => {
  const info = snapshot.agent?.agentInfo
  const reported = info && typeof info === 'object' ? text((info as any).version) : ''
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(reported) && reported.length <= 64
    ? reported
    : '未知版本'
}

/**
 * Fail with an actionable message that names the inspected version.
 *
 * The transport's own error text is never echoed: it is provider-controlled and can carry
 * arbitrary content. Only this suite's own parameters appear in the message, so a failure
 * can never leak the credential or the endpoint that produced it.
 */
function failure(message: string, snapshot: AcpSessionSnapshot): Error {
  return new HarnessConfigurationError(`OpenCode（opencode ${version(snapshot)}）${message}`)
}

/**
 * The single model value this session is allowed to run.
 *
 * It is derived from the session record, never from what the agent happens to advertise:
 * an advertisement that offers some other model — including one of OpenCode's own free
 * entries — must not become the target.
 */
function expectedModelValue(record: HarnessSession, describe: (message: string) => Error): string {
  const wireModel = openCodeWireModel(record.modelRef)
  if (!wireModel)
    throw describe('此模型不属于本适配声明的 OpenCode 组合；已停止，不会改用其他模型。')
  return officialOpenCodeModel(record.modelRef) ?? openCodeModelValue(wireModel)
}

/**
 * Apply the pinned model and return the advertisement that followed the write.
 *
 * @throws a controlled configuration error when the agent rejects the request. The
 * agent's message is discarded rather than surfaced.
 */
async function applyModel(
  acp: AcpRequestSurface,
  sessionId: string,
  modelValue: string,
  snapshot: AcpSessionSnapshot,
): Promise<unknown> {
  let result: Record<string, any>
  try {
    result = (await acp.request(OPENCODE_SET_CONFIG_OPTION, {
      sessionId,
      configId: OPENCODE_MODEL_OPTION,
      value: modelValue,
    })) as Record<string, any>
  } catch {
    throw failure(
      `拒绝设置 ${OPENCODE_MODEL_OPTION}=${modelValue}（官方 CLI 未接受该配置）。已停止，未发送任何任务。`,
      snapshot,
    )
  }
  return result?.configOptions
}

/**
 * Resolve the launcher for the official CLI, preferring a configured command and falling
 * back to the name the official installer writes.
 */
export async function openCodePath(options: { command?: string }): Promise<string | undefined> {
  return executablePath(options.command || 'opencode', OPENCODE_HARNESS)
}

/**
 * The suite-owned profile root for the official CLI.
 *
 * The pinned CLI keeps its data, config, cache, state and bin roots under the XDG base
 * directories, and `opencode debug paths` confirms each one follows them independently
 * while `home` stays untouched. Those five variables are therefore the official dedicated
 * profile entry: they isolate this suite's CLI without redefining a process-wide `HOME`,
 * which would also redirect unrelated tools and other suites.
 *
 * @returns the four XDG roots to set for the child, under the suite's own home.
 */
export function openCodeProfileRoots(home: string): Record<string, string> {
  return {
    XDG_DATA_HOME: join(home, 'opencode/data'),
    XDG_CONFIG_HOME: join(home, 'opencode/config'),
    XDG_CACHE_HOME: join(home, 'opencode/cache'),
    XDG_STATE_HOME: join(home, 'opencode/state'),
  }
}

/**
 * Launch the official CLI in its ACP mode over stdio, pinned to the session's directory.
 */
function launch(path: string, cwd: string, prefix: readonly string[] = []) {
  const resolved = commandLaunch(path, [...prefix, 'acp', '--print-logs', '--cwd', cwd])
  return {
    command: resolved.command,
    args: resolved.args,
    verbatim: !!resolved.windowsVerbatimArguments,
  }
}

export const openCodeAdapter: HarnessAdapter = {
  acpModelId: (ref) => openCodeModelValue(openCodeWireModel(ref) ?? ref.model),
  id: OPENCODE_HARNESS,
  transport: 'acp',
  // OpenCode can leave `session/prompt` pending after a provider returns a failed
  // non-stream response. A prompt that has produced no ACP update for ninety seconds is
  // no longer a useful live request; the shared transport closes it with a fixed error.
  // Once text, thought, tool, or permission progress arrives, the guard is removed and
  // the CLI may finish a legitimately slow request without an arbitrary total deadline.
  promptProgressTimeoutMs: 90 * 1000,
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: [...OPENCODE_SUPPORTED_PROTOCOLS],
    customEndpoint: true,
    // Permission decisions reach the client as a real request, but nothing in that
    // exchange confines the agent to a directory or an allow-list. A restricted sandbox
    // could only be advisory, so it is refused rather than advertised.
    permissions: ['full-access'],
    sessionLoad: true,
    // `session/cancel` answers -32601 on the pinned release. Advertising a cancellation
    // the CLI does not implement would let a caller believe a turn was stopped.
    cancel: false,
    // The CLI advertises only `model` and `mode`; no effort exists to be selected.
    // Declaring `none` keeps a provider's native token-budget metadata (OFM publishes
    // light/balanced/deep for some lanes) from being copied onto this combination as if
    // the adapter could honour it; an explicit effort is still refused in `prepare`.
    reasoning: 'none',
    autoReview: 'unsupported',
  },
  matches: (ref: ModelRef) => isOpenCodeModel(ref) || isOpenCodeGatewayGeminiModel(ref),
  async available(ctx, options) {
    const path = await openCodePath(options)
    if (!path)
      return {
        available: false,
        reason:
          '未找到官方 OpenCode CLI（opencode）。请用官方安装器安装（npm 包 opencode-ai 提供各平台二进制），安装后重新检测；未安装时可直接在执行引擎里登记其绝对路径。',
      }
    if (options.modelSources) return { available: true }
    try {
      await resolveGatewayExecution(
        ctx,
        {
          provider: 'opl-gateway',
          model: `gemini::${OPENCODE_GATEWAY_GEMINI_MODELS[0]}`,
        },
        options.resolveKey,
      )
      return { available: true }
    } catch {
      return {
        available: false,
        reason: '没有已注册的外部模型来源，且 OPL Gateway Gemini 分组凭据未就绪或已停用。',
      }
    }
  },
  async prepare(_ctx, record, options) {
    if (record.sandbox !== 'full-access')
      throw new HarnessConfigurationError(
        '官方 OpenCode ACP 把工具权限作为请求转发给客户端，但没有把自身限制在工作目录内的机制。此组合只支持显式授权的 full-access；受限任务已停止，未启动 CLI，也不声称工作目录隔离。',
      )
    // The CLI advertises no reasoning option, so an explicit choice is refused rather than
    // silently dropped: a caller who asked for `max` must not run at some other strength
    // without being told.
    if (text(record.reasoningEffort).trim())
      throw new HarnessConfigurationError(
        `官方 OpenCode 未广告推理档位配置项，无法应用所选的 ${text(record.reasoningEffort)}。已停止，未发送任何任务，不会改用其他模型或档位。`,
      )
    const path = await openCodePath(options)
    if (!path) throw Error('未找到官方 OpenCode CLI（opencode），无法启动此组合')
    const gatewayGemini = isOpenCodeGatewayGeminiModel(record.modelRef)
    if (!options.modelSources)
      throw new HarnessConfigurationError('该模型来源尚未适配此 Harness，已停止，未启动 OpenCode。')

    // Capture the source's registration identity before any asynchronous preparation, so
    // a source that is unloaded or re-registered mid-preparation cannot still yield a
    // launch. The registry's own re-check inside `resolve` does not cover the awaits this
    // adapter performs after it.
    const lease = gatewayGemini
      ? undefined
      : options.modelSources.lease(OPENCODE_HARNESS, record.modelRef)
    const nativeModel = officialOpenCodeModel(record.modelRef)
    const route = nativeModel
      ? undefined
      : await options.modelSources.resolve(
          OPENCODE_HARNESS,
          record.modelRef,
          OPENCODE_SUPPORTED_PROTOCOLS[0],
        )
    const config = nativeModel
      ? { content: '{}' }
      : buildOpenCodeRouteConfig(route!, openCodeWireModel(record.modelRef)!)
    const started = launch(path, record.cwd, options.prefix ?? [])
    // The shell check spawns a real process and is therefore an await point the shared
    // registry cannot cover. A source unloaded, replaced, or re-registered while the probe
    // runs must not still produce a launch.
    const binding = await openCodeShellBinding(systemEnvironment())
    lease?.assertCurrent()
    const prepared = {
      home: options.home,
      command: started.command,
      args: started.args,
      promptImageSupport: route?.imageInput === true,
      // The key is carried in the child's own configuration variable and nowhere else.
      env: {
        ...binding.env,
        ...openCodeProfileRoots(options.home),
        OPL_CHAT_EDIT_COMMAND: path,
        OPL_CHAT_EDIT_ARGS: JSON.stringify(options.prefix ?? []),
        OPENCODE_CONFIG_CONTENT: withOpenCodeShell(fullAccessCliConfig(config.content), binding),
        // The suite owns this CLI's updates through the execution engine; a child that
        // replaced itself mid-session would invalidate the pinned version.
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
      ...(started.verbatim ? { windowsVerbatimArguments: true } : {}),
    }
    return !gatewayGemini && !nativeModel
      ? chatToolCompatibilityLaunch(prepared, 'opencode')
      : prepared
  },
  async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
    const describe = (message: string) => failure(message, snapshot)
    const modelValue = expectedModelValue(record, describe)
    const sessionId = text(snapshot.session?.sessionId) || record.acpSessionId
    if (!sessionId) throw describe('未返回会话 ID，无法固定模型。')
    // Before the write, the only honest question is whether the exact value is offered:
    // a new or restored session always comes back on the CLI's own default model, so
    // requiring `currentValue` to match here would refuse every usable session. This also
    // covers a restored session: `session/load` does not restore a previously pinned
    // model, so the pinned value is re-asserted rather than assumed to have survived.
    assertOpenCodeModelOffered(modelValue, snapshot.configOptions, describe)
    // The write is idempotent and is the only way to obtain the agent's *current*
    // advertisement, so the pinned model is re-asserted and then read back rather than
    // trusted from the launch configuration or a cached earlier value.
    const configOptions = await applyModel(acp, sessionId, modelValue, snapshot)
    assertOpenCodeModelPinned(modelValue, configOptions, describe)
    return { configOptions }
  },
  verifySession(record, snapshot) {
    const describe = (message: string) => failure(message, snapshot)
    assertOpenCodeModelPinned(
      expectedModelValue(record, describe),
      snapshot.configOptions,
      describe,
    )
  },
  verifyPrompt(_record, snapshot, prompt) {
    if (
      prompt.some((part) => part.type === 'image') &&
      snapshot.agent?.agentCapabilities?.promptCapabilities?.image !== true
    )
      throw failure('未声明图片输入能力；未发送提示词。', snapshot)
  },
}

/** Export the launcher used by the adapter for direct verification in tests. */
export const openCodeLaunch = launch
