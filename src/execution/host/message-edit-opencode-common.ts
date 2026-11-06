/**
 * Shared OpenCode/Kilo implementation of the read/rewind driver contract.
 *
 * The driver owns only vendor history observation and a boundary fork. It never sends a
 * replacement prompt, writes a HarnessSession, touches DSH logs or nativeSessionId, undoes
 * files, or deletes an old branch. The shared owner journals the invocation and persists the
 * returned identity/mapping.
 *
 * The temporary control server is the official CLI's own `serve` command, launched with the
 * exact environment prepared by the adapter (`context.launch`). No credential is resolved or
 * copied here; the password below is a fresh per-run Basic-auth secret for loopback only.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { AdapterLaunch } from './adapters/types.ts'
import { commandLaunch } from './harness-registry.ts'
import type {
  ExternalEditBoundary,
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'
import { summarizeOpenCodeKiloUsage } from './usage-opencode-kilo.ts'

const exec = promisify(execFile)

export type ExternalMessageEditFailure =
  | 'unsupported'
  | 'busy'
  | 'aborted'
  | 'stale'
  | 'history-changed'
  | 'target-unknown'
  | 'target-unavailable'
  | 'control-unavailable'
  | 'fork-rejected'
  | 'uncertain'
  | 'protocol'

const FAILURE_MESSAGES: Record<ExternalMessageEditFailure, string> = {
  unsupported: '当前官方 CLI 版本不提供消息编辑所需的会话历史接口',
  busy: '会话仍在执行，暂时不能编辑历史',
  aborted: '编辑已取消',
  stale: '会话身份已变化，请重新读取',
  'history-changed': '会话历史已变化，请重新读取',
  'target-unknown': '目标消息不在当前活动历史中',
  'target-unavailable': '目标消息当前不可编辑',
  'control-unavailable': '无法启动官方 CLI 的临时控制服务',
  'fork-rejected': '官方 CLI 拒绝了本次分支请求',
  uncertain: '分支结果不确定，请核对会话历史',
  protocol: '官方 CLI 返回了无法验证的会话历史',
}

/** Fixed, credential-free failure. `status` is the only vendor response fact retained. */
export class ExternalMessageEditError extends Error {
  readonly code: ExternalMessageEditFailure
  readonly status: number | undefined
  constructor(code: ExternalMessageEditFailure, status?: number) {
    super(FAILURE_MESSAGES[code])
    this.name = 'ExternalMessageEditError'
    this.code = code
    this.status = status
  }
}

/** One vendor message as returned by the public message list. Unknown fields are retained. */
export interface VendorMessage {
  readonly info: Record<string, any>
  readonly parts: readonly Record<string, any>[]
}

/** Temporary authenticated control surface. Only observation/fork/close are exposed. */
export interface VendorControl {
  readMessages(sessionId: string): Promise<VendorMessage[]>
  /** Process-local status; an idle result does not certify a separate ACP process has exited. */
  readStatus?(sessionId: string): Promise<'idle' | 'busy'>
  /** Optional public route metadata from the same local server lifecycle. */
  readProviders?(): Promise<unknown>
  fork(sessionId: string, messageID: string): Promise<{ sessionId: string }>
  close(): Promise<void>
}

export type StartVendorControl = (context: ExternalEditContext) => Promise<VendorControl>

export interface ControlSpec {
  readonly passwordEnv: string
  readonly usernameEnv: string
  readonly defaultUsername: string
}

const object = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}

const string = (value: unknown): string => (typeof value === 'string' ? value : '')

function failure(code: ExternalMessageEditFailure, status?: number): ExternalMessageEditError {
  return new ExternalMessageEditError(code, status)
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw failure('aborted')
}

function abortable(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function messageId(message: VendorMessage): string {
  const id = string(message.info.id)
  if (!id) throw failure('protocol')
  return id
}

function parentId(message: VendorMessage): string | undefined {
  const value = message.info.parentID
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value) throw failure('protocol')
  return value
}

function compactionParts(message: VendorMessage): Record<string, any>[] {
  return message.parts.filter((part) => part.type === 'compaction')
}

function tailStart(part: Record<string, any>): string | undefined {
  const value = part.tail_start_id
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value) throw failure('protocol')
  return value
}

function normalizeForComparison(message: VendorMessage): unknown {
  const copy = clone(message)
  const info = object(copy.info)
  delete info.id
  delete info.sessionID
  delete info.parentID
  for (const part of Array.isArray(copy.parts) ? copy.parts : []) {
    const item = object(part)
    delete item.id
    delete item.messageID
    delete item.sessionID
    if (item.type === 'compaction') delete item.tail_start_id
  }
  return copy
}

