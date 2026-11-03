/**
 * Official Kilo CLI (`kilo`) adapter for the Our Free Model source.
 *
 * The CLI runs its own agent loop over ACP; this adapter contributes only protocol,
 * permission, and pinning rules, exactly as the other external harnesses do. It never
 * implements a loop of its own and never guesses work the public interface already owns.
 *
 * Authentication is not the official Kilo account: the model belongs to a registered model
 * source, so the credential is read by that plugin and reaches this adapter only as a
 * resolved route. Nothing here reads, copies, or logs the key, and the key is never written
 * to a file, a profile, or a repository path. The CLI's own `kilo-login` account and its
 * `kilo/*` catalog stay exactly where they are and are not used by this pairing.
 *
 * ## What the official CLI genuinely offers, as measured on `@kilocode/cli@7.8.8`
 *
 * Every item below was answered by the real pinned binary over ACP, not inferred from
 * documentation. "Advertised" and "implemented" turned out to differ, which is why each
 * capability is stated from its measured answer:
 *
 * - `kilo acp --cwd <dir>` serves ACP v1 over stdio ndjson. `initialize` reports protocol
 *   version 1, `agentInfo` `Kilo` `7.8.8`, `agentCapabilities.loadSession: true`, and
 *   `sessionCapabilities` for close/fork/list/resume.
 * - `session/new` advertises exactly three config options: `model` (category `model`),
 *   `effort` (category `thought_level`) and `mode` (category `mode`).
 * - `session/set_config_option` with `configId: "model"` writes the selection and returns
 *   the refreshed advertisement, which is what makes a read-back check possible. A value
 *   outside the advertisement is refused with `-32602 model not found` and the session keeps
 *   its previous model, so the refusal fails closed instead of drifting.
 * - `session/load` succeeds but **does not restore a previously pinned model** — it comes
 *   back advertising the CLI's own default. The pinned model is therefore re-asserted after
 *   a load, not trusted from the session.
 * - `session/cancel` answers `-32601 "Method not found"`. Cancellation is **not**
 *   advertised; a task that needs a cancelled turn must be refused or handled by the caller,
 *   never silently left to time out.
 * - The `effort` option is advertised only while the CLI's own default model is selected, and
 *   even that single value cannot be written. Once any declared model is selected the option
 *   is dropped from `configOptions` altogether, and writes for `thinking`, `high` or `max` are
 *   each refused. Nothing named `max` is advertised anywhere. No effort is ever sent, and an
 *   explicit request is refused rather than ignored — this run's own `max` tier is not
 *   portable to these targets.
 * - Tool permissions arrive as a real `session/request_permission` request carrying
 *   `once`/`always`/`reject`. Permission handling is therefore a *client relay*, not a
 *   sandbox.
 *
 * Because a permission relay cannot confine the agent to a directory, restricted sandboxes
 * are refused rather than approximated: the combination declares only `full-access`, and no
 * working-directory isolation is claimed.
 */
import { join } from 'node:path'
import { commandLaunch, executablePath } from '../../harness-registry.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import { systemEnvironment } from '../environment.ts'
import { fullAccessCliConfig } from '../full-access-config.ts'
import { chatToolCompatibilityLaunch } from '../chat-tool-launch.ts'
import { kiloShellBinding, withKiloShell } from './kilo-shell.ts'
import { buildKiloRouteConfig, kiloModelValue, KILO_SUPPORTED_PROTOCOLS } from './kilo-route.ts'
import {
  assertKiloModelOffered,
  assertKiloModelPinned,
  assertNoKiloEffort,
  isKiloModel,
  KILO_HARNESS,
  KILO_MODEL_OPTION,
  KILO_SET_CONFIG_OPTION,
} from './kilo-models.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  HarnessAdapter,
} from '../types.ts'

export {
  KILO_HARNESS,
  KILO_OFM_PROVIDER,
  KILO_OFM_MODELS,
  KILO_EFFORT_FACTS,
  assertNoKiloEffort,
} from './kilo-models.ts'
export {
  KILO_ROUTE_PROVIDER_ID,
  KILO_SUPPORTED_PROTOCOLS,
  buildKiloRouteConfig,
  kiloModelValue,
} from './kilo-route.ts'
export { KILO_SHELL_FACTS, kiloShellBinding } from './kilo-shell.ts'

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
  return new HarnessConfigurationError(`Kilo（kilo ${version(snapshot)}）${message}`)
}

