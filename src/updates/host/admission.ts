/** Exclude update application from input admission and inspect the Host's live work. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type { TaskRecord } from '../../collaboration/host/feedback/types.ts'

/** The synchronous admission counts observed by an update attempt. */
export interface UpdateAdmissionState {
  readonly pending: number
  readonly frozen: boolean
  readonly closed: boolean
}

/** One update attempt's exclusion; releasing an old lease cannot release a newer one. */
export interface UpdateFreezeLease {
  /** Reopen admission after this attempt settles; repeated releases do nothing. */
  release(): void
}

/** Refuse public work while another profile owns a Suite update or launch reservation. */
export function assertSuiteAdmission(
  root: string | undefined,
  resumed?: { id: string; nonce: string; launcherPid: number },
  launcherPid?: number,
): void {
  if (root === undefined) return
  let source: string
  try {
    source = readFileSync(join(root, 'enhancement-transaction.lock'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw Error('无法核验 OPL DSH 更新锁')
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw Error('OPL DSH 更新锁无效，任务已拒绝')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !['launch', 'update', 'maintenance'].includes((value as { kind?: string }).kind ?? '')
  )
    throw Error('OPL DSH 更新锁无效，任务已拒绝')
  const row = value as { kind: string; id?: unknown; nonce?: unknown; pid?: unknown }
  if (row.kind === 'launch' && row.pid === launcherPid) return
  if (row.kind === 'maintenance') return
  if (row.kind === 'update' && resumed && row.id === resumed.id && row.nonce === resumed.nonce) {
    const state = JSON.parse(
      readFileSync(join(root, 'updates', resumed.id, 'state.json'), 'utf8'),
    ) as {
      stage?: unknown
      launchClaim?: { pid?: unknown }
    }
    if (
      ['starting', 'confirming'].includes(String(state.stage)) &&
      state.launchClaim?.pid === resumed.launcherPid
    )
      return
  }
  throw Error('OPL DSH 正在准备或应用更新，请稍后重试')
}

/** A Host-local barrier claimed before an admitted operation's first asynchronous step. */
export class UpdateAdmission {
  private pending = 0
  private frozen: object | undefined
  private closed = false
  private readonly waiters = new Set<() => void>()
  private readonly freezeChecks = new Set<() => void>()
  private readonly availabilityWaiters = new Set<{
    resolve: () => void
    reject: (reason: unknown) => void
  }>()

  constructor(private readonly assertSharedAvailable: () => void = () => {}) {}

  /** Reject new work while the update attempt owns exclusion or the Host is closing. */
  assertAvailable(): void {
    if (this.closed) throw Error('更新准入服务已关闭')
    if (this.frozen !== undefined) throw Error('正在应用更新，请稍后重试')
    this.assertSharedAvailable()
  }

  /**
   * Reserve admission and invoke the operation synchronously, then retain it through settlement.
   * @param operation - Complete admission or mutation, including its asynchronous validation.
   * @returns The operation's result after its reservation is released.
   * @throws Synchronously when admission is unavailable or the operation throws synchronously.
   */
  admit<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.assertAvailable()
    this.pending++
    try {
      return Promise.resolve(operation()).finally(() => this.finish())
    } catch (error) {
      this.finish()
      throw error
    }
  }

  /**
   * Reserve one synchronous mutation, preserving its return value and thrown error.
   * @param operation - Synchronous input delivery or mutation.
   * @returns The value returned by the operation; a returned Promise is not retained.
   */
  admitSync<T>(operation: () => T): T {
    this.assertAvailable()
    this.pending++
    try {
      return operation()
    } finally {
      this.finish()
    }
  }

  /**
   * Reserve one Agent maintenance task while retaining Agent's synchronous admission errors.
   * @param operation - Maintenance callback, invoked only while this gate is available.
   * @returns The operation's result after its reservation is released.
   * @throws Synchronously when this gate is unavailable or the operation throws synchronously.
   */
  admitMaintenance<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.assertAvailable()
    this.pending++
    try {
      return Promise.resolve(operation()).finally(() => this.finish())
    } catch (error) {
      this.finish()
      throw error
    }
  }

  private finish(): void {
    this.pending--
    if (this.pending !== 0) return
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resolve of waiters) resolve()
  }

  /**
   * Require installed public-method guards to retain ownership when an update freezes input.
   * @param check - Synchronous check that throws if a required guard was removed or replaced.
   * @returns Disposer removing only this check.
   */
  verifyOnFreeze(check: () => void): () => void {
    this.assertAvailable()
    this.freezeChecks.add(check)
    return () => {
      this.freezeChecks.delete(check)
    }
  }

  /**
   * Close admission before the update attempt performs any asynchronous activity inspection.
   * @returns An idempotent lease reopening only this freeze.
   * @throws Synchronously when another attempt, pending admission, or missing guard prevents exclusion.
   */
  freeze(): UpdateFreezeLease {
    this.assertAvailable()
    if (this.pending !== 0) throw Error('仍有活动任务或启动请求，暂不能应用更新')
    const lease = {}
    this.frozen = lease
    try {
      for (const check of this.freezeChecks) check()
    } catch (error) {
      if (this.frozen === lease) this.frozen = undefined
      throw error
    }
    return {
      release: () => {
        if (this.frozen !== lease) return
        this.frozen = undefined
        this.resolveAvailabilityWaiters()
      },
    }
  }

  /**
   * Wait until a local freeze releases; this does not wait for admitted work.
   * @returns A promise resolved by a lease release or rejected when the owner tears down.
   */
  waitForAvailability(): Promise<void> {
    if (this.closed || this.frozen === undefined) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.availabilityWaiters.add({ resolve, reject })
    })
  }

  /** Reject deferred idle waits when the owning effect is being removed. */
  cancelAvailabilityWaiters(reason = Error('更新准入服务已卸载')): void {
    const waiters = [...this.availabilityWaiters]
    this.availabilityWaiters.clear()
    for (const waiter of waiters) waiter.reject(reason)
  }

  /** Check the cross-profile admission source without changing local freeze state. */
  checkSharedAvailable(): void {
    this.assertSharedAvailable()
  }

  /**
   * Wait for already admitted operations; this does not close admission or identify a turn result.
   * @returns Resolution after the current admission count reaches zero.
   */
  drain(): Promise<void> {
    if (this.pending === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.waiters.add(resolve))
  }

  /**
   * Permanently refuse new work before waiting for admitted operations to settle.
   * @returns Resolution after every admitted operation has released its reservation.
   */
  close(): Promise<void> {
    this.closed = true
    this.cancelAvailabilityWaiters(Error('更新准入服务已关闭'))
    return this.drain()
  }

  private resolveAvailabilityWaiters(): void {
    const waiters = [...this.availabilityWaiters]
    this.availabilityWaiters.clear()
    for (const waiter of waiters) waiter.resolve()
  }

  /** @returns A detached synchronous view of the admission barrier. */
  inspect(): UpdateAdmissionState {
    return { pending: this.pending, frozen: this.frozen !== undefined, closed: this.closed }
  }
}