function historyToken(sessionId: string, messages: readonly VendorMessage[]): string {
  return `sha256:${createHash('sha256')
    .update(canonical({ version: 1, sessionId, messages }))
    .digest('hex')}`
}

function asMessages(value: unknown): VendorMessage[] {
  if (!Array.isArray(value)) throw failure('protocol')
  const seen = new Set<string>()
  return value.map((item) => {
    const message = object(item)
    const info = object(message.info)
    if (
      !Array.isArray(message.parts) ||
      typeof info.id !== 'string' ||
      !info.id ||
      typeof info.role !== 'string'
    )
      throw failure('protocol')
    if (seen.has(info.id)) throw failure('protocol')
    seen.add(info.id)
    if (!message.parts.every((part) => typeof object(part).type === 'string'))
      throw failure('protocol')
    return message as VendorMessage
  })
}

function incompleteAssistant(messages: readonly VendorMessage[]): boolean {
  let incomplete = false
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue
    const completed = object(message.info.time).completed
    if (completed === undefined || completed === null) incomplete = true
    else if (typeof completed !== 'number' || !Number.isFinite(completed)) throw failure('protocol')
  }
  return incomplete
}

function assertSettled(messages: readonly VendorMessage[], quiescent = false): void {
  if (!quiescent && incompleteAssistant(messages)) throw failure('busy')
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      const status = object(part.state).status
      if (status === 'pending' || status === 'running') throw failure('busy')
      if (status !== 'completed' && status !== 'error') throw failure('protocol')
    }
  }
}

function assertTerminalTurns(context: ExternalEditContext): void {
  if (
    context.record.turns.some(
      (turn) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.state),
    )
  )
    throw failure('busy')
}

async function disconnectOwned(context: ExternalEditContext): Promise<void> {
  assertTerminalTurns(context)
  ensureActive(context.signal)
  try {
    await context.disconnect()
  } catch (error) {
    if (context.signal.aborted) throw failure('aborted')
    throw failure('control-unavailable')
  }
  ensureActive(context.signal)
  assertTerminalTurns(context)
}

async function readIdleMessages(
  context: ExternalEditContext,
  control: VendorControl,
  sessionId: string,
): Promise<VendorMessage[]> {
  const assertIdle = async () => {
    ensureActive(context.signal)
    if (control.readStatus && (await control.readStatus(sessionId)) !== 'idle')
      throw failure('busy')
  }
  await assertIdle()
  const messages = asMessages(await control.readMessages(sessionId))
  await assertIdle()
  ensureActive(context.signal)
  return messages
}

function nonSyntheticText(message: VendorMessage): string {
  return message.parts
    .filter(
      (part) =>
        part.type === 'text' &&
        part.synthetic !== true &&
        part.ignored !== true &&
        typeof part.text === 'string',
    )
    .map((part) => String(part.text))
    .join('')
}

function boundariesOf(messages: readonly VendorMessage[]): ExternalEditBoundary[] {
  const boundaries: ExternalEditBoundary[] = []
  for (const message of messages) {
    if (message.info.role !== 'user') continue
    const text = nonSyntheticText(message)
    const hasFile = message.parts.some((part) => part.type === 'file')
    const hasUnsupportedFile = message.parts.some(
      (part) =>
        part.type === 'file' &&
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(part.mime)),
    )
    const imageCount = message.parts.filter(
      (part) =>
        part.type === 'file' &&
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(part.mime)),
    ).length
    const id = messageId(message)
    if (!text.trim()) {
      if (hasFile) boundaries.push({ id, unavailableReason: '这条消息没有可编辑文本' })
      continue
    }
    boundaries.push({
      id,
      text,
      ...(imageCount ? { imageCount } : {}),
      ...(hasUnsupportedFile ? { unavailableReason: '这条消息带有附件，暂不支持编辑' } : {}),
    })
  }
  return boundaries
}

/**
 * Compare a fork prefix to the source prefix.
 *
 * Only documented identity fields are removed before exact structural equality:
 * message `id`/`sessionID`/`parentID`, part `id`/`messageID`/`sessionID`, and a compaction
 * part's `tail_start_id`. Parent and compaction links are then checked one-to-one against the
 * id map. Every other field - tool output/error/metadata, reasoning text, summary/subtask
 * data, attachments and unknown fields - must compare exactly. A changed tool output is not
 * accepted.
 */
