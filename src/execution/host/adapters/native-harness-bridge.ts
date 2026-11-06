/** ACP transport projection over the installed official Codex/Claude harnesses.
 * This file owns no agent loop, model requests, tool execution or session format.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { commandLaunch } from '../harness-registry.ts'
import {
  forkSession,
  getSessionMessages,
  query,
  type Query,
  type McpServerConfig,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  codexSandboxMode,
  codexShellProbeCommand,
  nativeGitBashEnv,
  readShellProbe,
  type NativePermission,
} from './native-bash.ts'
import { acpUpdatesForClaudeEvent } from './claude-transcript.ts'
import { bridgeFailure, HarnessReportedError } from './failure-diagnostics.ts'
import {
  CodexTurnUsageTracker,
  claudeContextCapacity,
  nativeContextUpdate,
  nativeContextUsageMeta,
  nativeTurnUsageMeta,
  normalizeClaudeTurnUsage,
  normalizeNativeContextUsage,
  type NativeContextUsage,
} from './native-usage.ts'
const kind = process.env.OPL_NATIVE_HARNESS!,
  command = process.env.OPL_NATIVE_COMMAND!
// The permission profile is a three-way authorization, not a boolean. Treating anything that
// is not `workspace` as read-only silently demoted an explicitly authorized `full-access`
// task, which also hid the only profile Codex accepts for Git Bash.
const taskPermission = (process.env.OPL_NATIVE_PERMISSION ?? 'read-only') as NativePermission,
  model = process.env.OPL_NATIVE_MODEL!,
  cwd = process.cwd(),
  readonly = taskPermission === 'read-only'
/** Source-owned image support; no model name or filename implies this capability. */
const imageInputSetting = process.env.OPL_NATIVE_IMAGE_INPUT
const imageInput = imageInputSetting === '1' && (kind === 'codex' || kind === 'claude')
type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
type NativePromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: ImageMimeType }

function imageMimeType(value: unknown): value is ImageMimeType {
  return (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/gif' ||
    value === 'image/webp'
  )
}
function imageData(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
}

/** Validate ACP JSON before starting a turn; image bytes always come from the caller. */
function nativePrompt(value: unknown): NativePromptPart[] {
  if (!Array.isArray(value) || !value.length) throw Error('提示词内容为空')
  return value.map((item: unknown): NativePromptPart => {
    if (!item || typeof item !== 'object') throw Error('提示词内容无效')
    const part = item as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string')
      return { type: 'text', text: part.text }
    if (part.type !== 'image') throw Error('当前原生桥接仅支持文字和图片提示词')
    if (!imageInput) throw Error('当前模型来源未声明图片输入能力')
    const mimeType = part.mimeType
    if (!imageMimeType(mimeType)) throw Error('当前原生桥接不支持此图片格式')
    if (!imageData(part.data)) throw Error('图片必须携带有效的 Base64 数据')
    // ACP's optional URI describes the source. It never authorizes a file read or fetch.
    return { type: 'image', data: part.data, mimeType }
  })
}

/** One structured user message retains every input block in its original order. */
async function* claudeUserMessage(prompt: NativePromptPart[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: prompt.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : {
              type: 'image',
              source: { type: 'base64', media_type: part.mimeType, data: part.data },
            },
      ),
    },
  }
}
/**
 * The Auto permission session's official-review opt-in, carried from the adapter.
 *
 * Only the literal `1` turns the route on. A value that is neither absent, `0` nor `1` is a
 * wiring fault and is refused in `initialize`: a session that asked for the official Auto
 * route must never fall back to an ordinary full / never-ask profile, because the profile it
 * would silently get is more permissive than the one it asked for.
 */
const autoReviewSetting = process.env.OPL_NATIVE_AUTO_REVIEW,
  autoReview = autoReviewSetting === '1'
/**
 * Codex's official auto-review value, as published by `approvalsReviewer`.
 *
 * The installed app-server builds this enum as `user | auto_review | guardian_subagent`;
 * `guardian_subagent` is documented as the legacy spelling of the same feature and the
 * server normalises it to `auto_review` in its own response. Both spellings therefore mean
 * "the official reviewer", and nothing else does.
 */
const CODEX_AUTO_REVIEWERS = ['auto_review', 'guardian_subagent'] as const
const send = (value: object) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const emit = (update: object) => send({ method: 'session/update', params: { sessionId, update } })
let sessionId = '',
  hasHistory = false,
  cancelled = false,
  claude: Query | undefined,
  turnId = ''
const codexUsage = new CodexTurnUsageTracker()
let codexOpeningSession = false
const codexOpeningUsage: unknown[] = []
let contextUsage: NativeContextUsage | undefined
function recordContext(context: NativeContextUsage | undefined): void {
  if (!context) return
  contextUsage = context
  const update = nativeContextUpdate(context)
  if (update) emit(update)
}
let servers: Record<string, McpServerConfig> = {}
let seq = 0
const asks = new Map<string, (allowed: boolean) => void>()
function permission(title: string): Promise<boolean> {
  const id = 'permission-' + ++seq
  return new Promise((resolve) => {
    asks.set(id, resolve)
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { title },
        options: [
          { optionId: 'allow', name: '允许本次', kind: 'allow_once' },
          { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
        ],
      },
    })
  })
}
// Built on first use so a rejected Git Bash path is reported through the normal ACP error
// path with its reason attached, instead of crashing the bridge before it can answer.
let harnessEnvCache: NodeJS.ProcessEnv | undefined
/** Non-empty when this session actually asked Codex to use a Git Bash executable. */
let codexGitBashRequested = false
function harnessEnv(): NodeJS.ProcessEnv {
  if (harnessEnvCache) return harnessEnvCache
  const preResolved = process.env.OPL_NATIVE_GIT_BASH
  const patch = nativeGitBashEnv(kind === 'codex' ? 'codex' : 'claude', taskPermission, {
    ...(preResolved ? { bash: preResolved } : {}),
  })
  codexGitBashRequested = kind === 'codex' && Boolean(patch.CODEX_NATIVE_GIT_BASH_PATH)
  harnessEnvCache = { ...process.env, ...patch }
  delete harnessEnvCache.ELECTRON_RUN_AS_NODE
  return harnessEnvCache
}
let child: ReturnType<typeof spawn> | undefined
/** Collects the output of an in-flight, model-free shell probe. */
let shellProbe: { output: string; done?: () => void } | null = null
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let resolveTurn: ((value: unknown) => void) | undefined,
  rejectTurn: ((e: Error) => void) | undefined