type GuardMode = 'promise' | 'sync' | 'maintenance' | 'idle'
type PublicMethod = (this: object, ...args: unknown[]) => unknown
const wrappedOriginal = Symbol('updateAdmissionOriginal')

type WrappedMethod = PublicMethod & { [wrappedOriginal]?: PublicMethod }

function concrete(owner: object): object {
  return (Reflect.get(owner, symbols.original) as object | undefined) ?? owner
}

function unwrap(method: PublicMethod): PublicMethod {
  let current = method as WrappedMethod
  while (current[wrappedOriginal] !== undefined) current = current[wrappedOriginal] as WrappedMethod
  return current
}

function originalMethod(owner: object, name: string): PublicMethod {
  const method = Reflect.get(concrete(owner), name)
  if (typeof method !== 'function') throw Error(`更新准入缺少公开方法：${name}`)
  return unwrap(method as PublicMethod)
}

function guardMethods(
  owner: object,
  methods: readonly string[],
  gate: UpdateAdmission,
  mode: GuardMode,
): () => void {
  gate.assertAvailable()
  const target = concrete(owner)
  const installed: {
    name: string
    previous: PropertyDescriptor | undefined
    wrapped: PublicMethod
  }[] = []
  let offCheck: (() => void) | undefined
  const restore = () => {
    offCheck?.()
    for (const { name, previous, wrapped } of [...installed].reverse()) {
      if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapped) continue
      if (previous) Object.defineProperty(target, name, previous)
      else Reflect.deleteProperty(target, name)
    }
  }
  try {
    for (const name of new Set(methods)) {
      const method: unknown = Reflect.get(target, name)
      if (typeof method !== 'function') throw Error(`更新准入缺少公开方法：${name}`)
      const original = unwrap(method as PublicMethod)
      const previous = Object.getOwnPropertyDescriptor(target, name)
      const wrapped: WrappedMethod =
        mode === 'sync'
          ? function (this: object, ...args) {
              return gate.admitSync(() => Reflect.apply(original, this, args) as unknown)
            }
          : mode === 'maintenance'
            ? function (this: object, ...args) {
                return gate.admitMaintenance(() => Reflect.apply(original, this, args) as unknown)
              }
            : mode === 'idle'
              ? function (this: object, ...args) {
                  const state = gate.inspect()
                  if (state.closed) return Reflect.apply(original, this, args) as unknown
                  if (state.frozen) {
                    return gate
                      .waitForAvailability()
                      .then(() => Reflect.apply(original, this, args) as unknown)
                  }
                  try {
                    gate.checkSharedAvailable()
                  } catch (error) {
                    return Promise.reject(error)
                  }
                  return Reflect.apply(original, this, args) as unknown
                }
              : async function (this: object, ...args) {
                  return gate.admit(() => Reflect.apply(original, this, args) as unknown)
                }
      Object.defineProperty(wrapped, wrappedOriginal, { value: original })
      Object.defineProperty(target, name, {
        configurable: previous?.configurable ?? true,
        enumerable: previous?.enumerable ?? false,
        writable: previous && 'writable' in previous ? previous.writable : true,
        value: wrapped,
      })
      installed.push({ name, previous, wrapped })
    }
    offCheck = gate.verifyOnFreeze(() => {
      for (const { name, wrapped } of installed)
        if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapped)
          throw Error(`更新准入保护已改变：${name}`)
    })
  } catch (error) {
    restore()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    restore()
  }
}

