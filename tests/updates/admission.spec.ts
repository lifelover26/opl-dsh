/** Admission races use explicit barriers and detached Sessions, without model calls or user state. */
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import {
  SessionController,
  type SessionPromptRequest,
} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testPeer } from '../test-peer.ts'
import {
  UpdateAdmission,
  assertSuiteAdmission,
  drainUpdateActivity,
  guardUpdateMethods,
  inspectUpdateActivity,
  installUpdateAdmission,
  type UpdateActivityCalls,
} from '../../src/updates/host/admission.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cleanups: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('Suite-wide update admission', () => {
  it('blocks other profiles once an update transaction owns the Suite lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-suite-admission-'))
    try {
      const gate = new UpdateAdmission(() => assertSuiteAdmission(root))
      const lock = join(root, 'enhancement-transaction.lock')
      await expect(gate.admit(() => 'ready')).resolves.toBe('ready')
      await writeFile(
        lock,
        JSON.stringify({ kind: 'update', id: 'update', nonce: 'nonce', pid: 1 }),
      )
      expect(() => gate.admitSync(() => 'must not start')).toThrow('正在准备或应用更新')
      await rm(lock)
      expect(gate.admitSync(() => 'ready')).toBe('ready')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for an unreadable update-lock record but allows a verified maintenance lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-suite-admission-'))
    try {
      await writeFile(join(root, 'enhancement-transaction.lock'), '{')
      expect(() => assertSuiteAdmission(root)).toThrow('更新锁无效')
      await writeFile(
        join(root, 'enhancement-transaction.lock'),
        JSON.stringify({ kind: 'maintenance', id: 'maintenance', nonce: 'nonce', pid: 1 }),
      )
      expect(() => assertSuiteAdmission(root)).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function deferred<T>() {
  return Promise.withResolvers<T>()
}

const message = () =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] })

/** A public Agent implementation with a real Session log and synchronous input methods. */
class TestAgent {
  readonly session: Session
  readonly id: SessionId
  readonly inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
  status: 'idle' | 'running' = 'idle'
  private maintenance: Promise<unknown> | undefined

  constructor(
    readonly ctx: Context,
    id = 'session-input',
  ) {
    this.id = SessionId(id)
    this.session = Session.create(this.id)
  }

  send(input: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void {
    const queue = target === 'next-turn' ? this.inbox.nextTurn : this.inbox.nextStep
    this.session.append('agent/inbox/spliced', { target, start: queue.length, inserted: [input] })
    queue.push(input)
    if (wakeup) this.status = 'running'
  }
  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }
  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }
  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.maintenance) throw Error('maintenance already active')
    const result = task(new AbortController().signal)
    this.maintenance = result
    return result.finally(() => {
      this.maintenance = undefined
    })
  }
  whenIdle(): Promise<void> {
    return (
      this.maintenance?.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve()
    )
  }
}

function nativeFixture(officialController = false, install = true, gate = new UpdateAdmission()) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const agent = new TestAgent(ctx)
  const live = [agent]
  const barrier = deferred<void>()
  const commands = {
    prompt: vi.fn(async () => {
      await barrier.promise
      agent.followup(message())
      return { accepted: true }
    }),
    create: vi.fn(async () => ({})),
    selectModel: vi.fn(async () => ({})),
    fork: vi.fn(async () => ({})),
    updateQueue: vi.fn(async () => ({})),
  }
  const spies = { ...commands }
  if (officialController) new SessionController(ctx, { nativeOpen: false })
  else ctx.provide('sessionController', commands as never)
  const registry = {
    list: () => [...live],
    get: (id: SessionId) => live.find((item) => item.id === id),
    create: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})),
  }
  ctx.provide('agents', registry as never)
  if (install) installUpdateAdmission(ctx, gate)
  return { ctx, gate, agent, live, commands, spies, registry, barrier }
}