const codexMessageText = new Map<string, string>()
/** Completed items also carry text when the CLI does not send message deltas. */
function completedCodexMessage(item: any) {
  if (item?.type !== 'agentMessage' || typeof item.id !== 'string' || typeof item.text !== 'string')
    return
  const streamed = codexMessageText.get(item.id) ?? ''
  if (item.text.startsWith(streamed)) {
    const suffix = item.text.slice(streamed.length)
    if (suffix)
      emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: suffix } })
    codexMessageText.set(item.id, item.text)
  }
}
function codexRequest(method: string, params: object): Promise<any> {
  if (!child || child.killed || child.exitCode !== null)
    return Promise.reject(new HarnessReportedError('codex', { type: 'processExited' }))
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
  })
}
async function openCodex() {
  const windowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
  const settings: [string, string | boolean][] = [
    ['model_provider', 'opl-gateway'],
    ['model', model],
    ['model_providers.opl-gateway.name', 'OPL Gateway'],
    ['model_providers.opl-gateway.env_key', 'OPL_NATIVE_API_KEY'],
    ['model_providers.opl-gateway.wire_api', 'responses'],
    ['model_providers.opl-gateway.requires_openai_auth', false],
    ['forced_login_method', 'api'],
  ]
  const baseURL = process.env.OPL_NATIVE_BASE_URL
  if (baseURL !== undefined) settings.push(['model_providers.opl-gateway.base_url', baseURL])
  // Codex compares a thread's provider with the process-wide provider before each turn.
  // Startup overrides bind both to the resolved route without writing the user's config.
  const args = settings.flatMap(([key, value]) => {
    if (windowsScript && typeof value === 'string' && /['\r\n]/.test(value))
      throw Error('Codex 启动参数无法通过 Windows 脚本安全传递，请使用官方 .exe 程序')
    const encoded =
      typeof value === 'boolean'
        ? String(value)
        : windowsScript
          ? `'${value}'`
          : JSON.stringify(value)
    return ['-c', `${key}=${encoded}`]
  })
  let launch: ReturnType<typeof commandLaunch>
  try {
    launch = commandLaunch(command, ['app-server', '--stdio', ...args])
  } catch {
    throw Error('Codex 启动参数无法通过 Windows 脚本安全传递，请使用官方 .exe 程序')
  }
  child = spawn(launch.command, launch.args, {
    cwd,
    env: harnessEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  child.stderr!.resume()
  const fail = () => {
    const error = new HarnessReportedError('codex', { type: 'processExited' })
    for (const p of pending.values()) p.reject(error)
    pending.clear()
    rejectTurn?.(error)
  }
  child.on('error', fail)
  child.on('exit', fail)
  createInterface({ input: child.stdout! }).on('line', (line) => {
    void (async () => {
      let m: any
      try {
        m = JSON.parse(line)
      } catch {
        return
      }
      if (m.id !== undefined && !m.method) {
        const p = pending.get(m.id)
        if (p) {
          pending.delete(m.id)
          if (m.error) {
            const error = new HarnessReportedError('codex', m.error)
            if (typeof m.error?.message === 'string')
              Object.defineProperty(error, 'bridgeRawMessage', { value: m.error.message })
            p.reject(error)
          } else p.resolve(m.result)
        }
        return
      }
      const p = m.params ?? {}
      if (m.id !== undefined) {
        let result: object
        if (
          m.method === 'item/commandExecution/requestApproval' ||
          m.method === 'item/fileChange/requestApproval'
        ) {
          // Approval may not enlarge the saved filesystem boundary.
          const allowed = false // Requests to escape the saved sandbox cannot be approved by this bridge.
          result = { decision: allowed ? 'accept' : 'decline' }
        } else if (m.method === 'item/tool/requestUserInput') result = { answers: {} }
        else {
          child!.stdin!.write(
            JSON.stringify({
              id: m.id,
              error: { code: -32601, message: 'Unsupported client request' },
            }) + '\n',
          )
          return
        }
        child!.stdin!.write(JSON.stringify({ id: m.id, result }) + '\n')
        return
      }
      if (
        m.method === 'thread/tokenUsage/updated' &&
        p.threadId !== sessionId &&
        codexOpeningSession
      ) {
        if (codexOpeningUsage.length < 16) codexOpeningUsage.push(p)
        return
      }
      if (p.threadId !== sessionId) return
      if (m.method === 'turn/started' && resolveTurn && typeof p.turn?.id === 'string')
        codexUsage.bindTurn(p.turn.id)
      if (m.method === 'thread/tokenUsage/updated') {
        recordContext(codexUsage.accept(p)?.context)
        return
      }
      // The shell probe borrows this thread's command stream; it is kept out of the tool
      // call stream so it never surfaces as task activity.
      if (shellProbe) {
        if (m.method === 'item/commandExecution/outputDelta') shellProbe.output += p.delta ?? ''
        else if (m.method === 'turn/completed') {
          shellProbe.done?.()
          return
        }
        // The probe is internal bookkeeping and is never surfaced as task activity.
        if (m.method === 'item/started' || m.method === 'item/completed') return
      }
      if (m.method === 'item/agentMessage/delta') {
        emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: p.delta } })
        if (typeof p.itemId === 'string' && typeof p.delta === 'string')
          codexMessageText.set(p.itemId, (codexMessageText.get(p.itemId) ?? '') + p.delta)
      }
      if (m.method === 'item/started' || m.method === 'item/completed') {
        const item = p.item ?? {}
        if (m.method === 'item/completed') completedCodexMessage(item)
        if (!['agentMessage', 'userMessage', 'reasoning'].includes(item.type))
          emit({
            sessionUpdate: m.method === 'item/started' ? 'tool_call' : 'tool_call_update',
            toolCallId: item.id,
            title: item.command ?? item.type,
            status:
              m.method === 'item/started'
                ? 'in_progress'
                : item.status === 'failed'
                  ? 'failed'
                  : 'completed',
            kind: 'other',
          })
      }
      if (m.method === 'turn/completed') {
        turnId = ''
        for (const item of p.turn.items ?? []) completedCodexMessage(item)
        if (p.turn.status === 'failed')
          rejectTurn?.(new HarnessReportedError('codex', p.turn.error, 'failed'))
        else if (p.turn.status === 'completed' || p.turn.status === 'interrupted') {
          const meta = {
            ...nativeTurnUsageMeta(codexUsage.current()),
            ...nativeContextUsageMeta(contextUsage),
          }
          resolveTurn?.({
            stopReason: p.turn.status === 'interrupted' ? 'cancelled' : 'end_turn',
            ...(Object.keys(meta).length ? { _meta: meta } : {}),
          })
        } else rejectTurn?.(new HarnessReportedError('codex', { type: 'protocolError' }))
        resolveTurn = undefined
        rejectTurn = undefined
      }
    })().catch(() => rejectTurn?.(Error('Codex 消息处理失败')))
  })
  await codexRequest('initialize', {
    clientInfo: { name: 'opl-dsh', version: '0.2.13' },
    capabilities: { experimentalApi: true },
  })
  child.stdin!.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
}
/**
 * Confirm with the running Codex process which shell it really executes commands with.
 *
 * Uses Codex's own `thread/shellCommand`, so the answer needs no model call and no
 * credentials and cannot be faked by the environment the bridge happened to set. The probe
 * only prints which shell is running it.
 * @param threadId - the Codex thread to probe.
 * @returns the raw probe output.
 */
async function probeCodexShell(threadId: string): Promise<string> {
  const probe: { output: string; done?: () => void } = { output: '' }
  shellProbe = probe
  let expired = false
  // The timeout still bounds the wait, but the timer is cleared on every exit path so a
  // finished probe never keeps the event loop alive or fires into a later session.
  const timer = setTimeout(() => {
    expired = true
    probe.done?.()
  }, 30000)
  try {
    const finished = new Promise<void>((resolve) => {
      probe.done = resolve
    })
    await codexRequest('thread/shellCommand', {
      threadId,
      command: codexShellProbeCommand(),
      timeoutMs: 20000,
    })
    await finished
  } finally {
    clearTimeout(timer)
    delete probe.done
    shellProbe = null
  }
  if (expired) throw Error('Codex shell 校验轮次未结束，未发送用户请求')
  return probe.output
}

/**
 * Refuse to continue when the requested Git Bash did not take effect.
 *
 * The Codex Git Bash variable is not an upstream Codex interface, so a build that ignores it
 * would otherwise silently keep running on its own shell while the task claims Bash.
 * @param threadId - the Codex thread to verify.
 */
async function confirmCodexGitBash(threadId: string): Promise<void> {
  const shell = readShellProbe(await probeCodexShell(threadId))
  if (shell?.bashVersion && shell.bashVersion !== 'none') return
  throw Error(
    '已请求 Codex 使用 Git Bash，但当前 Codex 进程实际使用的 shell 是 ' +
      `${shell?.name ?? '未知（未收到回读）'}。` +
      '该 Codex 构建不支持 Git Bash 设置，上游官方亦未提供此接口；请改用官方支持的 Windows 方案（PowerShell 或 WSL）。',
  )
}

/**
 * Refuse a Codex thread that did not really adopt the official auto reviewer.
 *
 * `thread/start` and `thread/resume` echo the reviewer and approval policy that are now in
 * force on the thread, so the answer is the installed build's own report rather than a
 * restatement of the request. That matters for two independent reasons:
 *
 *  - a build that ignores `approvalsReviewer` would otherwise keep the request's own
 *    approval policy and quietly run the session as an ordinary never-ask task; and
 *  - `approvalPolicy: never` never raises an approval request, so the reviewer would be
 *    configured but unreachable. Codex's own tool layer rejects an escalation outright in
 *    that state, which is a silent downgrade from "officially reviewed" to "never asked".
 *
 * Both are refusals, never fallbacks: there is no path here that runs the session with a
 * weaker guarantee than the one the record asked for.
 * @param answer - the `thread/start` or `thread/resume` result.
 * @throws when the effective reviewer or approval policy is not the official Auto route.
 */
function confirmCodexAutoReview(answer: object): void {
  const report = answer as { approvalsReviewer?: unknown; approvalPolicy?: unknown }
  const reviewer = report.approvalsReviewer
  if (typeof reviewer !== 'string' || !CODEX_AUTO_REVIEWERS.includes(reviewer as never))
    throw Error(
      '已请求 Codex 官方 Auto Review，但当前 Codex 进程回报的审批审核者是 ' +
        `${typeof reviewer === 'string' ? reviewer : '未知（未收到回读）'}；` +
        '该构建没有采用 approvalsReviewer，不能把普通审批策略当成官方 Auto。',
    )
  if (report.approvalPolicy === 'never')
    throw Error(
      '已请求 Codex 官方 Auto Review，但当前 Codex 进程的审批策略是 never，' +
        '官方 auto_review 不会收到任何审批请求；拒绝以 never 冒充官方 Auto。',
    )
}
async function pathInProject(path: unknown): Promise<boolean> {
  if (typeof path !== 'string') return false
  const target = resolve(cwd, path)
  let probe = target
  for (;;) {
    try {
      const actual = await realpath(probe)
      return actual === cwd || actual.startsWith(cwd + sep)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
}
async function claudePrompt(prompt: NativePromptPart[], effort?: string) {
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
    throw Error('Claude Code 不支持该推理强度')
  cancelled = false
  hasHistory = (await getSessionMessages(sessionId, { dir: cwd, limit: 1 })).length > 0
  // Restricted tasks keep the isolated sandbox and must fail loudly when no Windows sandbox
  // backend is active. Only an explicitly authorized full-access task turns the restricted
  // sandbox off, and it turns it off through the official SDK modes rather than by relaxing
  // anything a restricted task relies on.
  const fullAccess = taskPermission === 'full-access'
  const disallowed = readonly
    ? ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task']
    : ['Agent', 'Task']
  const abortController = new AbortController()
  let responseTimedOut = false
  let networkRetry = false
  let firstResponseTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => {
      responseTimedOut = true
      abortController.abort()
    },
    4 * 60 * 1000,
  )
  const receivedResponse = () => {
    if (firstResponseTimer) clearTimeout(firstResponseTimer)
    firstResponseTimer = undefined
  }
  claude = query({
    prompt: claudeUserMessage(prompt),
    options: {
      cwd,
      model,
      abortController,
      ...(effort ? { effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      pathToClaudeCodeExecutable: command,
      env: harnessEnv(),
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: servers,
      ...(hasHistory ? { resume: sessionId } : { sessionId }),
      // `bypassPermissions` is the official SDK mode for a task the user already authorized at full
      // access; it does not answer anyone else's pending approval, it only stops Claude Code
      // from asking again about a decision this task was granted. An Auto session instead runs
      // the official `auto` mode, whose own model classifier answers the permission prompts the
      // mode raises.
      permissionMode: autoReview ? 'auto' : fullAccess ? 'bypassPermissions' : 'default',
      // An Auto session has no host approval surface at all. The official SDK documents `none`
      // as "nobody answers permission prompts: the permission mode (including auto mode's
      // classifier), rules and hooks still decide, and anything that would otherwise prompt is
      // denied immediately". That is what keeps Auto honest: the classifier's own decisions
      // stand, and a prompt it declined to decide is refused rather than escalated to this
      // bridge — which is not an approval authority and must never act as the reviewer of
      // record. Ordinary sessions keep the host surface they have always had.
      ...(autoReview ? { permissionPrompts: 'none' as const } : {}),
      includePartialMessages: true,
      disallowedTools: disallowed,
      // A restricted task keeps the isolated sandbox and refuses to run without a Windows
      // sandbox backend. Full access instead turns the restricted sandbox off explicitly.
      sandbox: fullAccess
        ? { enabled: false }
        : {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            filesystem: { allowWrite: readonly ? [] : [cwd] },
            credentials: {
              envVars: [
                { name: 'ANTHROPIC_API_KEY', mode: 'deny' },
                { name: 'OPL_NATIVE_API_KEY', mode: 'deny' },
              ],
            },
          },
      // Restricted tasks only: under `bypassPermissions` the SDK auto-approves every tool call before
      // this callback is consulted, so it is not a filesystem boundary for a full-access task.
      // Such a task is bounded by the user's own explicit authorization, not by anything here.
      canUseTool: async (name, input) => {
        if (cancelled) return { behavior: 'deny', message: '任务已取消' }
        // Fail closed for an Auto session. Reaching this callback means the official auto
        // classifier did not decide the prompt, so there is no official review behind an
        // allow: the bridge is not the reviewer of record, it has no authorization from the
        // record for this call, and it must not fall back to the ordinary allow-list, to the
        // full-access `Bash`/write rules or to asking the operator. A build that ignores
        // `permissionPrompts: 'none'` therefore still cannot get an allow out of this bridge.
        if (autoReview)
          return { behavior: 'deny', message: '官方 Auto Review 未决出该操作，已按失败关闭拒绝' }
        if (name.startsWith('mcp__opl-harness__')) return { behavior: 'allow', updatedInput: input }
        if (['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'].includes(name))
          return { behavior: 'allow', updatedInput: input }
        if (readonly) return { behavior: 'deny', message: '此组合只允许读取' }
        if (['Write', 'Edit', 'NotebookEdit'].includes(name))
          return (await pathInProject(input.file_path ?? input.notebook_path))
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: '不能写入项目目录之外' }
        if (name === 'Bash')
          return input.dangerouslyDisableSandbox
            ? { behavior: 'deny', message: '不能退出组合的沙箱' }
            : { behavior: 'allow', updatedInput: input }
        return (await permission(
          'Claude Code · ' + name + '\n' + JSON.stringify(input).slice(0, 2000),
        ))
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: '用户未授权此操作' }
      },
    },
  })
  let result: any
  let mainAssistantModel = model
  let reportedContext: NativeContextUsage | undefined
  // The CLI's own `system`/`init` message reports the permission mode it really took, so an
  // Auto session is never trusted on the strength of the request alone.
  let reportedPermissionMode: unknown
  let sawInit = false
  try {
    for await (const event of claude) {
      if (event.type === 'system' && event.subtype === 'init') {
        sawInit = true
        reportedPermissionMode = (event as { permissionMode?: unknown }).permissionMode
        // Refused at init, which the CLI emits before it runs any tool, rather than after a
        // turn that already executed under the wrong mode.
        if (autoReview && reportedPermissionMode !== 'auto')
          throw Error(
            '已请求 Claude Code 官方 Auto Review，但当前进程回报的 permission mode 是 ' +
              `${typeof reportedPermissionMode === 'string' ? reportedPermissionMode : '未知'}；` +
              '拒绝把普通 permission mode 当成官方 Auto。',
          )
      }
      if (event.type === 'system' && event.subtype === 'api_retry' && event.error_status === null)
        networkRetry = true
      if (event.type === 'assistant' && event.parent_tool_use_id === null) {
        if (typeof event.message.model === 'string') mainAssistantModel = event.message.model
        const context = event.context_usage
        if (context)
          reportedContext = normalizeNativeContextUsage({
            used: context.total_tokens,
            size: context.raw_max_tokens,
            estimated: true,
          })
      }
      if (event.type === 'assistant' || event.type === 'result' || event.type === 'stream_event')
        receivedResponse()
      // Complete assistant text blocks are not replayed after their streamed deltas.
      for (const update of acpUpdatesForClaudeEvent(event)) emit(update)
      if (event.type === 'result') {
        result = event
        let contextTimer: ReturnType<typeof setTimeout> | undefined
        try {
          const contextRequest = claude.getContextUsage({ detail: 'summary' })
          const contextTimeout = new Promise<never>((_, reject) => {
            contextTimer = setTimeout(() => reject(Error('Claude context read timed out')), 1000)
          })
          const usage = await Promise.race([contextRequest, contextTimeout])
          reportedContext = normalizeNativeContextUsage({
            used: usage.totalTokens,
            size: usage.rawMaxTokens,
            estimated: true,
          })
          recordContext(reportedContext)
        } catch (contextError) {
          // Context reporting is advisory and must not replace the completed model result.
          void contextError
        } finally {
          if (contextTimer) clearTimeout(contextTimer)
        }
      }
    }
  } catch (error) {
    if (responseTimedOut) throw Error(networkRetry ? 'HARNESS_NETWORK' : 'HARNESS_TIMEOUT')
    throw error
  } finally {
    receivedResponse()
    claude.close()
    claude = undefined
  }
  if (responseTimedOut) throw Error(networkRetry ? 'HARNESS_NETWORK' : 'HARNESS_TIMEOUT')
  // A build that never reports its permission mode cannot be shown to be running the
  // official auto reviewer, so the Auto session is refused instead of assumed.
  if (autoReview && !sawInit)
    throw Error(
      '已请求 Claude Code 官方 Auto Review，但当前进程没有回报 permission mode；拒绝在无法确认时继续。',
    )
  const resultMeta = {
    ...nativeTurnUsageMeta(normalizeClaudeTurnUsage(result)),
    ...nativeContextUsageMeta(reportedContext ?? claudeContextCapacity(result, mainAssistantModel)),
  }
  if (cancelled)
    return {
      stopReason: 'cancelled',
      ...(Object.keys(resultMeta).length ? { _meta: resultMeta } : {}),
    }
  if (!result || result.is_error || result.subtype !== 'success') {
    const status = result?.api_error_status
    if (status === 401 || status === 403) throw Error('HARNESS_AUTH')
    if (status === 429) throw Error('HARNESS_RATE_LIMIT')
    if (status === 400 || status === 404) throw Error('HARNESS_MODEL')
    throw Error('HARNESS_EXECUTION')
  }
  hasHistory = true
  return {
    stopReason: 'end_turn',
    ...(Object.keys(resultMeta).length ? { _meta: resultMeta } : {}),
  }
}
const OPL_EDIT_META = 'opl/message-edit'
const OPL_EDIT_READ = 'opl/message-edit/read'
const OPL_EDIT_REWIND = 'opl/message-edit/rewind'

type EditBoundary = { id: string; text?: string; imageCount?: number; unavailableReason?: string }
type EditHistory = {
  sessionId: string
  token: string
  boundaries: EditBoundary[]
  /** Private prefix digests (including tool items); never parsed by the driver. */
  prefixDigests?: string[]
}
type EditResult = {
  sessionId: string
  retained: { previousId: string; nextId: string }[]
  ephemeral?: boolean
}

const editDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

function editIdle(): void {
  if (resolveTurn || rejectTurn || claude || turnId || asks.size > 0)
    editFailure('busy', '会话正在执行或等待审批，不能编辑历史')
}

function editFailure(reason: string, message: string): never {
  const error = new Error(message)
  ;(error as { code?: string }).code = reason
  throw error
}

function codexTurnUser(turn: any): EditBoundary {
  if (typeof turn?.id !== 'string' || !turn.id)
    editFailure('history-unreadable', 'Codex turn 缺少稳定身份')
  const items = Array.isArray(turn?.items) ? turn.items : []
  const users = items.filter((item: any) => item?.type === 'userMessage')
  if (users.length !== 1)
    return {
      id: String(turn?.id ?? ''),
      unavailableReason: '这条 turn 含有多个用户输入，无法精确定位单条边界',
    }
  const content = Array.isArray(users[0]?.content) ? users[0].content : []
  const texts: string[] = []
  let nonText = false
  let imageCount = 0
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (part?.type === 'image' && typeof part.url === 'string') {
      const source = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(part.url)
      if (source && imageData(source[2])) imageCount++
      else nonText = true
    } else nonText = true
  }
  return {
    id: String(turn?.id ?? ''),
    ...(nonText
      ? { unavailableReason: '这条消息带有附件或非文本内容，无法回填' }
      : { text: texts.join(''), ...(imageCount ? { imageCount } : {}) }),
  }
}

async function codexTurns(threadId: string): Promise<any[]> {
  const turns: any[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  for (;;) {
    let page: any
    try {
      page = await codexRequest('thread/turns/list', {
        threadId,
        cursor,
        limit: 100,
        itemsView: 'full',
        sortDirection: 'asc',
      })
    } catch (error) {
      const raw = (error as { bridgeRawMessage?: unknown })?.bridgeRawMessage
      if (
        typeof raw === 'string' &&
        /not materialized yet|unavailable before first user message/i.test(raw)
      )
        return []
      editFailure('history-unreadable', 'Codex 历史读取失败，未做任何改动')
    }
    if (!Array.isArray(page?.data))
      editFailure('history-unreadable', 'Codex 历史返回的 turn 列表无效')
    const data = page.data
    turns.push(...data)
    if (
      page.nextCursor !== undefined &&
      page.nextCursor !== null &&
      typeof page.nextCursor !== 'string'
    )
      editFailure('history-unreadable', 'Codex 历史分页游标无效')
    const next = typeof page?.nextCursor === 'string' ? page.nextCursor : null
    if (!next) return turns
    if (seen.has(next)) editFailure('history-unreadable', 'Codex 历史分页游标重复，已拒绝继续')
    seen.add(next)
    cursor = next
  }
}

async function codexHistory(threadId: string): Promise<EditHistory> {
  const turns = await codexTurns(threadId)
  const userTurns = turns.filter(
    (turn: any) =>
      !Array.isArray(turn.items) ||
      !turn.items.length ||
      !turn.items.every(
        (item: any) => item.type === 'commandExecution' && item.source === 'userShell',
      ),
  )
  const boundaries = userTurns.map(codexTurnUser)
  const token = editDigest({
    kind: 'codex',
    threadId,
    turns: turns.map((turn: any) => ({
      id: String(turn?.id ?? ''),
      status: typeof turn?.status === 'string' ? turn.status : '',
      items: editDigest(turn?.items ?? []),
    })),
  })
  return {
    sessionId: threadId,
    token,
    boundaries,
    prefixDigests: [
      ...userTurns.map((turn: any) => editDigest(turns.slice(0, turns.indexOf(turn)))),
      editDigest(turns),
    ],
  }
}

function codexPrefixDigest(history: EditHistory, count: number) {
  return history.prefixDigests?.[count]
}

async function codexRewind(
  threadId: string,
  targetId: string,
  expectedToken: string,
): Promise<EditResult> {
  const before = await codexHistory(threadId)
  if (before.token !== expectedToken)
    editFailure('history-changed', 'Codex 历史在读取后发生变化，已拒绝回退')
  const index = before.boundaries.findIndex((item) => item.id === targetId)
  if (index < 0) editFailure('unknown-target', '目标 turn 不在当前 Codex 历史中')
  if (before.boundaries[index]?.unavailableReason)
    editFailure('target-unavailable', '目标消息无法精确回退')
  const prefix = codexPrefixDigest(before, index)
  const response: any = await codexRequest('thread/revert', {
    threadId,
    beforeTurnId: targetId,
  })
  if (response?.thread?.id !== threadId)
    editFailure('rewind-failed', 'Codex 未确认同一 thread 的回退结果')
  codexUsage.reset()
  contextUsage = undefined
  const after = await codexHistory(threadId)
  if (after.boundaries.length !== index || codexPrefixDigest(after, index) !== prefix)
    editFailure('rewind-failed', 'Codex 回退后的保留前缀与预期不一致')
  const retained = before.boundaries.slice(0, index).map((item, position) => ({
    previousId: item.id,
    nextId: after.boundaries[position]!.id,
  }))
  return { sessionId: threadId, retained }
}

function claudeContent(
  message: any,
):
  | { kind: 'human'; text?: string; imageCount?: number; unavailableReason?: string }
  | { kind: 'tool' } {
  const content = message?.message?.content
  if (typeof content === 'string') return { kind: 'human', text: content }
  if (!Array.isArray(content))
    return { kind: 'human', unavailableReason: '这条消息的内容形状无法回填' }
  if (content.some((part: any) => part?.type === 'tool_result')) return { kind: 'tool' }
  const texts: string[] = []
  let nonText = false
  let imageCount = 0
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    else if (
      part?.type === 'image' &&
      part.source?.type === 'base64' &&
      imageMimeType(part.source.media_type) &&
      imageData(part.source.data)
    )
      imageCount++
    else nonText = true
  }
  return nonText
    ? { kind: 'human', unavailableReason: '这条消息带有附件或非文本内容，无法回填' }
    : { kind: 'human', text: texts.join(''), ...(imageCount ? { imageCount } : {}) }
}

async function claudeMessages(sessionId: string): Promise<any[]> {
  try {
    return await getSessionMessages(sessionId, { includeSystemMessages: true })
  } catch {
    editFailure('history-unreadable', 'Claude 历史读取失败，未做任何改动')
  }
}

function claudeBoundaries(messages: any[]): EditBoundary[] {
  const boundaries: EditBoundary[] = []
  for (const message of messages) {
    if (message?.type !== 'user') continue
    const content = claudeContent(message)
    if (content.kind === 'tool') continue
    boundaries.push({
      id: String(message.uuid),
      ...(content.unavailableReason
        ? { unavailableReason: content.unavailableReason }
        : {
            text: content.text ?? '',
            ...(content.imageCount ? { imageCount: content.imageCount } : {}),
          }),
    })
  }
  return boundaries
}

function claudeToken(sessionId: string, messages: any[]): string {
  return editDigest({
    kind: 'claude',
    sessionId,
    messages: messages.map((message) => ({
      type: message?.type,
      uuid: String(message?.uuid ?? ''),
      parentToolUseId: message?.parent_tool_use_id ?? null,
      parentAgentId: message?.parent_agent_id ?? null,
      content: editDigest(message?.message ?? null),
    })),
  })
}

async function claudeSnapshot(sessionId: string): Promise<{
  messages: any[]
  history: EditHistory
}> {
  const messages = await claudeMessages(sessionId)
  const boundaries = claudeBoundaries(messages)
  return {
    messages,
    history: {
      sessionId,
      token: claudeToken(sessionId, messages),
      boundaries,
    },
  }
}

async function claudeHistory(sessionId: string): Promise<EditHistory> {
  return (await claudeSnapshot(sessionId)).history
}

async function claudeRewind(
  sourceSessionId: string,
  targetId: string,
  expectedToken: string,
): Promise<EditResult> {
  const snapshot = await claudeSnapshot(sourceSessionId)
  const beforeMessages = snapshot.messages
  const before = snapshot.history
  if (before.token !== expectedToken)
    editFailure('history-changed', 'Claude 历史在读取后发生变化，已拒绝回退')
  const userIndex = before.boundaries.findIndex((item) => item.id === targetId)
  if (userIndex < 0) editFailure('unknown-target', '目标消息不在当前 Claude 历史中')
  if (before.boundaries[userIndex]?.unavailableReason)
    editFailure('target-unavailable', '目标消息无法精确回退')
  if (userIndex === 0) {
    // The driver binds this identity through the explicit session/load reconnect path;
    // the live global is not switched before that binding is validated.
    return { sessionId: randomUUID(), retained: [], ephemeral: true }
  }
  const targetIndex = beforeMessages.findIndex((message) => String(message.uuid) === targetId)
  if (targetIndex <= 0) editFailure('unknown-target', '目标消息缺少可保留的前缀')
  const previous = beforeMessages[targetIndex - 1]
  if (!previous || typeof previous.uuid !== 'string')
    editFailure('rewind-failed', '目标消息前一条历史不可用')
  let forked: { sessionId: string }
  try {
    forked = await forkSession(sourceSessionId, { upToMessageId: previous.uuid })
  } catch {
    editFailure('rewind-failed', 'Claude 分支未完成')
  }
  const afterSnapshot = await claudeSnapshot(forked.sessionId)
  const afterMessages = afterSnapshot.messages
  if (afterMessages.length !== targetIndex)
    editFailure('rewind-failed', 'Claude 分支的保留前缀长度与预期不一致')
  for (let index = 0; index < targetIndex; index++) {
    const oldMessage = beforeMessages[index]
    const newMessage = afterMessages[index]
    if (
      oldMessage?.type !== newMessage?.type ||
      (oldMessage?.parent_tool_use_id ?? null) !== (newMessage?.parent_tool_use_id ?? null) ||
      (oldMessage?.parent_agent_id ?? null) !== (newMessage?.parent_agent_id ?? null) ||
      editDigest(oldMessage?.message ?? null) !== editDigest(newMessage?.message ?? null)
    )
      editFailure('rewind-failed', 'Claude 分支的保留前缀内容或父关系与预期不一致')
  }
  const after = afterSnapshot.history
  if (after.boundaries.length !== userIndex)
    editFailure('rewind-failed', 'Claude 分支的保留边界数量与预期不一致')
  const retained = before.boundaries.slice(0, userIndex).map((item, position) => ({
    previousId: item.id,
    nextId: after.boundaries[position]!.id,
  }))
  // Switch the live bridge identity only after every retained prefix check passed.
  sessionId = forked.sessionId
  hasHistory = true
  return { sessionId: forked.sessionId, retained }
}

async function invoke(method: string, p: any) {
  if (method === 'initialize') {
    // Refused before any process is spawned: an unreadable Auto opt-in must not resolve to
    // an ordinary session, because the ordinary session is the more permissive of the two.
    if (autoReviewSetting !== undefined && autoReviewSetting !== '0' && autoReviewSetting !== '1')
      throw Error('OPL_NATIVE_AUTO_REVIEW 不是受支持的取值')
    if (imageInputSetting !== undefined && imageInputSetting !== '0' && imageInputSetting !== '1')
      throw Error('OPL_NATIVE_IMAGE_INPUT 不是受支持的取值')
    if (kind === 'codex') await openCodex()
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: imageInput },
        _meta: {
          [OPL_EDIT_META]: { version: 1, methods: [OPL_EDIT_READ, OPL_EDIT_REWIND] },
        },
      },
      agentInfo: { name: kind, version: 'native' },
    }
  }
  if (method === 'session/new' || method === 'session/load') {
    if (p.cwd !== cwd) throw Error('不能改变已绑定项目')
    contextUsage = undefined
    servers = Object.fromEntries(
      (p.mcpServers ?? []).map((s: any) => [
        s.name,
        {
          command: s.command,
          args: s.args,
          env: Object.fromEntries(s.env.map((e: any) => [e.name, e.value])),
        },
      ]),
    )
    if (kind === 'codex') {
      codexUsage.reset(method === 'session/new')
      sessionId = method === 'session/load' ? p.sessionId : ''
      const config = {
        model_provider: 'opl-gateway',
        model_providers: {
          'opl-gateway': {
            name: 'OPL Gateway',
            base_url: process.env.OPL_NATIVE_BASE_URL,
            env_key: 'OPL_NATIVE_API_KEY',
            wire_api: 'responses',
            requires_openai_auth: false,
          },
        },
        mcp_servers: Object.fromEntries(
          Object.entries(servers).map(([k, v]) => [
            k,
            { ...v, enabled: true, default_tools_approval_mode: 'approve', tool_timeout_sec: 600 },
          ]),
        ),
        shell_environment_policy: { inherit: 'core', exclude: ['OPL_*', 'ANTHROPIC_*', 'DSH_*'] },
        forced_login_method: 'api',
      }
      const params = {
        model,
        modelProvider: 'opl-gateway',
        cwd,
        // Codex refuses to start a thread under a restricted profile once
        // CODEX_NATIVE_GIT_BASH_PATH is set, so the mode and the Bash path have to agree.
        sandbox: codexSandboxMode(taskPermission),
        // An ordinary session keeps `never`: Codex runs to completion without ever asking,
        // and the bridge declines any request that still reaches it. An Auto session asks
        // Codex to route those requests to its official reviewer instead of the user, which
        // is only possible under a policy that raises them at all.
        approvalPolicy: autoReview ? 'on-request' : 'never',
        ...(autoReview ? { approvalsReviewer: 'auto_review' } : {}),
        config,
      }
      codexOpeningUsage.length = 0
      codexOpeningSession = true
      let r: any
      try {
        r = await codexRequest(method === 'session/load' ? 'thread/resume' : 'thread/start', {
          ...params,
          ...(p.sessionId ? { threadId: p.sessionId } : {}),
        })
      } finally {
        codexOpeningSession = false
      }
      sessionId = r.thread.id
      for (const notification of codexOpeningUsage.splice(0)) {
        const pending =
          notification && typeof notification === 'object' && !Array.isArray(notification)
            ? (notification as { threadId?: unknown })
            : {}
        if (pending.threadId === sessionId) recordContext(codexUsage.accept(notification)?.context)
      }
      if (r.model && r.model !== model) throw Error('Codex 返回不同模型')
      if (r.modelProvider && r.modelProvider !== 'opl-gateway')
        throw Error('Codex 返回不同模型来源')
      // Verified after the thread exists but before any turn, so a thread that did not take
      // the official reviewer is refused instead of being used.
      if (autoReview) confirmCodexAutoReview(r)
      if (codexGitBashRequested) await confirmCodexGitBash(sessionId)
    } else {
      sessionId = p.sessionId ?? randomUUID()
      hasHistory = false
    }
    return {
      sessionId,
      models: { currentModelId: model },
      _meta: nativeContextUsageMeta(contextUsage),
    }
  }
  if (p.sessionId !== sessionId) throw Error('会话身份不匹配')
  if (method === OPL_EDIT_READ) {
    editIdle()
    if (kind === 'codex') return codexHistory(sessionId)
    if (kind === 'claude') return claudeHistory(sessionId)
    editFailure('capability-missing', '当前原生桥接不支持消息编辑历史')
  }
  if (method === OPL_EDIT_REWIND) {
    editIdle()
    if (typeof p.targetId !== 'string' || typeof p.expectedToken !== 'string')
      editFailure('invalid-request', '消息编辑回退参数不完整')
    if (kind === 'codex') return codexRewind(sessionId, p.targetId, p.expectedToken)
    if (kind === 'claude') return claudeRewind(sessionId, p.targetId, p.expectedToken)
    editFailure('capability-missing', '当前原生桥接不支持消息编辑回退')
  }
  if (method === 'session/cancel') {
    cancelled = true
    for (const resolve of asks.values()) resolve(false)
    asks.clear()
    if (kind === 'codex' && turnId)
      await codexRequest('turn/interrupt', { threadId: sessionId, turnId })
    if (claude) await claude.interrupt()
    return {}
  }
  if (method === 'session/prompt') {
    if (kind === 'codex' && !process.env.OPL_NATIVE_BASE_URL)
      throw Error('Codex 模型来源未提供端点，未发送提示词')
    const prompt = nativePrompt(p.prompt)
    const effort = p._meta?.reasoningEffort ?? undefined
    if (kind === 'claude') return claudePrompt(prompt, effort)
    codexMessageText.clear()
    codexUsage.beginTurn()
    const done = new Promise((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    // Mark the promise handled before awaiting turn/start, which can itself fail.
    void done.catch(() => {})
    try {
      const r = await codexRequest('turn/start', {
        threadId: sessionId,
        input: prompt.map((part) =>
          part.type === 'text'
            ? { type: 'text', text: part.text, text_elements: [] }
            : { type: 'image', url: `data:${part.mimeType};base64,${part.data}` },
        ),
        model,
        effort: effort ?? null,
      })
      turnId = r.turn.id
      recordContext(codexUsage.bindTurn(turnId)?.context)
      return await done
    } finally {
      codexUsage.endTurn()
      resolveTurn = undefined
      rejectTurn = undefined
      turnId = ''
    }
  }
  throw Error('不支持的调用')
}
createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    let m: any
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (!m.method) {
      const answer = asks.get(m.id)
      if (answer) {
        asks.delete(m.id)
        answer(m.result?.outcome?.optionId === 'allow')
      }
      return
    }
    try {
      const result = await invoke(m.method, m.params ?? {})
      if (m.id !== undefined) send({ id: m.id, result })
    } catch (error) {
      if (process.env.OPL_NATIVE_DIAGNOSTICS === '1')
        process.stderr.write(
          JSON.stringify({
            method: m.method,
            error: String(error instanceof Error ? error.message : 'failure').replaceAll(
              process.env.OPL_NATIVE_API_KEY ?? '__none__',
              '[REDACTED]',
            ),
          }) + '\n',
        )
      if (m.id !== undefined)
        send({
          id: m.id,
          error: bridgeFailure(error),
        })
    }
  })()
})
const stop = () => {
  claude?.close()
  child?.kill('SIGTERM')
  process.exit()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
