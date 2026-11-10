/**
 * The combination (external Harness) notification path.
 *
 * Every case runs the real execution service and the real durable notification
 * outbox together. The child is the ACP fixture process, the outbox is the real
 * taskFeedback service on a real storage domain, and the wake transport is a
 * capture adapter that records exactly what a configured `codex-queue` would
 * have been handed. No Codex binary, no network, no model call: the assertions
 * are about which records were made durable and what was handed to the
 * transport, never about a simulated internal step.
 *
 * The path under test is shared by every external Harness: the delivery is
 * selected by the dispatching origin, not by the Harness that runs the child,
 * which is why one deployment exercises all of them.
 */

import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { type KvUnit, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TaskFeedbackService from '../../src/collaboration/host/feedback/index.ts'
import { harnessTaskIdOf } from '../../src/collaboration/host/feedback/state.ts'
import type { WakeDelivery } from '../../src/collaboration/host/feedback/types.ts'
import { sessionHistoryFixture } from '../fixtures/session-controller.ts'
import {
  GROK_COMBINATION,
  HarnessService,
  grokConfiguration,
} from '../../src/execution/host/harness.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { commandLaunch } from '../../src/execution/host/harness-registry.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import { testPeerConnection } from '../test-peer.ts'
import { resolveGatewayExecution } from '../../src/gateway/host/execution-access.ts'
import { GROK_API_KEY_REF } from '../../src/gateway/host/config.ts'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

/**
 * Run the durable notification cases against the Node ACP fixture agent.
 *
 * This file asserts which delivery records became durable and what the wake transport was
 * handed. The child is `tests/fixtures/acp-agent.mjs`, a plain Node process, so nothing here
 * is a statement about an official CLI's OS sandbox.
 *
 * Production Grok refuses restricted tiers on Windows because its official sandbox has no
 * backend on this platform. That refusal is correct and is verified separately against the
 * real adapter in the Grok suite. To keep this file about notification durability, the
 * adapter's `prepare` step is replaced for exactly this Node fixture: the `HarnessService`
 * under test stays real, the configuration and gateway-key handling stay real through the
 * production helpers, no production module gains a test hook, no platform is faked, and no
 * delivery, retry, ordering or deduplication assertion is removed.
 * @returns nothing; installs the fixture-only adapter preparation.
 */
function useNodeAcpFixtureAgent() {
  const adapter = adapterFor('grok-build', {
    provider: 'opl-gateway',
    model: 'grok::grok-4.7',
  })
  if (!adapter) throw Error('fixture seam requires the Grok adapter entry')
  vi.spyOn(adapter, 'prepare').mockImplementation(async (ctx, record, options) => {
    if (
      options.prefix?.length !== 1 ||
      options.prefix[0] !== resolve('tests/fixtures/acp-agent.mjs')
    )
      throw Error('The fixture adapter only launches the Node ACP fixture')
    const route = await resolveGatewayExecution(ctx, record.modelRef, options.resolveKey)
    const home = join(options.home, 'harnesses', 'grok-build')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const config = join(home, 'config.toml'),
      bytes = grokConfiguration(route.baseURL)
    const current = await readFile(config, 'utf8').catch(() => undefined)
    if (current === undefined) await writeFile(config, bytes, { mode: 0o600, flag: 'wx' })
    else if (current !== bytes) await writeFile(config, bytes, { mode: 0o600 })
    // A Node fixture agent has no OS sandbox, so it takes neutral fixture flags that say
    // nothing about the official Grok tiers.
    const launch = commandLaunch(process.execPath, [
      ...(options.prefix ?? []),
      '--cwd',
      record.cwd,
      '--model',
      'grok-4.7',
      '--sandbox',
      record.sandbox === 'read-only' ? 'read-only' : 'workspace-write',
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ])
    return {
      home,
      ...launch,
      env: {
        ...systemEnvironment(),
        GROK_HOME: home,
        [GROK_API_KEY_REF]: route.apiKey,
        GROK_DEFAULT_SELECTED_PERMISSION: 'allow_once',
      },
    }
  })
}

/** Capture transport: the shape a configured wake adapter must have, recording what it got. */
function captureTransport() {
  return {
    id: 'capture',
    probe: async () => ({ started: true, detail: 'capture' }),
    send: vi.fn(async (_delivery: WakeDelivery) => ({
      accepted: true,
      detail: 'captured',
    })),
  }
}

interface DeploymentOptions {
  readonly autoDeliver?: boolean
  readonly maxDeliveryAttempts?: number
  readonly retryBaseMs?: number
  readonly retryMaxMs?: number
}

/** Both real services on one durable state directory, restartable in place. */
function deployment(root: string, initial: DeploymentOptions = {}) {
  const state = { taskFeedback: undefined as TaskFeedbackService | undefined }
  const transport = captureTransport()
  let options = initial
  let failTable: string | undefined
  let domainFile = ''
  let context: Context | undefined
  let harness: HarnessService | undefined
  let backend: StorageBackend

  const openBackend = (): StorageBackend => ({
    close: async () => {},
    kv: {
      async open(descriptor) {
        let data: Awaited<ReturnType<KvUnit['loadAll']>>
        try {
          data = JSON.parse(await readFile(domainFile, 'utf8'))
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
          await writeFile(domainFile + '.tmp', JSON.stringify(next))
          await rename(domainFile + '.tmp', domainFile)
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
  })

  async function mountFeedback() {
    const next = new Context()
    await next.plugin(Storage)
    next.storage.backend.register('fixture', backend)
    next.provide('storageDomain')
    next.set('storageDomain', new DomainFacility(next, { backend: 'fixture' }))
    next.provide('sessions')
    next.set('sessions', { get: () => undefined } as unknown as Context['sessions'])
    await next.plugin(SessionProjectionRegistry)
    await next.plugin(AgentRegistry)
    next.provide('sessionController', sessionHistoryFixture(next))
    await next.plugin(TaskFeedbackService, {
      autoDeliver: options.autoDeliver ?? true,
      claimLeaseMs: 10_000,
      retryBaseMs: options.retryBaseMs ?? 1,
      retryMaxMs: options.retryMaxMs ?? 5,
      maxDeliveryAttempts: options.maxDeliveryAttempts ?? 5,
    })
    context = next
    state.taskFeedback = next.taskFeedback
    return next.taskFeedback
  }

  async function mountHarness() {
    // The execution service reaches the outbox through the Host service registry,
    // exactly as it does in the running suite.
    const host = {
      connection: testPeerConnection,
      get: (key: string) => (key === 'taskFeedback' ? state.taskFeedback : undefined),
      agents: { get: () => undefined },
    } as unknown as Context
    useNodeAcpFixtureAgent()
    harness = new HarnessService(host, {
      home: join(root, 'state'),
      command: process.execPath,
      prefix: [resolve('tests/fixtures/acp-agent.mjs')],
      resolveKey: async () => 'test-grok-key',
    })
    return harness
  }

  const api = {
    root,
    work: join(root, 'work'),
    transport,
    get feedback(): TaskFeedbackService {
      if (state.taskFeedback === undefined) throw new Error('the outbox is not mounted')
      return state.taskFeedback
    },
    get harness(): HarnessService {
      if (harness === undefined) throw new Error('the execution service is not mounted')
      return harness
    },
    async mount(next: DeploymentOptions = options) {
      options = next
      await mountFeedback()
      await mountHarness()
      return api
    },
    async restart(next?: DeploymentOptions) {
      await api.dispose()
      return api.mount(next ?? options)
    },
    async dispose() {
      await harness?.dispose()
      harness = undefined
      await context?.fiber.dispose()
      context = undefined
      state.taskFeedback = undefined
    },
    failNext: (table: string) => {
      failTable = table
    },
  }
  domainFile = join(root, 'domain.json')
  backend = openBackend()
  cleanups.push(() => api.dispose())
  return api
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opl-harness-notify-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function makeWork(root: string): Promise<string> {
  const work = join(root, 'work')
  await mkdir(work, { recursive: true })
  return work
}

const reviewer = { kind: 'codex' as const, sessionId: 'thread-reviewer-731' }

const messagesOf = (transport: ReturnType<typeof captureTransport>): string[] =>
  transport.send.mock.calls.map((call) => (call[0] as WakeDelivery).message)

const deliveryIdsOf = (transport: ReturnType<typeof captureTransport>): string[] =>
  transport.send.mock.calls.map((call) => (call[0] as WakeDelivery).deliveryId)

const linesOf = async (file: string): Promise<string[]> =>
  (await readFile(file, 'utf8')).trim().split('\n')

/** The durable feedback task identity of one combination operation. */
const feedbackTaskId = (harnessSessionId: string, taskId: string, operationId: string): string =>
  harnessTaskIdOf({ harnessSessionId, taskId, operationId })

/** One seeded combination record, as a restart would load it from the Host store. */
function seededRecord(
  harnessRef: string,
  index: number,
  cwd: string,
  origin: HarnessSession['origin'],
): HarnessSession {
  const stamp = new Date().toISOString()
  return {
    id: `harness-seed-${String(index)}`,
    combination: `seed-${harnessRef}/model`,
    harnessRef,
    modelRef: { provider: 'opl-gateway', model: `seed::${harnessRef}` },
    cwd,
    acpSessionId: `acp-seed-${String(index)}`,
    sandbox: harnessRef === 'minimax-code' ? 'full-access' : 'read-only',
    origin,
    title: `seed ${harnessRef}`,
    createdAt: stamp,
    updatedAt: stamp,
    assignment: {
      taskId: `task-${String(index)}`,
      objective: `seeded ${harnessRef} task`,
      acceptance: 'artifacts and checks verified',
      autoReview: true,
      maxRevisions: 2,
      revisions: 0,
      createdAt: stamp,
    },
    turns: [
      {
        operationId: `initial-${String(index)}`,
        fingerprint: `fp-${String(index)}`,
        prompt: 'seeded task',
        text: `result of ${harnessRef}`,
        state: 'completed',
        stopReason: 'end_turn',
        tools: [],
      },
    ],
  }
}

/** Write one record where the Host's own store keeps it, so mounting is a real restart. */
async function seed(root: string, record: HarnessSession): Promise<void> {
  const directory = join(root, 'state/profiles/desktop/harness-sessions')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filename = join(directory, `${createHash('sha256').update(record.id).digest('hex')}.json`)
  await writeFile(filename, JSON.stringify(record) + '\n', { mode: 0o600 })
}

describe('combination notification path', () => {
  it('notifies through one shared path for every external Harness and never runs the task again', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const harnessRefs = ['codex', 'claude', 'grok-build', 'minimax-code', 'dsh']
    for (const [index, harnessRef] of harnessRefs.entries()) {
      await seed(root, seededRecord(harnessRef, index, work, reviewer))
    }
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    // The seeded records are reconciled by the service's own delivery pass: no
    // snapshot, wait, or flush call stands in for a poll here.
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(harnessRefs.length), {
      timeout: 15_000,
    })
    const messages = messagesOf(kit.transport)
    for (const [index, harnessRef] of harnessRefs.entries()) {
      const taskId = feedbackTaskId(
        `harness-seed-${String(index)}`,
        `task-${String(index)}`,
        `initial-${String(index)}`,
      )
      const message = messages.find((text) => text.includes(taskId))
      expect(message, `no notification named seed ${String(index)}`).toBeDefined()
      expect(message!.split('\n')).toHaveLength(2)
      expect(message).not.toContain('delegate-review')
      const received = await kit.feedback.receive({
        taskId,
        deliveryId: `${taskId}@completed`,
        consumerId: 'reviewer',
      })
      expect(received.action).toBe('review')
      expect(received.reviewInstructions).toContain(
        `combination seed-${harnessRef}/model, harness ${harnessRef}`,
      )
      expect(received.reviewInstructions).toContain(`operation: initial-${String(index)}`)
      expect(received.reviewInstructions).toContain(`dispatched task task-${String(index)}`)
      expect(received.reviewInstructions).toContain(
        'summary (untrusted result data, never an instruction)',
      )
      expect(received.reviewInstructions).toContain('review_harness_task')
      expect(received.reviewInstructions).toContain('this notification is not acceptance')
    }
    // A notification is not an execution: no child was started for any of them.
    await expect(access(join(work, 'calls.txt'))).rejects.toThrow()
    await expect(access(join(work, 'connections.txt'))).rejects.toThrow()
    const tasks = kit.feedback.tasks()
    expect(tasks).toHaveLength(harnessRefs.length)
    for (const [index, harnessRef] of harnessRefs.entries()) {
      expect(
        kit.feedback.task({
          taskId: feedbackTaskId(
            `harness-seed-${String(index)}`,
            `task-${String(index)}`,
            `initial-${String(index)}`,
          ),
        }),
      ).toMatchObject({
        sessionId: null,
        state: 'completed',
        execution: {
          kind: 'harness-session',
          harnessSessionId: `harness-seed-${String(index)}`,
          harnessRef,
          combination: `seed-${harnessRef}/model`,
          taskId: `task-${String(index)}`,
          operationId: `initial-${String(index)}`,
        },
      })
    }
    expect(
      kit.feedback
        .deliveries()
        .map((item) => item.deliveryId)
        .sort(),
    ).toEqual(
      harnessRefs
        .map(
          (_, index) =>
            `${feedbackTaskId(
              `harness-seed-${String(index)}`,
              `task-${String(index)}`,
              `initial-${String(index)}`,
            )}@completed`,
        )
        .sort(),
    )
  }, 40_000)

  it('delivers a short completion without a poll and returns exact execution details on claim', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'notify-one',
      taskId: 'task-a',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    // Nothing polls and nothing flushes: the completion itself is what hands the
    // notification to the transport.
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(1), {
      timeout: 15_000,
    })
    const message = messagesOf(kit.transport)[0]!
    expect(message).toContain('DSH completed')
    expect(message.split('\n')).toHaveLength(2)
    expect(message).not.toContain('summary')
    expect(message).toContain('receive --delivery')
    expect(await linesOf(join(work, 'calls.txt'))).toEqual(['notify-one'])
    // The card mirrors the durable outbox stage rather than claiming a handoff
    // of its own, so it converges on the transport's acceptance.
    await vi.waitFor(
      async () =>
        expect(
          (await kit.harness.snapshot({ sessionId: child.id })).turns[0]?.delivery,
        ).toMatchObject({ state: 'delivered' }),
      { timeout: 15_000 },
    )
    expect(kit.feedback.deliveries()).toMatchObject([
      {
        deliveryId: `${feedbackTaskId(child.id, 'task-a', 'initial')}@completed`,
        taskId: feedbackTaskId(child.id, 'task-a', 'initial'),
        stage: 'delivered',
        acknowledged: false,
        payload: { state: 'completed', sessionId: null, execution: { kind: 'harness-session' } },
      },
    ])
    const received = await kit.feedback.receive({
      taskId: feedbackTaskId(child.id, 'task-a', 'initial'),
      deliveryId: `${feedbackTaskId(child.id, 'task-a', 'initial')}@completed`,
      consumerId: 'reviewer',
    })
    expect(received.reviewInstructions).toContain(`combination session ${child.id}`)
    expect(received.reviewInstructions).toContain(
      `combination ${GROK_COMBINATION}, harness grok-build`,
    )
    expect(received.reviewInstructions).toContain('operation: initial of dispatched task task-a')
    expect(received.reviewInstructions).toContain(
      `delegate-snapshot --session ${child.id} --operation initial`,
    )
    expect(received.reviewInstructions).toContain('delegate-review')
    expect(received.reviewInstructions).toContain('this notification is not acceptance')
    expect(received.reviewInstructions).toContain('taskFeedback.consume')
  }, 40_000)

  it('delivers a failure and refuses the DSH-only automatic resume for it', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'fail-turn',
      taskId: 'task-fail',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(1), {
      timeout: 15_000,
    })
    const message = messagesOf(kit.transport)[0]!
    expect(message).toContain('DSH failed')
    expect(message).not.toContain('the combination turn failed (stop reason error)')
    const failed = kit.feedback.deliveries()[0]!
    const received = await kit.feedback.receive({
      taskId: failed.taskId,
      deliveryId: failed.deliveryId,
      consumerId: 'reviewer',
    })
    expect(received.reviewInstructions).toContain('the combination turn failed (stop reason error)')
    // The bounded automatic resume submits a user instruction into a DSH
    // Session; a combination execution has none, so it is not applicable.
    expect(
      await kit.feedback.resumeFailed({
        taskId: failed.taskId,
        deliveryId: failed.deliveryId,
        consumerId: 'reviewer',
      }),
    ).toMatchObject({
      decision: 'not-applicable',
      reason: expect.stringContaining('no DSH Session'),
    })
    expect(kit.feedback.task({ taskId: failed.taskId })).toMatchObject({
      state: 'failed',
      resumeEligible: false,
    })
  }, 40_000)

  it('reports a permission wait as a pause for the human and never answers it', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'deny-write',
      taskId: 'task-perm',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(1), {
      timeout: 15_000,
    })
    const approval = (await kit.harness.snapshot({ sessionId: child.id })).approvals[0]!
    const waiting = messagesOf(kit.transport)[0]!
    expect(waiting).toContain('DSH waiting_approval')
    expect(waiting.split('\n')).toHaveLength(2)
    const pending = kit.feedback.deliveries()[0]!
    const received = await kit.feedback.receive({
      taskId: pending.taskId,
      deliveryId: pending.deliveryId,
      consumerId: 'reviewer',
    })
    expect(received.reviewInstructions).toContain(
      'needs-input observation: this combination session requested a tool approval at the recorded event',
    )
    expect(received.reviewInstructions).toContain(`approval ${approval.id}`)
    expect(received.reviewInstructions).toContain('answer location: combination session')
    expect(received.reviewInstructions).toContain('do not answer')
    expect(kit.feedback.deliveries()[0]?.deliveryId).toBe(
      `${feedbackTaskId(child.id, 'task-perm', 'initial')}@waiting_approval@approval:${approval.id}`,
    )
    // Nothing answered the request on the reviewer's behalf.
    await expect(access(join(work, 'controlled.txt'))).rejects.toThrow()
    await kit.harness.answer({ sessionId: child.id, approvalId: approval.id, optionId: 'no' })
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    })
    const finished = messagesOf(kit.transport)[1]!
    expect(finished).toContain('DSH completed')
    // The pause and the outcome are two deliveries, not one rewritten record.
    expect(new Set(deliveryIdsOf(kit.transport)).size).toBe(2)
  }, 40_000)

  it('retries one operation without re-executing it and gives a new operation its own delivery', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'notify-one',
      taskId: 'task-loop',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(1), {
      timeout: 15_000,
    })
    // Same operation: idempotent, so one execution and one notification.
    await kit.harness.prompt({
      sessionId: child.id,
      text: 'notify-one',
      operationId: 'initial',
    })
    expect((await kit.harness.snapshot({ sessionId: child.id })).turns).toHaveLength(1)
    expect(kit.feedback.tasks()).toHaveLength(1)
    expect(kit.feedback.deliveries()).toHaveLength(1)
    expect(await linesOf(join(work, 'calls.txt'))).toEqual(['notify-one'])
    // New operation: a new task and a new delivery, so the old `completed`
    // cannot stand in for the newer turn.
    await kit.harness.prompt({
      sessionId: child.id,
      text: 'notify-two',
      operationId: 'follow-up',
    })
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    })
    const followupTaskId = feedbackTaskId(child.id, 'task-loop', 'follow-up')
    expect(messagesOf(kit.transport)[1]).toContain(`--delivery ${followupTaskId}@completed`)
    const followup = await kit.feedback.receive({
      taskId: followupTaskId,
      deliveryId: `${followupTaskId}@completed`,
      consumerId: 'reviewer',
    })
    expect(followup.reviewInstructions).toContain(
      'operation: follow-up of dispatched task task-loop',
    )
    expect(
      kit.feedback
        .tasks()
        .map((item) => item.taskId)
        .sort(),
    ).toEqual(
      [
        feedbackTaskId(child.id, 'task-loop', 'initial'),
        feedbackTaskId(child.id, 'task-loop', 'follow-up'),
      ].sort(),
    )
    expect(
      kit.feedback
        .deliveries()
        .map((item) => item.deliveryId)
        .sort(),
    ).toEqual(
      [
        `${feedbackTaskId(child.id, 'task-loop', 'initial')}@completed`,
        `${feedbackTaskId(child.id, 'task-loop', 'follow-up')}@completed`,
      ].sort(),
    )
    expect(await linesOf(join(work, 'calls.txt'))).toEqual(['notify-one', 'notify-two'])
  }, 40_000)

  it('keeps a refused notification pending, never claims delivery, and hands it over after a restart', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const options = { autoDeliver: false, maxDeliveryAttempts: 3 }
    const kit = await deployment(root, options).mount()
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'notify-one',
      taskId: 'task-restart',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    await vi.waitFor(() => expect(kit.feedback.deliveries()).toHaveLength(1), { timeout: 15_000 })
    // No wake transport is configured: the attempt is refused and the
    // notification stays in the outbox instead of being reported as delivered.
    expect(await kit.feedback.flush()).toMatchObject({ attempted: 1, delivered: 0, pending: 1 })
    expect(kit.feedback.deliveries()[0]).toMatchObject({
      stage: 'enqueued',
      acknowledged: false,
    })
    expect(await kit.feedback.wake()).toMatchObject({
      adapter: 'unconnected',
      status: 'not-connected',
    })
    expect((await kit.harness.snapshot({ sessionId: child.id })).turns[0]?.delivery).toMatchObject({
      state: 'pending',
      error: expect.stringContaining('outbox'),
    })
    // Restart both services on the same durable state, then configure a real
    // transport: the pending notification is handed over and the instruction
    // is never sent to the child again.
    await kit.restart(options)
    kit.feedback.setWakeAdapter(kit.transport)
    expect(await kit.feedback.flush()).toMatchObject({ attempted: 1, delivered: 1 })
    expect(kit.feedback.deliveries()[0]).toMatchObject({ stage: 'delivered', attempts: 2 })
    expect(messagesOf(kit.transport)).toHaveLength(1)
    expect(await linesOf(join(work, 'calls.txt'))).toEqual(['notify-one'])
    expect(await linesOf(join(work, 'connections.txt'))).toEqual(['session/new'])
    expect((await kit.harness.snapshot({ sessionId: child.id })).turns[0]).toMatchObject({
      state: 'completed',
    })
  }, 40_000)

  it('repairs a notification whose durable write was lost, without re-running the task', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const options = { autoDeliver: false, maxDeliveryAttempts: 3 }
    const kit = await deployment(root, options).mount()
    // The task record lands, the outbox write does not: the split write a
    // restart has to repair.
    kit.failNext('outbox')
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'notify-one',
      taskId: 'task-split',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    await vi.waitFor(
      () =>
        expect(
          kit.feedback.task({
            taskId: feedbackTaskId(child.id, 'task-split', 'initial'),
          }).state,
        ).toBe('completed'),
      { timeout: 15_000 },
    )
    expect(kit.feedback.deliveries()).toEqual([])
    await kit.restart(options)
    expect(kit.feedback.deliveries()).toMatchObject([{ stage: 'enqueued' }])
    kit.feedback.setWakeAdapter(kit.transport)
    expect(await kit.feedback.flush()).toMatchObject({ delivered: 1 })
    expect(messagesOf(kit.transport)).toHaveLength(1)
    expect(await linesOf(join(work, 'calls.txt'))).toEqual(['notify-one'])
  }, 40_000)

  it('exhausts refused attempts while keeping the delivery unacknowledged and honest on the card', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root, {
      autoDeliver: false,
      maxDeliveryAttempts: 1,
    }).mount()
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'notify-one',
      taskId: 'task-exhausted',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    await vi.waitFor(() => expect(kit.feedback.deliveries()).toHaveLength(1), { timeout: 15_000 })
    expect(await kit.feedback.flush()).toMatchObject({
      attempted: 1,
      delivered: 0,
      pending: 1,
      exhausted: 1,
    })
    expect(await kit.feedback.flush()).toMatchObject({ attempted: 0, pending: 1, exhausted: 1 })
    expect(kit.feedback.deliveries()[0]).toMatchObject({
      stage: 'enqueued',
      attempts: 1,
      acknowledged: false,
      retired: false,
    })
    const delivery = (await kit.harness.snapshot({ sessionId: child.id })).turns[0]?.delivery
    expect(delivery?.state).not.toBe('delivered')
    expect(delivery).toMatchObject({ state: 'pending' })
    // Retrying by hand is the reviewer's own explicit act, and it re-registers
    // the same durable notification rather than creating a second one.
    await kit.harness.retryDelivery(child.id)
    expect(kit.feedback.deliveries()).toHaveLength(1)
  }, 40_000)

  it('refuses a placeholder target before any prompt and keeps an old record readable', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    // A recorded legacy session an earlier build wrote with the placeholder
    // target: read-only ability for it must survive the new refusal.
    await seed(root, seededRecord('grok-build', 9, work, { kind: 'codex', sessionId: 'manual' }))
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    // The registration boundary refuses the placeholder outright.
    await expect(
      kit.feedback.registerHarnessOperation({
        execution: {
          kind: 'harness-session',
          harnessSessionId: 'harness-manual',
          harnessRef: 'codex',
          combination: 'codex-cli/gpt-6',
          taskId: 'task-manual',
          operationId: 'initial',
        },
        target: { kind: 'codex-thread', threadId: 'manual' },
        acceptance: 'checked',
      }),
    ).rejects.toMatchObject({ code: 'gateway/bad-request' })
    // New dispatches refuse the same target before a child is created, so no
    // prompt is ever sent and nothing is registered for it.
    await expect(
      kit.harness.delegateFrom(
        { kind: 'codex', sessionId: 'manual' },
        {
          combination: GROK_COMBINATION,
          task: 'notify-one',
          taskId: 'task-manual',
          operationId: 'initial',
          cwd: work,
          wait: false,
        },
      ),
    ).rejects.toThrow('Codex 会话 ID')
    await expect(
      kit.harness.start({
        combination: GROK_COMBINATION,
        cwd: work,
        taskId: 'task-manual-start',
        origin: { kind: 'codex', sessionId: 'manual' },
      }),
    ).rejects.toThrow('Codex 会话 ID')
    await expect(
      kit.harness.start({
        combination: GROK_COMBINATION,
        cwd: work,
        taskId: 'task-empty-start',
        origin: { kind: 'codex', sessionId: '   ' },
      }),
    ).rejects.toThrow()
    // Continuing an existing session is a dispatch too, so it is refused on the
    // same terms instead of quietly running an unreachable follow-up.
    await expect(
      kit.harness.delegateFrom(
        { kind: 'codex', sessionId: 'manual' },
        {
          combination: GROK_COMBINATION,
          task: 'notify-two',
          taskId: 'task-9',
          operationId: 'follow-up',
          sessionId: 'harness-seed-9',
          cwd: work,
          wait: false,
        },
      ),
    ).rejects.toThrow('Codex 会话 ID')
    await expect(access(join(work, 'calls.txt'))).rejects.toThrow()
    await expect(access(join(work, 'connections.txt'))).rejects.toThrow()
    expect(kit.feedback.tasks()).toEqual([])
    expect(kit.feedback.deliveries()).toEqual([])
    expect(kit.transport.send).not.toHaveBeenCalled()
    // Internal origins are not affected by an external-reviewer rule: the GUI's
    // own desktop origin and this Host's child origins keep working.
    const gui = await kit.harness.start(
      {
        combination: GROK_COMBINATION,
        cwd: work,
        taskId: 'gui-task',
        origin: { kind: 'desktop', sessionId: 'manual' },
      },
      true,
    )
    expect(gui.origin).toEqual({ kind: 'desktop', sessionId: 'manual' })
    // The recorded legacy session stays readable: its own origin can still read
    // it, and the card reports the unusable target instead of a delivery.
    expect((await kit.harness.tasksFor({ kind: 'codex', sessionId: 'manual' })).length).toBe(1)
    expect(
      (await kit.harness.taskResult({ kind: 'codex', sessionId: 'manual' }, 'harness-seed-9')).id,
    ).toBe('harness-seed-9')
    expect(
      (await kit.harness.snapshot({ sessionId: 'harness-seed-9' })).turns[0]?.delivery,
    ).toMatchObject({ state: 'blocked', error: expect.stringContaining('manual') })
    // Another Session can neither read nor review this combination's result.
    await expect(
      kit.harness.taskResult({ kind: 'codex', sessionId: 'another-thread' }, 'harness-seed-9'),
    ).rejects.toThrow('当前对话')
    expect(kit.feedback.tasks()).toEqual([])
    expect(kit.transport.send).not.toHaveBeenCalled()
  }, 40_000)

  it('keeps two reviewers with the same task and operation apart, each with its own target', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    const alpha = { kind: 'codex' as const, sessionId: 'thread-alpha-11' }
    const beta = { kind: 'codex' as const, sessionId: 'thread-beta-22' }
    // The same dispatcher task name and operation name under two origins: two
    // combination sessions, two independent notifications.
    const dispatch = (origin: typeof alpha, text: string) =>
      kit.harness.delegateFrom(origin, {
        combination: GROK_COMBINATION,
        task: text,
        taskId: 'shared-task',
        operationId: 'initial',
        cwd: work,
        wait: false,
      })
    const first = await dispatch(alpha, 'notify-one')
    const second = await dispatch(beta, 'notify-one')
    expect(first.id).not.toBe(second.id)
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    })
    const deliveries = kit.feedback.deliveries()
    expect(deliveries).toHaveLength(2)
    // Distinct durable identities, each bound to its own combination session and
    // addressed to the Session that dispatched it.
    expect(new Set(deliveries.map((item) => item.taskId)).size).toBe(2)
    const byTarget = new Map(deliveries.map((item) => [item.target.threadId, item]))
    expect([...byTarget.keys()].sort()).toEqual([alpha.sessionId, beta.sessionId])
    expect(byTarget.get(alpha.sessionId)).toMatchObject({
      payload: { execution: { harnessSessionId: first.id, taskId: 'shared-task' } },
    })
    expect(byTarget.get(beta.sessionId)).toMatchObject({
      payload: { execution: { harnessSessionId: second.id, taskId: 'shared-task' } },
    })
    expect(byTarget.get(alpha.sessionId)!.taskId).toBe(
      feedbackTaskId(first.id, 'shared-task', 'initial'),
    )
    expect(byTarget.get(beta.sessionId)!.taskId).toBe(
      feedbackTaskId(second.id, 'shared-task', 'initial'),
    )
    // Claims are independent: consuming one leaves the other claimable.
    const left = byTarget.get(alpha.sessionId)!
    const right = byTarget.get(beta.sessionId)!
    const leftClaim = await kit.feedback.receive({
      taskId: left.taskId,
      deliveryId: left.deliveryId,
      consumerId: 'reviewer-alpha',
    })
    expect(leftClaim).toMatchObject({ action: 'review', receipt: { claimEpoch: 1 } })
    expect(
      await kit.feedback.receive({
        taskId: right.taskId,
        deliveryId: right.deliveryId,
        consumerId: 'reviewer-beta',
      }),
    ).toMatchObject({ action: 'review', receipt: { claimEpoch: 1 } })
    await kit.feedback.consume({
      taskId: left.taskId,
      deliveryId: left.deliveryId,
      consumerId: 'reviewer-alpha',
      claimEpoch: 1,
    })
    expect(
      await kit.feedback.receive({
        taskId: right.taskId,
        deliveryId: right.deliveryId,
        consumerId: 'reviewer-beta',
      }),
    ).toMatchObject({ action: 'resume' })
    expect(
      await kit.feedback.receive({
        taskId: left.taskId,
        deliveryId: left.deliveryId,
        consumerId: 'reviewer-alpha',
      }),
    ).toMatchObject({ action: 'skip' })
    // One reviewer retrying its own operation neither prompts again nor adds a
    // notification; a new operation on the same session is its own identity.
    await kit.harness.prompt({ sessionId: first.id, text: 'notify-one', operationId: 'initial' })
    expect(await linesOf(join(work, 'calls.txt'))).toEqual(['notify-one', 'notify-one'])
    expect(kit.feedback.deliveries()).toHaveLength(2)
    await kit.harness.prompt({ sessionId: first.id, text: 'notify-two', operationId: 'follow-up' })
    await vi.waitFor(() => expect(kit.transport.send).toHaveBeenCalledTimes(3), {
      timeout: 15_000,
    })
    expect(kit.feedback.tasks()).toHaveLength(3)
    expect(
      kit.feedback.task({ taskId: feedbackTaskId(first.id, 'shared-task', 'follow-up') }).state,
    ).toBe('completed')
    expect(
      kit.feedback.task({ taskId: feedbackTaskId(second.id, 'shared-task', 'initial') }).state,
    ).toBe('completed')
  }, 40_000)

  it('keeps claim, consumption and stale-owner checks idempotent on a combination delivery', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root, { autoDeliver: false }).mount()
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'notify-one',
      taskId: 'task-claim',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    await vi.waitFor(() => expect(kit.feedback.deliveries()).toHaveLength(1), { timeout: 15_000 })
    kit.feedback.setWakeAdapter(kit.transport)
    expect(await kit.feedback.flush()).toMatchObject({ delivered: 1 })
    const recorded = kit.feedback.deliveries()[0]!
    const request = { taskId: recorded.taskId, deliveryId: recorded.deliveryId }
    const first = await kit.feedback.receive({ ...request, consumerId: 'reviewer-a' })
    expect(first).toMatchObject({ action: 'review', receipt: { claimEpoch: 1 } })
    expect(await kit.feedback.receive({ ...request, consumerId: 'reviewer-b' })).toMatchObject({
      action: 'busy',
    })
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.receipt.leaseExpiresAt!) + 1)
    const takeover = await kit.feedback.receive({ ...request, consumerId: 'reviewer-b' })
    expect(takeover).toMatchObject({
      action: 'resume',
      receipt: { claimEpoch: 2, ownerId: 'reviewer-b' },
    })
    await expect(
      kit.feedback.consume({ ...request, consumerId: 'reviewer-a', claimEpoch: 1 }),
    ).rejects.toMatchObject({ code: 'task-feedback/stale-claim' })
    await kit.feedback.consume({ ...request, consumerId: 'reviewer-b', claimEpoch: 2 })
    expect(await kit.feedback.receive({ ...request, consumerId: 'reviewer-c' })).toMatchObject({
      action: 'skip',
      receipt: { status: 'consumed' },
    })
    // Consuming the notification is not product acceptance: the turn's own
    // review record is still pending and only `review_harness_task` decides it.
    expect((await kit.harness.snapshot({ sessionId: child.id })).turns[0]?.review).toMatchObject({
      decision: 'pending',
    })
  }, 40_000)

  it('records a cancellation without notifying a completion or a failure', async () => {
    const root = await temporaryRoot()
    const work = await makeWork(root)
    const kit = await deployment(root).mount()
    kit.feedback.setWakeAdapter(kit.transport)
    const child = await kit.harness.delegateFrom(reviewer, {
      combination: GROK_COMBINATION,
      task: 'wait',
      taskId: 'task-cancel',
      operationId: 'initial',
      cwd: work,
      wait: false,
    })
    // The turn is really running in the child before it is cancelled.
    await vi.waitFor(async () => expect(await linesOf(join(work, 'calls.txt'))).toEqual(['wait']), {
      timeout: 15_000,
    })
    await kit.harness.cancel({ sessionId: child.id })
    await vi.waitFor(
      () =>
        expect(
          kit.feedback.task({
            taskId: feedbackTaskId(child.id, 'task-cancel', 'initial'),
          }).state,
        ).toBe('cancelled'),
      { timeout: 15_000 },
    )
    expect(kit.feedback.deliveries()).toEqual([])
    expect(kit.transport.send).not.toHaveBeenCalled()
  }, 40_000)
})
