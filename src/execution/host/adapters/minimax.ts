/**
 * Official MiniMax Code CLI (`mcode`) adapter.
 *
 * Authentication belongs entirely to the official CLI: it stores and refreshes the
 * account credential itself, and this adapter never reads, copies, or logs a token.
 * Nothing here consults the OPL Gateway, so a MiniMax combination never depends on a
 * Gateway key and a missing `mcode login` is never reported as a Gateway problem.
 *
 * The product exposes exactly two models. What each one can be told to do is taken from
 * the installed CLI itself rather than assumed, and the two models differ in kind:
 *
 *  - `MiniMax-M3.1-Flash` declares
 *    `thinking: { effortOptions: ['default','low','medium','high','xhigh','max'] }` and
 *    `thinking_config: { mode: 'forced_on' }`. Thinking is therefore not switchable and
 *    the only real control is the effort, which the CLI advertises as the
 *    `thinkingEffort` config option *after* the owning model is selected.
 *  - `MiniMax-M3` declares no `thinking.effortOptions` at all and
 *    `thinking_config: { mode: 'switchable', default_value: 'true' }`. The CLI
 *    consequently never advertises a `thinkingEffort` option for it: its only control
 *    is the thinking switch carried by the model variant itself.
 *
 * Every selected value is written through the real `session/set_config_option` method
 * and then read back exactly. A refusal, a value the CLI never advertised, or a session
 * that reports a different value afterwards fails the session loudly instead of running
 * at some other strength.
 */
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandLaunch, executablePath, minimaxCodeRoots } from '../harness-registry.ts'
import { HarnessConfigurationError } from '../acp.ts'
import type { ModelRef } from '../../contracts/catalog.ts'
import { systemEnvironment } from './environment.ts'
import { minimaxBashEnvironment, verifyMinimaxBash } from './minimax-bash.ts'
import type {
  AcpRequestSurface,
  AcpSessionConfigureResult,
  AcpSessionSnapshot,
  HarnessAdapter,
} from './types.ts'

export const MINIMAX_CODE_HARNESS = 'minimax-code'
export const MINIMAX_CODE_PROVIDER = 'minimax-official'
/** The ACP provider id the official CLI uses inside its own model config values. */
const ACP_PROVIDER = 'minimax'
/** Wire method that selects the model and the reasoning effort in this CLI. */
const SET_CONFIG_OPTION = 'session/set_config_option'
const MODEL_OPTION = 'model'
const THINKING_EFFORT_OPTION = 'thinkingEffort'
const M3_FLASH = 'MiniMax-M3.1-Flash'
const M3 = 'MiniMax-M3'
/**
 * `iKn` in the official Runtime publishes a catalog's `none-thinking` variant as the
 * *empty* variant, so a variant-free `...:v:` value means "thinking disabled" and
 * `...:v:thinking` means "thinking enabled". Both models advertise both values; M3.1 is
 * `forced_on`, so the CLI rejects its variant-free value with "Invalid model reasoning".
 */
const THINKING_VARIANT = 'thinking'
const NO_THINKING_VARIANT = ''
/**
 * Applied only when the caller expressed no reasoning choice at all. An explicit choice
 * is never rewritten onto this value: `default` stays `default`.
 */
const DEFAULT_EFFORT = 'max'
const DEFAULT_THINKING = 'on'

/** One reasoning setting the official CLI genuinely honors for one model. */
export interface MinimaxReasoningOption {
  /** Opaque id carried by `GenerateOptions.reasoningEffort` and stored on the session. */
  readonly id: string
  readonly name: string
  readonly description?: string
}

/**
 * How a model is steered. `effort` models expose the CLI's `thinkingEffort` option;
 * `thinking` models are steered by the model variant and expose no effort at all.
 */
export interface MinimaxReasoningControl {
  readonly kind: 'effort' | 'thinking'
  /** Selectable settings, in the order the official CLI advertises them. */
  readonly options: readonly MinimaxReasoningOption[]
}