/**
 * The single model value this session is allowed to run.
 *
 * It is derived from the session record, never from what the agent happens to advertise: an
 * advertisement that offers some other model — including one of Kilo's own `kilo/*` entries,
 * which for two of the declared ids it really does — must not become the target.
 */
function expectedModelValue(record: HarnessSession, describe: (message: string) => Error): string {
  if (!isKiloModel(record.modelRef))
    throw describe('此模型不属于本适配声明的 Kilo 组合；已停止，不会改用其他模型。')
  return kiloModelValue(record.modelRef.model)
}

/**
 * Apply the pinned model and return the advertisement that followed the write.
 *
 * @throws a controlled configuration error when the agent rejects the request. The agent's
 * message is discarded rather than surfaced.
 */
async function applyModel(
  acp: AcpRequestSurface,
  sessionId: string,
  modelValue: string,
  snapshot: AcpSessionSnapshot,
): Promise<unknown> {
  let result: Record<string, any>
  try {
    result = (await acp.request(KILO_SET_CONFIG_OPTION, {
      sessionId,
      configId: KILO_MODEL_OPTION,
      value: modelValue,
    })) as Record<string, any>
  } catch {
    throw failure(
      `拒绝设置 ${KILO_MODEL_OPTION}=${modelValue}（官方 CLI 未接受该配置）。已停止，未发送任何任务。`,
      snapshot,
    )
  }
  return result?.configOptions
}

/**
 * Resolve the launcher for the official CLI, preferring a configured command and falling
 * back to the names the official npm package installs.
 */
export async function kiloPath(options: { command?: string }): Promise<string | undefined> {
  return executablePath(options.command || 'kilo', KILO_HARNESS)
}

/**
 * The suite-owned profile root for the official CLI.
 *
 * The pinned CLI reads `KILO_CONFIG_DIR` for its own configuration, data and state roots.
 * That is the official dedicated profile entry: it isolates this suite's CLI under the
 * suite's home without redefining a process-wide `HOME`, which would also redirect
 * unrelated tools and other suites.
 *
 * `KILO_CONFIG_DIR` is used rather than `HOME`/`CODEX_HOME` on purpose. Neither of those is
 * set or overridden anywhere in this adapter or in the tests: the suite owns exactly one
 * profile entry, and it is the one the official CLI documents.
 *
 * @returns the environment overrides that scope the child to the suite's own profile.
 */
export function kiloProfileRoots(home: string): Record<string, string> {
  return {
    KILO_CONFIG_DIR: join(home, 'kilo/config'),
  }
}

/**
 * Launch the official CLI in its ACP mode over stdio, pinned to the session's directory.
 */
function launch(path: string, cwd: string, prefix: readonly string[] = []) {
  const resolved = commandLaunch(path, [...prefix, 'acp', '--cwd', cwd])
  return {
    command: resolved.command,
    args: resolved.args,
    verbatim: !!resolved.windowsVerbatimArguments,
  }
}

