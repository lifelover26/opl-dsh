/**
 * ACP transport projection over the official StepCode CLI's own JSONL RPC.
 *
 * StepCode ships **no ACP server**. Its documented machine interface is
 * `step --mode rpc` (`packages/coding-agent/docs/rpc.md`), which is a different wire
 * format from ACP: newline-delimited JSON objects keyed by a `type` discriminator,
 * rather than JSON-RPC 2.0. This file bridges the two.
 *
 * **What this file is not.** It owns no agent loop, no model request, no tool
 * execution, no context management and no session format. Each of those stays inside
 * the official `step` process: this bridge launches it, forwards commands, translates
 * the events it streams back, and answers the dialogs it raises. The official product
 * keeps prompting, calling tools and persisting sessions exactly as it does in its own
 * TUI.
 *
 * **Everything asserted here is read back from the official CLI, never assumed.** Three
 * official behaviours make that mandatory, each confirmed against the shipped
 * `step.exe` 0.1.4 in an isolated probe:
 *
 * 1. `set_thinking_level` answers `success: true` for a tier the model does not offer
 *    (`turbo` was accepted). A successful write therefore proves nothing, so a tier is
 *    validated against `get_available_thinking_levels` *before* the write and re-read
 *    from `get_state` afterwards.
 * 2. `switch_session` answers `success: true` for a path that does not exist. Session
 *    identity is therefore confirmed from `get_state().sessionId` after every switch,
 *    and a mismatch refuses the session instead of continuing on other history.
 * 3. A `models.json` written into the agent directory is silently ignored
 *    (`get_available_models` returns `[]`); only the Step config root — the *parent* of
 *    the agent directory — is read. See `./step-config.ts`.
 *
 * For the same reason a turn ends on `agent_settled`, never on `agent_end`: the official
 * product documents `agent_end` as "one low-level agent run completes", which is still
 * followed by automatic retries, compaction or queued follow-ups, and the probe
 * observed exactly that sequence.
 *
 * **Credentials.** The model key arrives through this process's environment under
 * {@link STEP_CREDENTIAL_ENV} and is forwarded to the child under the same name. The
 * generated `models.json` refers to it with the official `$ENV_VAR` interpolation, so
 * the key is never written to a file, an argument vector, or a log line, and error text
 * is scrubbed against it before anything returns to the host.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { join, resolve, sep } from 'node:path'
import { commandLaunch } from '../../harness-registry.ts'
import { RpcTurnOutcome } from '../rpc-turn-outcome.ts'
import {
  nativeContextUpdate,
  nativeContextUsageMeta,
  nativeTurnUsageMeta,
} from '../native-usage.ts'
import { StepTurnUsage, stepContextUsage } from './step-usage.ts'
import {
  STEP_AGENT_DIR_ENV,
  STEP_SESSION_DIR_ENV,
  STEP_STORAGE_ROOT_ENV,
  STEP_CREDENTIAL_ENV,
  buildStepModelsConfig,
  buildStepSettings,
} from './step-config.ts'

// ── Launch contract ────────────────────────────────────────────────────────────────
// Bound by `./step.ts`. Everything here is non-secret except the credential, which is
// read straight from the environment and never copied into a file or a message.
const command = process.env.OPL_STEP_COMMAND ?? ''
const prefix: string[] = JSON.parse(process.env.OPL_STEP_PREFIX ?? '[]')
const agentDir = process.env.OPL_STEP_AGENT_DIR ?? ''
const configRoot = process.env.OPL_STEP_CONFIG_ROOT ?? ''
const sessionDir = process.env.OPL_STEP_SESSION_DIR ?? ''
const sessionIndexDir = process.env.OPL_STEP_SESSION_INDEX_DIR ?? ''
/** Official product storage root (`device-id`, telemetry), forwarded verbatim. */
const storageRoot = process.env[STEP_STORAGE_ROOT_ENV] ?? ''
const provider = process.env.OPL_STEP_PROVIDER ?? ''
const model = process.env.OPL_STEP_MODEL ?? ''
const baseURL = process.env.OPL_STEP_BASE_URL ?? ''
const api = process.env.OPL_STEP_API ?? ''
/** Source-configured context budget; unset leaves the official CLI's effective window in force. */
const contextWindowValue = process.env.OPL_STEP_CONTEXT_WINDOW
const contextWindow = contextWindowValue === undefined ? undefined : Number(contextWindowValue)
/** Whether the lane exposes a reasoning tier; declared per lane by the adapter. */
const reasoning = process.env.OPL_STEP_REASONING === '1'
/** Empty means "the caller expressed no choice"; nothing is written. */
const thinking = process.env.OPL_STEP_THINKING ?? ''
const preset = process.env.OPL_STEP_PRESET ?? ''
const acknowledgeFullAccess = process.env.OPL_STEP_ACKNOWLEDGE_FULL_ACCESS === '1'
const shellPath = process.env.OPL_STEP_SHELL_PATH ?? ''
const credential = process.env[STEP_CREDENTIAL_ENV] ?? ''