function comparePrefix(
  prefix: readonly VendorMessage[],
  fork: readonly VendorMessage[],
): Map<string, string> {
  if (prefix.length !== fork.length) throw failure('uncertain')
  const map = new Map<string, string>()
  const previous = new Set<string>()
  const next = new Set<string>()
  for (let index = 0; index < prefix.length; index += 1) {
    const oldId = messageId(prefix[index]!)
    const newId = messageId(fork[index]!)
    if (previous.has(oldId) || next.has(newId)) throw failure('protocol')
    previous.add(oldId)
    next.add(newId)
    map.set(oldId, newId)
  }
  for (let index = 0; index < prefix.length; index += 1) {
    const before = prefix[index]!
    const after = fork[index]!
    if (canonical(normalizeForComparison(before)) !== canonical(normalizeForComparison(after)))
      throw failure('uncertain')
    const oldParent = parentId(before)
    const newParent = parentId(after)
    if (oldParent === undefined) {
      if (newParent !== undefined) throw failure('uncertain')
    } else {
      const mapped = map.get(oldParent)
      if (!mapped || newParent !== mapped) throw failure('uncertain')
    }
    const oldCompactions = compactionParts(before)
    const newCompactions = compactionParts(after)
    if (oldCompactions.length !== newCompactions.length) throw failure('uncertain')
    for (let partIndex = 0; partIndex < oldCompactions.length; partIndex += 1) {
      const oldTail = tailStart(oldCompactions[partIndex]!)
      const newTail = tailStart(newCompactions[partIndex]!)
      if (oldTail === undefined) {
        if (newTail !== undefined) throw failure('uncertain')
      } else {
        const mapped = map.get(oldTail)
        if (!mapped || newTail !== mapped) throw failure('uncertain')
      }
    }
  }
  return map
}

function retainedBoundaries(
  boundaries: readonly ExternalEditBoundary[],
  messages: readonly VendorMessage[],
  fork: readonly VendorMessage[],
  targetIndex: number,
  map: ReadonlyMap<string, string>,
): ExternalEditResult['retained'] {
  const retained: ExternalEditResult['retained'] = []
  for (const boundary of boundaries) {
    const index = messages.findIndex((message) => messageId(message) === boundary.id)
    if (index < 0) throw failure('protocol')
    if (index >= targetIndex) continue
    const nextId = map.get(boundary.id)
    if (!nextId) throw failure('uncertain')
    const next = fork[index]
    if (!next || next.info.role !== 'user') throw failure('uncertain')
    if (boundary.text !== undefined && nonSyntheticText(next) !== boundary.text)
      throw failure('uncertain')
    retained.push({ previousId: boundary.id, nextId })
  }
  return retained
}

function ensureHarness(context: ExternalEditContext, kind: 'opencode' | 'kilo'): void {
  if (context.record.harnessRef !== kind) throw failure('unsupported')
  if (!context.record.acpSessionId) throw failure('stale')
}

function deriveServeLaunch(launch: AdapterLaunch): {
  command: string
  args: string[]
  windowsVerbatimArguments: boolean
} {
  const env = launch.env
  const controlCommand = string(env.OPL_CHAT_EDIT_COMMAND)
  if (controlCommand) {
    const prefix: unknown = JSON.parse(string(env.OPL_CHAT_EDIT_ARGS) || '[]')
    if (!Array.isArray(prefix) || !prefix.every((item) => typeof item === 'string'))
      throw failure('control-unavailable')
    const served = commandLaunch(controlCommand, [
      ...prefix,
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
    ])
    return {
      command: served.command,
      args: served.args,
      windowsVerbatimArguments: !!served.windowsVerbatimArguments,
    }
  }
  const bridgedCommand = string(env.OPL_CHAT_COMMAND)
  const command = bridgedCommand || launch.command
  if (!command) throw failure('control-unavailable')
  let args = bridgedCommand ? [] : launch.args
  const bridgedArgs = string(env.OPL_CHAT_ARGS)
  if (bridgedArgs) {
    try {
      const parsed: unknown = JSON.parse(bridgedArgs)
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string'))
        throw failure('control-unavailable')
      args = parsed
    } catch (error) {
      if (error instanceof ExternalMessageEditError) throw error
      throw failure('control-unavailable')
    }
  }
  // The adapter may hand over a cmd.exe wrapper. Rebuilding that wrapper is not safe here;
  // fail closed rather than launching a different program.
  if (/cmd\.exe$/i.test(command) || args.slice(0, 3).some((arg) => /^\/[dsc]$/i.test(arg)))
    throw failure('control-unavailable')
  const acp = args.indexOf('acp')
  const prefix = acp >= 0 ? args.slice(0, acp) : args
  const served = commandLaunch(command, [
    ...prefix,
    'serve',
    '--port',
    '0',
    '--hostname',
    '127.0.0.1',
  ])
  return {
    command: served.command,
    args: served.args,
    windowsVerbatimArguments: !!served.windowsVerbatimArguments,
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolveExit(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) finish(true)
  })
}

