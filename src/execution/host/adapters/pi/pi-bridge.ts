/**
 * ACP transport projection over the official Pi Coding Agent CLI's own JSONL RPC.
 *
 * Pi ships **no ACP server**. Its documented machine interface is `pi --mode rpc`
 * (official `docs/rpc.md`), which is a different wire format from ACP: newline-delimited
 * JSON objects keyed by a `type` discriminator, rather than JSON-RPC 2.0. This file
 * bridges the two.
 *
 * **What this file is not.** It owns no agent loop, no model request, no tool execution, no
 * context management and no session format. Each of those stays inside the official `pi`
 * process: this bridge launches it, forwards commands, translates the events it streams
 * back, and relays the dialogs it raises. The official product keeps prompting, calling
 * tools and persisting sessions exactly as it does in its own TUI.
 *
 * **Everything asserted here is read back from the official CLI, never assumed.** Four
 * official behaviours make that mandatory, each confirmed against the shipped 1.2.0 bundle
 * in an isolated probe with a controlled loopback provider:
 *
 * 1. `set_thinking_level` answers `success: true` for a level the model does not advertise.
 *    A probe asked for `max` against a model advertising `["off" … "high"]`, was told
 *    `success: true`, and `get_state().thinkingLevel` came back `high`. A successful write
 *    therefore proves nothing, so a tier is validated against `get_available_thinking_levels`
 *    *before* the write and re-read from `get_state` afterwards.
 * 2. `switch_session` answers `success: true` for a path that does not exist. A probe asked
 *    for a missing file, was told `success: true`, and the session silently became a *new*
 *    one with a different id. Session identity is therefore confirmed from
 *    `get_state().sessionId` after every switch, and a mismatch refuses the session instead
 *    of continuing on other history.
 * 3. `models.json` is read from **inside** the agent directory named by
 *    `PI_CODING_AGENT_DIR` — confirmed by enumerating the declared rows through
 *    `get_available_models`. The config root is not a parent of the agent directory, so
 *    there is no layout trap here beyond writing the file at all.
 * 4. A row's `reasoning` flag is what builds the thinking-level advertisement: a
 *    `reasoning: true` row advertised the full vocabulary, a row without it advertised
 *    only `["off"]`. A wrongly declared lane therefore loses its tier silently, which is why
 *    the declaration lives in `./pi-models.ts` per lane.
 *
 * For the same reason a turn ends on `agent_settled`, never on `agent_end`: the official
 * documentation defines `agent_end` as one low-level agent run, still followed by retries,
 * compaction or queued follow-ups — and the probe observed exactly `auto_retry_start` and
 * `auto_retry_end` bracketing the retry around a run that had already ended.
 *
 * **One shell for the model tool and for `!`.** The official Windows documentation states
 * that a single `shellPath` setting serves both the model-facing `bash` tool and the user's
 * `!` / `!!` commands. This bridge writes that one value into `settings.json` and never
 * configures a second surface, so the two cannot select different shells.
 *
 * **Credentials.** The model key arrives through this process's environment under
 * {@link PI_CREDENTIAL_ENV} and is forwarded to the child under the same name. The
 * generated `models.json` refers to it with the official `$ENV_VAR` interpolation, so the
 * key is never written to a file, an argument vector, or a log line, and error text is
 * scrubbed against it before anything returns to the host.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { commandLaunch } from '../../harness-registry.ts'
import { RpcTurnOutcome } from '../rpc-turn-outcome.ts'
import { PI_CREDENTIAL_ENV, buildPiModelsConfig, buildPiSettings } from './pi-config.ts'
import { PI_PROVIDER, piLane } from './pi-models.ts'
import { PiTurnUsage, piContextUsage, piSessionStatsUsage } from './pi-usage.ts'

// ── Launch contract ────────────────────────────────────────────────────────────────
// Bound by `./pi.ts`. Everything here is non-secret except the credential, which is read
// straight from the environment and never copied into a file or a message.
const command = process.env.OPL_PI_COMMAND ?? ''
const prefix: string[] = JSON.parse(process.env.OPL_PI_PREFIX ?? '[]')
const agentDir = process.env.OPL_PI_AGENT_DIR ?? ''
const sessionDir = process.env.OPL_PI_SESSION_DIR ?? ''
const sessionIndexDir = process.env.OPL_PI_SESSION_INDEX_DIR ?? ''
const provider = process.env.OPL_PI_PROVIDER ?? ''
const model = process.env.OPL_PI_MODEL ?? ''
const baseURL = process.env.OPL_PI_BASE_URL ?? ''
const api = process.env.OPL_PI_API ?? ''
/** Whether the lane exposes a reasoning tier; declared per lane by the adapter. */
const reasoning = process.env.OPL_PI_REASONING === '1'
/** Toggle-only lanes keep the channel's default without advertising a Pi effort. */
const upstreamThinking = piLane({ provider: PI_PROVIDER, model })?.thinking === 'upstream-default'
/** Last verified explicit choice, restored on load and fork; empty preserves the CLI default. */
let thinking = process.env.OPL_PI_THINKING ?? ''
const permissionTier = process.env.OPL_PI_PERMISSION_TIER ?? ''
const shellPath = process.env.OPL_PI_SHELL_PATH ?? ''
const credential = process.env[PI_CREDENTIAL_ENV] ?? ''