export interface MinimaxCombination {
  readonly model: string
  readonly combination: string
  /** Compact model name only: a reasoning tier never belongs in a model's name. */
  readonly name: string
  readonly control: MinimaxReasoningControl
  /** Used only when the caller stated no reasoning choice. */
  readonly fallback: string
}

/**
 * The complete product surface: one combination per supported model.
 *
 * The effort ids below are the CLI's own `thinking.effortOptions`, so every value sent
 * on the wire is one the official Runtime advertises and accepts.
 *
 * @returns the two combinations in catalog order.
 */
export const minimaxCodeCombinations = (): readonly MinimaxCombination[] => [
  {
    model: M3_FLASH,
    combination: `${MINIMAX_CODE_HARNESS}/${M3_FLASH}`,
    name: M3_FLASH,
    // The effort control only appears after the model is selected, so a chosen effort
    // cannot be validated from the initial `session/new` advertisement.
    control: {
      kind: 'effort',
      options: [
        { id: 'default', name: '默认' },
        { id: 'low', name: '低' },
        { id: 'medium', name: '中' },
        { id: 'high', name: '高' },
        { id: 'xhigh', name: '极高' },
        { id: 'max', name: '最高' },
      ],
    },
    fallback: DEFAULT_EFFORT,
  },
  {
    model: M3,
    combination: `${MINIMAX_CODE_HARNESS}/${M3}`,
    name: M3,
    // The CLI advertises no `thinkingEffort` option for this model, so the only control
    // is the thinking switch. Inventing effort tiers here would be a control the
    // official Runtime never sees.
    control: {
      kind: 'thinking',
      options: [
        { id: 'on', name: '开启思考' },
        { id: 'off', name: '关闭思考' },
      ],
    },
    fallback: DEFAULT_THINKING,
  },
]

/** Resolve the reasoning control and effective id for one model reference. */
export function minimaxReasoning(
  ref: ModelRef,
  requested?: string,
): { spec: MinimaxCombination; id: string } | undefined {
  const spec = minimaxCodeCombinations().find((item) => item.model === ref.model)
  if (!spec || ref.provider !== MINIMAX_CODE_PROVIDER) return undefined
  const choice = typeof requested === 'string' ? requested.trim() : ''
  // An explicit choice is honored verbatim, including `default`; the product fallback is
  // for an absent choice only and never overwrites one the user made.
  if (!choice) return { spec, id: spec.fallback }
  if (!spec.control.options.some((option) => option.id === choice)) return undefined
  return { spec, id: choice }
}

export const minimaxCodeModels = (): readonly ModelRef[] =>
  minimaxCodeCombinations().map((item) => ({ provider: MINIMAX_CODE_PROVIDER, model: item.model }))

export const isMinimaxCodeModel = (ref: ModelRef): boolean =>
  ref.provider === MINIMAX_CODE_PROVIDER &&
  minimaxCodeCombinations().some((item) => item.model === ref.model)

/**
 * Build the encoded `model` config value for a reasoning choice.
 *
 * Effort models are `forced_on`, so their variant is always `thinking` and the effort
 * travels on its own config option. A thinking model's variant *is* the switch.
 */
export function minimaxModelValue(spec: MinimaxCombination, id: string): string {
  const variant =
    spec.control.kind === 'thinking' && id === 'off' ? NO_THINKING_VARIANT : THINKING_VARIANT
  return [
    'm',
    encodeURIComponent(ACP_PROVIDER),
    encodeURIComponent(spec.model),
    'v',
    encodeURIComponent(variant),
  ].join(':')
}