/** ACP config-option ids this projection synthesises over the official state. */
const MODEL_OPTION = 'model'
const THINKING_OPTION = 'thinking'
const PERMISSION_OPTION = 'permission'

/** Official dialog methods that block the agent until a response arrives. */
const DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor'])
/** The official Full Access dialog's session-scoped grant option. */
const FULL_ACCESS_OPTION = 'apply full access for this session'

class StepBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly data?: { oplTurnSettled: true; _meta?: object },
  ) {
    super(message)
  }
}

const configuration = (message: string) => new StepBridgeError(message, 'HARNESS_CONFIG')

/**
 * Classify a bridge failure into the error code the host's ACP transport understands.
 *
 * The host maps these codes onto the message a user actually sees
 * (`src/execution/host/acp.ts`), so this choice decides whether a refusal reads as
 * "this combination's parameters were rejected" or as an undifferentiated failure. A
 * configuration refusal therefore uses the standard JSON-RPC `-32602`: a private string
 * code would fall through to the vaguest message the host has.
 */
function acpErrorCode(error: unknown): string | number {
  if (!(error instanceof StepBridgeError)) return -32603
  switch (error.code) {
    case 'HARNESS_CONFIG':
      return -32602
    case 'HARNESS_TIMEOUT':
      return 'HARNESS_TIMEOUT'
    case 'HARNESS_PROVIDER':
    case 'HARNESS_PROVIDER_CLIENT_REQUIRED':
    case 'HARNESS_PROVIDER_AUTH':
    case 'HARNESS_PROVIDER_MODEL':
    case 'HARNESS_PROVIDER_RATE_LIMIT':
    case 'HARNESS_PROVIDER_TIMEOUT':
    case 'HARNESS_PROVIDER_NETWORK':
      return error.code
    case 'HARNESS_TRANSPORT':
      // The official process went away: a broken connection, not a bad request.
      return 'HARNESS_NETWORK'
    default:
      return -32603
  }
}

/** Remove the key from any text that can reach the host, a log or an error. */
function redact(text: string): string {
  return credential ? text.split(credential).join('[redacted]') : text
}

const send = (value: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')

// ── Official CLI child ─────────────────────────────────────────────────────────────
let child: ChildProcessWithoutNullStreams | undefined
let stdoutBuffer = ''
const stdoutDecoder = new StringDecoder('utf8')
let seq = 0
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>()

let sessionId = ''
/**
 * The exact official startup phase.
 *
 * True only between launching the CLI and the first turn. The official product raises
 * its Full Access risk acknowledgment while handling `session_start`, before the host
 * has a session or any task; every other dialog belongs to a task and is a human
 * decision. Binding the acknowledgment to this phase is what stops a task dialog that
 * happens to carry the same option text from being answered by this bridge.
 */
let startupPhase = false
/** Once-only: the startup acknowledgment is granted at most once per process. */
let fullAccessAcknowledged = false
// Turn-scoped cancellation, plus a latch for a cancel that arrives before the turn has
// registered its resolver. `session/cancel` is a notification, so it can be dispatched
// while `session/prompt` is still awaiting its own model read-back; without the latch
// that cancel would be dropped and the cancelled turn would report `end_turn`.
let cancelled = false
let cancelLatched = false
/** True from the moment a prompt is accepted until that turn has fully settled. */
let turnActive = false
let resolveTurn: ((value: unknown) => void) | undefined
let rejectTurn: ((error: Error) => void) | undefined
const turnOutcome = new RpcTurnOutcome()
const turnUsage = new StepTurnUsage(provider, model)
/** Permission asks currently with the host, keyed by the ACP request id. */
const asks = new Map<string, (optionId: string | undefined) => void>()

const emit = (update: object) => {
  if (!sessionId) return
  send({ method: 'session/update', params: { sessionId, update } })
}

/** Reject everything in flight so no caller waits on a process that is gone. */
function failPending(reason: string) {
  turnActive = false
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(new StepBridgeError(reason, 'HARNESS_TRANSPORT'))
  }
  pending.clear()
  for (const release of asks.values()) release(undefined)
  asks.clear()
  rejectTurn?.(new StepBridgeError(reason, 'HARNESS_TRANSPORT'))
  resolveTurn = undefined
  rejectTurn = undefined
}

