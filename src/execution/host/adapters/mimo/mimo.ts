/**
 * Official MiMo Code CLI (`mimo`) adapter for the Our Free Model source.
 *
 * The CLI runs its own agent loop over ACP; this adapter contributes only protocol,
 * permission, and pinning rules, exactly as the other external harnesses do. It never
 * implements a loop of its own and never guesses work the public interface already owns.
 *
 * Authentication is not the official MiMo account: the model belongs to a registered
 * model source, so the credential is read by that plugin and reaches this adapter only
 * as a resolved route. Nothing here reads, copies, or logs the key, and the key is
 * never written to a file, a profile, or a repository path.
 *
 * What the official CLI genuinely offers, as of the pinned source:
 *
 *  - `initialize` advertises protocol v1 with `loadSession`, so new and restored
 *    sessions are both real; `session/cancel` aborts a run.
 *  - `session/new` and `session/load` return `configOptions` holding exactly two
 *    selects: `model` and `mode`. There is no reasoning/effort option, so no effort is
 *    ever sent, and a caller that asked for one is refused instead of ignored.
 *  - `session/set_config_option` writes the model and returns the refreshed
 *    advertisement, which is what makes a read-back check possible.
 *  - Permission decisions are forwarded to the client as a real request; nothing about
 *    that exchange restricts the agent to a working directory, so restricted sandboxes
 *    are refused rather than approximated.
 *  - `session/prompt` does not report a model-side failure: it returns `end_turn` with
 *    no body and no tool for a request the model never answered, so a turn is only
 *    reported complete when it produced body text or a completed tool.
 */
import { join } from 'node:path'
import { commandLaunch, executablePath } from '../../harness-registry.ts'
import { HarnessConfigurationError } from '../../acp.ts'
import type { ModelRef } from '../../../contracts/catalog.ts'
import type { HarnessSession } from '../../../contracts/sessions.ts'
import { systemEnvironment } from '../environment.ts'
import { mimoShellEnvironment } from './mimo-shell.ts'
import { buildMimoRouteConfig, mimoModelValue, MIMO_SUPPORTED_PROTOCOLS } from './mimo-route.ts'
import {
  assertMimoModelPinned,
  isMimoCodeModel,
  MIMO_CODE_HARNESS,
  MIMO_MODEL_OPTION,
  MIMO_SET_CONFIG_OPTION,
} from './mimo-models.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  HarnessAdapter,
  HarnessResultVerdict,
  HarnessTurnOutcome,
} from '../types.ts'

export { MIMO_CODE_HARNESS, MIMO_OFM_PROVIDER, MIMO_OFM_MODEL } from './mimo-models.ts'
export { MIMO_AMD_MODEL, MIMO_OFM_MODELS } from './mimo-models.ts'
export {
  MIMO_ROUTE_PROVIDER_ID,
  MIMO_SUPPORTED_PROTOCOLS,
  buildMimoRouteConfig,
  mimoModelValue,
} from './mimo-route.ts'
export { MIMO_SHELL_FACTS, mimoShellEnvironment } from './mimo-shell.ts'

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
 * The transport's own error text is never echoed: it is provider-controlled and can
 * carry arbitrary content. Only this suite's own parameters appear in the message, so
 * a failure can never leak the credential or the endpoint that produced it.
 */
function failure(message: string, snapshot: AcpSessionSnapshot): Error {
  return new HarnessConfigurationError(`MiMo Code（mimo ${version(snapshot)}）${message}`)
}

/**
 * The single model value this session is allowed to run.
 *
 * It is derived from the session record, never from what the agent happens to
 * advertise: an advertisement that offers some other model — even the only one in the
 * suite's own namespace — must not become the target.
 */
function expectedModelValue(record: HarnessSession, describe: (message: string) => Error): string {
  if (!isMimoCodeModel(record.modelRef))
    throw describe('此模型不属于本适配声明的 MiMo Code 组合；已停止，不会改用其他模型。')
  return mimoModelValue(record.modelRef.model)
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
    result = (await acp.request(MIMO_SET_CONFIG_OPTION, {
      sessionId,
      configId: MIMO_MODEL_OPTION,
      value: modelValue,
    })) as Record<string, any>
  } catch {
    throw failure(
      `拒绝设置 ${MIMO_MODEL_OPTION}=${modelValue}（官方 CLI 未接受该配置）。已停止，未发送任何任务。`,
      snapshot,
    )
  }
  return result?.configOptions
}

