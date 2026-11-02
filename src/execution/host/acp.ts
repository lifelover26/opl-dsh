/** Bounded JSON-RPC stdio transport for the ACP v1 surface Grok advertises. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { failureDiagnosticSuffix, safeFailureDetails } from './adapters/failure-diagnostics.ts'
import { canonicalHarnessContext, canonicalHarnessUsage } from './usage.ts'
import type { HarnessStatistics } from '../contracts/usage.ts'
export const object = (value: unknown): Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
/**
 * Map a JSON-RPC error to a controlled, actionable message.
 *
 * Only finite error labels and validated protocol numbers are interpreted. The agent's
 * message and response text are never reflected: an arbitrary provider string could
 * carry credentials or account identifiers. Structured details contribute only the
 * explicitly recognized fields in failure-diagnostics. The
 * `HARNESS_*` families belong to this suite's own native bridge rather than to an
 * official CLI account, so a MiniMax login problem can never surface Gateway advice.
 */
const failureMessage = (code: unknown, data?: unknown) => {
  switch (code) {
    case 'HARNESS_AUTH':
      return '所选渠道认证失败，请在 OPL Gateway 刷新账号后重试。原任务未自动重发。'
    case 'HARNESS_RATE_LIMIT':
      return '所选渠道当前限流，请稍后重试。原任务未自动重发。'
    case 'HARNESS_MODEL':
      return '所选模型未被当前渠道接受，请检查模型配置。原任务未自动重发。'
    case 'HARNESS_TIMEOUT':
      return '所选渠道长时间没有返回首个响应，已停止本轮请求。请检查渠道状态后再手动发起新指令；原任务未自动重发。'
    case 'HARNESS_NETWORK':
      return '所选渠道连接中断，重试后仍未收到响应，已停止本轮请求。请检查网络或切换已配置的渠道；原任务未自动重发。'
    case 'HARNESS_EXECUTION':
      if (safeFailureDetails(data).errorName === 'NO_PROGRESS')
        return '上游在等待期限内没有返回正文、思考或工具进展，已停止本轮请求。'
      return '官方 Harness 报告本轮执行失败，原任务未自动重发。'
    case 'HARNESS_PROVIDER_CLIENT_REQUIRED':
      return '所选免费渠道要求通过其指定的官方客户端访问，当前转发请求被拒绝。原任务未自动重发。'
    case 'HARNESS_PROVIDER':
      return '官方渠道报告本轮请求失败，已停止本轮请求；原任务未自动重发。'
    case 'HARNESS_PROVIDER_AUTH':
      return '官方渠道认证失败或权限不足，原任务未自动重发。'
    case 'HARNESS_PROVIDER_RETIRED':
      return '上游已停止提供所选模型，请选择其他模型。原任务未自动重发。'
    case 'HARNESS_PROVIDER_ROUTE':
      return '上游账户缺少所选模型的服务路由，请等待渠道修复。原任务未自动重发。'
    case 'HARNESS_PROVIDER_MODEL':
      return '官方渠道不接受所选模型，原任务未自动重发。'
    case 'HARNESS_PROVIDER_RATE_LIMIT':
      return '官方渠道限流或配额已达上限，原任务未自动重发。'
    case 'HARNESS_PROVIDER_TIMEOUT':
      return '官方渠道请求超时，原任务未自动重发。'
    case 'HARNESS_PROVIDER_NETWORK':
      return '官方渠道连接或响应流中断，原任务未自动重发。'
    case -32700:
    case -32600:
    case -32601:
      return '官方 Harness 不支持本次请求的协议方法，请检查套件与官方 CLI 的版本是否匹配。原任务未自动重发。'
    case -32602:
      return '官方 Harness 拒绝了本次请求参数，请检查所选模型与固定组合是否匹配。原任务未自动重发。'
    case -32000:
      return '官方 Harness 要求认证，当前模型来源未通过认证。原任务未自动重发。'
    case -32603:
      if (object(data).service === 'session') {
        switch (object(data).errorName) {
          case 'APIError':
            return safeFailureDetails(data).httpStatus !== undefined
              ? '官方 Harness 报告模型接口请求失败。原任务未自动重发。'
              : '官方 Harness 报告模型接口请求失败，尚未提供可确认的 HTTP 状态。原任务未自动重发。'
          case 'ContextOverflowError':
            return '官方 Harness 报告本轮请求超出模型上下文容量。原任务未自动重发。'
          case 'StructuredOutputError':
            return '官方 Harness 未能取得要求的结构化输出。原任务未自动重发。'
        }
      }
      return '官方 Harness 返回内部错误，尚不能确定是渠道还是请求处理问题。原任务未自动重发。'
    default:
      return '官方 Harness 未提供可确认的失败原因。原任务未自动重发。'
  }
}
const harnessFailure = (code: unknown, data?: unknown) =>
  failureMessage(code, data) +
  failureDiagnosticSuffix({
    ...object(data),
    ...(typeof code === 'number' ? { rpcCode: code } : {}),
  })