/** Exact `thinkingEffort` value for a reasoning choice, absent for thinking-only models. */
export const minimaxEffortValue = (spec: MinimaxCombination, id: string): string | undefined =>
  spec.control.kind === 'effort' ? id : undefined

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Read one `select` config option out of an advertised `configOptions` array. */
export function configOption(
  configOptions: unknown,
  id: string,
): { currentValue: string; values: string[] } | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const raw of configOptions) {
    const option = raw as Record<string, any> | null
    if (!option || typeof option !== 'object' || option.id !== id) continue
    const values = Array.isArray(option.options)
      ? option.options
          .map((entry: any) => text(entry?.value))
          .filter((value: string) => value.length > 0)
      : []
    return { currentValue: text(option.currentValue), values }
  }
  return undefined
}

const version = (snapshot: AcpSessionSnapshot): string => {
  const info = snapshot.agent?.agentInfo
  const reported = info && typeof info === 'object' ? text((info as any).version) : ''
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(reported) && reported.length <= 64
    ? reported
    : '未知版本'
}

/**
 * Fail with an actionable, credential-free message. The CLI owns its own login, so a
 * missing or stale account is reported as such rather than as a Gateway credential
 * problem, and the message names the exact version that was inspected.
 */
function capabilityFailure(message: string, snapshot: AcpSessionSnapshot): Error {
  return new HarnessConfigurationError(`MiniMax Code（mcode ${version(snapshot)}）${message}`)
}

/**
 * Resolve the launcher for the official CLI, preferring the configured command and
 * falling back to the official installer's default location.
 * @param options - adapter options carrying an optional configured command.
 * @returns the executable path, or undefined when the CLI is not installed.
 */
export async function minimaxCodePath(options: { command?: string }): Promise<string | undefined> {
  return executablePath(options.command || 'mcode', MINIMAX_CODE_HARNESS)
}

/**
 * Report whether the official CLI holds an account credential. Only the presence of
 * the CLI's own credential file is checked: its contents are never opened, so no token
 * is read, copied, or logged, and the CLI stays the sole owner of refresh.
 *
 * This is an availability hint for the picker, not proof of a valid account or quota;
 * the authoritative answer is whatever the CLI itself reports when it connects. An
 * explicit data-directory override is honored exclusively: falling back to the default
 * directory would report a stale login that this process's CLI would never use.
 *
 * @param env - environment used to resolve the CLI data directory override.
 * @returns true when an account credential file exists.
 */
export async function minimaxCodeLoggedIn(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const override = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim()
  if (override) return containsCredential(join(override, 'auth'), 0)
  const home = env.USERPROFILE || env.HOME || homedir()
  return containsCredential(join(home, '.minimax', 'auth'), 0)
}

async function containsCredential(directory: string, depth: number): Promise<boolean> {
  if (depth > 4) return false
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (!entries) return false
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'auth.json') return true
    if (entry.isDirectory() && (await containsCredential(join(directory, entry.name), depth + 1)))
      return true
  }
  return false
}

/** Launch the official CLI in its ACP mode over stdio. */
function launch(path: string, prefix: readonly string[] = []) {
  const resolved = commandLaunch(path, [...prefix, 'acp'])
  return {
    command: resolved.command,
    args: resolved.args,
    verbatim: !!resolved.windowsVerbatimArguments,
  }
}

/**
 * Apply one option and return the config options the agent advertised afterwards.
 *
 * The transport's own message is deliberately not echoed: it can carry arbitrary
 * provider text. The failure names only this suite's own parameter, which is enough to
 * act on and cannot leak account material.
 *
 * @throws a controlled configuration error when the agent rejects the request.
 */
async function applyOption(
  acp: AcpRequestSurface,
  sessionId: string,
  configId: string,
  value: string,
  snapshot: AcpSessionSnapshot,
): Promise<unknown> {
  let result: Record<string, any>
  try {
    result = (await acp.request(SET_CONFIG_OPTION, { sessionId, configId, value })) as Record<
      string,
      any
    >
  } catch {
    throw capabilityFailure(
      `拒绝设置 ${configId}=${value}（官方 CLI 未接受该配置）。已停止，未发送任何任务。`,
      snapshot,
    )
  }
  return result?.configOptions
}

/**
 * Check the required model against an explicit advertisement when one exists.
 * An agent that omits the option is not rejected here: the
 * authoritative round-trip below is what actually decides.
 */