async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    try {
      await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000,
      })
    } catch (error) {
      // The child can exit before taskkill resolves; the exit observation below is authoritative.
    }
  } else {
    child.kill()
  }
  if (await waitForExit(child, 5000)) return
  try {
    child.kill('SIGKILL')
  } catch (error) {
    // A concurrent exit is accepted only by the bounded exit observation below.
  }
  if (!(await waitForExit(child, 2000))) throw failure('control-unavailable')
}

async function waitForServer(child: ChildProcess, signal: AbortSignal): Promise<string> {
  ensureActive(signal)
  if (!child.stdout) throw failure('control-unavailable')
  return new Promise<string>((resolveUrl, reject) => {
    const lines = createInterface({ input: child.stdout! })
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      lines.removeListener('line', onLine)
      lines.close()
      child.stdout?.resume()
      child.removeListener('error', onFailure)
      child.removeListener('exit', onFailure)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (url?: string, aborted = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (url) resolveUrl(url)
      else reject(failure(aborted ? 'aborted' : 'control-unavailable'))
    }
    const onLine = (line: string) => {
      const match = line.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) finish(match[1])
    }
    const onFailure = () => finish()
    const onAbort = () => finish(undefined, true)
    const timer = setTimeout(onFailure, 30_000)
    lines.on('line', onLine)
    child.once('error', onFailure)
    child.once('exit', onFailure)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else if (child.exitCode !== null || child.signalCode !== null) onFailure()
  })
}

/**
 * Start the official CLI's `serve` from the exact adapter environment.
 *
 * No credential is resolved here; the adapter's config/credential environment is copied
 * verbatim and never logged. The only addition is a fresh loopback Basic-auth password.
 */