describe('update admission exclusion', () => {
  it('reserves before the operation reaches its first await and drains through settlement', async () => {
    const gate = new UpdateAdmission()
    const barrier = deferred<number>()
    let entered = false
    const work = gate.admit(async () => {
      entered = true
      expect(gate.inspect().pending).toBe(1)
      return await barrier.promise
    })
    expect(entered).toBe(true)
    expect(() => gate.freeze()).toThrow('活动任务或启动请求')
    expect(gate.inspect()).toEqual({ pending: 1, frozen: false, closed: false })
    let drained = false
    const drain = gate.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    barrier.resolve(42)
    expect(await work).toBe(42)
    await drain
    expect(drained).toBe(true)
    gate.freeze().release()
  })

  it('freezes synchronously and prevents an old lease from releasing a newer freeze', async () => {
    const gate = new UpdateAdmission()
    const input = vi.fn(() => 1)
    const first = gate.freeze()
    expect(() => gate.admit(input)).toThrow('正在应用更新')
    expect(() => gate.admitSync(input)).toThrow('正在应用更新')
    expect(() => gate.freeze()).toThrow('正在应用更新')
    expect(input).not.toHaveBeenCalled()
    first.release()
    const second = gate.freeze()
    first.release()
    expect(() => gate.assertAvailable()).toThrow('正在应用更新')
    second.release()
    expect(await gate.admit(input)).toBe(1)
  })

  it('releases rejected, thrown and reentrant synchronous admissions', async () => {
    const gate = new UpdateAdmission()
    const failure = Error('admission failed')
    expect(() =>
      gate.admit(() => {
        throw failure
      }),
    ).toThrow(failure)
    await expect(gate.admit(() => Promise.reject(failure))).rejects.toBe(failure)
    expect(() =>
      gate.admitSync(() => {
        expect(() => gate.freeze()).toThrow('活动任务或启动请求')
        throw failure
      }),
    ).toThrow(failure)
    expect(gate.inspect().pending).toBe(0)
    gate.freeze().release()
  })

  it('closes before draining and never reopens when an existing update lease releases', async () => {
    const gate = new UpdateAdmission()
    const barrier = deferred<void>()
    const work = gate.admit(() => barrier.promise)
    let closed = false
    const closing = gate.close().then(() => {
      closed = true
    })
    expect(() => gate.admit(() => undefined)).toThrow('已关闭')
    await Promise.resolve()
    expect(closed).toBe(false)
    barrier.resolve()
    await Promise.all([work, closing])
    expect(gate.inspect()).toEqual({ pending: 0, frozen: false, closed: true })
    const frozen = new UpdateAdmission()
    const lease = frozen.freeze()
    await frozen.close()
    lease.release()
    expect(() => frozen.assertAvailable()).toThrow('已关闭')
  })
})