function releaseEverything(reason = '官方 StepCode 会话已结束') {
  failPending(reason)
  const previous = child
  child = undefined
  previous?.kill('SIGTERM')
}

/** Send one official RPC command and await its correlated `response`. */
function stepRequest(
  type: string,
  extra: Record<string, unknown> = {},
  timeoutMs = 60000,
): Promise<any> {
  if (!child) throw configuration('官方 StepCode 进程未启动')
  const id = ++seq
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id))
        reject(
          new StepBridgeError(
            `官方 StepCode 未在 ${timeoutMs}ms 内回应 ${type}`,
            'HARNESS_TIMEOUT',
          ),
        )
    }, timeoutMs)
    pending.set(id, {
      timer,
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    child!.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n')
  })
}

/** Issue a command that must be accepted; the official failure mode is `success: false`. */
async function stepCommand(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  const response = await stepRequest(type, extra)
  if (response?.success !== true)
    throw configuration(`官方 StepCode 拒绝了 ${type}，已停止，未继续会话。`)
  return response.data
}

// ── Official frames ────────────────────────────────────────────────────────────────

/**
 * Split the official stream on LF only.
 *
 * The official RPC documentation is explicit that Node's `readline` is not
 * protocol-compliant here, because it also splits on U+2028/U+2029, which are valid
 * inside a JSON string. Reimplementing the documented framing instead of importing a
 * generic line reader keeps agent output containing those characters intact.
 */
function drain(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer
  for (;;) {
    const index = rest.indexOf('\n')
    if (index === -1) break
    const raw = rest.slice(0, index)
    rest = rest.slice(index + 1)
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length > 0) onLine(line)
  }
  return rest
}

/**
 * Launch the official CLI in RPC mode.
 *
 * The argument vector is assembled rather than assumed, and deliberately carries **no
 * `--model`**: a `--model` argument resolves against the default `step` provider and
 * fails closed for any custom provider (confirmed by probe), so the model is selected
 * with `set_model` over RPC instead — which is also the read the host pins against.
 */
function openAgent(): void {
  if (child) return
  mkdirSync(configRoot, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(sessionDir, { recursive: true })
  // No `HOME`/`USERPROFILE`/`APPDATA`: the official CLI owns each of its paths behind a
  // dedicated variable, so redirecting those three is what keeps this session off the
  // signed-in user's profile. `STEPCODE_CONFIG_DIR` is left unset on purpose — it is a
  // *name* (`.stepcode`), not a path, and is only consulted when no agent directory is
  // set, which is never the case here.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    [STEP_AGENT_DIR_ENV]: agentDir,
    [STEP_SESSION_DIR_ENV]: sessionDir,
    [STEP_STORAGE_ROOT_ENV]: storageRoot,
    [STEP_CREDENTIAL_ENV]: credential,
  }
  if (preset) env.STEP_PERMISSION_PRESET = preset
  if (shellPath) env.SHELL = shellPath
  const launch = commandLaunch(command, [...prefix, '--mode', 'rpc', '--session-dir', sessionDir])
  const launched = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  }) as ChildProcessWithoutNullStreams
  child = launched
  startupPhase = true
  // stdout carries protocol frames only; stderr is diagnostics and is never reflected.
  launched.stderr.on('data', (chunk: Buffer) => {
    const sink = process.env.OPL_STEP_DIAGNOSTICS_FILE
    if (process.env.OPL_STEP_DIAGNOSTICS === '1' && sink) {
      try {
        appendFileSync(
          sink,
          JSON.stringify({ childStderr: redact(chunk.toString('utf8').slice(0, 800)) }) + '\n',
        )
      } catch {
        // Diagnostics must never fail the run.
      }
    }
  })
  launched.on('error', () => releaseEverything('无法启动官方 StepCode，请检查执行引擎中的安装路径'))
  launched.on('exit', () => releaseEverything('官方 StepCode 进程已退出'))
  launched.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer = drain(stdoutBuffer + stdoutDecoder.write(chunk), handleOfficialLine)
  })
  launched.stdout.on('end', () => {
    stdoutBuffer += stdoutDecoder.end()
    releaseEverything()
  })
}

function handleOfficialLine(line: string): void {
  let message: any
  try {
    message = JSON.parse(line)
  } catch {
    // Non-protocol output means the transport is wrong. It is surfaced rather than
    // dropped, so a broken stream cannot look like silence.
    releaseEverything('官方 StepCode 输出了非协议内容，连接已中断')
    return
  }
  if (message?.type === 'response' && typeof message.id === 'number') {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry.resolve(message)
    return
  }
  if (message?.type === 'extension_ui_request') {
    handleDialog(message)
    return
  }
  if (typeof message?.type === 'string') handleEvent(message)
}