function assertAdvertised(
  spec: MinimaxCombination,
  modelValue: string,
  configOptions: unknown,
  snapshot: AcpSessionSnapshot,
): void {
  const model = configOption(configOptions, MODEL_OPTION)
  if (!model || model.values.includes(modelValue)) return
  throw capabilityFailure(
    `广告的 ${MODEL_OPTION} 不含所需取值 ${modelValue}，已停止，未发送任何任务。`,
    snapshot,
  )
}

/** Verify the session reports exactly the model the reasoning choice requires. */
function assertModelPinned(
  spec: MinimaxCombination,
  modelValue: string,
  configOptions: unknown,
  snapshot: AcpSessionSnapshot,
): void {
  const model = configOption(configOptions, MODEL_OPTION)
  if (!model)
    throw capabilityFailure('当前会话未广告模型配置项，无法确认目标模型，已停止。', snapshot)
  if (model.currentValue !== modelValue)
    throw capabilityFailure(
      `会话当前模型与要求的 ${modelValue} 不一致，已停止，未发送任何任务。`,
      snapshot,
    )
}

/** Verify the session reports exactly the reasoning setting the choice requires. */
function assertReasoningPinned(
  spec: MinimaxCombination,
  effort: string | undefined,
  configOptions: unknown,
  snapshot: AcpSessionSnapshot,
): void {
  if (!effort) return
  const option = configOption(configOptions, THINKING_EFFORT_OPTION)
  if (!option)
    throw capabilityFailure(
      `已选择 ${spec.model}，但未广告 ${THINKING_EFFORT_OPTION} 配置项，无法设置 ${effort} 思考档位。请升级官方 mcode 后重试；已停止，未发送任何任务。`,
      snapshot,
    )
  // The agent's reported value is deliberately not echoed: it is provider-controlled
  // text. Naming only this suite's own requested value is enough to act on.
  if (option.currentValue !== effort)
    throw capabilityFailure(
      `会话思考档位与要求的 ${effort} 不一致，已停止，未发送任何任务。`,
      snapshot,
    )
}

/** Verify the session reports the exact model and, when modeled, the exact effort. */
function assertPinned(
  spec: MinimaxCombination,
  modelValue: string,
  effort: string | undefined,
  configOptions: unknown,
  snapshot: AcpSessionSnapshot,
): void {
  assertModelPinned(spec, modelValue, configOptions, snapshot)
  assertReasoningPinned(spec, effort, configOptions, snapshot)
}

