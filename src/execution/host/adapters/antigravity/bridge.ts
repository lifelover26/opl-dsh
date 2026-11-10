/** Stdio ACP projection over the official Antigravity CLI and a native Gemini relay. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { safeFailureDetails } from '../failure-diagnostics.ts'
import { nativeContextUsageMeta, nativeTurnUsageMeta } from '../native-usage.ts'
import {
  startAntigravityGeminiProxy,
  type AntigravityGeminiProxy,
  type AntigravityNativeRoute,
  type GeminiProxyFailure,
} from './gemini-proxy.ts'
import { prepareAntigravityShell } from './shell.ts'
import { antigravityContextUsage, normalizeAntigravityUsage } from './usage.ts'

type RpcId = string | number
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
const rpcId = (value: unknown): value is RpcId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))

interface PendingRequest {
  readonly method: string
  readonly sessionId?: string
}
interface ActivePrompt {
  readonly id: RpcId
  readonly sessionId: string
  readonly scope: number
  forwarded: boolean
  cancelled: boolean
  body: string
  bodyTruncated: boolean
  readonly toolCommands: Map<string, string>
  usageMetadata?: unknown
}
interface FatalPrompt {
  readonly turn: ActivePrompt
  readonly failure: GeminiProxyFailure
}

/** Optional I/O and shell dependencies used by the bridge's process-level verification. */
export interface AntigravityBridgeOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly input?: Readable
  readonly output?: Writable
  readonly prepareShell?: typeof prepareAntigravityShell
}

function routeFromEnvironment(raw: string | undefined): AntigravityNativeRoute {
  const route = object(JSON.parse(raw ?? '{}'))
  if (
    route.protocol !== 'gemini-native' ||
    typeof route.baseURL !== 'string' ||
    typeof route.model !== 'string' ||
    typeof route.apiKey !== 'string' ||
    (route.contextWindow !== undefined &&
      (typeof route.contextWindow !== 'number' ||
        !Number.isSafeInteger(route.contextWindow) ||
        route.contextWindow <= 0))
  )
    throw Error('Antigravity native route is incomplete')
  return route as unknown as AntigravityNativeRoute
}

function upstreamCode(failure: GeminiProxyFailure): string {
  if (failure.kind === 'policy') return 'HARNESS_EXECUTION'
  const status = failure.httpStatus
  if (status === undefined)
    return failure.kind === 'stream' ? 'HARNESS_PROVIDER' : 'HARNESS_PROVIDER_NETWORK'
  if (status === 401 || status === 403) return 'HARNESS_PROVIDER_AUTH'
  if (status === 404) return 'HARNESS_PROVIDER_MODEL'
  if (status === 408 || status === 504) return 'HARNESS_PROVIDER_TIMEOUT'
  if (status === 429) return 'HARNESS_PROVIDER_RATE_LIMIT'
  return 'HARNESS_PROVIDER'
}

/** Stop this bridge's own CLI tree before releasing Hook files or reporting cancellation. */
async function stopChild(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<void>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolveStop, reject) => {
      execFile(
        join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 },
        (error) => {
          if (error && child.exitCode === null && child.signalCode === null)
            reject(Error('Antigravity owned process tree did not stop'))
          else resolveStop()
        },
      )
    })
    await exited
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // The owned process may have exited between the state read and the signal.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      // A successful TERM may already have removed the owned process group.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 1500)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run one suite-owned official CLI; this module has no agent loop or retry policy.
 * @param options - Process environment and optional explicit dependencies.
 * @returns After input ends or the child exits, with all owned sockets and children stopped.
 */