/** ACP config-option ids this projection synthesises over the official state. */
const MODEL_OPTION = 'model'
const THINKING_OPTION = 'thinking'
const PERMISSION_OPTION = 'permission'

/** Official dialog methods that block the agent until a response arrives. */
const DIALOG_METHODS = new Set(['confirm', 'select', 'input', 'editor'])

class PiBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly turnSettled = false,
  ) {
    super(message)
  }
}

const configuration = (message: string) => new PiBridgeError(message, 'HARNESS_CONFIG')

/**
 * Classify a bridge failure into the error code the host's ACP transport understands.
 *
 * The host maps these codes onto the message a user actually sees
 * (`src/execution/host/acp.ts`), so this choice decides whether a refusal reads as "this
 * combination's parameters were rejected" or as an undifferentiated failure. A
 * configuration refusal therefore uses the standard JSON-RPC `-32602`: a private string
 * code would fall through to the vaguest message the host has.
 */
function acpErrorCode(error: unknown): string | number {
  if (!(error instanceof PiBridgeError)) return -32603
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
 * A first-message fork allocates a session file lazily. Until the replacement prompt
 * appends its user message the file does not exist, so the identity is reported as
 * ephemeral and its index entry is written only after the file appears.
 */
let ephemeralFile = ''
// Turn-scoped cancellation, plus a latch for a cancel that arrives before the turn has
// registered its resolver. `session/cancel` is a notification, so it can be dispatched
// while `session/prompt` is still awaiting its own model read-back; without the latch that
// cancel would be dropped and the cancelled turn would report `end_turn`.
let cancelled = false
let cancelLatched = false
let resolveTurn: ((value: unknown) => void) | undefined
let rejectTurn: ((error: Error) => void) | undefined
const turnOutcome = new RpcTurnOutcome()
const turnUsage = new PiTurnUsage(provider, model)
/** Permission asks currently with the host, keyed by the ACP request id. */
const asks = new Map<string, (optionId: string | undefined) => void>()

const emit = (update: object) => {
  if (!sessionId) return
  send({ method: 'session/update', params: { sessionId, update } })
}

/** Reject everything in flight so no caller waits on a process that is gone. */
function failPending(reason: string) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(new PiBridgeError(reason, 'HARNESS_TRANSPORT'))
  }
  pending.clear()
  for (const release of asks.values()) release(undefined)
  asks.clear()
  rejectTurn?.(new PiBridgeError(reason, 'HARNESS_TRANSPORT'))
  resolveTurn = undefined
  rejectTurn = undefined
}

function releaseEverything(reason = '官方 Pi 会话已结束') {
  failPending(reason)
  const previous = child
  child = undefined
  previous?.kill('SIGTERM')
}

/** Send one official RPC command and await its correlated `response`. */
function piRequest(
  type: string,
  extra: Record<string, unknown> = {},
  timeoutMs = 60000,
): Promise<any> {
  if (!child) throw configuration('官方 Pi 进程未启动')
  const id = ++seq
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id))
        reject(new PiBridgeError(`官方 Pi 未在 ${timeoutMs}ms 内回应 ${type}`, 'HARNESS_TIMEOUT'))
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
async function piCommand(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  const response = await piRequest(type, extra)
  if (response?.success !== true)
    throw configuration(`官方 Pi 拒绝了 ${type}，已停止，未继续会话。`)
  return response.data
}

