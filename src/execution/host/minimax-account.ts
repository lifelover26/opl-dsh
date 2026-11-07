/**
 * Official MiniMax account seat.
 *
 * The official CLI owns the browser authorization, credential storage, refresh, and
 * sign-out. This service only starts the configured official command, waits for it, and
 * projects the CLI's own metadata into a bounded status. It never captures process output,
 * never reads `auth.json`, and never re-exposes the `authorization` block.
 */
import {
  execFile,
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { promisify } from 'node:util'
import { commandLaunch, type CommandLaunch } from './harness-registry.ts'
import { minimaxCodePath } from './adapters/minimax.ts'
import { systemEnvironment } from './adapters/environment.ts'
import { readMiniMaxAccountLoginState, type MiniMaxAccountRegion } from './minimax-account-state.ts'
import type { MiniMaxAccountStatus } from '../contracts/minimax-account.ts'

const executeFile = promisify(execFile)
/** The official device-authorization lease is ten minutes; the UI gets the same bound. */
const LOGIN_LEASE_MS = 600_000
/** Bounds the sign-out process and the metadata confirmation together. */
const LOGOUT_TIMEOUT_MS = 120_000
/** Metadata can settle after the configured command has exited. */
const LOGOUT_RECHECK_INTERVAL_MS = 250
/** Grace period between a graceful stop and a forced one. */
const STOP_GRACE_MS = 5_000

type Region = MiniMaxAccountRegion
type Command = { command?: string; prefix?: readonly string[] }
export type MiniMaxAccountSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess
export type MiniMaxAccountStop = (child: ChildProcess) => void | Promise<void>

export interface MiniMaxAccountOptions {
  /** Environment used both to locate metadata and to launch the official CLI. */
  environment?: () => NodeJS.ProcessEnv
  spawn?: MiniMaxAccountSpawn
  /** Test seam: replace the normal taskkill/SIGTERM step. */
  stop?: MiniMaxAccountStop
  /** Test seam: replace the normal forced-kill step. */
  forceStop?: MiniMaxAccountStop
  now?: () => number
  platform?: NodeJS.Platform
  loginLeaseMs?: number
  /** Shared budget for the child process and post-exit metadata confirmation. */
  logoutTimeoutMs?: number
  stopGraceMs?: number
}

interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: unknown
}

interface WatchedExit {
  exit: Promise<ExitResult>
}

interface Operation {
  region: Region
  child: ChildProcess | undefined
  watch: WatchedExit | undefined
  exited: boolean
  cancelled: boolean
  timedOut: boolean
  finished: boolean
  authControlReady?: boolean
  stopping: Promise<void> | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

interface LoginOperation extends Operation {
  deadline: number
  abort: Promise<never>
  rejectAbort: (error: unknown) => void
  /** Settles the RPC immediately when cancellation or a pre-spawn timeout wins. */
  early: Promise<MiniMaxAccountStatus>
  resolveEarly: (status: MiniMaxAccountStatus) => void
  rejectEarly: (error: unknown) => void
  earlySettled: boolean
  result: Promise<MiniMaxAccountStatus>
}

interface LogoutOperation extends Operation {
  recheck: AbortController
  result: Promise<MiniMaxAccountStatus>
}

interface TimedExit {
  timedOut: boolean
  result?: ExitResult
}

/** One explicit login attempt; ordinary status reads never start the CLI or a browser. */
export class MiniMaxAccount {
  private readonly environment: () => NodeJS.ProcessEnv
  private readonly spawnHook: MiniMaxAccountSpawn
  private readonly stopHook: MiniMaxAccountStop | undefined
  private readonly forceStopHook: MiniMaxAccountStop | undefined
  private readonly now: () => number
  private readonly platform: NodeJS.Platform
  private readonly loginLeaseMs: number
  private readonly logoutTimeoutMs: number
  private readonly stopGraceMs: number

  private pending: LoginOperation | undefined
  private logoutOperation: LogoutOperation | undefined
  private closed = false
  private disposePromise: Promise<void> | undefined
  /** Last resolved launch prefix, used by a cancellation that cannot await configuration. */
  private prefix: readonly string[] = []
  /** Last known installation fact; `undefined` until the first successful resolution. */
  private installedHint: boolean | undefined