describe('public method compatibility guards', () => {
  it('guards real Typert Gateway calls through the dynamically resolved service method', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const entered = deferred<void>()
    const barrier = deferred<void>()
    class Calls extends TypertRemoteService {
      calls = 0
      constructor(scope: Context) {
        super(scope, 'updateTestCalls')
      }
      async change(): Promise<string | undefined> {
        this.calls++
        entered.resolve()
        await barrier.promise
        return this.ctx.invocation?.peer.id
      }
    }
    const service = new Calls(ctx)
    const descriptor: InvocationDescriptor = {
      id: 'update-test/change',
      service: 'updateTestCalls',
      namespace: 'updateTestCalls',
      method: 'change',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'src-json' },
    }
    ctx.provide('typert', { local: { get: () => descriptor } })
    const gateway = new TypertGatewayService(ctx, {})
    const gate = new UpdateAdmission()
    cleanups.push(guardUpdateMethods(service, ['change'], gate))
    const request = {
      namespace: 'updateTestCalls',
      method: 'change',
      args: {},
      peer: testPeer,
    }
    const work = gateway.invoke(request)
    await entered.promise
    expect(() => gate.freeze()).toThrow('活动任务或启动请求')
    barrier.resolve()
    expect(await work).toBe(testPeer.id)
    const lease = gate.freeze()
    await expect(gateway.invoke(request)).rejects.toThrow('正在应用更新')
    expect(service.calls).toBe(1)
    lease.release()
  })

  it('retains the Cordis caller context and guards a prototype method before its first await', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const gate = new UpdateAdmission()
    const barrier = deferred<void>()
    class Calls extends Service {
      entered = 0
      constructor(scope: Context) {
        super(scope, 'updateTestCalls')
      }
      async change(): Promise<unknown> {
        this.entered++
        const caller: unknown = Reflect.get(this.ctx, 'updateCaller')
        await barrier.promise
        return caller
      }
    }
    const service = new Calls(ctx)
    cleanups.push(guardUpdateMethods(ctx.get('updateTestCalls'), ['change'], gate))
    const caller = ctx.extend({ updateCaller: 'owner-client' }).get('updateTestCalls') as Calls
    const work = caller.change()
    expect(service.entered).toBe(1)
    expect(() => gate.freeze()).toThrow('活动任务或启动请求')
    barrier.resolve()
    expect(await work).toBe('owner-client')
    const lease = gate.freeze()
    await expect(caller.change()).rejects.toThrow('正在应用更新')
    expect(service.entered).toBe(1)
    lease.release()
  })

  it('rolls back a partial install when a required method cannot be extended', () => {
    const gate = new UpdateAdmission()
    const owner = { first: () => 1, second: () => 2 }
    Object.defineProperty(owner, 'second', { configurable: false, writable: false })
    const before = Object.getOwnPropertyDescriptors(owner)
    expect(() => guardUpdateMethods(owner, ['first', 'second'], gate)).toThrow()
    expect(Object.getOwnPropertyDescriptors(owner)).toEqual(before)
    expect(() => guardUpdateMethods(owner, ['first', 'missing'], gate)).toThrow('缺少公开方法')
    expect(Object.getOwnPropertyDescriptors(owner)).toEqual(before)
    gate.freeze().release()
  })

  it('refuses freeze after a guard is replaced and preserves the replacement during disposal', () => {
    const gate = new UpdateAdmission()
    const owner = { change: async () => 1 }
    const dispose = guardUpdateMethods(owner, ['change'], gate)
    const later = async () => 2
    owner.change = later
    expect(() => gate.freeze()).toThrow('准入保护已改变')
    expect(gate.inspect().frozen).toBe(false)
    dispose()
    dispose()
    expect(owner.change).toBe(later)
    gate.freeze().release()
  })
})