/** Fixed request stages; unknown extension names never enter diagnostics. */
function requestStage(method: string): string {
  switch (method) {
    case 'initialize':
      return '初始化'
    case 'session/new':
      return '新建会话'
    case 'session/load':
      return '恢复会话'
    case 'session/set_config_option':
    case 'session/set_model':
    case 'session/set_mode':
      return '配置会话'
    case 'session/prompt':
      return '执行本轮请求'
    default:
      return '扩展请求'
  }
}
export class HarnessTransportError extends Error {}
/** A matched ACP error response; transport loss never creates this observation. */
export class HarnessRequestError extends HarnessTransportError {
  readonly promptSettled: boolean
  /** Validated per-prompt observations supplied by an owned bridge, never raw error data. */
  readonly statistics: HarnessStatistics
  constructor(message: string, method: string, code: unknown, data?: unknown) {
    super(message)
    const meta = method === 'session/prompt' ? object(object(data)._meta) : {}
    const account = object(meta['opl/turnUsage'])
    const usage = account.version === 1 ? canonicalHarnessUsage(account.usage) : undefined
    const contextUsage = canonicalHarnessContext(meta['opl/contextUsage'])
    this.statistics = {
      ...(usage ? { usage } : {}),
      ...(contextUsage ? { contextUsage } : {}),
    }
    this.promptSettled =
      method === 'session/prompt' &&
      (object(data).oplTurnSettled === true ||
        safeFailureDetails(data).terminalState === 'failed' ||
        (typeof code === 'string' &&
          [
            'HARNESS_PROVIDER_RATE_LIMIT',
            'HARNESS_PROVIDER_AUTH',
            'HARNESS_PROVIDER_MODEL',
            'HARNESS_PROVIDER_CLIENT_REQUIRED',
            'HARNESS_PROVIDER_RETIRED',
            'HARNESS_PROVIDER_ROUTE',
          ].includes(code)))
  }
}
/** Options for refusing an ACP prompt that never reports visible progress. */
export interface AcpRequestOptions {
  /** Maximum time to wait for the first useful update; disabled when omitted. */
  readonly firstProgressTimeoutMs?: number
  /** Fixed, credential-free diagnostic used when the first update never arrives. */
  readonly firstProgressTimeoutMessage?: string
  /** Return true only for notifications that demonstrate progress in this request. */
  readonly stderrFailure?: ((line: string) => string | undefined) | undefined
  readonly isProgress?: (method: string, params: unknown) => boolean
}
/**
 * The agent accepted the ACP session but refused to honor the combination's pinned
 * model or reasoning parameters. Carried separately so the precise reason survives
 * the turn-level error mapping instead of collapsing into a generic message.
 */