  constructor(
    private readonly configuration: () => Promise<Command>,
    options: MiniMaxAccountOptions = {},
  ) {
    this.environment = options.environment ?? systemEnvironment
    this.spawnHook =
      options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
    this.stopHook = options.stop
    this.forceStopHook = options.forceStop
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    this.loginLeaseMs = options.loginLeaseMs ?? LOGIN_LEASE_MS
    this.logoutTimeoutMs = options.logoutTimeoutMs ?? LOGOUT_TIMEOUT_MS
    this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
  }

  /** Read one region's local account state without spawning the CLI or a browser. */
  /** Login and logout remain active until their owned CLI process has settled. */
  updateBusy(): boolean {
    return !!this.pending || !!this.logoutOperation
  }

  async status(region: Region): Promise<MiniMaxAccountStatus> {
    assertRegion(region)
    const config = await this.configuration()
    this.prefix = config.prefix ?? []
    const installed = !!(await minimaxCodePath(config))
    this.installedHint = installed
    return this.statusSnapshot(region, installed, this.prefix)
  }

  /**
   * Start the official browser sign-in and wait for it to finish.
   *
   * The operation is reserved before the first `await`, so a `cancel` arriving while the
   * configured command is still being resolved can mark this exact attempt. The returned
   * status is always re-read from the CLI's metadata: a late success is reported as
   * signed-in even when cancellation raced the credential commit.
   */
  async login(region: Region): Promise<MiniMaxAccountStatus> {
    assertRegion(region)
    if (this.closed) throw Error('账号服务已关闭')
    const existing = this.pending
    if (existing) {
      if (existing.region !== region) throw Error('另一个地区的官方登录尚未结束')
      if (existing.finished) throw Error('官方登录程序尚未结束，请刷新状态后重试')
      // The first attempt may settle through `early` (cancel/timeout before spawn) while
      // its `result` is still waiting for command resolution; join either settlement.
      return Promise.race([existing.result, existing.early])
    }
    if (this.logoutOperation) throw Error('官方退出尚未结束')
    const operation = this.reserveLogin(region)
    return Promise.race([operation.result, operation.early])
  }

  /**
   * Run the official sign-out command for the selected region.
   *
   * Sign-out is a real CLI operation with the same region flag as login. This method never
   * fabricates a signed-out state: process exit and metadata confirmation share one timeout,
   * and an unconfirmed result preserves the last observed pending, signed-in or unknown state.
   */
  async logout(region: Region): Promise<MiniMaxAccountStatus> {
    assertRegion(region)
    if (this.closed) throw Error('账号服务已关闭')
    if (this.pending) throw Error('官方登录尚未结束，请先取消登录')
    if (this.logoutOperation) throw Error('官方退出尚未结束')
    return this.reserveLogout(region).result
  }

  /**
   * Cancel this service's login for one region, without signing the account out.
   *
   * Cancellation never waits for configuration: it marks the reserved attempt immediately
   * and, when a child exists, stops only that child. A different region's attempt is never
   * touched. The returned status is read from the real metadata after the process is
   * drained, so a credential committed just before the stop is still reported as signed-in.
   */
  async cancel(region: Region): Promise<MiniMaxAccountStatus> {
    assertRegion(region)
    const operation = this.pending
    if (!operation || operation.region !== region)
      return this.statusSnapshot(region, this.installedHint ?? false, this.prefix)
    operation.cancelled = true
    if (!operation.child) {
      // The login loop checks this flag after every await and before spawning. Release the
      // reservation and settle the RPC now so a slow command resolution cannot keep the
      // maintenance gate open after the user cancelled.
      this.releaseOperation(operation)
      const status = await this.statusSnapshot(region, this.installedHint ?? false, this.prefix)
      operation.resolveEarly(status)
      return status
    }
    try {
      await this.stopOperation(operation)
    } catch (error) {
      operation.rejectAbort(error)
      throw error
    }
    await operation.result.catch(() => {})
    return this.statusSnapshot(region, this.installedHint ?? false, this.prefix)
  }