/**
 * Resolve the launcher for the official CLI, preferring a configured command and
 * falling back to the name the official installer writes.
 */
export async function mimoCodePath(options: { command?: string }): Promise<string | undefined> {
  return executablePath(options.command || 'mimo', MIMO_CODE_HARNESS)
}

/**
 * The suite-owned profile root for the official CLI.
 *
 * `MIMOCODE_HOME` is the CLI's documented isolation override: it relocates the config,
 * data, auth and database roots away from `%LOCALAPPDATA%\mimocode` and
 * `~/.local/share/mimocode`, while still persisting across restarts so `session/load`
 * can resume. `HOME` and `CODEX_HOME` are deliberately left alone — redefining a
 * process-wide home would also redirect unrelated tools and other suites.
 */
export function mimoProfileHome(home: string): string {
  return join(home, 'mimocode')
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

/**
 * Refuse the empty `end_turn` that official MiMo Code reports for a request the
 * model never answered.
 *
 * MiMo Code 0.1.15 builds its ACP prompt result from the SDK reply without
 * inspecting the assistant message's error, so a controlled HTTP 400 and a
 * controlled HTTP 429 both come back as `stopReason: end_turn` with zero usage,
 * no body and no tool. This suite rejects that shape instead of publishing a
 * completed turn, because a completed turn is what the queue, the notification
 * and the user all read as real finished work.
 *
 * Accepted outcomes, both of which are work the user actually asked for:
 *
 *  - body text on its own — the answer is the deliverable, tool calls or not;
 *  - at least one tool that actually completed — a silent run that really did the
 *    work is still work, and requiring prose to certify it would reject it.
 *
 * Reasoning never counts as body, so a turn that only thought is empty. A tool
 * that failed, was still pending, or never reported a status is not a completed
 * tool either: on its own it leaves nothing to show, and it must not be dressed
 * up as success. Body text still wins when both are present, because the model
 * then told the user about the failure in its own words.
 *
 * The transport carries no original HTTP status and no upstream error text, so
 * none is reconstructed or guessed here. The refusal states only what was
 * observed, and the request is never replayed against another model or channel.
 */
export function acceptMimoTurnResult(outcome: HarnessTurnOutcome): HarnessResultVerdict {
  const hasBody = outcome.text.trim().length > 0
  const completedTools = outcome.tools.filter((tool) => tool.status === 'completed').length
  if (hasBody || completedTools > 0) return { accepted: true }
  return {
    accepted: false,
    reason:
      'MiMo Code 报告 end_turn，但本轮既没有正文，也没有任何已完成的工具结果；该请求实际未完成。原任务未自动重发，也未改用其他模型或渠道。',
  }
}

export const mimoCodeAdapter: HarnessAdapter = {
  id: MIMO_CODE_HARNESS,
  transport: 'acp',
  capabilities: {
    transport: 'acp',
    authentication: 'api-source',
    protocols: [...MIMO_SUPPORTED_PROTOCOLS],
    customEndpoint: true,
    // The CLI forwards permission decisions to the client but exposes no way to hold
    // itself to a directory, so a restricted sandbox cannot be honoured or verified.
    permissions: ['full-access'],
    sessionLoad: true,
    cancel: true,
    // The CLI advertises only `model` and `mode`; no effort exists to be selected.
    reasoning: 'none',
    autoReview: 'unsupported',
  },
  matches: (ref: ModelRef) => isMimoCodeModel(ref),
  acpModelId: (ref) => mimoModelValue(ref.model),
  async available(_ctx, options) {
    const path = await mimoCodePath(options)
    if (!path)
      return {
        available: false,
        reason:
          '未找到官方 MiMo Code CLI（mimo）。请用官方安装器 https://mimo.xiaomi.com/install 安装（默认落在 ~/.mimocode/bin/mimo），安装后重新检测；未安装时可直接在执行引擎里登记其绝对路径。',
      }
    if (!options.modelSources)
      return {
        available: false,
        reason:
          '当前没有已注册的外部模型来源，Our Free Model 尚未声明与官方 mimo 的配对；凭据由模型来源插件管理。',
      }
    return { available: true }
  },
  async prepare(_ctx, record, options) {
    if (record.sandbox !== 'full-access')
      throw new HarnessConfigurationError(
        '官方 mimo ACP 未提供可验证的只读或工作区限制。此组合只支持显式授权的 full-access；受限任务已停止，未启动 CLI，也不声称工作目录隔离。',
      )
    // The CLI advertises no reasoning option, so an explicit choice is refused rather
    // than silently dropped: a caller who asked for `max` must not run at some other
    // strength without being told.
    if (text(record.reasoningEffort).trim())
      throw new HarnessConfigurationError(
        `官方 mimo 未广告推理档位配置项，无法应用所选的 ${text(record.reasoningEffort)}。已停止，未发送任何任务，不会改用其他模型或档位。`,
      )
    const path = await mimoCodePath(options)
    if (!path) throw Error('未找到官方 MiMo Code CLI（mimo），无法启动此组合')
    if (!options.modelSources)
      throw new HarnessConfigurationError('该模型来源尚未适配此 Harness，已停止，未启动 mimo。')
    // Capture the registration before any await. The lease is the shared registry's own
    // check: it covers both removal and replacement of the registration, which a bare
    // `supports()` re-read cannot distinguish.
    const lease = options.modelSources.lease(MIMO_CODE_HARNESS, record.modelRef)
    // Resolves through the owning plugin and re-checks it after the read, so a source
    // that was unloaded or replaced mid-resolve cannot authorize this launch.
    const route = await options.modelSources.resolve(
      MIMO_CODE_HARNESS,
      record.modelRef,
      MIMO_SUPPORTED_PROTOCOLS[0],
    )
    const config = buildMimoRouteConfig(route, record.modelRef.model)
    const started = launch(path, record.cwd, options.prefix ?? [])
    // The shell check spawns a real process and is therefore an await point the shared
    // registry cannot cover: it only re-checks around its own `resolve`. A source
    // unloaded or replaced while the probe runs must not still yield a launch.
    const env = await mimoShellEnvironment(systemEnvironment())
    lease.assertCurrent()
    return {
      home: options.home,
      command: started.command,
      args: started.args,
      // The key is carried in the child's own configuration variable and nowhere else.
      env: {
        ...env,
        MIMOCODE_CONFIG_CONTENT: config.content,
        MIMOCODE_HOME: mimoProfileHome(options.home),
      },
      ...(started.verbatim ? { windowsVerbatimArguments: true } : {}),
    }
  },
  async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
    const describe = (message: string) => failure(message, snapshot)
    const modelValue = expectedModelValue(record, describe)
    const sessionId = text(snapshot.session?.sessionId) || record.acpSessionId
    if (!sessionId) throw describe('未返回会话 ID，无法固定模型。')
    // The advertisement is checked against the record before anything is written, so a
    // session that offers only a different model fails without a single write.
    assertMimoModelPinned(modelValue, snapshot.configOptions, describe)
    // The write is idempotent and is the only way to obtain the agent's *current*
    // advertisement, so the pinned model is re-asserted and then read back rather than
    // trusted from the launch configuration or a cached earlier value.
    const configOptions = await applyModel(acp, sessionId, modelValue, snapshot)
    assertMimoModelPinned(modelValue, configOptions, describe)
    return { configOptions }
  },
  verifySession(record, snapshot) {
    const describe = (message: string) => failure(message, snapshot)
    assertMimoModelPinned(expectedModelValue(record, describe), snapshot.configOptions, describe)
  },
  acceptResult: acceptMimoTurnResult,
}

/** Export the launcher used by the adapter for direct verification in tests. */
export const mimoCodeLaunch = launch