export const kiloAdapter: HarnessAdapter = {
  acpModelId: (ref) => kiloModelValue(ref.model),
  id: KILO_HARNESS,
  transport: 'acp',
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: [...KILO_SUPPORTED_PROTOCOLS],
    customEndpoint: true,
    // Permission decisions reach the client as a real request, but nothing in that exchange
    // confines the agent to a directory or an allow-list: the bash tool runs with host-user
    // filesystem, process and network authority. A restricted sandbox could only be
    // advisory, so it is refused rather than advertised.
    permissions: ['full-access'],
    sessionLoad: true,
    // `session/cancel` answers -32601 on the pinned release. Advertising a cancellation the
    // CLI does not implement would let a caller believe a turn was stopped.
    cancel: false,
    // The paired route models advertise no selectable effort values in the pinned CLI.
    reasoning: 'none',
    autoReview: 'unsupported',
  },
  matches: (ref: ModelRef) => isKiloModel(ref),
  async available(_ctx, options) {
    const path = await kiloPath(options)
    if (!path)
      return {
        available: false,
        reason:
          '未找到官方 Kilo CLI（kilo）。请用官方安装器安装（npm 包 @kilocode/cli 提供 kilo 与 kilocode 两个命令及各平台二进制），安装后重新检测；未安装时可直接在执行引擎里登记其绝对路径。',
      }
    if (!options.modelSources)
      return {
        available: false,
        reason:
          '当前没有已注册的外部模型来源，Our Free Model 尚未声明与官方 kilo 的配对；凭据由模型来源插件管理。',
      }
    return { available: true }
  },
  async prepare(_ctx, record, options) {
    if (record.sandbox !== 'full-access')
      throw new HarnessConfigurationError(
        '官方 Kilo ACP 把工具权限作为请求转发给客户端，但其 bash 工具以宿主用户权限执行，并没有把自身限制在工作目录内的机制。此组合只支持显式授权的 full-access；受限任务已停止，未启动 CLI，也不声称工作目录隔离。',
      )
    // The CLI advertises an `effort` option that offers no values for these models and
    // rejects every write, so an explicit choice is refused rather than silently dropped: a
    // caller who asked for `max` must not run at some other strength without being told.
    if (text(record.reasoningEffort).trim())
      throw new HarnessConfigurationError(
        `官方 Kilo 对本组合声明的模型未广告任何可用推理档位，无法应用所选的 ${text(record.reasoningEffort)}。已停止，未发送任何任务，不会静默降级到其他档位，也不会把本套件的 max 档位套用到未广告该档位的模型。`,
      )
    const path = await kiloPath(options)
    if (!path) throw Error('未找到官方 Kilo CLI（kilo），无法启动此组合')
    if (!options.modelSources)
      throw new HarnessConfigurationError('该模型来源尚未适配此 Harness，已停止，未启动 Kilo。')

    // Capture the source's registration identity before any asynchronous preparation, so a
    // source that is unloaded or re-registered mid-preparation cannot still yield a launch.
    // The registry's own re-check inside `resolve` does not cover the awaits this adapter
    // performs after it.
    const lease = options.modelSources.lease(KILO_HARNESS, record.modelRef)
    const route = await options.modelSources.resolve(
      KILO_HARNESS,
      record.modelRef,
      KILO_SUPPORTED_PROTOCOLS[0],
    )
    const config = buildKiloRouteConfig(route, record.modelRef.model)
    const started = launch(path, record.cwd, options.prefix ?? [])
    // The shell check spawns a real process and is therefore an await point the shared
    // registry cannot cover. A source unloaded, replaced, or re-registered while the probe
    // runs must not still produce a launch.
    const binding = await kiloShellBinding(systemEnvironment())
    lease.assertCurrent()
    return chatToolCompatibilityLaunch(
      {
        home: options.home,
        command: started.command,
        args: started.args,
        // The key is carried in the child's own configuration variable and nowhere else.
        env: {
          ...binding.env,
          ...kiloProfileRoots(options.home),
          OPL_CHAT_EDIT_COMMAND: path,
          OPL_CHAT_EDIT_ARGS: JSON.stringify(options.prefix ?? []),
          // One merged document: the root `shell` the bash tool actually reads, and the
          // provider namespace the model is pinned from.
          KILO_CONFIG_CONTENT: withKiloShell(fullAccessCliConfig(config.content), binding),
          // The suite owns this CLI's updates through the execution engine; a child that
          // replaced itself mid-session would invalidate the pinned version.
          KILO_DISABLE_AUTOUPDATE: '1',
          // An external Harness must not silently reach out for a catalog during preparation;
          // the model list for this pairing comes from the source's own route.
          KILO_DISABLE_MODELS_FETCH: '1',
        },
        ...(started.verbatim ? { windowsVerbatimArguments: true } : {}),
      },
      'kilo',
    )
  },
  async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
    const describe = (message: string) => failure(message, snapshot)
    const modelValue = expectedModelValue(record, describe)
    const sessionId = text(snapshot.session?.sessionId) || record.acpSessionId
    if (!sessionId) throw describe('未返回会话 ID，无法固定模型。')
    // Before the write, the only honest question is whether the exact value is offered: a
    // new or restored session always comes back on the CLI's own default model, so
    // requiring `currentValue` to match here would refuse every usable session. This also
    // covers a restored session: `session/load` does not restore a previously pinned model,
    // so the pinned value is re-asserted rather than assumed to have survived.
    assertKiloModelOffered(modelValue, snapshot.configOptions, describe)
    // The write is idempotent and is the only way to obtain the agent's *current*
    // advertisement, so the pinned model is re-asserted and then read back rather than
    // trusted from the launch configuration or a cached earlier value.
    const configOptions = await applyModel(acp, sessionId, modelValue, snapshot)
    assertKiloModelPinned(modelValue, configOptions, describe)
    return { configOptions }
  },
  verifySession(record, snapshot) {
    const describe = (message: string) => failure(message, snapshot)
    assertKiloModelPinned(expectedModelValue(record, describe), snapshot.configOptions, describe)
  },
}

/** Export the launcher used by the adapter for direct verification in tests. */
export const kiloLaunch = launch