// ── Dialogs ────────────────────────────────────────────────────────────────────────

/**
 * Answer one official dialog.
 *
 * Two cases, deliberately separated:
 *
 * - **The Full Access risk acknowledgment** is raised by the official product while it
 *   handles `session_start`, before the host has a session or any task, and it decides
 *   whether the authorized tier takes effect at all. It is answered only when the
 *   combination's permission policy already authorized `full-access`, only during that
 *   exact startup phase, and only once per process — and always with the session-scoped
 *   option, never the "don't ask again" variant that would write a durable preference
 *   into the user's own profile.
 * - **Any other dialog raised while a task runs** is a real approval decision: it is
 *   forwarded to the host's approval flow and answered by the user.
 *
 * The dialog's own text is agent-controlled, so it never decides which case a dialog
 * falls into. A task dialog carrying the same option text as the startup acknowledgment
 * is relayed for human approval like any other.
 */
function handleDialog(request: any): void {
  const method = String(request?.method ?? '')
  // Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`,
  // `set_editor_text`) expect no response, so they are left alone.
  if (!DIALOG_METHODS.has(method)) return
  const id = String(request?.id ?? '')
  const options: string[] = Array.isArray(request?.options) ? request.options : []
  const text = `${String(request?.title ?? '')}\n${String(request?.message ?? '')}`
  const grantIndex = options.findIndex((option) => option.includes(FULL_ACCESS_OPTION))
  // Read the approval-lifetime state defensively: `typeof` is the only way to probe a
  // binding without throwing, and this function is additionally evaluated in isolation
  // against a hand-built context to prove the gate independently of process state.
  const startupGranted = typeof startupPhase !== 'undefined' && startupPhase === true
  const alreadyAcknowledged =
    typeof fullAccessAcknowledged !== 'undefined' && fullAccessAcknowledged === true
  const turnRunning =
    (typeof turnActive !== 'undefined' && turnActive === true) ||
    (typeof resolveTurn !== 'undefined' && resolveTurn !== undefined)
  // Four conditions, all required. Authorization alone is not enough: the dialog text is
  // agent-controlled, so matching on it would let a task dialog impersonate the startup
  // one. The phase and the in-flight turn are what bind it — a dialog raised while a turn
  // is running is a task approval no matter what it says.
  const isFullAccessAck =
    acknowledgeFullAccess === true &&
    startupGranted &&
    !alreadyAcknowledged &&
    !turnRunning &&
    method === 'select' &&
    grantIndex >= 0

  if (isFullAccessAck) {
    if (typeof fullAccessAcknowledged !== 'undefined') fullAccessAcknowledged = true
    if (typeof startupPhase !== 'undefined') startupPhase = false
    child?.stdin.write(
      JSON.stringify({
        type: 'extension_ui_response',
        id,
        value: options[grantIndex],
      }) + '\n',
    )
    return
  }
  // Any other dialog ends the startup phase: a decision taken later is never the startup
  // acknowledgment, whatever it asks for.
  if (typeof startupPhase !== 'undefined') startupPhase = false

  // A real approval decision: the host asks, the user answers, this bridge only relays.
  const rpcId = `step-permission-${++seq}`
  const respond = (optionId: string | undefined) => {
    asks.delete(rpcId)
    child?.stdin.write(
      JSON.stringify({
        type: 'extension_ui_response',
        id,
        ...(optionId === 'allow' ? { value: options[0] ?? 'allow' } : { cancelled: true }),
      }) + '\n',
    )
  }
  asks.set(rpcId, respond)
  send({
    id: rpcId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: rpcId,
        title: redact(`StepCode · ${method}\n${text}`.slice(0, 2000)),
        kind: 'other',
        rawInput: { method, options },
      },
      options: [
        { optionId: 'allow', name: '允许本次', kind: 'allow_once' },
        { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
      ],
    },
  })
}

/** Resolve the pending permission asks when the host answers one. */
function answerPermission(id: string, outcome: any): void {
  const release = asks.get(id)
  if (!release) return
  const optionId =
    outcome?.outcome === 'selected' && typeof outcome.optionId === 'string'
      ? outcome.optionId
      : undefined
  release(optionId)
}