// ── Official frames ────────────────────────────────────────────────────────────────

/**
 * Split the official stream on LF only.
 *
 * The official RPC documentation is explicit that Node's `readline` is not
 * protocol-compliant here, because it also splits on U+2028/U+2029, which are valid inside
 * a JSON string. Reimplementing the documented framing instead of importing a generic line
 * reader keeps agent output containing those characters intact.
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
 * `--model`**: `--model` resolves against the catalog Pi discovers for itself and would be
 * a second, unverified way to select a model. The model is selected with `set_model` over
 * RPC instead — which is also the read the host pins against. `--session-dir` is passed
 * because the official docs give it the highest precedence over both the environment
 * variable and the `sessionDir` setting.
 */
function openAgent(): void {
  if (child) return
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(sessionDir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    [PI_CREDENTIAL_ENV]: credential,
  }
  const shellInstructions =
    process.platform === 'win32' ? ['--append-system-prompt', join(agentDir, 'opl-shell.md')] : []
  const launch = commandLaunch(command, [
    ...prefix,
    '--mode',
    'rpc',
    '--session-dir',
    sessionDir,
    ...shellInstructions,
  ])
  const launched = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  }) as ChildProcessWithoutNullStreams
  child = launched
  // stdout carries protocol frames only; stderr is diagnostics and is never reflected.
  launched.stderr.resume()
  launched.on('error', () => releaseEverything('无法启动官方 Pi，请检查执行引擎中的安装路径'))
  launched.on('exit', () => releaseEverything('官方 Pi 进程已退出'))
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
    // Non-protocol output means the transport is wrong. It is surfaced rather than dropped,
    // so a broken stream cannot look like silence.
    releaseEverything('官方 Pi 输出了非协议内容，连接已中断')
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
 * Relay one official dialog to the host's real approval flow.
 *
 * Pi has no approval gate for ordinary tool calls — the official security documentation
 * states it runs with the user's own permissions and does not ask before every call — so a
 * `confirm`/`select`/`input`/`editor` request here is something the official product
 * genuinely wants a human to decide. It is therefore always relayed and answered by the
 * user, and this bridge never auto-answers one: answering it here would invent an approval
 * the product asked a person for. `notify`, `setStatus`, `setWidget`, `setTitle` and
 * `set_editor_text` are fire-and-forget methods that expect no response and are left alone.
 */
function handleDialog(request: any): void {
  const method = String(request?.method ?? '')
  if (!DIALOG_METHODS.has(method)) return
  const id = String(request?.id ?? '')
  const options: string[] = Array.isArray(request?.options) ? request.options : []
  const text = `${String(request?.title ?? '')}\n${String(request?.message ?? '')}`

  const rpcId = `pi-permission-${++seq}`
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
        title: redact(`Pi · ${method}\n${text}`.slice(0, 2000)),
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
  persistEphemeral()
  if (event.type === 'message_start' || event.type === 'message_end') turnUsage.accept(event)
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
        content: { type: 'text', text: `官方 Pi 正在自动重试（第 ${event.attempt} 次）` },
      })
      return
    case 'compaction_start':
      emit({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '官方 Pi 正在压缩上下文' },
      })
      return
    case 'extension_error':
      emit({
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: redact(`官方 Pi 扩展报错：${String(event.error ?? '')}`).slice(0, 500),
        },
      })
      return
    case 'agent_settled':
      // The documented "fully settled" signal: no retry, compaction retry or queued
      // continuation remains. `agent_end` is deliberately not a turn end — the probe saw
      // `auto_retry_start` after one, and the docs list retries, compaction and follow-ups
      // as things that can still follow it.
      const failure = turnOutcome.failure
      turnOutcome.reset()
      if (!cancelled && failure)
        rejectTurn?.(new PiBridgeError('官方渠道报告本轮请求失败', failure, true))
      else resolveTurn?.({ stopReason: cancelled ? 'cancelled' : 'end_turn' })
      resolveTurn = undefined
      rejectTurn = undefined
      return
    default:
      return
  }
}

// ── Pinning and read-back ─────────────────────────────────────────────────────────
async function readState(): Promise<any> {
  const state = await piRequest('get_state')
  if (state?.success !== true) throw configuration('官方 Pi 未返回会话状态')
  return state.data
}