/**
 * Extend public instance methods while preserving each invocation's Cordis caller context.
 * @param owner - Public service or Agent instance; only its own method descriptors are extended.
 * @param methods - Required methods; missing or immutable methods reject installation.
 * @param gate - Shared Host update exclusion.
 * @param synchronous - Whether the methods complete synchronously and preserve their exact result.
 * @returns Disposer restoring descriptors only while these wrappers still own them.
 */
export function guardUpdateMethods(
  owner: object,
  methods: readonly string[],
  gate: UpdateAdmission,
  synchronous = false,
): () => void {
  return guardMethods(owner, methods, gate, synchronous ? 'sync' : 'promise')
}

/**
 * Guard native Session commands, Agent construction and public Agent input delivery.
 * Existing controller methods are wrapped before returning; serial Agent creation installs
 * input guards before later listeners or queued work can drive the new Agent. Scheduled
 * deliveries using public send/followup/steer/inject therefore share the same barrier.
 * @param ctx - Host scope with the official Session Controller and Agent registry.
 * @param gate - Barrier also used by OPL execution and feedback owners.
 * @returns Effect-owned disposer restoring only this installation's wrappers and listeners.
 */
export function installUpdateAdmission(ctx: Context, gate: UpdateAdmission): () => void {
  return ctx.effect(() => {
    const controller = ctx.get('sessionController')
    const registry = ctx.get('agents')
    if (controller === undefined || registry === undefined)
      throw Error('更新准入需要官方会话控制器和 Agent 注册表')
    const controllerOwner = concrete(controller)
    const registryOwner = concrete(registry)
    const cleanups: (() => void)[] = []
    const agents = new Map<object, () => void>()
    const installAgent = (agent: Agent) => {
      const owner = concrete(agent)
      if (agents.has(owner)) return
      const guards: (() => void)[] = []
      try {
        guards.push(guardUpdateMethods(owner, ['send', 'followup', 'steer', 'inject'], gate, true))
        guards.push(guardMethods(owner, ['runMaintenance'], gate, 'maintenance'))
        guards.push(guardMethods(owner, ['whenIdle'], gate, 'idle'))
      } catch (error) {
        for (const dispose of guards.reverse()) dispose()
        throw error
      }
      agents.set(owner, () => {
        for (const dispose of guards.reverse()) dispose()
      })
    }
    const cleanup = () => {
      gate.cancelAvailabilityWaiters()
      for (const dispose of cleanups.reverse()) dispose()
      for (const dispose of agents.values()) dispose()
      agents.clear()
    }
    try {
      cleanups.push(
        guardUpdateMethods(
          controller,
          ['prompt', 'create', 'selectModel', 'fork', 'updateQueue'],
          gate,
        ),
      )
      cleanups.push(guardUpdateMethods(registry, ['create', 'resume'], gate))
      cleanups.push(
        ctx.on(
          'agent/created',
          ({ agent }) => {
            gate.assertAvailable()
            installAgent(agent)
          },
          { global: true, prepend: true },
        ),
      )
      cleanups.push(
        ctx.on(
          'agent/disposed',
          ({ agent }) => {
            const owner = concrete(agent)
            agents.get(owner)?.()
            agents.delete(owner)
          },
          { global: true },
        ),
      )
      for (const agent of registry.list()) installAgent(agent)
      cleanups.push(
        gate.verifyOnFreeze(() => {
          if (
            concrete(ctx.get('sessionController') ?? {}) !== controllerOwner ||
            concrete(ctx.get('agents') ?? {}) !== registryOwner
          )
            throw Error('更新准入的官方服务已改变')
          for (const agent of registry.list())
            if (!agents.has(concrete(agent))) throw Error('仍有未受更新准入保护的 Agent')
        }),
      )
    } catch (error) {
      cleanup()
      throw error
    }
    return cleanup
  })
}