// ── Official events → ACP updates ──────────────────────────────────────────────────
function handleEvent(event: any): void {
  if (resolveTurn) turnUsage.accept(event)
  switch (event.type) {
    case 'message_update': {
      const delta = event.assistantMessageEvent ?? {}
      if (delta.type === 'text_delta' && typeof delta.delta === 'string')
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta.delta } })
      else if (delta.type === 'thinking_delta' && typeof delta.delta === 'string')
        emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta.delta } })
      return
    }
    case 'tool_execution_start':
      emit({
        sessionUpdate: 'tool_call',
        toolCallId: String(event.toolCallId),
        title: String(event.toolName ?? 'tool'),
        kind: 'other',
        status: 'pending',
        rawInput: event.args ?? {},
      })
      return
    case 'tool_execution_end':
      emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: String(event.toolCallId),
        status: event.isError ? 'failed' : 'completed',
        rawOutput: event.result ?? null,
      })
      return
    case 'message_end':
    case 'auto_retry_end':
      if (resolveTurn) turnOutcome.accept(event)
      return
    case 'auto_retry_start':
      // Surfaced so a stalled turn stays visibly alive instead of looking hung.
      emit({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: `官方 StepCode 正在自动重试（第 ${event.attempt} 次）` },
      })
      return
    case 'agent_settled':
      // The documented "fully settled" signal: no retry, compaction retry or queued
      // continuation remains. `agent_end` is deliberately not a turn end.
      const failure = turnOutcome.failure
      turnOutcome.reset()
      if (!cancelled && failure)
        rejectTurn?.(
          new StepBridgeError('官方渠道报告本轮请求失败', failure, { oplTurnSettled: true }),
        )
      else resolveTurn?.({ stopReason: cancelled ? 'cancelled' : 'end_turn' })
      resolveTurn = undefined
      rejectTurn = undefined
      return
    case 'extension_error':
      emit({
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: redact(`官方 StepCode 扩展报错：${String(event.error ?? '')}`).slice(0, 500),
        },
      })
      return
    default:
      return
  }
}

// ── Pinning and read-back ─────────────────────────────────────────────────────────

async function readState(): Promise<any> {
  const state = await stepRequest('get_state')
  if (state?.success !== true) throw configuration('官方 StepCode 未返回会话状态')
  return state.data
}

/** Optional statistics must not hold a completed answer behind an unresponsive RPC. */
const STATISTICS_TIMEOUT_MS = 2000

/** Fresh context after completion or load; a failed statistics request never retries a prompt. */
async function contextMetadata(): Promise<object> {
  const read = async (type: string): Promise<unknown> => {
    try {
      const response = await stepRequest(type, {}, STATISTICS_TIMEOUT_MS)
      return response?.success === true ? response.data : undefined
    } catch (error) {
      // Optional state/statistics can be unavailable after an otherwise successful turn.
      return undefined
    }
  }
  const [state, stats] = await Promise.all([read('get_state'), read('get_session_stats')])
  const context = stepContextUsage(state, stats, {
    sessionId,
    provider,
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  })
  const update = nativeContextUpdate(context)
  if (update) emit(update)
  return nativeContextUsageMeta(context) ?? {}
}

/** Completed calls belong to this prompt; session-wide token and cost totals are never used. */
async function turnMetadata(interrupted: boolean): Promise<object> {
  const usage = turnUsage.snapshot(interrupted)
  return { ...nativeTurnUsageMeta(usage), ...(await contextMetadata()) }
}

/**
 * Assert the live session runs the exact pinned model.
 *
 * `models.currentModelId` is the authoritative read-back the host also compares; a
 * silent downgrade to another model is refused here rather than found mid-task.
 */
async function assertModel(): Promise<void> {
  const live = (await readState())?.model ?? null
  if (!live || live.id !== model || live.provider !== provider)
    throw configuration(
      `官方 StepCode 当前模型与固定组合不一致（实际 ${live?.provider ?? 'unknown'}/${live?.id ?? 'unknown'}，要求 ${provider}/${model}）；已停止，未发送任务。`,
    )
}

/** The reasoning tiers the pinned model actually advertises. */
async function readThinkingLevels(): Promise<string[]> {
  const response = await stepRequest('get_available_thinking_levels')
  if (response?.success !== true) throw configuration('官方 StepCode 未返回可用思考档位')
  const levels = response?.data?.levels
  return Array.isArray(levels)
    ? levels.filter((v: unknown): v is string => typeof v === 'string')
    : []
}

/**
 * Pin the reasoning tier, validated against the live advertisement first.
 *
 * `set_thinking_level` answers `success: true` for a tier the model does not offer, so
 * the pre-write check is what makes the write meaningful, and the post-write read is
 * what makes it observable.
 */
