/**
 * Focused checks for the external-Harness permission binding.
 *
 * Two layers are exercised here:
 *
 *  - the pure ACP `toolCall` → structured action mapping, including every shape
 *    that must stay unbindable; and
 *  - the real `HarnessService` accessor, driven end to end over a real ACP
 *    stdio child process, the real `approval/request` waterfall and the real
 *    Auto Review service. Only the Harness adapter's *launch* is replaced (it
 *    would otherwise spawn an official CLI), and the ownership the native
 *    conversation bridge normally establishes is set directly — every other
 *    fact (ACP session id, connection generation, turn identity, structured
 *    action, authorization, preset) is read from the live connection record by
 *    the code under test.
 *
 * A passing case here says nothing about the real ZCode CLI, its account or its
 * model: the fixture agent speaks ACP, so it cannot stand in for those.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as OfficialAutoReview from '@deepseek-ai/dsh-experimental-auto-review'
import { testPeerConnection } from '../test-peer.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import PermissionPresetService, { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, {
  type ApprovalOutcome,
  type ApprovalRequestEvent,
} from '@deepseek-ai/dsh-user-approval'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { HarnessService } from '../../src/execution/host/harness.ts'
import {
  EXTERNAL_TOOL_NAME_META,
  externalAskFromToolCall,
} from '../../src/execution/host/external-binding.ts'
import { adapterFor } from '../../src/execution/host/adapters/index.ts'
import { systemEnvironment } from '../../src/execution/host/adapters/environment.ts'
import OplAutoReviewService, {
  EXTERNAL_REVIEW_BINDING_SERVICE,
  LEDGER_SERVICE,
  MAINTENANCE_SERVICE,
} from '../../src/auto-review/host/service.ts'
import {
  AUTO_REVIEW_FIELD,
  AUTO_REVIEW_OWNER_NS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type Config as FlatConfig,
} from '../../src/auto-review/host/settings.ts'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

const FIXTURE = resolve('tests/auto-review/fixtures/structured-permission-agent.mjs')
/** The combination the fixture catalog declares for the ZCode adapter. */
const ZCODE_COMBINATION = 'zcode/z-ai/glm-5.3'
const LOW_ALLOW = '{"risk":"low","decision":"allow"}'
const HIGH_DENY = '{"risk":"high","decision":"deny","reason":"irreversible"}'

/** The reviewer stream one complete answer produces. */
function chunksFor(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface ReviewerStub {
  answer(text: string): void
  readonly prepares: Record<string, unknown>[]
}

/** The smallest official-LLM face the Auto Review service prepares a call on. */
function createReviewer(): ReviewerStub {
  let answer = LOW_ALLOW
  const prepares: Record<string, unknown>[] = []
  return Object.assign(
    {
      listProviders: () => [
        { id: 'opl-gateway', name: 'OPL Gateway' },
        { id: 'our-free-model', name: 'Our Free Model' },
      ],
      listConfigurableProviders: () => [],
      listModels: async (provider: string) =>
        provider === 'opl-gateway'
          ? [{ id: 'codex::codex-auto-review', name: 'Codex Auto Review' }]
          : [{ id: 'z-ai/glm-5.3', name: 'GLM-5.3' }],
      resolveModelInfo: async () => ({}),
      prepareCall: async (config: Record<string, unknown>) => {
        prepares.push({ ...config })
        return {
          config: { ...config },
          retryPolicy: {},
          adapterDefaults: {},
          stream: () =>
            (async function* () {
              yield* chunksFor(answer)
            })(),
        }
      },
    },
    { answer: (text: string) => (answer = text), prepares },
  ) as unknown as ReviewerStub
}

/** A settings surface holding the suite entry, as the real one does. */
function createSettings(enabled: boolean): {
  describe(): readonly { ns: string; value: unknown; revision: number }[]
  update(): Promise<void>
  configure(): () => void
} {
  const section: FlatConfig = {
    enabled,
    reviewerProvider: '',
    reviewerModel: '',
    reviewerEffort: '',
    reviewerKind: 'reviewer',
    timeoutMs: 5000,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  }
  return {
    describe: () => [
      { ns: AUTO_REVIEW_OWNER_NS, value: { [AUTO_REVIEW_FIELD]: { ...section } }, revision: 1 },
    ],
    update: async () => {},
    configure: () => () => {},
  }
}

/** A recording review ledger. */
function createLedger(): { entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = []
  return { entries }
}

/** The native Session that owns the Harness conversation, with an open turn. */
function createOwnerSession(id: string, cwd: string): Session {
  const session = Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    cwd,
  })
  // The official ApprovalService requires the ask to be enclosed by an open turn.
  session.append('turn/start', { turn: 1 })
  return session
}