/** Only live work prevents applying an update; completed feedback history remains readable. */
export type UpdateActivityReason =
  | 'admission'
  | 'agent'
  | 'queue'
  | 'session'
  | 'harness'
  | 'feedback'

/** Activity observations collected from the owners of native and external execution. */
export interface UpdateActivityInspection {
  readonly idle: boolean
  readonly reasons: readonly UpdateActivityReason[]
}

/** Public owner calls supplied by the Host assembly; failures propagate to refuse update application. */
export interface UpdateActivityCalls {
  /** Read HarnessService.inspectForUpdate(), including active connections and final persistence. */
  harness(): PromiseLike<{ readonly busy: boolean }> | { readonly busy: boolean }
  /** Read taskFeedback.tasks(); completed tasks and historical notification receipts do not block. */
  feedbackTasks():
    | PromiseLike<readonly Pick<TaskRecord, 'state'>[]>
    | readonly Pick<TaskRecord, 'state'>[]
}

/**
 * Read all live Agents and every attached or project-owned Session's activity providers.
 * @param ctx - Official Agent, Session and Workspace registry services.
 * @param calls - Public Harness and feedback reads under the caller's Host identity.
 * @param gate - Optional admission counts included with the activity observation.
 * @returns An observation; callers freeze input and repeat it before applying an update.
 */
export async function inspectUpdateActivity(
  ctx: Context,
  calls: UpdateActivityCalls,
  gate?: UpdateAdmission,
): Promise<UpdateActivityInspection> {
  const registry = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const workspaces = ctx.get('workspaceRegistry')
  if (registry === undefined || sessions === undefined || workspaces === undefined)
    throw Error('更新活动检查需要官方 Agent、会话和项目注册表')
  const reasons = new Set<UpdateActivityReason>()
  const native = () => {
    const agents = registry.list()
    if (agents.some((agent) => agent.status === 'running')) reasons.add('agent')
    if (agents.some((agent) => agent.inbox.nextTurn.length || agent.inbox.nextStep.length))
      reasons.add('queue')
    if (gate && gate.inspect().pending > 0) reasons.add('admission')
    return agents
  }
  const ids = new Set<SessionId>([
    ...native().map((agent) => agent.id),
    ...sessions.list().map((session) => session.id),
    ...workspaces.list().flatMap((workspace) => [...workspace.sessionIds]),
  ])
  for (const sessionId of ids) {
    const activity = await ctx.waterfall(
      'workspace/session-activity',
      { sessionId },
      async () => [],
    )
    if (activity.length) reasons.add('session')
  }
  if ((await calls.harness()).busy) reasons.add('harness')
  const tasks = await calls.feedbackTasks()
  if (
    tasks.some((task) =>
      ['queued', 'accepted', 'running', 'waiting_approval', 'waiting_input'].includes(task.state),
    )
  )
    reasons.add('feedback')
  native()
  return { idle: reasons.size === 0, reasons: [...reasons] }
}

/**
 * Drain native maintenance that may have started before public input guards were installed.
 * @param ctx - Host scope carrying the official Agent registry; callers hold update exclusion.
 * @param signal - Caller-owned cancellation and deadline for waiting on public whenIdle() promises.
 * @returns Resolution after the observed Agents reach quiescence, or rejection on cancellation.
 */
export async function drainUpdateActivity(ctx: Context, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const registry = ctx.get('agents')
  if (registry === undefined) throw Error('更新排空需要官方 Agent 注册表')
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([
      aborted,
      Promise.all(
        registry
          .list()
          .map(
            (agent) =>
              Reflect.apply(originalMethod(agent, 'whenIdle'), agent, []) as PromiseLike<void>,
          ),
      ),
    ])
    signal.throwIfAborted()
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