async function applyThinking(requested?: string): Promise<string | undefined> {
  if (!requested) return undefined
  const levels = await readThinkingLevels()
  if (!levels.includes(requested))
    throw configuration(
      `所选模型未广告思考档位 ${requested}（实际可用：${levels.join('、') || '无'}）；不会改用其他档位，已停止，未发送任务。`,
    )
  await stepCommand('set_thinking_level', { level: requested })
  const live = (await readState())?.thinkingLevel
  if (live !== requested)
    throw configuration(
      `官方 StepCode 思考档位未生效（实际 ${String(live ?? '未知')}，要求 ${requested}），已停止，未发送任务。`,
    )
  return requested
}

/** The config options this projection advertises, all read from live official state. */
async function configOptions(currentThinking?: string): Promise<unknown[]> {
  const state = await readState()
  const levels = await readThinkingLevels()
  return [
    {
      type: 'select',
      id: MODEL_OPTION,
      category: 'model',
      currentValue: state?.model?.id ?? '',
      options: [{ value: model, name: model }],
    },
    {
      type: 'select',
      id: THINKING_OPTION,
      category: 'thought_level',
      currentValue: currentThinking ?? state?.thinkingLevel ?? '',
      options: levels.map((value) => ({ value, name: value })),
    },
    {
      type: 'select',
      id: PERMISSION_OPTION,
      category: 'mode',
      currentValue: preset,
      options: [
        { value: 'ask', name: 'Ask' },
        { value: 'approve-for-me', name: 'Approve for Me' },
        { value: 'full-access', name: 'Full Access' },
      ],
    },
  ]
}

/**
 * A session id is used as a filename, so only an opaque identifier is accepted.
 *
 * Anything carrying a separator, a traversal segment or a control character could
 * otherwise make the index write outside the suite-owned directory, or point the resume
 * at an arbitrary path.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/

/** Reject a session id that cannot safely be used as an index filename. */
function assertSessionIdSafe(id: string): void {
  if (!SAFE_SESSION_ID.test(id))
    throw configuration(
      `官方 StepCode 会话标识不合法，拒绝用于会话索引：${JSON.stringify(id.slice(0, 64))}`,
    )
}

/**
 * Reject a recorded history path that is not inside this session's own storage.
 *
 * The index is suite-owned, but a value in it still decides what `switch_session` opens.
 */
function assertSessionFileContained(file: unknown): string {
  if (typeof file !== 'string' || file.trim().length === 0)
    throw configuration('官方 StepCode 会话记录缺少历史文件路径，拒绝猜测。')
  const resolved = resolve(file)
  const root = resolve(sessionDir)
  if (resolved !== root && !resolved.startsWith(root + sep))
    throw configuration('官方 StepCode 会话历史不在本会话的存储目录内，已拒绝加载。')
  return resolved
}

/**
 * Record where this session's history lives, so `session/load` can find it again.
 *
 * A failure is surfaced rather than swallowed. Swallowing it would let `session/new`
 * succeed while resume silently became impossible, and this bridge advertises
 * `loadSession` — an unusable resume is a lie the user only discovers later.
 */
function rememberSessionFile(file: string): void {
  assertSessionIdSafe(sessionId)
  mkdirSync(sessionIndexDir, { recursive: true })
  const target = join(sessionIndexDir, `${sessionId}.json`)
  writeFileSync(target, JSON.stringify({ sessionFile: assertSessionFileContained(file) }), {
    mode: 0o600,
  })
}

/** Read a recorded session target, refusing anything the suite did not write itself. */
function readSessionIndex(id: string): string {
  assertSessionIdSafe(id)
  let record: unknown
  try {
    record = JSON.parse(readFileSync(join(sessionIndexDir, `${id}.json`), 'utf8'))
  } catch {
    throw configuration(`官方 StepCode 会话 ${id} 没有套件自有的会话记录，拒绝猜测历史来源。`)
  }
  return assertSessionFileContained((record as { sessionFile?: unknown })?.sessionFile)
}

/** Write the credential-blind files the official CLI loads from its config root. */
function writeProviderConfig(): void {
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0))
    throw configuration('模型来源提供的上下文容量无效，已停止，未启动 CLI。')
  mkdirSync(configRoot, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(configRoot, 'models.json'),
    JSON.stringify(
      buildStepModelsConfig({
        provider,
        model,
        baseURL,
        api,
        reasoning,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }),
      null,
      2,
    ),
    { mode: 0o600 },
  )
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify(buildStepSettings(shellPath || undefined), null, 2),
    {
      mode: 0o600,
    },
  )
}

/** Replay a resumed session's history as ACP chunks, so a load shows real content. */
async function replayHistory(): Promise<void> {
  const response = await stepRequest('get_messages')
  const messages = Array.isArray(response?.data?.messages) ? response.data.messages : []
  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
              .map((block: any) => block.text)
              .join('')
          : ''
    if (text.length > 0)
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  }
}