/** Read the installed RPC's cumulative statistics without making them required for a turn. */
async function readSessionStats(): Promise<any | undefined> {
  try {
    const response = await piRequest('get_session_stats')
    return response?.success === true ? response.data : undefined
  } catch {
    return undefined
  }
}

/** Attach only validated usage metadata; provider-controlled fields never cross this bridge. */
async function settleMetadata(): Promise<Record<string, unknown>> {
  let usage = turnUsage.snapshot()
  let contextUsage: { used?: number; size?: number; estimated?: boolean } | undefined
  try {
    const [state, stats] = await Promise.all([readState(), readSessionStats()])
    usage ??= piSessionStatsUsage(stats, { provider, model })
    contextUsage = piContextUsage(state, stats, { sessionId, provider, model })
  } catch {
    contextUsage = undefined
  }
  const metadata: Record<string, unknown> = {}
  if (usage) metadata['opl/turnUsage'] = { version: 1, usage }
  if (contextUsage) metadata['opl/contextUsage'] = contextUsage
  return metadata
}

/**
 * Assert the live session runs the exact pinned model.
 *
 * `get_state().model` is the authoritative read-back the host also compares; a silent
 * downgrade to another model is refused here rather than found mid-task.
 */
async function assertModel(): Promise<void> {
  const live = (await readState())?.model ?? null
  if (!live || live.id !== model || live.provider !== provider)
    throw configuration(
      `官方 Pi 当前模型与固定组合不一致（实际 ${live?.provider ?? 'unknown'}/${live?.id ?? 'unknown'}，要求 ${provider}/${model}）；已停止，未发送任务。`,
    )
}

/** The reasoning tiers the pinned model actually advertises. */
async function readThinkingLevels(): Promise<string[]> {
  const response = await piRequest('get_available_thinking_levels')
  if (response?.success !== true) throw configuration('官方 Pi 未返回可用思考档位')
  const levels = response?.data?.levels
  return Array.isArray(levels)
    ? levels.filter((v: unknown): v is string => typeof v === 'string')
    : []
}

/**
 * Pin the reasoning tier, validated against the live advertisement first.
 *
 * `set_thinking_level` answers `success: true` for a tier the model does not offer and
 * silently clamps it, so the pre-write check is what makes the write meaningful and the
 * post-write read is what makes it observable. Without both, a lane that never advertised
 * `max` would appear to accept it and then quietly run at a lower tier.
 */
async function applyThinking(requested?: string): Promise<string | undefined> {
  if (!requested) return undefined
  if (upstreamThinking)
    throw configuration('此模型保留渠道默认思考设置，不提供可选思考档位；已停止，未发送任务。')
  const levels = await readThinkingLevels()
  if (!levels.includes(requested))
    throw configuration(
      `所选模型未广告思考档位 ${requested}（实际可用：${levels.join('、') || '无'}）；不会改用其他档位，已停止，未发送任务。`,
    )
  await piCommand('set_thinking_level', { level: requested })
  const live = (await readState())?.thinkingLevel
  if (live !== requested)
    throw configuration(
      `官方 Pi 思考档位未生效（实际 ${String(live ?? '未知')}，要求 ${requested}），已停止，未发送任务。`,
    )
  thinking = requested
  return requested
}

/** The config options this projection advertises, all read from live official state. */
async function configOptions(currentThinking?: string): Promise<unknown[]> {
  const state = await readState()
  const levels = upstreamThinking ? undefined : await readThinkingLevels()
  return [
    {
      type: 'select',
      id: MODEL_OPTION,
      category: 'model',
      currentValue: state?.model?.id ?? '',
      options: [{ value: model, name: model }],
    },
    ...(levels
      ? [
          {
            type: 'select',
            id: THINKING_OPTION,
            category: 'thought_level',
            currentValue: currentThinking ?? state?.thinkingLevel ?? '',
            options: levels.map((value) => ({ value, name: value })),
          },
        ]
      : []),
    {
      type: 'select',
      id: PERMISSION_OPTION,
      category: 'mode',
      currentValue: permissionTier,
      options: [{ value: 'full-access', name: 'Full Access（官方 Pi 无审批门，无隔离）' }],
    },
  ]
}

