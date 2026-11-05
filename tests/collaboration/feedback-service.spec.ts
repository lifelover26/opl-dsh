import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { type KvUnit, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskFeedbackService from '../../src/collaboration/host/feedback/index.ts'
import { feedbackSessionFacts } from '../../src/collaboration/host/feedback/session-facts.ts'
import { installSessionWaitProjection } from '../../src/execution/host/session-wait.ts'
import type { WakeDelivery } from '../../src/collaboration/host/feedback/types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

/** Only the opaque media seam is substituted: real DomainFacility validates
 * reloads and updates its memory after successful writes, under its own queue.
 * The file is reread on every mount; no service/domain state survives restart.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opl-feedback-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let failTable: string | undefined
  const file = join(root, 'domain.json')
  const backend: StorageBackend = {
    close: async () => {},
    kv: {
      async open(descriptor) {
        let data: Awaited<ReturnType<KvUnit['loadAll']>>
        try {
          data = JSON.parse(await readFile(file, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          data = {
            tables: Object.fromEntries(descriptor.tables.map((name) => [name, {}])),
            global: null,
          }
        }
        let closed = false
        async function persist(next: typeof data, table: string) {
          if (closed) throw new Error('closed')
          if (failTable === table) {
            failTable = undefined
            throw new Error(`injected ${table} write failure`)
          }
          await writeFile(file + '.tmp', JSON.stringify(next))
          await rename(file + '.tmp', file)
          data = next
        }
        return {
          loadAll: async () => structuredClone(data),
          putRecord: async (table, key, value) => {
            await persist(
              {
                ...data,
                tables: { ...data.tables, [table]: { ...data.tables[table], [key]: value } },
              },
              table,
            )
          },
          deleteRecord: async (table, key) => {
            const records = { ...data.tables[table] }
            delete records[key]
            await persist({ ...data, tables: { ...data.tables, [table]: records } }, table)
          },
          setGlobal: async (global) => {
            await persist({ ...data, global }, 'global')
          },
          close: async () => {
            closed = true
          },
        }
      },
    },
  }
  async function mount(
    autoDeliver = false,
    options: {
      seed?: readonly SessionEvent[]
      beforeMount?: (ctx: Context, session: Session) => Promise<void>
      whileStarting?: (ctx: Context, session: Session) => void
    } = {},
  ) {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(Storage)
    ctx.storage.backend.register('fixture', backend)
    ctx.provide('storageDomain')
    ctx.set('storageDomain', new DomainFacility(ctx, { backend: 'fixture' }))
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    const waitOwner = await ctx.plugin({
      inject: ['sessionProjections'],
      apply: installSessionWaitProjection,
    })
    const session = ctx.sessions.create(SessionId('source-session'), {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    })
    if (options.seed === undefined) {
      session.append(
        'system/message',
        { turn: 0, step: 0, message: createSystemMessage('fixture instructions') },
        { surfaceOp: 'append' },
      )
    }
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockImplementation(() => {
      throw Error('A domain reader must use its ready projection handle')
    })
    await options.beforeMount?.(ctx, session)
    const mounting = ctx.plugin(TaskFeedbackService, {
      autoDeliver,
      claimLeaseMs: 10_000,
      retryBaseMs: 1,
    })
    if (options.whileStarting !== undefined) {
      // Cordis begins activation on its next microtask; the registry's own handoff follows it.
      await Promise.resolve()
      options.whileStarting(ctx, session)
    }
    await mounting
    const service = ctx.taskFeedback
    async function complete(taskId = 'task') {
      await service.register({
        taskId,
        sessionId: session.id,
        turn: 1,
        target: { kind: 'codex-thread', threadId: 'target-thread' },
        acceptance: 'verified outcome',
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await service.settled()
      return service.deliveries()[0]!
    }
    async function emit(event: SessionEvent) {
      session.append(event.type, event.data)
      await service.settled()
    }
    async function start(taskId = 'task') {
      await service.register({
        taskId,
        sessionId: session.id,
        turn: 1,
        target: { kind: 'codex-thread', threadId: 'target-thread' },
        acceptance: 'verified outcome',
      })
      await emit({ type: 'turn/start', seq: 1, data: { turn: 1 } } as SessionEvent)
    }
    return { ctx, session, waitOwner, service, complete, emit, start }
  }
  return {
    mount,
    failNext: (table: string) => {
      failTable = table
    },
  }
}

const accepting = () => ({
  id: 'test-transport',
  probe: async () => ({ started: true, detail: 'test' }),
  send: vi.fn(async (_delivery: WakeDelivery) => ({ accepted: true })),
})

describe('feedback service durable lifecycle', () => {
  it('propagates a facts registration failure before opening its storage domain', async () => {
    const disk = await fixture()
    let opened: ReturnType<typeof vi.spyOn> | undefined
    await expect(
      disk.mount(false, {
        beforeMount: async (ctx) => {
          await ctx.sessionProjections.register({ ...feedbackSessionFacts, stateVersion: 4 })
          opened = vi.spyOn(ctx.storageDomain, 'open')
        },
      }),
    ).rejects.toThrow('already registered at stateVersion 4')
    expect(opened).not.toHaveBeenCalled()
  })

  it('recovers a terminal event and final assistant diagnostics committed during registration', async () => {
    const disk = await fixture()
    const first = await disk.mount()
    await first.service.register({
      taskId: 'task',
      sessionId: first.session.id,
      turn: 1,
      target: { kind: 'codex-thread', threadId: 'target-thread' },
      acceptance: 'verified outcome',
    })
    const seed = first.session.snapshotEvents()
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount(false, {
      seed,
      whileStarting: (ctx, session) => {
        expect(ctx.get('taskFeedback')).toBeUndefined()
        session.append('turn/start', { turn: 1 })
        session.append(
          'assistant/message',
          {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              source: { provider: 'fixture', model: 'fixture' },
              content: [{ type: 'text', text: '<invoke name="search" />' }],
            }),
            stream: [],
          },
          { surfaceOp: 'append' },
        )
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    })
    expect(restarted.service.task({ taskId: 'task' })).toMatchObject({
      state: 'completed',
      turn: 1,
      leakedToolSyntax: ['invoke-tag'],
    })
    expect(restarted.service.deliveries()).toMatchObject([{ deliveryId: 'task@completed' }])
  })

  it('recovers each pending startup approval once for matching turns and registration cursors', async () => {
    const disk = await fixture()
    const first = await disk.mount()
    for (const task of [
      { taskId: 'matching', turn: 1 },
      { taskId: 'unnamed' },
      { taskId: 'other-turn', turn: 2 },
      { taskId: 'future-cursor', turn: 1, fromSeq: 100 },
    ]) {
      await first.service.register({
        ...task,
        sessionId: first.session.id,
        target: { kind: 'codex-thread', threadId: 'target-thread' },
        acceptance: 'verified outcome',
      })
    }
    const seed = first.session.snapshotEvents()
    await first.ctx.fiber.dispose()
    const pending: { approvalId: string; toolName: string; seq: number }[] = []
    let registering: ReturnType<typeof vi.spyOn> | undefined
    const restarted = await disk.mount(false, {
      seed,
      beforeMount: async (ctx) => {
        registering = vi.spyOn(ctx.sessionProjections, 'register')
      },
      whileStarting: (ctx, session) => {
        expect(registering).toHaveBeenCalledWith(feedbackSessionFacts)
        expect(ctx.get('taskFeedback')).toBeUndefined()
        session.append('turn/start', { turn: 1 })
        session.append('approval/asked', { id: ApprovalRequestId('decided'), toolName: 'Write' })
        for (const ask of [
          { approvalId: 'pending-1', toolName: 'Bash' },
          { approvalId: 'pending-2', toolName: 'Read' },
        ]) {
          const event = session.append('approval/asked', {
            id: ApprovalRequestId(ask.approvalId),
            toolName: ask.toolName,
          })
          pending.push({ ...ask, seq: Number(event.seq) })
        }
        session.append('approval/decided', {
          id: ApprovalRequestId('decided'),
          outcome: 'allowed-once',
        })
      },
    })
    const expectedIds = ['matching', 'unnamed']
      .flatMap((taskId) => pending.map((ask) => `${taskId}@waiting_approval@${String(ask.seq)}`))
      .sort()
    for (const taskId of ['matching', 'unnamed']) {
      expect(restarted.service.task({ taskId })).toMatchObject({
        turn: 1,
        state: 'waiting_approval',
      })
    }
    for (const taskId of ['other-turn', 'future-cursor']) {
      expect(restarted.service.task({ taskId }).state).toBe('accepted')
    }
    const deliveries = restarted.service.deliveries()
    expect(deliveries.map((delivery) => delivery.deliveryId).sort()).toEqual(expectedIds)
    for (const delivery of deliveries) {
      const ask = pending.find((candidate) => candidate.seq === delivery.payload.needsInput?.seq)!
      expect(delivery.payload).toMatchObject({
        turn: 1,
        needsInput: {
          turn: 1,
          seq: ask.seq,
          pauseId: String(ask.seq),
          approval: { approvalId: ask.approvalId, toolName: ask.toolName },
        },
      })
    }
    const transport = accepting()
    restarted.service.setWakeAdapter(transport)
    await restarted.service.flush()
    expect(transport.send.mock.calls.map(([delivery]) => delivery.deliveryId).sort()).toEqual(
      expectedIds,
    )
    restarted.ctx.emit('session/created', restarted.session)
    await restarted.service.settled()
    expect(
      restarted.service
        .deliveries()
        .map((delivery) => delivery.deliveryId)
        .sort(),
    ).toEqual(expectedIds)
    const restoredSeed = restarted.session.snapshotEvents()
    await restarted.ctx.fiber.dispose()
    const restored = await disk.mount(false, { seed: restoredSeed })
    expect(
      restored.service
        .deliveries()
        .map((delivery) => delivery.deliveryId)
        .sort(),
    ).toEqual(expectedIds)
    restored.service.setWakeAdapter(transport)
    await expect(restored.service.flush()).resolves.toMatchObject({ attempted: 0 })
    expect(transport.send).toHaveBeenCalledTimes(expectedIds.length)
  })

  it.each(['decided', 'cancelled'] as const)(
    'does not restore an approval that was %s before the watcher became ready',
    async (resolution) => {
      const disk = await fixture()
      const first = await disk.mount()
      await first.service.register({
        taskId: 'task',
        sessionId: first.session.id,
        turn: 1,
        target: { kind: 'codex-thread', threadId: 'target-thread' },
        acceptance: 'verified outcome',
      })
      const seed = first.session.snapshotEvents()
      await first.ctx.fiber.dispose()
      const restarted = await disk.mount(false, {
        seed,
        whileStarting: (_ctx, session) => {
          session.append('turn/start', { turn: 1 })
          session.append('approval/asked', { id: ApprovalRequestId('ask'), toolName: 'Bash' })
          if (resolution === 'decided') {
            session.append('approval/decided', {
              id: ApprovalRequestId('ask'),
              outcome: 'allowed-once',
            })
          } else {
            session.append('turn/end', {
              turn: 1,
              reason: { kind: 'aborted', reason: { kind: 'user' } },
            })
          }
        },
      })
      expect(restarted.service.task({ taskId: 'task' }).state).toBe(
        resolution === 'cancelled' ? 'cancelled' : 'accepted',
      )
      expect(
        restarted.service
          .deliveries()
          .some((delivery) => delivery.payload.state === 'waiting_approval'),
      ).toBe(false)
    },
  )

  it('unloads the watcher before its required wait reader is released', async () => {
    const first = await (await fixture()).mount()
    await first.start()
    const before = first.ctx.events._hooks['session/event']!.length
    await first.waitOwner.dispose()
    expect(first.ctx.get('taskFeedback')).toBeUndefined()
    expect(first.ctx.events._hooks['session/event']!.length).toBe(before - 1)
    first.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => first.service.deliveries()).toThrow("domain 'task_feedback' is closed")
  })

  it.each(['completed', 'failed', 'waiting_approval'] as const)(
    'catches up a resumed turn that reaches %s before task registration and preserves it after restore',
    async (state) => {
      const disk = await fixture()
      const first = await disk.mount()
      await first.start()
      const failure = {
        kind: 'error' as const,
        error: {
          code: 'INVALID_REQUEST',
          status: 400,
          message: 'reasoning_text must be passed back',
        },
      }
      first.session.append('turn/end', { turn: 1, reason: failure })
      await first.service.settled()
      const prompt = vi.fn(async (request: { requestId: string }) => {
        first.session.append('turn/start', { turn: 2 })
        first.session.append(
          'user/message',
          createUserMessage({
            source: { kind: 'user', rpcId: request.requestId },
            content: [{ type: 'text', text: 'resume instruction' }],
          }),
          { surfaceOp: 'append' },
        )
        if (state === 'waiting_approval') {
          first.session.append('approval/asked', {
            id: ApprovalRequestId('resume-approval'),
            toolName: 'Bash',
          })
        } else {
          first.session.append('turn/end', {
            turn: 2,
            reason: state === 'failed' ? failure : { kind: 'completed' },
          })
          first.session.append('turn/start', { turn: 3 })
          first.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
        }
      })
      first.ctx.provide('sessionController', { prompt })
      const request = { taskId: 'task', deliveryId: 'task@failed', consumerId: 'reviewer' }
      const resumed = await first.service.resumeFailed(request)
      expect(resumed).toMatchObject({ decision: 'resumed', attempt: { taskId: 'task#r1' } })
      expect(first.service.task({ taskId: 'task#r1' })).toMatchObject({ turn: 2, state })
      expect(prompt).toHaveBeenCalledOnce()
      const seed = first.session.snapshotEvents()
      await first.ctx.fiber.dispose()
      const restarted = await disk.mount(false, { seed })
      expect(restarted.service.task({ taskId: 'task#r1' })).toMatchObject({ turn: 2, state })
      await expect(restarted.service.resumeFailed(request)).resolves.toMatchObject({
        decision: 'resumed',
        attempt: resumed.attempt,
      })
      expect(restarted.service.tasks()).toHaveLength(2)
      expect(prompt).toHaveBeenCalledOnce()
    },
  )

  it('queues only a short pointer and retrieves full native review details after restart', async () => {
    const disk = await fixture()
    const first = await disk.mount()
    const delivery = await first.complete()
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await first.service.flush()
    const message = transport.send.mock.calls[0]![0].message
    expect(message.split('\n')).toHaveLength(2)
    expect(message).toContain('receive --delivery task@completed --consumer <stable-id>')
    expect(message.match(/task/g)).toHaveLength(1)
    expect(message).not.toContain('verified outcome')
    expect(message).not.toContain('source-session')
    expect(message).not.toContain('taskFeedback.consume')
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    const received = await restarted.service.receive({
      taskId: delivery.taskId,
      deliveryId: delivery.deliveryId,
      consumerId: 'reviewer',
    })
    expect(received.action).toBe('review')
    expect(received.delivery.payload).toEqual(delivery.payload)
    expect(received.reviewInstructions).toContain('acceptance: verified outcome')
    expect(received.reviewInstructions).toContain('evidence: read session source-session')
    expect(received.reviewInstructions).toContain(
      'consume task task@completed --epoch <claimEpoch from receive>',
    )
  })

  it('withdraws an obsolete combination pause without dropping its completion', async () => {
    const first = await (await fixture()).mount()
    const { task } = await first.service.registerHarnessOperation({
      execution: {
        kind: 'harness-session',
        harnessSessionId: 'harness-test',
        harnessRef: 'minimax-code',
        combination: 'minimax-code/M3.1',
        taskId: 'external',
        operationId: 'initial',
      },
      target: { kind: 'codex-thread', threadId: 'target-thread' },
      acceptance: 'verified outcome',
    })
    await first.service.reportHarnessState({
      taskId: task.taskId,
      state: 'waiting_approval',
      summary: 'pending',
      pause: {
        kind: 'approval',
        pauseId: 'approval:a',
        approval: { approvalId: 'a', toolName: 'Bash' },
      },
    })
    await first.service.reportHarnessState({
      taskId: task.taskId,
      state: 'completed',
      summary: 'done',
    })
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await first.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
    expect(transport.send.mock.calls[0]?.[0].deliveryId).toBe(task.taskId + '@completed')
    expect(first.service.deliveries().find((x) => x.payload.needsInput !== null)?.retired).toBe(
      true,
    )
  })

  it('does not retire a transport-owned pause when another flush observes resolution', async () => {
    const first = await (await fixture()).mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    const entered = Promise.withResolvers<void>(),
      result = Promise.withResolvers<{ accepted: boolean }>()
    const transport = accepting()
    transport.send.mockImplementationOnce(async () => {
      entered.resolve()
      return result.promise
    })
    first.service.setWakeAdapter(transport)
    const flush = first.service.flush()
    await entered.promise
    await first.emit({
      type: 'approval/decided',
      seq: 3,
      data: { id: 'a', outcome: 'allowed-once' },
    } as SessionEvent)
    const again = first.service.flush()
    result.resolve({ accepted: true })
    await Promise.all([flush, again])
    expect(first.service.deliveries()[0]).toMatchObject({ retired: false, stage: 'delivered' })
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('skips an acknowledgment received while an earlier delivery is in flight', async () => {
    const first = await (await fixture()).mount()
    await first.complete('first')
    await first.complete('second')
    const entered = Promise.withResolvers<void>()
    const result = Promise.withResolvers<{ accepted: boolean }>()
    const transport = accepting()
    transport.send.mockImplementationOnce(async () => {
      entered.resolve()
      return result.promise
    })
    first.service.setWakeAdapter(transport)
    const flush = first.service.flush()
    await entered.promise
    const claim = await first.service.receive({
      taskId: 'second',
      deliveryId: 'second@completed',
      consumerId: 'reviewer',
    })
    await first.service.consume({
      taskId: 'second',
      deliveryId: 'second@completed',
      consumerId: 'reviewer',
      claimEpoch: claim.receipt.claimEpoch,
    })
    result.resolve({ accepted: true })
    await flush
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('retires only the decided approval and keeps other simultaneous approvals deliverable', async () => {
    const first = await (await fixture()).mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    await first.emit({
      type: 'approval/asked',
      seq: 3,
      data: { id: 'b', toolName: 'Read' },
    } as SessionEvent)
    await first.emit({
      type: 'approval/decided',
      seq: 4,
      data: { id: 'a', outcome: 'allowed-once' },
    } as SessionEvent)
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await first.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
    expect(transport.send.mock.calls[0]?.[0]).toMatchObject({
      deliveryId: 'task@waiting_approval@3',
    })
    expect(
      first.service.deliveries().find((x) => x.deliveryId === 'task@waiting_approval@2'),
    ).toMatchObject({ retired: true, attempts: 0 })
  })

  it('retires unsent pauses after completion and preserves retirement across restart', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    await first.emit({
      type: 'turn/end',
      seq: 3,
      data: { turn: 1, reason: { kind: 'completed' } },
    } as SessionEvent)
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await first.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
    expect(transport.send.mock.calls[0]?.[0]).toMatchObject({ deliveryId: 'task@completed' })
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    restarted.service.setWakeAdapter(transport)
    expect(await restarted.service.flush()).toMatchObject({ attempted: 0 })
    expect(
      restarted.service.deliveries().find((x) => x.payload.state === 'waiting_approval')?.retired,
    ).toBe(true)
  })

  it('keeps an accepted pause claimable after it resolves', async () => {
    const first = await (await fixture()).mount()
    await first.start()
    await first.emit({
      type: 'approval/asked',
      seq: 2,
      data: { id: 'a', toolName: 'Bash' },
    } as SessionEvent)
    first.service.setWakeAdapter(accepting())
    await first.service.flush()
    await first.emit({
      type: 'approval/decided',
      seq: 3,
      data: { id: 'a', outcome: 'allowed-once' },
    } as SessionEvent)
    await first.service.flush()
    expect(
      await first.service.receive({
        taskId: 'task',
        deliveryId: 'task@waiting_approval@2',
        consumerId: 'reviewer',
      }),
    ).toMatchObject({ action: 'review', delivery: { retired: false } })
  })

  it('repairs the task/outbox split write on restart without registering or executing work again', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    disk.failNext('outbox')
    await expect(first.complete()).rejects.toThrow('injected outbox')
    expect(first.service.deliveries()).toEqual([])
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    expect(restarted.service.tasks()).toMatchObject([{ taskId: 'task', state: 'completed' }])
    expect(restarted.service.deliveries()).toMatchObject([
      { deliveryId: 'task@completed', stage: 'enqueued' },
    ])
    const transport = accepting()
    restarted.service.setWakeAdapter(transport)
    await restarted.service.flush()
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('serializes concurrent flushes and never resends an accepted handoff after restart', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const transport = accepting()
    first.service.setWakeAdapter(transport)
    await Promise.all([first.service.flush(), first.service.flush()])
    expect(transport.send).toHaveBeenCalledOnce()
    expect(first.service.deliveries()[0]).toMatchObject({
      stage: 'delivered',
      attempts: 1,
      acknowledged: false,
    })
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    restarted.service.setWakeAdapter(transport)
    expect(await restarted.service.flush()).toMatchObject({ attempted: 0, pending: 1 })
    expect(transport.send).toHaveBeenCalledOnce()
  })

  it('does not acknowledge a failed receipt write, and recovers a claim whose acknowledgment failed', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    const delivery = await first.complete()
    const request = {
      taskId: delivery.taskId,
      deliveryId: delivery.deliveryId,
      consumerId: 'reviewer',
    }
    disk.failNext('receipts')
    await expect(first.service.receive(request)).rejects.toThrow('injected receipts')
    expect(first.service.receipts()).toEqual([])
    expect(first.service.deliveries()[0]?.acknowledged).toBe(false)
    disk.failNext('outbox')
    await expect(first.service.receive(request)).rejects.toThrow('injected outbox')
    expect(first.service.receipts()).toMatchObject([{ ownerId: 'reviewer', claimEpoch: 1 }])
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    expect(await restarted.service.receive(request)).toMatchObject({
      action: 'resume',
      receipt: { claimEpoch: 1 },
      delivery: { acknowledged: true },
      reviewInstructions: expect.stringContaining('consume task task@completed'),
    })
    expect(await restarted.service.receive({ ...request, consumerId: 'other' })).toMatchObject({
      action: 'busy',
      reviewInstructions: null,
    })
  })

  it('rejects a superseded consumer and persists consumption so duplicate notifications skip review', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const request = { taskId: 'task', deliveryId: 'task@completed' }
    const received = await first.service.receive({ ...request, consumerId: 'first' })
    expect(received.reviewInstructions).toContain('read session source-session')
    const future = Date.parse(received.receipt.leaseExpiresAt!) + 1
    vi.spyOn(Date, 'now').mockReturnValue(future)
    const reclaimed = await first.service.receive({ ...request, consumerId: 'second' })
    expect(reclaimed).toMatchObject({
      action: 'resume',
      receipt: { claimEpoch: 2, ownerId: 'second' },
      reviewInstructions: received.reviewInstructions,
    })
    await expect(
      first.service.consume({ ...request, consumerId: 'first', claimEpoch: 1 }),
    ).rejects.toMatchObject({ code: 'task-feedback/stale-claim' })
    disk.failNext('receipts')
    await expect(
      first.service.consume({ ...request, consumerId: 'second', claimEpoch: 2 }),
    ).rejects.toThrow('injected receipts')
    expect(first.service.receipts()[0]?.status).toBe('received')
    await first.service.consume({ ...request, consumerId: 'second', claimEpoch: 2 })
    await first.ctx.fiber.dispose()
    const restarted = await disk.mount()
    expect(await restarted.service.receive({ ...request, consumerId: 'third' })).toMatchObject({
      action: 'skip',
      receipt: { status: 'consumed', claimEpoch: 2 },
      reviewInstructions: null,
    })
  })

  it('keeps a receiver acknowledgment that lands while the transport is still returning', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const entered = Promise.withResolvers<void>()
    const result = Promise.withResolvers<{ accepted: boolean }>()
    const transport = accepting()
    transport.send.mockImplementationOnce(async () => {
      entered.resolve()
      return result.promise
    })
    first.service.setWakeAdapter(transport)
    const flush = first.service.flush()
    await entered.promise
    await first.service.receive({
      taskId: 'task',
      deliveryId: 'task@completed',
      consumerId: 'receiver',
    })
    result.resolve({ accepted: true })
    await flush
    expect(first.service.deliveries()[0]).toMatchObject({
      stage: 'received',
      acknowledged: true,
      attempts: 1,
      nextAttemptAt: null,
    })
  })

  it('starts the automatic pump and aborts a hanging send before closing the domain', async () => {
    const disk = await fixture(),
      first = await disk.mount(true)
    const entered = Promise.withResolvers<AbortSignal>()
    first.service.setWakeAdapter({
      ...accepting(),
      send: async (_delivery, signal) => {
        entered.resolve(signal)
        return new Promise(() => {})
      },
    })
    await first.complete()
    const signal = await entered.promise
    await first.ctx.fiber.dispose()
    expect(signal.aborted).toBe(true)
    const restarted = await disk.mount()
    expect(restarted.service.deliveries()[0]).toMatchObject({
      stage: 'enqueued',
      attempts: 0,
      acknowledged: false,
    })
  })

  it('retries refused transport without changing the completed task', async () => {
    const disk = await fixture(),
      first = await disk.mount()
    await first.complete()
    const transport = accepting()
    transport.send.mockResolvedValueOnce({ accepted: false })
    first.service.setWakeAdapter(transport)
    expect(await first.service.flush()).toMatchObject({ attempted: 1, delivered: 0, pending: 1 })
    expect(first.service.task({ taskId: 'task' }).state).toBe('completed')
    vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse(first.service.deliveries()[0]!.nextAttemptAt!) + 1,
    )
    expect(await first.service.flush()).toMatchObject({ attempted: 1, delivered: 1 })
    expect(transport.send).toHaveBeenCalledTimes(2)
  })
})