// ── ACP request handling ───────────────────────────────────────────────────────────

async function invoke(method: string, params: any): Promise<unknown> {
  if (method === 'initialize') {
    if (child) throw configuration('官方 StepCode 桥接器已经初始化')
    writeProviderConfig()
    openAgent()
    // Confirm the documented machine interface before the host is told this session can
    // be loaded and resumed.
    const state = await readState()
    if (!state) throw configuration('官方 StepCode 未返回会话状态，无法确认 RPC 接口')
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'step-code', version: `step-rpc ${api}`, model, provider },
    }
  }

  if (method === 'session/new' || method === 'session/load') {
    if (!child) throw configuration('官方 StepCode 桥接器尚未初始化')
    if (method === 'session/load') {
      const wanted = String(params?.sessionId ?? '')
      // Read back the suite-owned index. An unknown id is refused rather than resolved by
      // scanning the session tree or by name similarity.
      const file = readSessionIndex(wanted)
      await stepCommand('switch_session', { sessionPath: file })
      // `switch_session` reports success even for a path that does not exist, so the
      // identity is confirmed from live state rather than from the response.
      const liveId = (await readState())?.sessionId
      if (liveId !== wanted)
        throw configuration(
          `官方 StepCode 恢复的会话身份不一致（实际 ${String(liveId ?? '未知')}，要求 ${wanted}）；已停止，未发送任务。`,
        )
      sessionId = wanted
      await stepCommand('set_model', { provider, modelId: model })
      await assertModel()
      const pinned = await applyThinking(thinking)
      await replayHistory()
      const options = await configOptions(pinned)
      return {
        sessionId,
        models: { currentModelId: model },
        configOptions: options,
        _meta: await contextMetadata(),
      }
    }

    // A second `session/new` would otherwise report the live session's identity as if a
    // new session existed, hiding the fact that only one is supported.
    if (sessionId) throw configuration('本桥接器已持有一个会话，不能再创建第二个会话。')
    const state = await readState()
    const id = String(state?.sessionId ?? '')
    if (!id) throw configuration('官方 StepCode 未返回会话标识')
    assertSessionIdSafe(id)
    sessionId = id
    rememberSessionFile(String(state?.sessionFile ?? ''))
    // Model first: the tier is only meaningful once the model that owns it is selected.
    await stepCommand('set_model', { provider, modelId: model })
    await assertModel()
    const pinned = await applyThinking(thinking)
    const options = await configOptions(pinned)
    return {
      sessionId,
      models: { currentModelId: model },
      configOptions: options,
      _meta: await contextMetadata(),
    }
  }

  // Identity first: a cancel for someone else's session must not reach the official
  // process, which would abort whichever turn this bridge is actually running.
  if (params?.sessionId !== undefined && params.sessionId !== sessionId)
    throw configuration('会话身份不匹配')

  if (method === 'session/cancel') {
    cancelled = turnActive
    cancelLatched = turnActive && !resolveTurn
    // A pending approval would otherwise keep the turn open forever.
    for (const release of asks.values()) release(undefined)
    asks.clear()
    await stepRequest('abort', {}, 30000)
    return {}
  }

  if (method === 'session/set_config_option') {
    const configId = String(params?.configId ?? '')
    const value = String(params?.value ?? '')
    if (configId === MODEL_OPTION) {
      if (value !== model)
        throw configuration(`官方 StepCode 只接受本组合固定的模型 ${model}，拒绝 ${value}。`)
      await stepCommand('set_model', { provider, modelId: model })
      await assertModel()
    } else if (configId === THINKING_OPTION) {
      if (value && value !== thinking)
        throw configuration(`官方 StepCode 只接受本组合固定的思考档位，拒绝 ${value}。`)
      await applyThinking(value)
    } else if (configId === PERMISSION_OPTION) {
      throw configuration('官方 StepCode 的权限档位在启动时固定，会话内不可更改。')
    } else {
      throw configuration(`官方 StepCode 未广告 ${configId} 配置项，无法确认该取值。`)
    }
    const options = await configOptions()
    emit({ sessionUpdate: 'config_option_update', configOptions: options })
    return { configOptions: options }
  }

  if (method === 'session/prompt') {
    const text = (Array.isArray(params?.prompt) ? params.prompt : [])
      .filter((part: any) => part?.type === 'text')
      .map((part: any) => part.text)
      .join('\n')
    // One turn at a time, claimed **before** the first await. Testing `resolveTurn` here
    // would still race: the model read-back below is asynchronous, so a second prompt
    // arriving in that window would replace the first prompt's resolvers and leave its
    // caller waiting forever.
    if (turnActive) throw configuration('上一轮任务尚未结束，拒绝并发发送新任务。')
    turnActive = true
    startupPhase = false
    try {
      // Re-read the live identity before every send, so a drifted session cannot run.
      await assertModel()
    } catch (error) {
      // The turn was never dispatched, so the slot must be released for the next one.
      turnActive = false
      throw error
    }
    turnOutcome.reset()
    turnUsage.reset()
    const done = new Promise<unknown>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    void done.catch(() => undefined)
    // Adopt any cancel that arrived while this turn was being dispatched.
    if (cancelLatched) cancelled = true
    cancelLatched = false
    try {
      await stepCommand('prompt', { message: text })
      const settled = (await done) as { stopReason: string }
      return {
        ...settled,
        _meta: await turnMetadata(settled.stopReason === 'cancelled'),
      }
    } catch (error) {
      if (error instanceof StepBridgeError && error.data?.oplTurnSettled === true)
        throw new StepBridgeError(error.message, error.code, {
          oplTurnSettled: true,
          _meta: await turnMetadata(true),
        })
      throw error
    } finally {
      turnActive = false
      cancelled = false
      cancelLatched = false
      turnOutcome.reset()
      turnUsage.reset()
      resolveTurn = undefined
      rejectTurn = undefined
    }
  }

  throw configuration(`不支持的调用：${method}`)
}