/** Record where this session's history lives, so `session/load` can find it again. */
function rememberSessionFile(file: string): void {
  if (!file) return
  try {
    mkdirSync(sessionIndexDir, { recursive: true })
    writeFileSync(
      join(sessionIndexDir, `${sessionId}.json`),
      JSON.stringify({ sessionFile: file }),
      {
        mode: 0o600,
      },
    )
  } catch {
    // A missing index costs the ability to resume, never the correctness of the run.
  }
}

/** Once a lazy first-fork file appears, publish its index entry exactly once. */
function persistEphemeral(): void {
  if (!ephemeralFile || !existsSync(ephemeralFile)) return
  rememberSessionFile(ephemeralFile)
  ephemeralFile = ''
}

/** Write the credential-blind files the official CLI loads from its agent directory. */
function writeProviderConfig(): void {
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(sessionDir, { recursive: true })
  if (process.platform === 'win32')
    writeFileSync(
      join(agentDir, 'opl-shell.md'),
      'The bash tool runs Git for Windows Bash, not cmd.exe or PowerShell. Use POSIX shell syntax: ls instead of dir /b, /dev/null instead of nul, and quoted forward-slash paths such as "C:/Users/name" or /c/Users/name. A Windows host does not imply CMD syntax.\n',
      { mode: 0o600 },
    )
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify(buildPiModelsConfig({ provider, model, baseURL, api, reasoning }), null, 2),
    { mode: 0o600 },
  )
  // One `shellPath` is the whole shell story: the official product resolves both the
  // model-facing `bash` tool and the user's `!` commands from this single setting, so the
  // two surfaces cannot select different shells.
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify(buildPiSettings(shellPath || undefined), null, 2),
    {
      mode: 0o600,
    },
  )
}

/** Replay a resumed session's history as ACP chunks, so a load shows real content. */
async function replayHistory(): Promise<void> {
  const response = await piRequest('get_messages')
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

// ── Private edit protocol over the official RPC ────────────────────────────────────
// The host's Pi driver calls these two ACP extension methods. Both answer a structured
// `{ok:false, code}` for an expected refusal and throw only for a transport failure, so
// the driver never parses bridge text. No method here sends a replacement prompt, writes a
// HarnessSession, edits a DSH log, reverts files or deletes an old branch.

class EditRefusal extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

const refuse = (code: string): never => {
  throw new EditRefusal(code)
}

const object = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}

function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort)
    if (input && typeof input === 'object') {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        const next = (input as Record<string, unknown>)[key]
        if (next !== undefined) result[key] = sort(next)
      }
      return result
    }
    return input
  }
  return JSON.stringify(sort(value))
}

/** Exact user text from one persisted message; never a summary or a synthesized label. */
function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => object(part).type === 'text' && typeof object(part).text === 'string')
    .map((part) => String(object(part).text))
    .join('')
}

/**
 * The active branch, root → leaf. `get_entries` returns the whole append-ordered tree, so
 * the active history must be reconstructed from `leafId`/`parentId`; a global fork list is
 * never used as a conversation order.
 */
function activeEntries(entries: readonly any[], leafId: string | null): any[] {
  const byId = new Map<string, any>()
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id : ''
    if (id) byId.set(id, entry)
  }
  const chain: any[] = []
  const seen = new Set<string>()
  let current: string | undefined = leafId ?? undefined
  while (current !== undefined) {
    if (seen.has(current)) refuse('protocol')
    seen.add(current)
    const entry = byId.get(current)
    if (!entry) refuse('protocol')
    chain.push(entry)
    const parent = entry.parentId
    if (parent === undefined || parent === null) current = undefined
    else if (typeof parent === 'string' && parent) current = parent
    else refuse('protocol')
  }
  chain.reverse()
  return chain
}

interface PiEditHistory {
  sessionId: string
  token: string
  boundaries: { id: string; text?: string }[]
  ephemeral: boolean
  settledInputId?: string
}

/**
 * Observe the live active history. The token covers the exact facts a fork depends on:
 * session identity, active leaf, boundary ids/text, pinned model/effort and the session
 * file. A tool result or compaction that moves the leaf changes the token.
 */