  /** Stop owned children and refuse new sign-in/out work. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.closed = true
    const disposing = (async () => {
      let failure: unknown
      let failed = false
      const login = this.pending
      if (login) {
        login.cancelled = true
        if (login.child) {
          try {
            await this.stopOperation(login)
          } catch (error) {
            failed = true
            failure = error
            login.rejectAbort(error)
          }
          await login.result.catch(() => {})
        } else {
          this.releaseOperation(login)
          const status = await this.statusSnapshot(
            login.region,
            this.installedHint ?? false,
            this.prefix,
          )
          login.resolveEarly(status)
        }
      }
      const logout = this.logoutOperation
      if (logout) {
        logout.cancelled = true
        logout.recheck.abort()
        let stopped = true
        if (logout.child) {
          try {
            await this.stopOperation(logout)
          } catch (error) {
            stopped = false
            if (!failed) failure = error
            failed = true
          }
        }
        if (stopped && logout.exited) await logout.result.catch(() => {})
      }
      if (failed) throw failure
    })()
    this.disposePromise = disposing.catch((error) => {
      // A failed disposal must not become a permanently cached "success" or a permanently
      // cached rejection: the caller can retry once the child has actually closed.
      this.disposePromise = undefined
      throw error
    })
    return this.disposePromise
  }

  private reserveLogin(region: Region): LoginOperation {
    const operation = this.createOperation(region) as LoginOperation
    operation.deadline = this.now() + this.loginLeaseMs
    operation.timer = undefined
    let rejectAbort!: (error: unknown) => void
    operation.abort = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    operation.rejectAbort = rejectAbort
    let resolveEarly!: (status: MiniMaxAccountStatus) => void
    let rejectEarly!: (error: unknown) => void
    operation.early = new Promise<MiniMaxAccountStatus>((resolve, reject) => {
      resolveEarly = resolve
      rejectEarly = reject
    })
    operation.resolveEarly = (status) => {
      if (operation.earlySettled) return
      operation.earlySettled = true
      resolveEarly(status)
    }
    operation.rejectEarly = (error) => {
      if (operation.earlySettled) return
      operation.earlySettled = true
      rejectEarly(error)
    }
    operation.earlySettled = false
    operation.result = undefined as unknown as Promise<MiniMaxAccountStatus>
    this.pending = operation
    operation.timer = setTimeout(() => {
      operation.timedOut = true
      void this.abortLogin(operation)
    }, this.loginLeaseMs)
    operation.timer.unref?.()
    void operation.abort.catch(() => {
      /* Consumed by the login race; the timer must not create an unhandled rejection. */
    })
    void operation.early.catch(() => {
      /* The login caller receives this rejection; the timer must not leak it. */
    })
    operation.result = this.runLogin(operation)
    void operation.result.catch(() => {
      /* The RPC caller receives this rejection; disposal/cancellation must not leak it. */
    })
    return operation
  }

  private reserveLogout(region: Region): LogoutOperation {
    const operation = this.createOperation(region) as LogoutOperation
    operation.recheck = new AbortController()
    operation.result = undefined as unknown as Promise<MiniMaxAccountStatus>
    this.logoutOperation = operation
    operation.result = this.runLogout(operation)
    void operation.result.catch(() => {})
    return operation
  }

  private createOperation(region: Region): Operation {
    return {
      region,
      child: undefined,
      watch: undefined,
      exited: false,
      cancelled: false,
      timedOut: false,
      finished: false,
      stopping: undefined,
      timer: undefined,
    }
  }

  private async runLogin(operation: LoginOperation): Promise<MiniMaxAccountStatus> {
    try {
      const early = await this.beforeSpawn(operation)
      if (early) return early
      let config: Command
      try {
        config = await this.configuration()
      } catch (error) {
        const settled = await this.beforeSpawn(operation)
        if (settled) return settled
        throw error
      }
      this.prefix = config.prefix ?? []
      const afterConfig = await this.beforeSpawn(operation)
      if (afterConfig) return afterConfig
      const path = await minimaxCodePath(config)
      const afterPath = await this.beforeSpawn(operation)
      if (afterPath) return afterPath
      if (!path) throw Error('请先在执行引擎中安装 MiniMax Code')
      this.installedHint = true
      const launch = commandLaunch(path, [
        ...(config.prefix ?? []),
        'login',
        '--region',
        operation.region,
      ])
      const child = this.spawnChild(launch, true)
      operation.child = child
      operation.watch = watchExit(child)
      this.observeAuthorization(operation, child)
      this.ownExit(operation)
      const outcome = await Promise.race([operation.watch.exit, operation.abort])
      const status = await this.statusSnapshot(operation.region, true, config.prefix ?? this.prefix)
      if (outcome.error) {
        if (status.loginState === 'signed-in') return status
        throw Error('无法启动官方 MiniMax 登录程序')
      }
      if (operation.cancelled) return status
      if (operation.timedOut) {
        if (status.loginState === 'signed-in') return status
        throw Error('官方登录等待超时，请刷新状态后重试')
      }
      if (outcome.code === 0) return status
      if (status.loginState === 'signed-in') return status
      throw Error('官方登录未完成，请刷新状态后重试')
    } finally {
      this.finishOperation(operation)
    }
  }

  private async runLogout(operation: LogoutOperation): Promise<MiniMaxAccountStatus> {
    try {
      const config = await this.configuration()
      this.prefix = config.prefix ?? []
      if (this.closed) throw Error('账号服务已关闭')
      const path = await minimaxCodePath(config)
      if (this.closed) throw Error('账号服务已关闭')
      if (!path) throw Error('请先在执行引擎中安装 MiniMax Code')
      this.installedHint = true
      const launch = commandLaunch(path, [
        ...(config.prefix ?? []),
        'logout',
        '--region',
        operation.region,
      ])
      const child = this.spawnChild(launch)
      operation.child = child
      operation.watch = watchExit(child)
      this.ownExit(operation)
      const outcome = await this.waitForTimedExit(operation, this.logoutTimeoutMs)
      if (outcome.timedOut) {
        await this.stopOperation(operation)
        const status = await this.statusSnapshot(
          operation.region,
          true,
          config.prefix ?? this.prefix,
        )
        if (status.loginState === 'signed-out') return status
        throw Error('官方退出等待超时，请刷新状态后重试')
      }
      const result = outcome.result
      const status = await this.statusSnapshot(operation.region, true, config.prefix ?? this.prefix)
      if (result?.error) {
        if (status.loginState === 'signed-out') return status
        throw Error('无法启动官方 MiniMax 退出程序')
      }
      if (result?.code === 0)
        return await this.confirmLogout(operation, config.prefix ?? this.prefix, status)
      if (status.loginState === 'signed-out') return status
      throw Error('官方退出未完成，请刷新状态后重试')
    } finally {
      this.finishOperation(operation)
    }
  }

  private async confirmLogout(
    operation: LogoutOperation,
    prefix: readonly string[],
    initial: MiniMaxAccountStatus,
  ): Promise<MiniMaxAccountStatus> {
    let status = initial
    while (
      status.loginState !== 'signed-out' &&
      !operation.timedOut &&
      !operation.cancelled &&
      !this.closed
    ) {
      await this.waitForLogoutRecheck(operation.recheck.signal)
      if (operation.cancelled || this.closed) break
      status = await this.statusSnapshot(operation.region, true, prefix)
    }
    return status
  }

  private waitForLogoutRecheck(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, LOGOUT_RECHECK_INTERVAL_MS)
      timer.unref?.()
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  /**
   * Check cancellation, closure, and the lease before the child exists. The timeout branch
   * still reads the real state first: if another process finished the login, report that
   * rather than pretending the account is signed out.
   */
  private async beforeSpawn(operation: LoginOperation): Promise<MiniMaxAccountStatus | undefined> {
    if (this.closed || operation.cancelled) {
      this.releaseOperation(operation)
      return this.statusSnapshot(operation.region, this.installedHint ?? false, this.prefix)
    }
    if (!operation.timedOut) return undefined
    this.releaseOperation(operation)
    const status = await this.statusSnapshot(
      operation.region,
      this.installedHint ?? false,
      this.prefix,
    )
    if (status.loginState === 'signed-in') return status
    throw Error('官方登录等待超时，请刷新状态后重试')
  }

  private async abortLogin(operation: LoginOperation): Promise<void> {
    if (!operation.child) {
      // The lease expired while command resolution or discovery was still pending. Settle
      // the RPC now; the login loop will observe `timedOut` and never spawn.
      this.releaseOperation(operation)
      const status = await this.statusSnapshot(
        operation.region,
        this.installedHint ?? false,
        this.prefix,
      )
      if (status.loginState === 'signed-in') operation.resolveEarly(status)
      else operation.rejectEarly(Error('官方登录等待超时，请刷新状态后重试'))
      return
    }
    try {
      await this.stopOperation(operation)
    } catch (error) {
      operation.rejectAbort(error)
    }
  }

  private async statusSnapshot(
    region: Region,
    installed: boolean,
    prefix: readonly string[] = this.prefix,
  ): Promise<MiniMaxAccountStatus> {
    const { loginState } = await readMiniMaxAccountLoginState(region, {
      env: this.environment(),
      prefix,
    })
    const pending = this.pending
    return {
      installed,
      region,
      loginState,
      loginPending: !!pending,
      ...(pending ? { pendingRegion: pending.region, loginDeadline: pending.deadline } : {}),
    }
  }

  /** Only fixed control records are consumed; URLs, codes and CLI messages are discarded. */
  private observeAuthorization(operation: LoginOperation, child: ChildProcess): void {
    let buffered = ''
    child.stdout?.on('data', (data: Buffer) => {
      buffered += data.toString('utf8')
      if (buffered.length > 8192) {
        buffered = ''
        return
      }
      let index: number
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index).trim()
        buffered = buffered.slice(index + 1)
        if (line === 'OPL_AUTH_READY_V1') operation.authControlReady = true
        const expiry = /^OPL_AUTH_EXPIRES_V1 ([0-9]+)$/.exec(line)
        if (
          !expiry ||
          !operation.authControlReady ||
          operation.finished ||
          this.pending !== operation
        )
          continue
        const seconds = Number(expiry[1])
        if (!Number.isSafeInteger(seconds) || seconds <= 0) continue
        operation.deadline = Math.min(operation.deadline, this.now() + seconds * 1000)
        clearTimeout(operation.timer)
        operation.timer = setTimeout(
          () => {
            operation.timedOut = true
            void this.abortLogin(operation)
          },
          Math.max(0, operation.deadline - this.now()),
        )
        operation.timer.unref?.()
      }
    })
    child.stdin?.on('error', () => {
      /* A closed pipe is handled by the bounded stop fallback. */
    })
  }

  private spawnChild(launch: CommandLaunch, login = false): ChildProcess {
    const options: SpawnOptions = {
      windowsHide: true,
      stdio: login ? ['pipe', 'pipe', 'ignore'] : 'ignore',
      env: { ...this.environment(), ...(login ? { OPL_MCODE_AUTH_CONTROL: '1' } : {}) },
      ...(launch.windowsVerbatimArguments
        ? { windowsVerbatimArguments: launch.windowsVerbatimArguments }
        : {}),
    }
    try {
      return this.spawnHook(launch.command, launch.args, options)
    } catch {
      throw Error('无法启动官方 MiniMax 程序')
    }
  }

  /**
   * Keep ownership until the child actually closes. A failed stop therefore leaves the
   * operation reserved, and `status` continues to report `loginPending` instead of
   * pretending the process is gone.
   */
  private ownExit(operation: Operation): void {
    const watch = operation.watch
    if (!watch) return
    void watch.exit.then(() => {
      operation.exited = true
      operation.child = undefined
      if (this.pending === operation) this.pending = undefined
      if (operation.finished) this.releaseOperation(operation)
    })
  }

  private finishOperation(operation: Operation): void {
    operation.finished = true
    if (operation.timer) clearTimeout(operation.timer)
    this.releaseOperation(operation)
  }

  /** Drop the reservation only when no live child is still owned by this operation. */
  private releaseOperation(operation: Operation): void {
    if (operation.child) return
    if (this.pending === operation) this.pending = undefined
    if (this.logoutOperation === operation) this.logoutOperation = undefined
  }

  private async stopOperation(operation: Operation): Promise<void> {
    if (operation.exited || !operation.child) return
    if (operation.stopping) return operation.stopping
    const child = operation.child
    const stop = (async () => {
      if (operation.authControlReady && child.stdin?.writable) {
        child.stdin.write('OPL_AUTH_CANCEL_V1\n')
        if (await this.waitForExit(operation, this.stopGraceMs)) return
      }
      try {
        await this.stopProcess(child)
      } catch {
        /* Fall through to the forced stop and the bounded close wait. */
      }
      if (await this.waitForExit(operation, this.stopGraceMs)) return
      try {
        await this.forceStopProcess(child)
      } catch {
        /* The close wait below decides whether ownership can be released. */
      }
      if (await this.waitForExit(operation, this.stopGraceMs)) return
      throw Error('无法停止官方 MiniMax 程序')
    })()
    operation.stopping = stop.finally(() => {
      operation.stopping = undefined
    })
    return operation.stopping
  }

  private async stopProcess(child: ChildProcess): Promise<void> {
    if (this.stopHook) {
      await this.stopHook(child)
      return
    }
    if (this.platform === 'win32' && child.pid) {
      await executeFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5_000,
      }).catch(() => {})
      return
    }
    child.kill('SIGTERM')
  }

  private async forceStopProcess(child: ChildProcess): Promise<void> {
    if (this.forceStopHook) {
      await this.forceStopHook(child)
      return
    }
    child.kill('SIGKILL')
  }

  private async waitForExit(operation: Operation, timeoutMs: number): Promise<boolean> {
    if (operation.exited) return true
    const watch = operation.watch
    if (!watch) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    })
    const exited = watch.exit.then(() => true)
    const result = await Promise.race([exited, timedOut])
    if (timer) clearTimeout(timer)
    return result
  }

  private async waitForTimedExit(
    operation: LogoutOperation,
    timeoutMs: number,
  ): Promise<TimedExit> {
    const watch = operation.watch
    if (!watch) return { timedOut: true }
    const timeout = new Promise<TimedExit>((resolve) => {
      operation.timer = setTimeout(() => {
        operation.timedOut = true
        operation.recheck.abort()
        resolve({ timedOut: true })
      }, timeoutMs)
      operation.timer.unref?.()
    })
    const exited = watch.exit.then((result) => ({ timedOut: false, result }))
    return Promise.race([exited, timeout])
  }
}

function watchExit(child: ChildProcess): WatchedExit {
  let done = false
  const exit = new Promise<ExitResult>((resolve) => {
    const finish = (result: ExitResult) => {
      if (done) return
      done = true
      resolve(result)
    }
    // `error` after a successful spawn is not a terminal event when the OS process is
    // still alive (for example a failed kill or a broken IPC channel). Keep ownership and
    // wait for `close`; only a spawn failure without a live PID is terminal.
    child.on('error', (error) => {
      if (done || hasLiveProcess(child)) return
      finish({ code: null, signal: null, error })
    })
    child.once('close', (code, signal) => finish({ code, signal }))
    if (typeof child.exitCode === 'number' || child.signalCode != null)
      finish({
        code: typeof child.exitCode === 'number' ? child.exitCode : null,
        signal: child.signalCode,
      })
  })
  return { exit }
}

function hasLiveProcess(child: ChildProcess): boolean {
  return (
    typeof child.pid === 'number' &&
    child.pid > 0 &&
    child.exitCode == null &&
    child.signalCode == null
  )
}

function assertRegion(region: unknown): asserts region is Region {
  if (region !== 'cn' && region !== 'global') throw Error('MiniMax 账号地区无效')
}