export async function startAuthenticatedControl(
  context: ExternalEditContext,
  spec: ControlSpec,
): Promise<VendorControl> {
  ensureActive(context.signal)
  const launch = deriveServeLaunch(context.launch)
  const password = randomUUID()
  const username = string(context.launch.env[spec.usernameEnv]) || spec.defaultUsername
  const env = { ...context.launch.env, [spec.passwordEnv]: password }
  const child = spawn(launch.command, launch.args, {
    cwd: context.record.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  child.stderr?.on('data', () => {})
  let base: string
  try {
    base = await waitForServer(child, context.signal)
    ensureActive(context.signal)
  } catch (error) {
    await stopOwnedChild(child)
    if (context.signal.aborted) throw failure('aborted')
    throw error
  }
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

  const request = async (
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(base + path, {
      redirect: 'error',
      method: init.method ?? 'GET',
      headers: {
        authorization,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: abortable(context.signal, init.timeoutMs ?? 15_000),
    })
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      throw failure('protocol')
    }
    return { status: response.status, json }
  }

  return {
    async readStatus(sessionId: string): Promise<'idle' | 'busy'> {
      let result: { status: number; json: unknown }
      try {
        result = await request('/session/status')
      } catch (error) {
        if (context.signal.aborted) throw failure('aborted')
        if (error instanceof ExternalMessageEditError) throw error
        throw failure('control-unavailable')
      }
      if (result.status === 404 || result.status === 405) throw failure('unsupported')
      if (result.status < 200 || result.status >= 300) throw failure('control-unavailable')
      if (typeof result.json !== 'object' || result.json === null || Array.isArray(result.json))
        throw failure('protocol')
      const statuses = result.json as Record<string, unknown>
      if (!Object.hasOwn(statuses, sessionId)) return 'idle'
      const type = object(statuses[sessionId]).type
      if (type === 'idle') return 'idle'
      if (['busy', 'retry', 'offline', 'scheduled'].includes(type)) return 'busy'
      throw failure('protocol')
    },
    async readMessages(sessionId: string): Promise<VendorMessage[]> {
      let result: { status: number; json: unknown }
      try {
        result = await request(`/session/${encodeURIComponent(sessionId)}/message`)
      } catch (error) {
        if (context.signal.aborted) throw failure('aborted')
        if (error instanceof ExternalMessageEditError) throw error
        throw failure('control-unavailable')
      }
      if (result.status === 405) throw failure('unsupported')
      if (result.status === 404) throw failure('stale')
      if (result.status === 401 || result.status === 403) throw failure('control-unavailable')
      if (result.status < 200 || result.status >= 300) throw failure('control-unavailable')
      const messages = asMessages(result.json)
      if (
        messages.some(
          (message) =>
            message.info.sessionID !== sessionId ||
            message.parts.some(
              (part) => part.sessionID !== sessionId || part.messageID !== message.info.id,
            ),
        )
      )
        throw failure('protocol')
      return messages
    },
    async readProviders(): Promise<unknown> {
      const result = await request('/provider')
      if (result.status < 200 || result.status >= 300) throw failure('control-unavailable')
      return result.json
    },
    async fork(sessionId: string, messageID: string): Promise<{ sessionId: string }> {
      let result: { status: number; json: unknown }
      try {
        result = await request(`/session/${encodeURIComponent(sessionId)}/fork`, {
          method: 'POST',
          body: { messageID },
          timeoutMs: 30_000,
        })
      } catch (error) {
        if (context.signal.aborted) throw failure('uncertain')
        if (error instanceof ExternalMessageEditError) throw error
        throw failure('uncertain')
      }
      if (result.status >= 400 && result.status < 500) throw failure('fork-rejected', result.status)
      if (result.status < 200 || result.status >= 300) throw failure('uncertain', result.status)
      const id = string(object(result.json).id)
      if (!id) throw failure('uncertain')
      return { sessionId: id }
    },
    async close(): Promise<void> {
      await stopOwnedChild(child)
    },
  }
}

function asUncertain(error: unknown): ExternalMessageEditError {
  if (error instanceof ExternalMessageEditError && error.code === 'uncertain') return error
  return failure('uncertain')
}

/** Identify the failed tail's reply without deriving a missing recorded input identity. */
function failedReplyInput(
  context: ExternalEditContext,
  messages: readonly VendorMessage[],
): string | undefined {
  const turn = context.record.turns.at(-1)
  if (!turn || !['failed', 'cancelled', 'interrupted'].includes(turn.state)) return
  const inputIndex = messages.findLastIndex((message) => message.info.role === 'user')
  const input = messages[inputIndex]
  if (!input) return
  const id = messageId(input)
  const replies = messages.slice(inputIndex + 1)
  if (
    !replies.length ||
    replies.some((reply) => reply.info.role !== 'assistant' || parentId(reply) !== id)
  )
    return
  if (turn.native?.userMessageId) return turn.native.userMessageId === id ? id : undefined
  // A single input in an empty fork can be abandoned explicitly. Its id is never
  // assigned to the record; the owner allocates another empty session for that edit.
  if (
    context.record.turns.length === 1 &&
    messages.filter((message) => message.info.role === 'user').length === 1
  )
    return id
}

async function readHistory(
  context: ExternalEditContext,
  startControl: StartVendorControl,
): Promise<{
  control: VendorControl
  messages: VendorMessage[]
  history: ExternalEditHistory
  quiescent: boolean
}> {
  ensureActive(context.signal)
  const modelId =
    typeof context.snapshot === 'function'
      ? string(object(context.snapshot().session.models).currentModelId)
      : ''
  const control = await startControl(context)
  try {
    const sessionId = context.record.acpSessionId
    const messages = await readIdleMessages(context, control, sessionId)
    const quiescent = incompleteAssistant(messages)
    const failedInput = failedReplyInput(context, messages)
    let stopped = false
    if (quiescent || (failedInput && control.readStatus)) {
      assertSettled(messages, quiescent)
      assertTerminalTurns(context)
      if (
        !context.record.turns.some((turn) =>
          ['failed', 'cancelled', 'interrupted'].includes(turn.state),
        )
      )
        throw failure('busy')
      if (!control.readStatus) throw failure('unsupported')
      // Status belongs to this temporary server. Only the owned ACP process exit plus
      // a stable reread can establish that an unfinished failed request is abandoned.
      await disconnectOwned(context)
      const after = await readIdleMessages(context, control, sessionId)
      if (historyToken(sessionId, after) !== historyToken(sessionId, messages))
        throw failure('history-changed')
      assertTerminalTurns(context)
      stopped = true
    }
    assertSettled(messages, quiescent)
    let statistics = new Map<string, import('./usage-opencode-kilo.ts').ExternalUsageStatistics>()
    try {
      if (modelId && control.readProviders)
        statistics = summarizeOpenCodeKiloUsage(
          messages,
          sessionId,
          modelId,
          await control.readProviders(),
        )
    } catch {
      // Optional statistics never make a successfully read edit history unavailable.
    }
    const boundaries = boundariesOf(messages).map((boundary) => {
      const value = statistics.get(boundary.id)
      return value ? { ...boundary, statistics: value } : boundary
    })
    ensureActive(context.signal)
    if (context.record.acpSessionId !== sessionId) throw failure('stale')
    return {
      control,
      messages,
      quiescent,
      history: {
        sessionId,
        token: historyToken(sessionId, messages),
        boundaries,
        ...(stopped && failedInput && boundaries.at(-1)?.id === failedInput
          ? { settledInputId: failedInput }
          : {}),
      },
    }
  } catch (error) {
    await control.close()
    throw error
  }
}

function createDriver(
  kind: 'opencode' | 'kilo',
  startControl: StartVendorControl,
): ExternalMessageEditDriver {
  return {
    async read(context) {
      ensureHarness(context, kind)
      ensureActive(context.signal)
      const { control, history } = await readHistory(context, startControl)
      await control.close()
      ensureActive(context.signal)
      return history
    },

    async rewind(context, input) {
      ensureHarness(context, kind)
      ensureActive(context.signal)
      if (!string(input.operationId) || !string(input.targetId)) throw failure('target-unknown')
      if (input.expected.sessionId !== context.record.acpSessionId) throw failure('stale')

      const { control, messages, history, quiescent } = await readHistory(context, startControl)
      const sessionId = history.sessionId
      try {
        if (history.token !== input.expected.token) throw failure('history-changed')
        const targetIndex = messages.findIndex((message) => messageId(message) === input.targetId)
        if (targetIndex < 0) throw failure('target-unknown')
        const boundary = history.boundaries.find((item) => item.id === input.targetId)
        if (!boundary) throw failure('target-unknown')
        if (boundary.unavailableReason) throw failure('target-unavailable')
        const expectedBoundary = input.expected.boundaries.find(
          (item) => item.id === input.targetId,
        )
        if (!expectedBoundary) throw failure('target-unknown')
        if (expectedBoundary.text !== boundary.text) throw failure('history-changed')
        if (!quiescent) await disconnectOwned(context)
        const beforeFork = await readIdleMessages(context, control, sessionId)
        if (historyToken(sessionId, beforeFork) !== history.token) throw failure('history-changed')
        assertSettled(beforeFork, quiescent)
        assertTerminalTurns(context)
        if (context.record.acpSessionId !== sessionId) throw failure('stale')
        ensureActive(context.signal)

        let forked: { sessionId: string }
        try {
          forked = await control.fork(sessionId, input.targetId)
        } catch (error) {
          // A 4xx is a known rejection; anything else may have created a branch.
          if (error instanceof ExternalMessageEditError && error.code === 'fork-rejected')
            throw error
          if (error instanceof ExternalMessageEditError && error.code === 'uncertain') throw error
          throw failure('uncertain')
        }
        if (!forked.sessionId || forked.sessionId === sessionId) throw failure('uncertain')
        if (context.signal.aborted) throw failure('uncertain')

        try {
          // The source must not have moved while the fork was being created. A concurrent
          // prompt/tool update invalidates the expected token even if the fork succeeded.
          const sourceAfter = await readIdleMessages(context, control, sessionId)
          if (historyToken(sessionId, sourceAfter) !== history.token) throw failure('uncertain')
          const forkMessages = await readIdleMessages(context, control, forked.sessionId)
          assertSettled(forkMessages, quiescent)
          const map = comparePrefix(messages.slice(0, targetIndex), forkMessages)
          const retained = retainedBoundaries(
            history.boundaries,
            messages,
            forkMessages,
            targetIndex,
            map,
          )
          if (context.signal.aborted) throw failure('uncertain')
          if (context.record.acpSessionId !== sessionId) throw failure('uncertain')
          assertTerminalTurns(context)
          return { sessionId: forked.sessionId, retained }
        } catch (error) {
          throw asUncertain(error)
        }
      } finally {
        await control.close()
      }
    },
  }
}

export function createVendorMessageEditDriver(
  kind: 'opencode' | 'kilo',
  startControl: StartVendorControl,
): ExternalMessageEditDriver {
  return createDriver(kind, startControl)
}

export { historyToken, comparePrefix, boundariesOf, asMessages }