async function editHistory(): Promise<PiEditHistory> {
  const state = await readState()
  const id = typeof state?.sessionId === 'string' ? state.sessionId : ''
  if (!id) refuse('protocol')
  const response = await piRequest('get_entries')
  if (response?.success !== true) refuse('protocol')
  const entries = Array.isArray(response.data?.entries) ? response.data.entries : undefined
  const leafId = response.data?.leafId
  if (!entries || (leafId !== null && (typeof leafId !== 'string' || !leafId))) refuse('protocol')
  const branch = activeEntries(entries, leafId)
  const boundaries: { id: string; text?: string }[] = []
  for (const entry of branch) {
    if (entry?.type !== 'message' || entry.message?.role !== 'user') continue
    const text = userText(entry.message.content)
    boundaries.push({ id: entry.id, ...(text.length > 0 ? { text } : {}) })
  }
  const file = typeof state?.sessionFile === 'string' ? state.sessionFile : ''
  const ephemeral = !file || !existsSync(file)
  // A non-empty history without a file cannot be restored; refuse it rather than report a
  // boundary set the shared owner could persist as loadable.
  if (ephemeral && boundaries.length > 0) refuse('stale')
  const token = `sha256:${createHash('sha256')
    .update(
      canonical({
        version: 1,
        sessionId: id,
        leafId,
        boundaries,
        model: typeof state?.model?.id === 'string' ? state.model.id : '',
        thinking: typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : '',
        file,
        ephemeral,
      }),
    )
    .digest('hex')}`
  const leaf = branch.at(-1)
  const settledInputId =
    state.isStreaming === false &&
    state.isCompacting === false &&
    leaf?.type === 'message' &&
    leaf.message?.role === 'assistant' &&
    ['stop', 'error', 'aborted', 'length'].includes(leaf.message.stopReason)
      ? boundaries.at(-1)?.id
      : undefined
  return {
    sessionId: id,
    token,
    boundaries,
    ephemeral,
    ...(settledInputId ? { settledInputId } : {}),
  }
}

/**
 * Fork before `targetId`, re-pin the original model/effort and prove the retained prefix.
 *
 * A successful fork already changed vendor history, so any later failure is `uncertain`:
 * the caller must not retry automatically and must block sends until it re-reads history.
 */
async function editRewind(
  targetId: string,
  expectedToken: string,
): Promise<{
  ok: true
  sessionId: string
  retained: { previousId: string; nextId: string }[]
  ephemeral: boolean
}> {
  if (!targetId || !expectedToken) refuse('target-unknown')
  if (resolveTurn !== undefined || asks.size > 0) refuse('busy')
  const before = await editHistory()
  if (before.token !== expectedToken) refuse('history-changed')
  const targetIndex = before.boundaries.findIndex((boundary) => boundary.id === targetId)
  if (targetIndex < 0) refuse('target-unknown')

  const fork = await piRequest('fork', { entryId: targetId })
  if (fork?.success !== true || fork.data?.cancelled === true) refuse('fork-rejected')
  const state = await readState()
  const newId = typeof state?.sessionId === 'string' ? state.sessionId : ''
  if (!newId || newId === before.sessionId) refuse('uncertain')
  // From this point the bridge is on the new identity even if a later read-back fails.
  sessionId = newId
  const newFile = typeof state?.sessionFile === 'string' ? state.sessionFile : ''
  try {
    // Pi does not carry a model/thinking entry that sits after the fork boundary.
    await piCommand('set_model', { provider, modelId: model })
    await assertModel()
    if (thinking) await applyThinking(thinking)
  } catch {
    refuse('uncertain')
  }
  const after = await editHistory()
  if (after.sessionId !== newId) refuse('uncertain')
  const retained: { previousId: string; nextId: string }[] = []
  for (const boundary of before.boundaries.slice(0, targetIndex)) {
    const next = after.boundaries.find((item) => item.id === boundary.id)
    if (!next) throw new EditRefusal('uncertain')
    if ((boundary.text ?? '') !== (next.text ?? '')) refuse('uncertain')
    retained.push({ previousId: boundary.id, nextId: next.id })
  }
  // The target and every later boundary must be gone; a longer prefix means the fork kept
  // history it promised to exclude.
  if (after.boundaries.length !== targetIndex) refuse('uncertain')
  const ephemeral = !newFile || !existsSync(newFile)
  if (ephemeral) ephemeralFile = newFile
  else rememberSessionFile(newFile)
  return { ok: true, sessionId: newId, retained, ephemeral }
}