export const minimaxCodeAdapter: HarnessAdapter = {
  id: MINIMAX_CODE_HARNESS,
  transport: 'acp',
  capabilities: {
    transport: 'acp',
    authentication: 'official-account',
    protocols: [],
    customEndpoint: false,
    permissions: ['full-access'],
    sessionLoad: true,
    cancel: true,
    reasoning: 'cli-advertised',
    autoReview: 'unsupported',
  },
  matches: isMinimaxCodeModel,
  async available(_ctx, options) {
    const path = await minimaxCodePath(options)
    if (!path)
      return {
        available: false,
        reason:
          '未找到官方 MiniMax Code CLI（mcode）。请使用 MiniMax 官方安装器安装，安装后重新检测；此组合不依赖 OPL Gateway。',
      }
    if (!(await minimaxCodeLoggedIn()))
      return {
        available: false,
        reason:
          '官方 mcode 尚未登录。请在终端运行 mcode login 完成官方账号登录；凭据由官方 CLI 自行保存与刷新。',
      }
    return { available: true }
  },
  async prepare(_ctx, record, options) {
    if (record.sandbox !== 'full-access')
      throw new HarnessConfigurationError(
        '官方 mcode ACP 未提供可验证的 DSH 只读或工作区限制。此组合只支持显式授权的 full-access；受限任务已停止，未启动 CLI。',
      )
    const path = await minimaxCodePath(options)
    if (!path) throw Error('未找到官方 MiniMax Code CLI（mcode），无法启动此组合')
    const started = launch(path, options.prefix ?? [])
    if (!minimaxReasoning(record.modelRef, record.reasoningEffort))
      throw new HarnessConfigurationError(
        '此模型不属于 MiniMax Code 的可选推理组合，或所选推理设置不被官方支持；已停止，不会自动改用其他模型。',
      )
    return {
      home: options.home,
      command: started.command,
      args: started.args,
      // The official CLI reads, refreshes, and stores its own account credential.
      // The suite injects no key and copies no token into the child environment.
      env: await minimaxBashEnvironment(systemEnvironment()),
      ...(started.verbatim ? { windowsVerbatimArguments: true } : {}),
    }
  },
  async configureSession(acp, record, snapshot): Promise<AcpSessionConfigureResult> {
    verifyMinimaxBash(snapshot)
    const resolved = minimaxReasoning(record.modelRef, record.reasoningEffort)
    if (!resolved)
      throw new HarnessConfigurationError(
        '此模型不属于 MiniMax Code 的可选推理组合，或所选推理设置不被官方支持；已停止。',
      )
    const { spec, id } = resolved
    const modelValue = minimaxModelValue(spec, id)
    const effort = minimaxEffortValue(spec, id)
    const sessionId = text(snapshot.session?.sessionId) || record.acpSessionId
    if (!sessionId) throw capabilityFailure('未返回会话 ID，无法固定模型。', snapshot)
    // An advertisement returned by `session/new` or `session/load` lets the failure
    // name the exact offered values before any write happens.
    if (snapshot.configOptions !== undefined)
      assertAdvertised(spec, modelValue, snapshot.configOptions, snapshot)
    // Authoritative read-back. `session/set_config_option` is idempotent and is the only
    // way to obtain the agent's *current* advertisement, so the selected model is always
    // re-asserted rather than trusted from a default or from a cached earlier value.
    let configOptions = await applyOption(acp, sessionId, MODEL_OPTION, modelValue, snapshot)
    assertModelPinned(spec, modelValue, configOptions, snapshot)
    if (effort) {
      // The effort control is advertised only once the model that owns it is selected,
      // so it is read from the advertisement that followed the model selection.
      const option = configOption(configOptions, THINKING_EFFORT_OPTION)
      if (!option)
        throw capabilityFailure(
          `已选择 ${spec.model}，但未广告 ${THINKING_EFFORT_OPTION} 配置项，无法设置 ${effort} 思考档位。请升级官方 mcode 后重试；已停止，未发送任何任务。`,
          snapshot,
        )
      if (!option.values.includes(effort))
        throw capabilityFailure(
          `广告的 ${THINKING_EFFORT_OPTION} 不含所选取值 ${effort}，已停止，未发送任何任务。`,
          snapshot,
        )
      // Only a differing value is written, so an idempotent reconnect does not re-send
      // a setting the session already reports.
      if (option.currentValue !== effort)
        configOptions = await applyOption(acp, sessionId, THINKING_EFFORT_OPTION, effort, snapshot)
    }
    assertPinned(spec, modelValue, effort, configOptions, snapshot)
    return { configOptions }
  },
  verifySession(record, snapshot) {
    verifyMinimaxBash(snapshot)
    const resolved = minimaxReasoning(record.modelRef, record.reasoningEffort)
    if (!resolved)
      throw new HarnessConfigurationError(
        '此模型不属于 MiniMax Code 的可选推理组合，或所选推理设置不被官方支持；已停止。',
      )
    const { spec, id } = resolved
    assertPinned(
      spec,
      minimaxModelValue(spec, id),
      minimaxEffortValue(spec, id),
      snapshot.configOptions,
      snapshot,
    )
  },
}

/** Export the launcher used by the adapter for direct verification in tests. */
export const minimaxCodeLaunch = launch
/** Roots the official installer writes `mcode` into, reused by discovery tests. */
export { minimaxCodeRoots }