export async function runAntigravityBridge(options: AntigravityBridgeOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const command = env.OPL_AGY_COMMAND
  const profile = env.OPL_AGY_PROFILE
  const workspace = env.OPL_AGY_WORKSPACE
  const node = env.OPL_AGY_NODE
  if ([command, profile, workspace, node].some((value) => !value || !isAbsolute(value)))
    throw Error('Antigravity launch paths are incomplete')
  const route = routeFromEnvironment(env.OPL_AGY_ROUTE)
  const prefix: unknown = JSON.parse(env.OPL_AGY_ARGS ?? '[]')
  if (
    !Array.isArray(prefix) ||
    prefix.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw Error('Antigravity launch arguments are invalid')
  const shell = await (options.prepareShell ?? prepareAntigravityShell)({
    profile: profile!,
    workspace: workspace!,
    node: node!,
    hookPath: join(dirname(fileURLToPath(import.meta.url)), 'antigravity-shell-hook.mjs'),
    ...(env.OPL_AGY_GIT_BASH ? { bash: env.OPL_AGY_GIT_BASH } : {}),
    env,
  })
  let active: ActivePrompt | undefined
  let fatal: FatalPrompt | undefined
  let relay: AntigravityGeminiProxy
  let closing: Promise<void> | undefined
  let stopping = false
  let child: ChildProcessWithoutNullStreams | undefined
  let exited: Promise<void> = Promise.resolve()
  const pending = new Map<RpcId, PendingRequest>()
  let currentSession = ''
  let inputLines: ReturnType<typeof createInterface> | undefined
  let outputLines: ReturnType<typeof createInterface> | undefined
  let outputQueue = Promise.resolve()

  const send = (message: JsonObject) =>
    output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const failureReply = (id: RpcId, code: string, data: JsonObject = {}) =>
    send({
      id,
      error: {
        code,
        message: 'Antigravity request did not complete',
        data: { service: 'session', ...data },
      },
    })
  function finish(turn: ActivePrompt): void {
    if (active !== turn) return
    active = undefined
    pending.delete(turn.id)
    relay.finishPrompt(turn.scope)
  }
  function fail(scope: number, failure: GeminiProxyFailure): void {
    if (stopping || !active || active.scope !== scope || active.cancelled || fatal) return
    fatal = { turn: active, failure }
    void stop().catch(() => {
      // Cleanup failure is reported by the awaited bridge completion, never raw CLI text.
    })
  }

  async function stop(): Promise<void> {
    return (closing ??= (async () => {
      stopping = true
      inputLines?.close()
      await relay.close()
      if (child) await stopChild(child, exited)
      await outputQueue
      outputLines?.close()
      await shell.dispose()
      if (fatal) {
        const { turn, failure } = fatal
        failureReply(turn.id, upstreamCode(failure), {
          oplTurnSettled: true,
          terminalState: 'failed',
          errorName:
            failure.kind === 'policy'
              ? 'protocolError'
              : failure.kind === 'http'
                ? 'APIError'
                : 'responseStreamDisconnected',
          ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
        })
        pending.delete(turn.id)
      } else if (active?.cancelled) {
        send({ id: active.id, result: { stopReason: 'cancelled' } })
        pending.delete(active.id)
      }
      for (const id of pending.keys())
        failureReply(id, 'HARNESS_EXECUTION', {
          terminalState: 'failed',
          errorName: 'processExited',
          oplTurnSettled: true,
        })
      pending.clear()
      active = undefined
    })())
  }

  try {
    relay = await startAntigravityGeminiProxy({
      route,
      env,
      beforeForward: () => shell.verifyInvocation(),
      onFailure: fail,
      onUsageMetadata: (scope, value) => {
        if (active?.scope === scope) active.usageMetadata = value
      },
    })
  } catch (error) {
    await shell.dispose()
    throw error
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...shell.env,
    GEMINI_API_KEY: relay.key,
    GOOGLE_GEMINI_BASE_URL: relay.baseURL,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  }
  for (const key of Object.keys(childEnv))
    if (key.startsWith('OPL_AGY_') && !key.startsWith('OPL_AGY_SHELL_')) delete childEnv[key]
  delete childEnv.ELECTRON_RUN_AS_NODE
  // The CLI only receives an ephemeral loopback key. The actual source key stays in this process.
  child = spawn(
    command!,
    [
      ...(prefix as string[]),
      'acp',
      '--disable-telemetry',
      '--dangerously-skip-permissions',
      '--log-file',
      join(profile!, 'cli.log'),
      ...shell.args,
    ],
    {
      cwd: workspace!,
      env: childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  )
  const cli = child
  exited = new Promise<void>((resolveExit) => {
    cli.once('close', () => resolveExit())
    cli.once('error', () => resolveExit())
  })
  cli.stderr.resume()
  cli.stdin.on('error', () => {
    void stop().catch(() => {})
  })

  async function forwardInput(line: string): Promise<void> {
    if (stopping) return
    let message: JsonObject
    try {
      message = object(JSON.parse(line))
    } catch {
      send({ id: null, error: { code: -32700, message: 'Invalid ACP JSON' } })
      return
    }
    const id = message.id
    const method = message.method
    const params = object(message.params)
    if (typeof method !== 'string') {
      if (!cli.stdin.destroyed) cli.stdin.write(line + '\n')
      return
    }
    const reject = (messageText: string) => {
      if (rpcId(id)) send({ id, error: { code: -32602, message: messageText } })
    }
    if (method === 'authenticate' && params.methodId !== 'gemini-api-key') {
      reject('Only the selected Gemini API-key route is available')
      return
    }
    if (
      (method === 'session/new' || method === 'session/load') &&
      (typeof params.cwd !== 'string' || resolve(params.cwd) !== resolve(workspace!))
    ) {
      reject('Antigravity workspace cannot change')
      return
    }
    if (method === 'session/set_config_option') {
      if (
        (params.configId === 'model' && params.value !== route.model) ||
        (params.configId === 'thought_level' &&
          !['low', 'medium', 'high'].includes(String(params.value)))
      ) {
        reject('Antigravity model or thought level is outside the selected combination')
        return
      }
    }
    if (method === 'session/cancel' && active && params.sessionId === active.sessionId) {
      const turn = active
      turn.cancelled = true
      relay.finishPrompt(turn.scope)
      if (!turn.forwarded) {
        finish(turn)
        send({ id: turn.id, result: { stopReason: 'cancelled' } })
        if (rpcId(id)) send({ id, result: {} })
        return
      }
      // Confirm the owned tool tree has exited before reporting cancellation. The
      // vendor's prompt reply alone does not establish that a spawned shell stopped.
      if (!cli.stdin.destroyed) cli.stdin.write(line + '\n')
      await stop()
      if (rpcId(id)) send({ id, result: {} })
      return
    }
    if (method === 'session/prompt') {
      if (
        !rpcId(id) ||
        typeof params.sessionId !== 'string' ||
        params.sessionId !== currentSession ||
        active
      ) {
        reject('Antigravity prompt requires its current idle session')
        return
      }
      const turn: ActivePrompt = {
        id,
        sessionId: params.sessionId,
        scope: relay.beginPrompt(),
        forwarded: false,
        cancelled: false,
        body: '',
        bodyTruncated: false,
        toolCommands: new Map(),
      }
      active = turn
      pending.set(id, { method, sessionId: turn.sessionId })
      try {
        await shell.invalidateInvocation()
      } catch {
        fail(turn.scope, { kind: 'policy' })
        return
      }
      if (stopping || active !== turn || turn.cancelled) return
      turn.forwarded = true
    } else if (rpcId(id)) {
      pending.set(id, {
        method,
        ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
      })
    }
    if (!cli.stdin.destroyed) cli.stdin.write(line + '\n')
  }

  async function forwardOutput(line: string): Promise<void> {
    if (stopping) return
    let message: JsonObject
    try {
      message = object(JSON.parse(line))
    } catch {
      // Official CLI diagnostics are not ACP and may contain provider-supplied strings.
      return
    }
    const id = message.id
    const method = message.method
    if (typeof method === 'string') {
      if (method === 'session/update') {
        const params = object(message.params)
        const update = object(params.update)
        const kind = update.sessionUpdate
        const isTurnContent = [
          'agent_message_chunk',
          'agent_thought_chunk',
          'tool_call',
          'tool_call_update',
          'plan',
          'usage_update',
        ].includes(String(kind))
        if (isTurnContent && (!active || active.cancelled || params.sessionId !== active.sessionId))
          return
        if (kind === 'agent_message_chunk' && active) {
          const content = object(update.content)
          if (content.type === 'text' && typeof content.text === 'string') {
            if (active.body.length + content.text.length > 512) active.bodyTruncated = true
            if (!active.bodyTruncated) active.body += content.text
          }
        }
        if ((kind === 'tool_call' || kind === 'tool_call_update') && active) {
          const rawInput = object(update.rawInput)
          const toolId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
          const direct = rawInput.CommandLine ?? object(update.args).CommandLine
          if (toolId && typeof direct === 'string') active.toolCommands.set(toolId, direct)
          const commandLine = direct ?? (toolId ? active.toolCommands.get(toolId) : undefined)
          if (typeof commandLine === 'string') {
            const hash = createHash('sha256').update(commandLine).digest('hex')
            const execution = (await shell.executions()).findLast(
              (entry) => entry.commandSha256 === hash,
            )
            if (execution)
              update._meta = { ...object(update._meta), 'opl/commandExecution': execution }
          }
        }
      }
      send(message)
      return
    }
    if (!rpcId(id)) return
    const request = pending.get(id)
    if (!request) return
    if (request.method === 'session/prompt' && active?.id === id) {
      const turn = active
      if (turn.cancelled) {
        finish(turn)
        send({ id, result: { stopReason: 'cancelled' } })
        return
      }
      if (
        !turn.bodyTruncated &&
        /^⚠\s*Agent execution terminated due to error\.$/u.test(turn.body.trim())
      ) {
        fail(turn.scope, { kind: 'stream' })
        return
      }
      const result = object(message.result)
      const usage = normalizeAntigravityUsage(result.usage)
      const context = antigravityContextUsage(turn.usageMetadata, route.contextWindow)
      if (message.result !== undefined) {
        result._meta = {
          ...object(result._meta),
          ...nativeTurnUsageMeta(usage),
          ...nativeContextUsageMeta(context),
        }
        message.result = result
      }
      finish(turn)
    } else {
      pending.delete(id)
      if (request.method === 'session/new' || request.method === 'session/load') {
        const result = object(message.result)
        if (typeof result.sessionId === 'string') currentSession = result.sessionId
        else if (message.error === undefined && request.sessionId)
          currentSession = request.sessionId
      }
    }
    if (message.error !== undefined) {
      const error = object(message.error)
      const code =
        typeof error.code === 'number' && Number.isInteger(error.code) ? error.code : -32603
      message.error = {
        code,
        message: 'Antigravity request failed',
        data: safeFailureDetails(error),
      }
    }
    send(message)
  }

  inputLines = createInterface({ input, crlfDelay: Infinity })
  outputLines = createInterface({ input: cli.stdout, crlfDelay: Infinity })
  inputLines.on('line', (line) => {
    void forwardInput(line).catch(() => {
      if (active) fail(active.scope, { kind: 'policy' })
      else void stop().catch(() => {})
    })
  })
  outputLines.on('line', (line) => {
    outputQueue = outputQueue
      .then(() => forwardOutput(line))
      .catch(() => {
        if (active) fail(active.scope, { kind: 'policy' })
        else void stop().catch(() => {})
      })
  })
  const onInputEnd = () => {
    void stop().catch(() => {})
  }
  const onSignal = () => {
    void stop().catch(() => {})
  }
  input.once('end', onInputEnd)
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  try {
    await exited
    await outputQueue
    await stop()
  } finally {
    input.removeListener('end', onInputEnd)
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('SIGINT', onSignal)
  }
}