/** Serialize prompts, history edits and configuration writes. */
let lifecycle: Promise<unknown> = Promise.resolve()
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(run, run)
  lifecycle = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

// ── ACP request handling ───────────────────────────────────────────────────────────
async function invoke(method: string, params: any): Promise<unknown> {
  if (method === 'initialize') {
    if (child) throw configuration('官方 Pi 桥接器已经初始化')
    writeProviderConfig()
    openAgent()
    // Confirm the documented machine interface before the host is told this session can be
    // loaded and resumed.
    const state = await readState()
    if (!state) throw configuration('官方 Pi 未返回会话状态，无法确认 RPC 接口')
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        // Advertised only because the bridge itself implements both methods below.
        _meta: {
          'opl/message-edit': {
            version: 1,
            methods: ['opl/edit/read', 'opl/edit/rewind'],
            ephemeralFirstFork: true,
          },
        },
      },
      agentInfo: { name: 'pi-coding-agent', version: `pi-rpc ${api}`, model, provider },
    }
  }

  if (method === 'session/new' || method === 'session/load') {
    if (!child) throw configuration('官方 Pi 桥接器尚未初始化')
    if (method === 'session/load') {
      const wanted = String(params?.sessionId ?? '')
      let file = ''
      try {
        // Read back the suite-owned index. An unknown id is refused rather than resolved by
        // scanning the session tree or by name similarity.
        file = JSON.parse(readFileSync(join(sessionIndexDir, `${wanted}.json`), 'utf8')).sessionFile
      } catch {
        throw configuration(`官方 Pi 会话 ${wanted} 没有套件自有的会话记录，拒绝猜测历史来源。`)
      }
      // A recorded path can be gone even while the index entry survives — the official product
      // creates a session file lazily, so a session that never wrote an entry has no file yet,
      // and a user cleanup can remove one. Both are refused here, because `switch_session`
      // answers `success: true` for a missing path and silently continues on a *different*,
      // empty session.
      if (!file || !existsSync(file))
        throw configuration(
          `官方 Pi 会话 ${wanted} 的历史文件已不存在，拒绝以空历史继续；已停止，未发送任务。`,
        )
      await piCommand('switch_session', { sessionPath: file })
      // `switch_session` reports success even for a path that does not exist — the probe
      // confirmed it silently becomes a *different* session — so the identity is confirmed
      // from live state rather than from the response.
      const liveId = (await readState())?.sessionId
      if (liveId !== wanted)
        throw configuration(
          `官方 Pi 恢复的会话身份不一致（实际 ${String(liveId ?? '未知')}，要求 ${wanted}）；已停止，未发送任务。`,
        )
      sessionId = wanted
      ephemeralFile = ''
      await piCommand('set_model', { provider, modelId: model })
      await assertModel()
      const pinned = await applyThinking(thinking)
      await replayHistory()
      return {
        sessionId,
        models: { currentModelId: model },
        configOptions: await configOptions(pinned),
      }
    }

    const state = await readState()
    const id = String(state?.sessionId ?? '')
    if (!id) throw configuration('官方 Pi 未返回会话标识')
    sessionId = id
    ephemeralFile = ''
    rememberSessionFile(String(state?.sessionFile ?? ''))
    // Model first: the tier is only meaningful once the model that owns it is selected.
    await piCommand('set_model', { provider, modelId: model })
    await assertModel()
    const pinned = await applyThinking(thinking)
    return {
      sessionId,
      models: { currentModelId: model },
      configOptions: await configOptions(pinned),
    }
  }

  if (method === 'opl/edit/read') {
    return serialize(async () => {
      try {
        const requested = typeof params?.sessionId === 'string' ? params.sessionId : ''
        if (requested && requested !== sessionId) refuse('stale')
        const history = await editHistory()
        return {
          ok: true,
          sessionId: history.sessionId,
          token: history.token,
          boundaries: history.boundaries,
          ...(history.settledInputId ? { settledInputId: history.settledInputId } : {}),
        }
      } catch (error) {
        if (error instanceof EditRefusal) return { ok: false, code: error.code }
        throw error
      }
    })
  }

  if (method === 'opl/edit/rewind') {
    return serialize(async () => {
      try {
        const requested = typeof params?.sessionId === 'string' ? params.sessionId : ''
        if (!requested || requested !== sessionId) refuse('stale')
        const targetId = typeof params?.targetId === 'string' ? params.targetId : ''
        const expectedToken = typeof params?.expectedToken === 'string' ? params.expectedToken : ''
        return await editRewind(targetId, expectedToken)
      } catch (error) {
        if (error instanceof EditRefusal) return { ok: false, code: error.code }
        throw error
      }
    })
  }

  if (method === 'session/cancel') {
    cancelled = true
    cancelLatched = true
    // A pending approval would otherwise keep the turn open forever.
    for (const release of asks.values()) release(undefined)
    asks.clear()
    await piRequest('abort', {}, 30000)
    return {}
  }

  if (params?.sessionId !== undefined && params.sessionId !== sessionId)
    throw configuration('会话身份不匹配')

  if (method === 'session/set_config_option') {
    return serialize(async () => {
      if (params?.sessionId !== undefined && params.sessionId !== sessionId)
        throw configuration('会话身份不匹配')
      const configId = String(params?.configId ?? '')
      const value = String(params?.value ?? '')
      if (configId === MODEL_OPTION) {
        if (value !== model)
          throw configuration(`官方 Pi 只接受本组合固定的模型 ${model}，拒绝 ${value}。`)
        await piCommand('set_model', { provider, modelId: model })
        await assertModel()
      } else if (configId === THINKING_OPTION) {
        if (upstreamThinking)
          throw configuration('官方 Pi 未广告 thinking 配置项；此模型保留渠道默认思考设置。')
        if (typeof params?.value !== 'string' || !value)
          throw configuration('官方 Pi 需要一个已广告的非空思考档位。')
        await applyThinking(value)
      } else if (configId === PERMISSION_OPTION) {
        throw configuration('官方 Pi 的权限档位在启动时固定，会话内不可更改。')
      } else {
        throw configuration(`官方 Pi 未广告 ${configId} 配置项，无法确认该取值。`)
      }
      const options = await configOptions()
      emit({ sessionUpdate: 'config_option_update', configOptions: options })
      return { configOptions: options }
    })
  }

  if (method === 'session/prompt') {
    return serialize(async () => {
      const text = (Array.isArray(params?.prompt) ? params.prompt : [])
        .filter((part: any) => part?.type === 'text')
        .map((part: any) => part.text)
        .join('\n')
      // Re-read the live identity before every send, so a session that drifted cannot run.
      await assertModel()
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
      const accepted = await piCommand('prompt', { message: text })
      // A first-message fork allocates its file lazily. The replacement prompt is what
      // makes it durable; the event stream also retries this once the file appears.
      persistEphemeral()
      // The official docs are explicit that `success: true` means the prompt was accepted,
      // queued or handled — not that work finished — and that `disposition: "handled"` means
      // no run started, so waiting for `agent_settled` would hang forever.
      if (accepted?.disposition === 'handled') {
        resolveTurn = undefined
        rejectTurn = undefined
        return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
      }
      try {
        const settled = (await done) as Record<string, unknown>
        const metadata =
          settled.stopReason === 'end_turn' && !cancelled ? await settleMetadata() : {}
        return Object.keys(metadata).length > 0 ? { ...settled, _meta: metadata } : settled
      } finally {
        cancelled = false
        turnOutcome.reset()
      }
    })
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
        // These messages are this bridge's own fixed strings, or text this bridge built from
        // the official product's documented vocabulary — never an echo of provider- or
        // agent-controlled output, and always scrubbed of the credential. Suppressing them
        // would leave the user with "call failed" instead of the reason a session refused
        // to start.
        send({
          id,
          error: {
            code,
            message: redact(error instanceof Error ? error.message : '官方 Pi 调用未完成'),
            ...(error instanceof PiBridgeError && error.turnSettled
              ? { data: { oplTurnSettled: true } }
              : {}),
          },
        })
      if (process.env.OPL_PI_DIAGNOSTICS === '1')
        process.stderr.write(
          JSON.stringify({
            method: message.method,
            error: redact(error instanceof Error ? error.message : 'failure'),
          }) + '\n',
        )
    }
  })()
}

process.stdin.on('data', (chunk: Buffer) => {
  stdinBuffer = drain(stdinBuffer + chunk.toString('utf8'), handleAcpLine)
})

const stop = () => {
  releaseEverything()
  process.exit()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('exit', () => releaseEverything())