describe('native and scheduled input admission', () => {
  it('retains real official prompt admission while its attachment service is awaiting', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const agent = new TestAgent(ctx)
    const entered = deferred<void>()
    const content = deferred<ContentBlock[]>()
    const commit = vi.fn()
    ctx.provide('agents', {
      list: () => [agent],
      get: (id: SessionId) => (id === agent.id ? agent : undefined),
      create: async () => ({}),
      resume: async () => ({}),
    } as never)
    ctx.provide('sessions', { list: () => [agent.session], get: () => agent.session } as never)
    ctx.provide('attachments', {
      admitPromptContent: () => {
        entered.resolve()
        return content.promise
      },
    } as never)
    ctx.provide('fileUploads', {
      registerAgentResolver: () => () => {},
      bindPrompt: () => ({ commit, [Symbol.dispose]: () => {} }),
    } as never)
    ctx.provide('typert', {
      resources: { register: () => () => {} },
      lookups: { configure: () => {} },
      contexts: { configureHost: () => {} },
    })
    ctx.provide('sessionProjections', {
      onEventChanged: () => () => {},
      register: async () => ({ stateOf: () => ({ blank: true, lastPromptAt: null }) }),
    } as never)
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
    class ReadySessionController extends SessionController {
      initializeForTest(): Promise<void> {
        return this[Service.init]()
      }
    }
    const controller = new ReadySessionController(ctx, { nativeOpen: false })
    await controller.initializeForTest()
    const gate = new UpdateAdmission()
    installUpdateAdmission(ctx, gate)
    const request: SessionPromptRequest = {
      sessionId: agent.id,
      requestId: 'prompt-real' as SessionPromptRequest['requestId'],
      content: [{ type: 'text', text: 'continue' }],
      mode: 'queue',
    }
    const work = controller.prompt(request, new AbortController().signal)
    void work.catch(entered.reject)
    expect(gate.inspect().pending).toBe(1)
    await entered.promise
    expect(() => gate.freeze()).toThrow('活动任务或启动请求')
    expect(agent.session.snapshotEvents()).toEqual([])
    content.resolve([{ type: 'text', text: 'continue' }])
    expect(await work).toEqual({ accepted: true })
    expect(commit).toHaveBeenCalledOnce()
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(agent.session.snapshotEvents()).toHaveLength(1)
    expect(gate.inspect().pending).toBe(0)
  })

  it('guards an in-flight native submit before attachment or Agent resolution can await', async () => {
    const f = nativeFixture()
    const submit = f.commands.prompt()
    expect(f.spies.prompt).toHaveBeenCalledTimes(1)
    expect(f.agent.inbox.nextTurn).toEqual([])
    expect(() => f.gate.freeze()).toThrow('活动任务或启动请求')
    f.barrier.resolve()
    await submit
    expect(f.agent.inbox.nextTurn).toHaveLength(1)
    expect(f.agent.session.snapshotEvents()).toHaveLength(1)
  })

  it.each(['send', 'followup', 'steer', 'inject'] as const)(
    'refuses scheduled %s synchronously without changing inbox or Session history',
    (method) => {
      const f = nativeFixture()
      const scheduled = f.agent[method].bind(f.agent)
      const before = f.agent.session.snapshotEvents()
      const lease = f.gate.freeze()
      expect(() => scheduled(message(), 'next-turn', true)).toThrow('正在应用更新')
      expect(f.agent.inbox).toEqual({ nextTurn: [], nextStep: [] })
      expect(f.agent.status).toBe('idle')
      expect(f.agent.session.snapshotEvents()).toEqual(before)
      lease.release()
      scheduled(message(), 'next-turn', true)
      expect(f.agent.session.snapshotEvents()).toHaveLength(1)
    },
  )

  it('guards the official SessionController methods while frozen before their business code runs', async () => {
    const f = nativeFixture(true)
    const controller = f.ctx.get('sessionController')!
    const lease = f.gate.freeze()
    for (const method of ['prompt', 'create', 'selectModel', 'fork', 'updateQueue']) {
      const operation = Reflect.get(controller, method) as (...args: unknown[]) => Promise<unknown>
      await expect(operation.call(controller, {}, new AbortController().signal)).rejects.toThrow(
        '正在应用更新',
      )
    }
    lease.release()
    expect(f.agent.session.snapshotEvents()).toEqual([])
  })

  it('installs guards before later serial Agent creation listeners can drive input', async () => {
    const f = nativeFixture()
    const created = new TestAgent(f.ctx, 'session-created')
    const later = vi.fn(() => {
      created.followup(message())
      return undefined
    })
    f.ctx.on('agent/created', later, { global: true })
    f.live.push(created)
    await f.ctx.serial('agent/created', {
      agent: created as never,
      source: 'startup',
      signal: new AbortController().signal,
    })
    expect(later).toHaveBeenCalledOnce()
    expect(created.inbox.nextTurn).toHaveLength(1)
    const lease = f.gate.freeze()
    expect(() => created.followup(message())).toThrow('正在应用更新')
    const rejected = new TestAgent(f.ctx, 'session-rejected')
    await expect(
      f.ctx.serial('agent/created', {
        agent: rejected as never,
        source: 'startup',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('正在应用更新')
    expect(later).toHaveBeenCalledOnce()
    lease.release()
  })

  it('retains idle maintenance through completion and preserves synchronous busy errors', async () => {
    const f = nativeFixture()
    const barrier = deferred<void>()
    const work = f.agent.runMaintenance(() => barrier.promise)
    expect(f.agent.status).toBe('idle')
    expect(() => f.gate.freeze()).toThrow('活动任务或启动请求')
    expect(() => f.agent.runMaintenance(async () => {})).toThrow('maintenance already active')
    expect(f.gate.inspect().pending).toBe(1)
    barrier.resolve()
    await work
    f.gate.freeze().release()
  })

  it('holds Schedule idle retry behind a freeze without running or spinning maintenance', async () => {
    const f = nativeFixture()
    const lease = f.gate.freeze()
    let attempts = 0
    let callbackRuns = 0
    const retried = deferred<void>()
    const attempt = (): void => {
      attempts++
      try {
        void f.agent.runMaintenance(async () => {
          callbackRuns++
          retried.resolve()
          return true
        })
      } catch {
        void f.agent.whenIdle().then(attempt, () => {})
      }
    }
    attempt()
    await Promise.resolve()
    await Promise.resolve()
    expect(attempts).toBe(1)
    expect(callbackRuns).toBe(0)
    lease.release()
    await retried.promise
    expect(attempts).toBe(2)
    expect(callbackRuns).toBe(1)
  })

  it('turns a Suite lock maintenance denial into one synchronous failure without spinning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opl-suite-admission-'))
    try {
      const gate = new UpdateAdmission(() => assertSuiteAdmission(root))
      const f = nativeFixture(false, true, gate)
      await writeFile(
        join(root, 'enhancement-transaction.lock'),
        JSON.stringify({ kind: 'update', id: 'update', nonce: 'nonce', pid: 1 }),
      )
      let attempts = 0
      let callbackRuns = 0
      const failure = deferred<unknown>()
      const attempt = (): void => {
        attempts++
        try {
          void f.agent
            .runMaintenance(async () => {
              callbackRuns++
              return true
            })
            .catch(failure.resolve)
        } catch (error) {
          failure.resolve(error)
          void f.agent.whenIdle().then(attempt, () => {})
        }
      }
      attempt()
      await failure.promise
      await Promise.resolve()
      await Promise.resolve()
      expect(attempts).toBe(1)
      expect(callbackRuns).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a deferred Schedule idle retry during close without replaying its task', async () => {
    const f = nativeFixture()
    const lease = f.gate.freeze()
    let attempts = 0
    let callbackRuns = 0
    const stopped = deferred<void>()
    const attempt = (): void => {
      attempts++
      try {
        void f.agent.runMaintenance(async () => {
          callbackRuns++
          return true
        })
      } catch {
        void f.agent.whenIdle().then(attempt, () => stopped.resolve())
      }
    }
    attempt()
    await Promise.resolve()
    await f.gate.close()
    await stopped.promise
    lease.release()
    await Promise.resolve()
    expect(attempts).toBe(1)
    expect(callbackRuns).toBe(0)
  })

  it('drains a pre-existing maintenance task through the original whenIdle during freeze', async () => {
    const f = nativeFixture(false, false)
    f.ctx.provide('sessions', { list: () => [f.agent.session] } as never)
    f.ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const barrier = deferred<void>()
    const maintenance = f.agent.runMaintenance(() => barrier.promise)
    installUpdateAdmission(f.ctx, f.gate)
    const lease = f.gate.freeze()
    const drain = drainUpdateActivity(f.ctx, new AbortController().signal)
    await Promise.resolve()
    expect(f.gate.inspect().pending).toBe(0)
    barrier.resolve()
    await Promise.all([maintenance, drain])
    lease.release()
  })

  it('fails closed if a registry changes or a published Agent has no input guards', () => {
    const f = nativeFixture()
    const created = new TestAgent(f.ctx, 'session-unannounced')
    f.live.push(created)
    expect(() => f.gate.freeze()).toThrow('未受更新准入保护')
    f.live.pop()
    f.ctx.set('sessionController', { ...f.commands } as never)
    expect(() => f.gate.freeze()).toThrow('官方服务已改变')
  })

  it('restores native descriptors when the owning effect unloads', async () => {
    const f = nativeFixture()
    expect(Object.hasOwn(f.agent, 'followup')).toBe(true)
    await f.ctx.fiber.dispose()
    expect(Object.hasOwn(f.agent, 'followup')).toBe(false)
    expect(f.spies.prompt).toHaveBeenCalledTimes(0)
  })
})

function activityFixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const agent = new TestAgent(ctx)
  ctx.provide('agents', { list: () => [agent] } as never)
  ctx.provide('sessions', { list: () => [agent.session] } as never)
  const cold = SessionId('session-cold-project')
  ctx.provide('workspaceRegistry', {
    list: () => [{ sessionIds: [cold, agent.id] }],
  } as never)
  const calls: UpdateActivityCalls = {
    harness: vi.fn(async () => ({ busy: false })),
    feedbackTasks: vi.fn<UpdateActivityCalls['feedbackTasks']>(async () => [
      { state: 'completed' },
      { state: 'disconnected' },
    ]),
  }
  return { ctx, agent, cold, calls }
}

describe('update activity inspection', () => {
  it('drains idle maintenance that started before guards were installed', async () => {
    const f = activityFixture()
    const barrier = deferred<void>()
    const maintenance = f.agent.runMaintenance(() => barrier.promise)
    const gate = new UpdateAdmission()
    const lease = gate.freeze()
    let drained = false
    const drain = drainUpdateActivity(f.ctx, new AbortController().signal).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(f.agent.status).toBe('idle')
    barrier.resolve()
    await Promise.all([maintenance, drain])
    expect(drained).toBe(true)
    lease.release()
  })

  it('cancels an outstanding native drain and removes its abort listener', async () => {
    const f = activityFixture()
    const barrier = deferred<void>()
    const maintenance = f.agent.runMaintenance(() => barrier.promise)
    const abort = new AbortController()
    const off = vi.spyOn(abort.signal, 'removeEventListener')
    const drain = drainUpdateActivity(f.ctx, abort.signal)
    const failure = Error('drain deadline')
    abort.abort(failure)
    await expect(drain).rejects.toBe(failure)
    expect(off).toHaveBeenCalledWith('abort', expect.any(Function))
    barrier.resolve()
    await maintenance
    await expect(drainUpdateActivity(f.ctx, abort.signal)).rejects.toBe(failure)
  })

  it('asks real activity providers for every live and project-owned Session, without duplicate reads', async () => {
    const f = activityFixture()
    const seen: SessionId[] = []
    f.ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      seen.push(sessionId)
      const rest = await next()
      return sessionId === f.cold ? [{ kind: 'schedule' } as never, ...rest] : rest
    })
    expect(await inspectUpdateActivity(f.ctx, f.calls)).toEqual({
      idle: false,
      reasons: ['session'],
    })
    expect(seen).toEqual([f.agent.id, f.cold])
    expect(f.calls.harness).toHaveBeenCalledOnce()
    expect(f.calls.feedbackTasks).toHaveBeenCalledOnce()
  })

  it('allows completed feedback history and detects queued input, pending admission and active Harness work', async () => {
    const f = activityFixture()
    expect(await inspectUpdateActivity(f.ctx, f.calls)).toEqual({ idle: true, reasons: [] })
    f.agent.inject(message())
    vi.mocked(f.calls.harness).mockResolvedValue({ busy: true })
    vi.mocked(f.calls.feedbackTasks).mockResolvedValue([{ state: 'accepted' }])
    const gate = new UpdateAdmission()
    const barrier = deferred<void>()
    const pending = gate.admit(() => barrier.promise)
    expect(await inspectUpdateActivity(f.ctx, f.calls, gate)).toEqual({
      idle: false,
      reasons: ['queue', 'admission', 'harness', 'feedback'],
    })
    barrier.resolve()
    await pending
  })

  it('propagates activity read failures and resamples a native wake during an asynchronous owner read', async () => {
    const f = activityFixture()
    const barrier = deferred<{ busy: boolean }>()
    vi.mocked(f.calls.harness).mockReturnValue(barrier.promise)
    const entered = deferred<void>()
    vi.mocked(f.calls.harness).mockImplementation(() => {
      entered.resolve()
      return barrier.promise
    })
    const inspection = inspectUpdateActivity(f.ctx, f.calls)
    await entered.promise
    f.agent.followup(message())
    barrier.resolve({ busy: false })
    expect(await inspection).toEqual({ idle: false, reasons: ['agent', 'queue'] })
    const failure = Error('activity unavailable')
    vi.mocked(f.calls.harness).mockRejectedValue(failure)
    await expect(inspectUpdateActivity(f.ctx, f.calls)).rejects.toBe(failure)
  })
})