export class HarnessConfigurationError extends Error {}
export class AcpProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
      firstProgressTimer?: ReturnType<typeof setTimeout> | undefined
      sessionId?: string
      method: string
      firstProgressTimeoutMessage?: string
      isProgress?: (method: string, params: unknown) => boolean
    }
  >()
  private stderrObservers = new Map<number, (line: string) => string | undefined>()
  private sequence = 0
  closed = false
  private disposing?: Promise<void>
  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly update: (value: unknown) => void,
    private readonly permission: (id: string | number, value: unknown) => void,
    private readonly onExit: () => void,
    verbatimArguments = false,
    /** 扩展通知：官方 ACP 只定义 `session/update`，其余通知必须由使用方自行取用。 */
    private readonly notification?: (method: string, params: unknown) => void,
    private readonly clientRequests?: ReadonlyMap<string, () => Promise<unknown>>,
  ) {
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Needed for `cmd.exe` wrappers: see AdapterLaunch.windowsVerbatimArguments.
      ...(verbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    // Always drain stderr; it may contain provider diagnostics and is never reflected into the UI.
    let diagnostic = ''
    this.child.stderr.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString('utf8')
      let end: number
      while ((end = diagnostic.indexOf(String.fromCharCode(10))) >= 0) {
        const line = diagnostic.slice(0, end)
        diagnostic = diagnostic.slice(end + 1)
        for (const [id, classify] of this.stderrObservers) {
          if (!this.pending.has(id)) {
            this.stderrObservers.delete(id)
            continue
          }
          const message = classify(line)
          if (message) {
            this.fail(message)
            void this.dispose().catch(() => {})
            break
          }
        }
      }
      if (diagnostic.length > 65536) diagnostic = ''
    })
    this.child.stdin.on('error', () => this.fail('Harness ACP 输入通道关闭'))
    this.child.on('error', () => this.fail('无法启动 Harness，请检查官方程序与执行路径'))
    this.child.on('exit', () => this.fail('Harness 进程已结束'))
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let m: Record<string, any>
      try {
        m = object(JSON.parse(line))
      } catch {
        return
      }
      if (m.jsonrpc !== '2.0') return
      if (this.closed) return
      if (typeof m.id === 'number' && m.method === undefined) {
        const p = this.pending.get(m.id)
        if (!p) return
        clearTimeout(p.timer)
        if (p.firstProgressTimer) clearTimeout(p.firstProgressTimer)
        this.pending.delete(m.id)
        this.stderrObservers.delete(m.id)
        if (m.error) {
          p.reject(
            new HarnessRequestError(
              `${harnessFailure(object(m.error).code, object(m.error).data)}（${requestStage(p.method)}）`,
              p.method,
              object(m.error).code,
              object(m.error).data,
            ),
          )
        } else p.resolve(m.result)
      } else if (m.method === 'session/update') {
        this.observePromptProgress(m.method, m.params)
        this.update(m.params)
      } else if (typeof m.id === 'string' || typeof m.id === 'number') {
        // 带 id 的是发往本方的请求，必须照常回应；扩展通知永远不会走到这里。
        if (m.method === 'session/request_permission') {
          const sessionId = object(m.params).sessionId
          for (const p of this.pending.values())
            if (p.method === 'session/prompt' && p.sessionId === sessionId)
              this.clearFirstProgressTimer(p)
          this.permission(m.id, m.params)
        } else if (this.clientRequests?.has(m.method)) {
          void this.handleClientRequest(m.id, this.clientRequests.get(m.method)!)
        } else
          this.send({
            id: m.id,
            error: { code: -32601, message: 'Unsupported ACP client request' },
          })
      } else if (this.notification !== undefined) this.notification(m.method, m.params)
    })
  }
  private clearFirstProgressTimer(p: {
    firstProgressTimer?: ReturnType<typeof setTimeout> | undefined
  }): void {
    if (!p.firstProgressTimer) return
    clearTimeout(p.firstProgressTimer)
    p.firstProgressTimer = undefined
  }
  private observePromptProgress(method: string, params: unknown): void {
    for (const p of this.pending.values()) {
      if (p.method !== 'session/prompt') continue
      let progress = false
      try {
        progress = p.isProgress?.(method, params) === true
      } catch {
        progress = false
      }
      if (progress) this.clearFirstProgressTimer(p)
    }
  }
  private fail(message: string) {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      this.clearFirstProgressTimer(p)
      p.reject(new HarnessTransportError(`${message}（${requestStage(p.method)}）`))
    }
    this.pending.clear()
    this.stderrObservers.clear()
    this.onExit()
  }
  private async handleClientRequest(id: string | number, handler: () => Promise<unknown>) {
    let response: object
    try {
      response = { id, result: (await handler()) ?? null }
    } catch {
      response = { id, error: { code: -32603, message: 'Bridge request failed' } }
    }
    if (!this.closed) this.send(response)
  }
  private send(value: object) {
    if (this.closed) throw new Error('Harness ACP 通道已关闭')
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
  }
  request(
    method: string,
    params: object,
    timeoutMs = 30000,
    options: AcpRequestOptions = {},
  ): Promise<unknown> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.stderrObservers.delete(id)
        // The request's overall deadline also owns the first-progress timer.
        // Clear it before disposing so a late callback cannot report a second failure.
        clearTimeout(pending.firstProgressTimer)
        reject(new HarnessTransportError(`Harness ACP 请求超时（${requestStage(method)}）`))
        void this.dispose().catch(() => {})
      }, timeoutMs)
      const pending: {
        resolve: (v: unknown) => void
        reject: (e: Error) => void
        timer: ReturnType<typeof setTimeout>
        firstProgressTimer?: ReturnType<typeof setTimeout> | undefined
        sessionId?: string
        method: string
        firstProgressTimeoutMessage?: string
        firstProgressTimeoutMs?: number
        isProgress?: (method: string, params: unknown) => boolean
      } = {
        resolve,
        reject,
        timer,
        method,
        ...(typeof object(params).sessionId === 'string'
          ? { sessionId: object(params).sessionId }
          : {}),
        ...(options.isProgress ? { isProgress: options.isProgress } : {}),
        ...(options.firstProgressTimeoutMessage
          ? { firstProgressTimeoutMessage: options.firstProgressTimeoutMessage }
          : {}),
        ...(options.firstProgressTimeoutMs && options.firstProgressTimeoutMs > 0
          ? { firstProgressTimeoutMs: options.firstProgressTimeoutMs }
          : {}),
      }
      if (options.firstProgressTimeoutMs && options.firstProgressTimeoutMs > 0) {
        pending.firstProgressTimer = setTimeout(() => {
          this.fail(options.firstProgressTimeoutMessage ?? 'Harness 未报告本轮进展')
          void this.dispose().catch(() => {})
        }, options.firstProgressTimeoutMs)
      }
      this.pending.set(id, pending)
      if (options.stderrFailure) this.stderrObservers.set(id, options.stderrFailure)
      try {
        this.send({ id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.clearFirstProgressTimer(pending)
        this.pending.delete(id)
        this.stderrObservers.delete(id)
        reject(e)
      }
    })
  }
  cancel(sessionId: string) {
    if (!this.closed) this.send({ method: 'session/cancel', params: { sessionId } })
  }
  /** Immediately rejects consumers, then finishes owned process cleanup. */
  async terminate(message: string): Promise<void> {
    this.fail(message)
    await this.dispose()
  }
  answer(id: string | number, optionId?: string) {
    if (!this.closed)
      this.send({
        id,
        result: {
          outcome:
            optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
        },
      })
  }
  dispose(): Promise<void> {
    return (this.disposing ??= this.stop())
  }
  private async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return
    const exit = new Promise<void>((resolve) => this.child.once('exit', () => resolve()))
    if (process.platform === 'win32') {
      // Kill descendants while the owned root still exists. Killing cmd.exe first
      // loses the ancestry needed to reach its CLI and MCP children.
      await new Promise<void>((resolve, reject) => {
        execFile(
          process.env.SystemRoot
            ? join(process.env.SystemRoot, 'System32', 'taskkill.exe')
            : 'taskkill.exe',
          ['/PID', String(this.child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 5000 },
          (error) => {
            if (error && this.child.exitCode === null && this.child.signalCode === null)
              reject(new Error('无法结束自有 Harness 进程树'))
            else resolve()
          },
        )
      })
      await exit
      return
    }
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500)
    await exit
    clearTimeout(timer)
  }
}