// ── ACP stdio loop ─────────────────────────────────────────────────────────────────
let stdinBuffer = ''

const handleAcpLine = (line: string) => {
  let message: any
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // A response to one of this bridge's own permission requests.
  if (!message.method && message.id !== undefined && typeof message.id === 'string') {
    answerPermission(message.id, message.result?.outcome)
    return
  }
  if (!message.method) return
  const id = message.id
  void (async () => {
    try {
      const result = await invoke(message.method, message.params ?? {})
      if (id !== undefined) send({ id, result })
    } catch (error) {
      const code = acpErrorCode(error)
      if (id !== undefined)
        // These messages are this bridge's own fixed strings, or text this bridge built
        // from the official product's documented vocabulary — never an echo of
        // provider- or agent-controlled output, and always scrubbed of the credential.
        // Suppressing them would leave the user with "call failed" instead of the reason
        // a session refused to start.
        send({
          id,
          error: {
            code,
            message: redact(error instanceof Error ? error.message : '官方 StepCode 调用未完成'),
            ...(error instanceof StepBridgeError && error.data ? { data: error.data } : {}),
          },
        })
      if (process.env.OPL_STEP_DIAGNOSTICS === '1') {
        const entry = JSON.stringify({
          method: message.method,
          error: redact(error instanceof Error ? error.message : 'failure'),
        })
        process.stderr.write(entry + '\n')
        // The host's ACP transport drains this process's stderr, so an optional file sink
        // lets an owner read the same diagnostic after the fact. Diagnostic only: no
        // credential is written, and the file lives in suite-owned storage.
        const sink = process.env.OPL_STEP_DIAGNOSTICS_FILE
        if (sink) {
          try {
            appendFileSync(sink, entry + '\n')
          } catch {
            // Diagnostics must never fail a call.
          }
        }
      }
    }
  })()
}

process.stdin.on('data', (chunk: Buffer) => {
  stdinBuffer = drain(stdinBuffer + chunk.toString('utf8'), handleAcpLine)
})
// The host closed the transport: the official process must not be left running with no
// reader, so it is terminated and its exit is awaited.
process.stdin.on('end', () => {
  releaseEverything('宿主已关闭 ACP 连接')
})

/**
 * Terminate the official process and wait for it to actually exit.
 *
 * `kill` only delivers a signal; returning immediately would let the child outlive this
 * process and keep a session file and a shell open. The wait is bounded so a wedged
 * child cannot hang shutdown forever.
 */
async function shutdown(reason: string): Promise<void> {
  const running = child
  child = undefined
  failPending(reason)
  if (!running || running.exitCode !== null || running.signalCode !== null) {
    resolveTurn = undefined
    rejectTurn = undefined
    return
  }
  const exited = new Promise<void>((done) => running.once('exit', () => done()))
  running.kill('SIGTERM')
  await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 5000))])
  resolveTurn = undefined
  rejectTurn = undefined
}

let shuttingDown = false
const stop = () => {
  if (shuttingDown) return
  shuttingDown = true
  void shutdown('官方 StepCode 会话已结束').then(() => process.exit())
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('exit', () => failPending('桥接器已退出'))