interface Mounted {
  ctx: Context
  reviewer: ReviewerStub
  ledger: { entries: Record<string, unknown>[] }
  session: Session
  service: HarnessService
  presets: PermissionPresetService
  human: HumanAnswerer
}

/**
 * The interactive answerer a real Host composes: it holds every approval
 * request until a human decides, exactly like the settings UI does.
 */
interface HumanAnswerer {
  readonly requests: ApprovalRequestEvent[]
  decide(outcome: ApprovalOutcome): void
}

function createHumanAnswerer(ctx: Context): HumanAnswerer {
  const requests: ApprovalRequestEvent[] = []
  const waiting: ((outcome: ApprovalOutcome) => void)[] = []
  ctx.on('approval/request', async (request: ApprovalRequestEvent) => {
    requests.push(request)
    return await new Promise<ApprovalOutcome>((resolve) => waiting.push(resolve))
  })
  return {
    requests,
    decide: (outcome: ApprovalOutcome) => waiting.shift()?.(outcome),
  }
}

/**
 * Mount the real permission, approval, Auto Review and Harness services on one
 * Context and launch the fixture ACP agent instead of the official CLI.
 */
async function mount(options: { enabled?: boolean } = {}): Promise<Mounted> {
  const root = await mkdtemp(join(tmpdir(), 'opl-ar-binding-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('connection', testPeerConnection)
  const session = createOwnerSession('session-owner', root)
  const owner = { session, status: 'idle' } as unknown as Agent
  ctx.provide('sessions', {
    get: (id: SessionId) => (id === session.id ? session : undefined),
    list: () => [session],
    flush: async () => {},
  })
  ctx.provide('agents', {
    get: (id: SessionId) => (id === session.id ? owner : undefined),
    list: () => [owner],
  })
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  ctx.provide('tools', {})
  ctx.provide('workingDirectory', { ensure: async (agent: Agent) => agent.session.header.cwd })
  const reviewer = createReviewer()
  ctx.provide('llm', reviewer)
  ctx.provide('settings', createSettings(options.enabled ?? true))
  const ledger = createLedger()
  ctx.provide(LEDGER_SERVICE, {
    append: async (entry: Record<string, unknown>) => {
      ledger.entries.push(entry)
    },
  })
  ctx.provide(MAINTENANCE_SERVICE, { change: (operation: () => Promise<unknown>) => operation() })
  new SessionProjectionRegistry(ctx)
  await ctx.plugin(ApprovalService, {})
  await ctx.plugin(PermissionPresetService, {
    presets: {
      'workspace-write': {
        sandbox: 'workspace-write',
        approval: 'ask',
        name: 'workspace-write',
        description: '',
      },
      'danger-full-access': {
        sandbox: 'danger-full-access',
        approval: 'never',
        name: 'danger-full-access',
        description: '',
      },
    },
  })
  await ctx.plugin(OfficialAutoReview)
  await ctx.plugin(OplAutoReviewService, {
    enabled: options.enabled ?? true,
    reviewerProvider: '',
    reviewerModel: '',
    reviewerEffort: '',
    reviewerKind: 'reviewer',
    timeoutMs: 5000,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  })
  const presets = (ctx as unknown as { permissionPresets: PermissionPresetService })
    .permissionPresets
  const human = createHumanAnswerer(ctx)
  const service = new HarnessService(ctx, {
    home: join(root, 'state'),
    command: process.execPath,
    prefix: [FIXTURE],
    resolveKey: async () => 'fixture-key',
  })
  cleanups.push(() => service.dispose())
  ctx.provide(EXTERNAL_REVIEW_BINDING_SERVICE, {
    bind: (agent: Agent, request: { callId?: string }) =>
      service.externalApprovalBinding(String(agent.session.id), request.callId),
  })
  const adapter = adapterFor('zcode', { provider: 'our-free-model', model: 'z-ai/glm-5.3' })!
  vi.spyOn(adapter, 'available').mockResolvedValue({ available: true })
  vi.spyOn(adapter, 'prepare').mockImplementation(async (_ctx, record, adapterOptions) => {
    if (adapterOptions.prefix?.[0] !== FIXTURE) throw Error('the fixture launch is the only one')
    const home = join(adapterOptions.home, 'harnesses', 'zcode', record.id)
    await mkdir(home, { recursive: true, mode: 0o700 })
    return {
      home,
      command: process.execPath,
      args: [FIXTURE],
      env: { ...systemEnvironment(), OPL_FIXTURE_MODEL: 'z-ai/glm-5.3' },
    }
  })
  // The ZCode combination is generated from the Gateway account catalog in the
  // real Host, so the fixture declares the same shape explicitly.
  await service.saveExecutionCatalog({
    version: 2,
    models: [],
    harnesses: [
      { id: 'dsh', name: 'DSH', kind: 'dsh', adapter: 'native-session' },
      { id: 'zcode', name: 'ZCode', kind: 'acp', command: 'zcode' },
    ],
    combinations: [
      {
        id: ZCODE_COMBINATION,
        name: 'GLM-5.3 + ZCode',
        modelRef: { provider: 'our-free-model', model: 'z-ai/glm-5.3' },
        harnessRef: 'zcode',
        permissionPolicy: 'full-access',
        enabled: true,
      },
    ],
  })
  return { ctx, reviewer, ledger, session, service, presets, human }
}

/** Start one Harness task and claim it for the native Session, as the conversation bridge does. */
async function startTask(mounted: Mounted, cwd: string): Promise<string> {
  const snapshot = await mounted.service.start({
    combination: ZCODE_COMBINATION,
    cwd,
    taskId: 'task-1',
    origin: { kind: 'desktop', sessionId: 'manual' },
    sandbox: 'full-access',
  })
  // The native conversation bridge is what normally establishes this ownership;
  // everything else the binding reads stays the live Harness state.
  ;(
    mounted.service as unknown as {
      conversationOwners: Map<string, { sessionId: string }>
    }
  ).conversationOwners.set(snapshot.id, { sessionId: String(mounted.session.id) })
  return snapshot.id
}

/** Yield until one condition holds, so an asynchronous review is awaited. */
async function until(predicate: () => Promise<boolean>, attempts = 400): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the awaited condition never became true')
}

async function written(cwd: string): Promise<boolean> {
  return await readFile(join(cwd, 'controlled.txt'), 'utf8').then(
    () => true,
    () => false,
  )
}

describe('external ask mapping', () => {
  it('starts an Auto-owned ZCode conversation in approval-capable build mode', async () => {
    const mounted = await mount()
    mounted.presets.set(mounted.session, AUTO_PRESET)
    const started = await mounted.service.start({
      combination: ZCODE_COMBINATION,
      cwd: mounted.session.header.cwd,
      taskId: 'auto-mode',
      origin: { kind: 'dsh', sessionId: String(mounted.session.id) },
      sandbox: 'full-access',
    })
    const { HarnessSessionStore } = await import('../../src/execution/host/session-store.ts')
    const records = await new HarnessSessionStore(join(mounted.session.header.cwd!, 'state')).load()
    expect(records.find((record) => record.id === started.id)?.zcodeMode).toBe('build')
  })

  it('reads the tool name from the ACP extension slot and the parameters verbatim', () => {
    expect(
      externalAskFromToolCall({
        toolCallId: 'permission-1',
        title: 'ZCode · bash\nsomething the model wrote',
        kind: 'other',
        rawInput: { command: 'rm -rf build' },
        _meta: { [EXTERNAL_TOOL_NAME_META]: 'bash' },
      }),
    ).toEqual({
      toolCallId: 'permission-1',
      name: 'bash',
      parameters: { command: 'rm -rf build' },
    })
  })

  it('refuses every ask whose action is not exactly bindable', () => {
    const cases: unknown[] = [
      undefined,
      null,
      'bash',
      { _meta: { [EXTERNAL_TOOL_NAME_META]: 'bash' } },
      { rawInput: { command: 'ls' } },
      { rawInput: { command: 'ls' }, _meta: {} },
      { rawInput: { command: 'ls' }, _meta: { [EXTERNAL_TOOL_NAME_META]: '' } },
      { rawInput: { command: 'ls' }, _meta: { [EXTERNAL_TOOL_NAME_META]: 7 } },
      { rawInput: undefined, _meta: { [EXTERNAL_TOOL_NAME_META]: 'bash' } },
      { rawInput: { broken: 1n }, _meta: { [EXTERNAL_TOOL_NAME_META]: 'bash' } },
      { rawInput: { command: 'ls' }, _meta: { [EXTERNAL_TOOL_NAME_META]: 'b'.repeat(201) } },
    ]
    for (const value of cases) expect(externalAskFromToolCall(value)).toBeUndefined()
    // The display title alone never becomes an action.
    expect(
      externalAskFromToolCall({ title: 'ZCode · bash\n{"command":"rm -rf build"}' }),
    ).toBeUndefined()
  })
})

describe('external Harness permission binding over a real ACP lifecycle', () => {
  it('binds the live connection and answers from the reviewer instead of the human', async () => {
    const mounted = await mount()
    const taskCwd = mounted.session.header.cwd
    const id = await startTask(mounted, taskCwd)
    mounted.presets.set(mounted.session, AUTO_PRESET)

    await mounted.service.prompt({ sessionId: id, text: 'structured-write', operationId: 'op-1' })

    await until(() => written(taskCwd))
    expect(await readFile(join(taskCwd, 'controlled.txt'), 'utf8')).toBe('approved')
    // The review ran through the dedicated OpenAI route, tool-free.
    expect(mounted.reviewer.prepares[0]).toMatchObject({
      provider: 'opl-gateway',
      model: 'codex::codex-auto-review',
      temperature: 0,
    })
    const begin = mounted.ledger.entries[0]!
    expect(begin).toMatchObject({
      kind: 'begin',
      pending: { mode: 'external-approval', name: 'bash', turn: 1 },
      reviewer: { source: 'native-auto-review', provider: 'opl-gateway' },
      authorization: { preset: 'auto' },
    })
    expect((begin['pending'] as { turnId?: string }).turnId).toBeTruthy()
    expect(mounted.ledger.entries[1]).toMatchObject({
      kind: 'result',
      reviewer: 'allow',
      status: 'allow',
    })
  })

  it('rejects the ask when the reviewer denies it, and writes nothing', async () => {
    const mounted = await mount()
    const taskCwd = mounted.session.header.cwd
    const id = await startTask(mounted, taskCwd)
    mounted.presets.set(mounted.session, AUTO_PRESET)
    mounted.reviewer.answer(HIGH_DENY)

    await mounted.service.prompt({ sessionId: id, text: 'structured-write', operationId: 'op-1' })

    // The committed outcome is the durable completion signal of the review.
    await until(async () => mounted.ledger.entries.length >= 2)
    expect(await written(taskCwd)).toBe(false)
    expect(mounted.reviewer.prepares).toHaveLength(1)
    expect(mounted.ledger.entries[1]).toMatchObject({
      kind: 'result',
      reviewer: 'deny',
      status: 'deny',
    })
  })

  it('leaves the ask to the human chain while the integration is disabled', async () => {
    const mounted = await mount({ enabled: false })
    const taskCwd = mounted.session.header.cwd
    const id = await startTask(mounted, taskCwd)

    await mounted.service.prompt({ sessionId: id, text: 'structured-write', operationId: 'op-1' })

    const pending = await waitForAsk(mounted, id)
    expect(mounted.reviewer.prepares).toHaveLength(0)
    expect(mounted.human.requests).toHaveLength(1)
    expect(await written(taskCwd)).toBe(false)
    // The pending ask is the human's, and answering it still works exactly as before.
    mounted.human.decide('allowed-once')
    await until(() => written(taskCwd))
    expect(pending.approvals).toHaveLength(1)
  })

  it('leaves the ask to the human chain for a Session that does not select auto', async () => {
    const mounted = await mount()
    const taskCwd = mounted.session.header.cwd
    const id = await startTask(mounted, taskCwd)

    await mounted.service.prompt({ sessionId: id, text: 'structured-write', operationId: 'op-1' })

    await waitForAsk(mounted, id)
    // The facts are all bindable — the refusal is the integration's eligibility
    // rule, not a missing binding — and no reviewer was called.
    const binding = mounted.service.externalApprovalBinding(
      String(mounted.session.id),
      mounted.human.requests[0]?.callId,
    )
    expect(binding?.authorization.preset).toBe('workspace-write')
    expect(binding?.action).toEqual({
      name: 'bash',
      parameters: { command: 'printf approved > controlled.txt' },
    })
    expect(mounted.reviewer.prepares).toHaveLength(0)
    mounted.human.decide('rejected')
    await until(async () => (await mounted.service.snapshot({ sessionId: id })).turns.length > 0)
    expect(await written(taskCwd)).toBe(false)
  })
})

/** Wait until the fixture's one permission ask is pending for a human decision. */
async function waitForAsk(mounted: Mounted, id: string) {
  let pending = await mounted.service.snapshot({ sessionId: id })
  await until(async () => {
    pending = await mounted.service.snapshot({ sessionId: id })
    return pending.approvals.length === 1
  })
  return pending
}
