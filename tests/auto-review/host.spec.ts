/**
 * Focused behaviour tests for the Auto Review Host.
 *
 * Everything here drives real official code: real `Session` event logs, the
 * real `SessionProjectionRegistry`, the real `PermissionPresetService` (so the
 * `auto` preset, the `registerAuto` admission check and the durable
 * `approval/policy` knob are the official ones), the real Cordis
 * `tools/pre-execute` waterfall dispatch, and the real service class.
 *
 * Only the seams that do not exist in this repository are substituted:
 * `ctx.sessions`, `ctx.llm`, `ctx.agents`, `ctx.shell`, `ctx.approval`,
 * `ctx.settings` and the ledger sink are filled with the smallest public face
 * the service reads. No model is called and no provider metadata is invented by
 * the service; the substituted `llm` records exactly what was asked for.
 *
 * The `user-rpc` source shape used by the real application (a `user` kind
 * carrying an `rpcId`) and the direct-parent `agent-message` source are declared
 * inside the shipped Desktop build rather than by this repository's dev
 * dependencies, so the fixtures build them structurally. The service reads
 * every source structurally for the same reason.
 */
import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import {
  ToolCallId,
  createAssistantMessage,
  ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import PermissionPresetService, { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import OplAutoReviewService, {
  EXTERNAL_REVIEW_BINDING_SERVICE,
  LEDGER_SERVICE,
  MAINTENANCE_SERVICE,
} from '../../src/auto-review/host/service.ts'
import type {
  ExternalReviewBinding,
  ExternalReviewBindingPort,
} from '../../src/auto-review/host/external-review.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { reviewLeaseOf } from '../../src/auto-review/host/guard.ts'
import {
  createDomainLedger,
  reviewRecordKey,
  reviewRecordSchema,
  type ReviewRecord,
} from '../../src/auto-review/host/ledger.ts'
import {
  AUTO_REVIEW_FIELD,
  AUTO_REVIEW_OWNER_NS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  type Config as FlatConfig,
} from '../../src/auto-review/host/settings.ts'
import type {
  AutoReviewPreferences,
  AutoReviewStatus,
} from '../../src/auto-review/contracts/settings.ts'

const cleanups: (() => unknown)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const LOW_ALLOW = '{"risk":"low","decision":"allow"}'

/** One provider route the substituted LLM service advertises. */
interface RouteSpec {
  provider: string
  name: string
  models: { id: string; name: string; efforts?: string[]; defaultEffort?: string }[]
}

const DEFAULT_ROUTES: RouteSpec[] = [
  {
    provider: 'opl-gateway',
    name: 'OPL Gateway',
    models: [{ id: 'codex::codex-auto-review', name: 'Codex Auto Review' }],
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'Flash', efforts: ['high', 'medium'], defaultEffort: 'medium' },
    ],
  },
]

/** What the substituted LLM service observed. */
interface LlmProbe {
  prepares: {
    provider: string
    model: string
    reasoningEffort?: string
    temperature?: number
    maxTokens?: number
  }[]
  requests: Record<string, unknown>[]
}

interface LlmStub {
  providers: RouteSpec[]
  probe: LlmProbe
  answer: (text: string) => void
  hold: () => () => void
  failPrepare: () => void
}

function createLlm(routes: RouteSpec[]): LlmStub {
  const probe: LlmProbe = { prepares: [], requests: [] }
  let answer = LOW_ALLOW
  let fail = false
  let held: Promise<void> | undefined
  let release: (() => void) | undefined
  const service = {
    listProviders: () => routes.map((route) => ({ id: route.provider, name: route.name })),
    listModels: async (provider: string) =>
      routes
        .find((route) => route.provider === provider)
        ?.models.map((model) => ({ provider, id: model.id, name: model.name })) ?? [],
    resolveModelInfo: async (provider: string, model: string) => {
      const spec = routes
        .find((route) => route.provider === provider)
        ?.models.find((entry) => entry.id === model)
      if (spec === undefined) throw new Error('synthetic: unknown model')
      return {
        provider,
        id: model,
        name: spec.name,
        ...(spec.efforts === undefined
          ? {}
          : {
              reasoning: {
                efforts: spec.efforts.map((id) => ({ id, name: id })),
                ...(spec.defaultEffort === undefined ? {} : { defaultEffort: spec.defaultEffort }),
              },
            }),
      }
    },
    prepareCall: async (config: {
      provider: string
      model: string
      reasoningEffort?: string
      temperature?: number
      maxTokens?: number
    }) => {
      if (fail) throw new Error('synthetic: NO_ADAPTER')
      probe.prepares.push({ ...config })
      return {
        config: { ...config },
        retryPolicy: {},
        adapterDefaults: {},
        stream: (options: Record<string, unknown>) => {
          probe.requests.push(options)
          return (async function* () {
            if (held !== undefined) await held
            yield* chunksFor(answer)
          })()
        },
      }
    },
  }
  return Object.assign(service, {
    probe,
    providers: routes,
    answer: (text: string) => {
      answer = text
    },
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => release?.()
    },
    failPrepare: () => {
      fail = true
    },
  }) as unknown as LlmStub
}

/** The chunk sequence one complete reviewer answer produces. */
function chunksFor(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A settings surface holding the suite entry, with injectable write failures. */
interface SettingsStub {
  describe(): readonly { ns: string; value: unknown; revision: number }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  configure(): () => void
  failNext(): void
  conflictNext(): void
  moveRevision(): void
  readonly section: FlatConfig
  readonly writes: number
}

const DEFAULT_FLAT: FlatConfig = {
  enabled: true,
  reviewerProvider: '',
  reviewerModel: '',
  reviewerEffort: '',
  reviewerKind: 'reviewer',
  timeoutMs: 5000,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
}

function createSettings(overrides: Partial<FlatConfig> = {}): SettingsStub {
  const section: FlatConfig = { ...DEFAULT_FLAT, ...overrides }
  let revision = 1
  let fail = false
  let conflict = false
  let writes = 0
  return {
    describe: () => [
      { ns: AUTO_REVIEW_OWNER_NS, value: { [AUTO_REVIEW_FIELD]: { ...section } }, revision },
    ],
    update: async (_ns: string, patch: object) => {
      if (fail) {
        fail = false
        throw new Error('synthetic: settings write refused')
      }
      if (conflict) {
        conflict = false
        throw Object.assign(new Error('synthetic: conflict'), { code: 'SETTINGS_CONFLICT' })
      }
      const incoming = (patch as Record<string, unknown>)[AUTO_REVIEW_FIELD] as
        | Partial<FlatConfig>
        | undefined
      if (incoming !== undefined) Object.assign(section, incoming)
      revision += 1
      writes += 1
    },
    configure: () => () => {},
    failNext: () => {
      fail = true
    },
    conflictNext: () => {
      conflict = true
    },
    moveRevision: () => {
      revision += 1
    },
    get section() {
      return section
    },
    get writes() {
      return writes
    },
  }
}

/**
 * The composition-owned settings/admission transaction.
 *
 * The real owner holds the shared runtime exclusion across native and external
 * task admission; here the operation runs under an injectable refusal so the
 * service's use of the exclusion can be observed.
 */
interface MaintenanceStub {
  change<T>(operation: () => Promise<T>): Promise<T>
  failNext(): void
  readonly runs: number
}

function createMaintenance(): MaintenanceStub {
  let fail = false
  let runs = 0
  return {
    change: async <T>(operation: () => Promise<T>): Promise<T> => {
      if (fail) {
        fail = false
        throw new Error('synthetic: the maintenance exclusion is busy')
      }
      runs += 1
      return await operation()
    },
    failNext: () => {
      fail = true
    },
    get runs() {
      return runs
    },
  }
}

/** A recording ledger sink, with an injectable failure. */
interface LedgerStub {
  entries: Record<string, unknown>[]
  failNext(): void
}

function createLedger(): LedgerStub {
  const entries: Record<string, unknown>[] = []
  let fail = false
  return {
    entries,
    failNext: () => {
      fail = true
    },
    append: async (entry: Record<string, unknown>) => {
      if (fail) {
        fail = false
        throw new Error('synthetic: ledger write refused')
      }
      entries.push(entry)
    },
  } as unknown as LedgerStub
}

function createSession(id: string, cwd = resolve('test-workspace')): Session {
  return Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    cwd,
  })
}

/** A durable shipped-Web human instruction, as the application records it. */
function humanMessage(id: string, text: string, rpcId = 'rpc-1'): unknown {
  return { id, source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] }
}

/** The `user/message` payload type accepted by `Session.append`. */
type UserMessagePayload = Parameters<Session['append']>[1]

/** Live fields read by the official permission initializer and review activity gate. */
interface AgentFixture {
  id: SessionId
  session: Session
  status: 'idle' | 'running'
}

function liveAgent(session: Session, status: AgentFixture['status'] = 'idle'): AgentFixture {
  return { id: session.id, session, status }
}

interface MountOptions {
  session?: Session
  extraSessions?: Session[]
  routes?: RouteSpec[]
  settings?: SettingsStub
  ledger?: LedgerStub
  maintenance?: MaintenanceStub
  withoutMaintenance?: boolean
  agents?: AgentFixture[]
  config?: Partial<FlatConfig>
  /** Optional composition-supplied binding port for external permission asks. */
  bindingPort?: ExternalReviewBindingPort
}

async function mount(options: MountOptions = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const session = options.session ?? createSession('session-auto')
  const all = [session, ...(options.extraSessions ?? [])]
  ctx.provide('sessions', {
    get: (id: SessionId) => all.find((entry) => entry.id === id),
    list: () => all,
  })
  const llm = createLlm(options.routes ?? DEFAULT_ROUTES)
  ctx.provide('llm', llm)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  const agents = options.agents ?? []
  ctx.provide('agents', {
    get: (id: SessionId) => agents.find((agent) => agent.id === id),
    list: () => agents,
  })
  // The gate is only effective with the tools pipeline mounted, so the service
  // injects it; the substituted face is never called by the tests.
  ctx.provide('tools', {})
  ctx.provide('approval', {
    config: { policy: 'ask' },
    overrideOf: (target: Session) => lastApprovalPolicy(target),
    setPolicy: () => {},
  })
  const settings = options.settings ?? createSettings(options.config)
  ctx.provide('settings', settings)
  const ledger = options.ledger ?? createLedger()
  ctx.provide(LEDGER_SERVICE, ledger)
  const maintenance = options.maintenance ?? createMaintenance()
  if (options.withoutMaintenance !== true) ctx.provide(MAINTENANCE_SERVICE, maintenance)
  if (options.bindingPort !== undefined)
    ctx.provide(EXTERNAL_REVIEW_BINDING_SERVICE, options.bindingPort)
  const registry = new SessionProjectionRegistry(ctx)
  const presetFork = await ctx.plugin(PermissionPresetService, {
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
  const serviceFork = await ctx.plugin(OplAutoReviewService, {
    ...DEFAULT_FLAT,
    ...options.config,
  })
  const service = (ctx as unknown as { oplAutoReview: OplAutoReviewService }).oplAutoReview
  const presets = (
    ctx as unknown as {
      permissionPresets: PermissionPresetService
    }
  ).permissionPresets
  for (const current of all) {
    let agent = agents.find((entry) => entry.session === current)
    if (!agent) {
      agent = liveAgent(current)
      agents.push(agent)
    }
    await ctx.serial('agent/created', {
      agent: agent as Agent,
      source: 'resume',
    })
  }
  return {
    ctx,
    service,
    presets,
    presetFork,
    session,
    llm,
    registry,
    settings,
    ledger,
    maintenance,
    serviceFork,
  }
}

/** Record the persisted request header that routes this Session. */
function recordHeader(
  session: Session,
  input: {
    provider?: string
    model?: string
    reasoningEffort?: string
    tool?: string
    tools?: boolean
  } = {},
): void {
  session.append('request/header', {
    header: {
      config: {
        provider: input.provider ?? 'deepseek',
        model: input.model ?? 'deepseek-flash',
        ...(input.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(input.reasoningEffort) }),
      },
      ...(input.tools === false
        ? {}
        : {
            tools: [
              {
                name: input.tool ?? 'bash',
                description: 'Run one shell command',
                parameters: { type: 'object', properties: { command: { type: 'string' } } },
              },
            ],
          }),
    },
    reason: 'initial',
  })
}

/** Open turn 1 / step 1. */
function beginStep(session: Session, turn = 1, step = 1): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
}

/** Record the visible assistant tool call and its logged native action. */
function recordCall(
  session: Session,
  input: { callId: string; name?: string; arguments: string; turn?: number; step?: number },
): void {
  const turn = input.turn ?? 1
  const step = input.step ?? 1
  const name = input.name ?? 'bash'
  session.append(
    'assistant/message',
    {
      turn,
      step,
      message: createAssistantMessage({
        content: [
          { type: 'tool-call', id: ToolCallId(input.callId), name, arguments: input.arguments },
        ],
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  session.append('tool/call', {
    turn,
    step,
    callId: ToolCallId(input.callId),
    name,
    arguments: input.arguments,
  })
}

/** Record one started PTC sub-dispatch. */
function recordPtcStart(
  session: Session,
  input: {
    rootCallId: string
    parentCallId: string
    subCallId: string
    name?: string
    arguments: unknown
  },
): void {
  session.append('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId(input.rootCallId),
    parentCallId: ToolCallId(input.parentCallId),
    subCallId: ToolCallId(input.subCallId),
    name: input.name ?? 'bash',
    arguments: input.arguments,
  })
}

/** Build one pending execution as the tool registry would expose it. */
function pendingExec(
  session: Session,
  input: {
    callId: string
    name?: string
    arguments: unknown
    rootCallId?: string
    parent?: boolean
    schema?: { name: string; description: string; parameters: Record<string, unknown> }
    signal?: AbortSignal
  },
): ToolExecution {
  return {
    callId: ToolCallId(input.callId),
    rootCallId: ToolCallId(input.rootCallId ?? input.callId),
    name: input.name ?? 'bash',
    arguments: input.arguments,
    agent: { session },
    ...(input.parent === true ? { parent: Symbol('parent') } : {}),
    ...(input.schema === undefined ? {} : { schema: input.schema }),
    signal: input.signal ?? new AbortController().signal,
    token: Symbol('token'),
  } as unknown as ToolExecution
}

/** Dispatch the real `tools/pre-execute` waterfall. */
async function dispatch(
  ctx: Context,
  exec: ToolExecution,
  inner: () => Promise<PreToolDecision> = async () => ({ kind: 'allow' }),
): Promise<PreToolDecision> {
  const waterfall = ctx as unknown as {
    waterfall(thisArg: unknown, name: string, ...args: unknown[]): Promise<PreToolDecision>
  }
  return await waterfall.waterfall({}, 'tools/pre-execute', exec, inner)
}

async function statusOf(service: OplAutoReviewService): Promise<AutoReviewStatus> {
  return await service.read()
}

/** Enable with a fixed reviewer through the real save path. */
async function enableFixed(
  service: OplAutoReviewService,
  provider: string,
  model: string,
  effort?: string,
): Promise<{ ok: boolean; failure?: string; status?: AutoReviewStatus }> {
  const current = await service.read()
  const preferences: AutoReviewPreferences = {
    enabled: true,
    reviewer: {
      mode: 'fixed',
      route: { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  }
  const result = await service.save({ expectedRevision: current.revision, preferences })
  return result.ok
    ? { ok: true, status: result.status }
    : { ok: false, failure: result.failure, status: result.status }
}

/** Enable the explicit decision-model route through the real save path. */
async function enableDecision(service: OplAutoReviewService) {
  const current = await service.read()
  return await service.save({
    expectedRevision: current.revision,
    preferences: {
      enabled: true,
      reviewer: {
        mode: 'decision',
        route: {
          provider: 'bamboo-startlux',
          model: 'startlux-decision-27b-autothink',
        },
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    },
  })
}

/** Yield until one condition holds, so a review that has not started yet is awaited. */
async function until(predicate: () => boolean, attempts = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('synthetic: the awaited condition never became true')
}

/** Select the official `auto` preset for one Session. */
function selectAuto(presets: PermissionPresetService, session: Session): void {
  presets.set(session, AUTO_PRESET)
}

/** The session's last durable approval policy. */
function lastApprovalPolicy(session: Session): string | undefined {
  let policy: string | undefined
  for (const event of session.snapshotEvents() as unknown as {
    type: string
    data: { policy?: string }
  }[]) {
    if (event.type === 'approval/policy') policy = event.data.policy
  }
  return policy
}

/** Append one durable human instruction to a session. */
function appendPrompt(session: Session, id: string, text: string): void {
  session.append('user/message', humanMessage(id, text) as UserMessagePayload, {
    surfaceOp: 'append',
  })
}

/** A reviewable native call: header, prompt, step, and one visible pending call. */
function reviewableSession(id = 'session-auto'): Session {
  const session = createSession(id)
  recordHeader(session)
  appendPrompt(session, 'm-1', 'tidy the workspace')
  beginStep(session)
  recordCall(session, { callId: 'call-1', arguments: '{"command":"ls"}' })
  return session
}

const CALL1 = { callId: 'call-1', arguments: { command: 'ls' } }

describe('auto review gate ownership', () => {
  it('leaves a plain Session alone while the integration is disabled', async () => {
    const session = reviewableSession()
    const { ctx, llm } = await mount({ session, config: { enabled: false } })
    let reached = 0

    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(decision).toEqual({ kind: 'allow' })
    expect(reached).toBe(1)
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('leaves a plain Session alone while the integration is enabled', async () => {
    const session = reviewableSession()
    const { ctx, llm } = await mount({ session })
    let reached = 0

    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(decision).toEqual({ kind: 'allow' })
    expect(reached).toBe(1)
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('refuses a Session that selects auto while the integration is disabled', async () => {
    const session = reviewableSession()
    const { ctx, presets, service } = await mount({ session })
    selectAuto(presets, session)
    const current = await statusOf(service)
    const off = await service.save({
      expectedRevision: current.revision,
      preferences: { ...current.preferences, enabled: false },
    })
    expect(off.ok).toBe(false)

    // A disable cannot be accepted while the Session still selects auto, so the
    // guard is never dropped; a forced-off selection would refuse instead.
    expect(presets.current(session)).toBe(AUTO_PRESET)
    expect(ctx).toBeDefined()
  })
})

describe('auto review settings and routes', () => {
  it('defaults to disabled on the current route and advertises only registered pure-LLM routes', async () => {
    const { service } = await mount({
      config: { enabled: false },
      routes: [
        ...DEFAULT_ROUTES,
        {
          provider: 'minimax-official',
          name: 'MiniMax Code',
          models: [{ id: 'MiniMax-M3', name: 'M3' }],
        },
      ],
    })

    const status = await statusOf(service)

    expect(status.state).toBe('disabled')
    expect(status.preferences.enabled).toBe(false)
    expect(status.preferences.reviewer).toEqual({ mode: 'current' })
    expect(status.preferences.timeoutMs).toBe(5000)
    expect(status.routes.map((route) => route.provider)).toEqual(['opl-gateway', 'deepseek'])
    expect(status.routes.find((route) => route.provider === 'deepseek')).toMatchObject({
      provider: 'deepseek',
      providerName: 'DeepSeek',
      model: 'deepseek-flash',
      modelName: 'Flash',
      efforts: ['high', 'medium'],
      defaultEffort: 'medium',
    })
  })

  it('accepts an advertised fixed reviewer and refuses unregistered, excluded or unknown routes', async () => {
    const { service } = await mount()

    const accepted = await enableFixed(service, 'deepseek', 'deepseek-flash', 'high')
    expect(accepted.ok).toBe(true)
    expect(accepted.status?.state).toBe('ready')

    const before = await statusOf(service)
    for (const [provider, model] of [
      ['ghost-provider', 'x'],
      ['minimax-official', 'MiniMax-M3'],
      ['huawei-maas', 'glm-5.2'],
      ['deepseek', 'not-a-model'],
    ] as [string, string][]) {
      const result = await enableFixed(service, provider, model)
      expect(result.ok, provider).toBe(false)
      expect(result.failure, provider).toBe('invalid-settings')
      expect(result.status?.preferences).toEqual(before.preferences)
    }

    // A fixed effort the adapter does not advertise is refused too.
    const badEffort = await enableFixed(service, 'deepseek', 'deepseek-flash', 'ultra')
    expect(badEffort.ok).toBe(false)
    expect(badEffort.failure).toBe('invalid-settings')
  })

  it('accepts an advertised decision model but refuses to use a normal reviewer as one', async () => {
    const { service } = await mount({
      routes: [
        ...DEFAULT_ROUTES,
        {
          provider: 'bamboo-startlux',
          name: 'BambooNode · StartLux',
          models: [
            { id: 'startlux-decision-27b-autothink', name: 'StartLux Decision 27B AutoThink' },
          ],
        },
      ],
    })
    const accepted = await enableDecision(service)
    expect(accepted.ok).toBe(true)
    expect(accepted.status?.preferences.reviewer.mode).toBe('decision')

    const current = await service.read()
    const rejected = await service.save({
      expectedRevision: current.revision,
      preferences: {
        ...current.preferences,
        reviewer: { mode: 'decision', route: { provider: 'deepseek', model: 'deepseek-flash' } },
      },
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.failure).toBe('invalid-settings')
  })

  it('rejects malformed preferences, a stale revision and an out-of-range bound', async () => {
    const { service } = await mount()
    const before = await statusOf(service)
    const base: AutoReviewPreferences = {
      enabled: true,
      reviewer: { mode: 'current' },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    }

    for (const preferences of [
      { ...base, timeoutMs: 10 },
      { ...base, timeoutMs: 120000 },
      { ...base, maxOutputTokens: 8 },
      { ...base, maxOutputTokens: 999999 },
      { ...base, reviewer: { mode: 'fixed', route: { provider: 'deepseek', model: '' } } },
      { ...base, extra: 1 },
    ] as unknown as AutoReviewPreferences[]) {
      const result = await service.save({ expectedRevision: before.revision, preferences })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure).toBe('invalid-settings')
    }

    const stale = await service.save({ expectedRevision: 'nope', preferences: base })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.failure).toBe('stale-settings')
  })

  it('uses the real settings revision, so an external move makes a read-then-save stale', async () => {
    const settings = createSettings()
    const { service } = await mount({ settings })
    const read = await statusOf(service)
    // Another surface commits between the read and the save.
    settings.moveRevision()

    const result = await service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, timeoutMs: 4500 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('stale-settings')
    expect((await statusOf(service)).revision).not.toBe(read.revision)
  })

  it('reports stale-settings when the settings surface reports a conflict', async () => {
    const settings = createSettings()
    const { service } = await mount({ settings })
    const read = await statusOf(service)
    settings.conflictNext()

    const result = await service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, timeoutMs: 4500 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('stale-settings')
  })

  it('refuses a save that changes the selection while a native agent is running', async () => {
    const session = createSession('session-running')
    const { service } = await mount({ session, agents: [liveAgent(session, 'running')] })
    const read = await statusOf(service)

    const result = await service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, timeoutMs: 4500 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('sessions-active')

    // An unchanged save is still accepted: nothing is being reconfigured.
    const same = await service.save({
      expectedRevision: read.revision,
      preferences: read.preferences,
    })
    expect(same.ok).toBe(true)
  })

  it('reports unavailable and never claims a memory-only save when the settings section is absent', async () => {
    const settings = { ...createSettings() }
    const bare = {
      describe: () => [{ ns: AUTO_REVIEW_OWNER_NS, value: {}, revision: 3 }],
      update: settings.update,
      configure: () => () => {},
    }
    const { service } = await mount({ settings: bare as unknown as SettingsStub })
    const read = await statusOf(service)

    expect(read.failure).toBe('unavailable')
    const result = await service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, enabled: true },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('unavailable')
  })

  it('keeps the gate, preset and selection intact when the settings write fails', async () => {
    const session = reviewableSession()
    const settings = createSettings()
    const { ctx, presets, service, llm } = await mount({ session, settings })
    const enabled = await enableFixed(service, 'deepseek', 'deepseek-flash')
    expect(enabled.ok).toBe(true)
    selectAuto(presets, session)

    const read = await statusOf(service)
    expect(presets.names).toContain(AUTO_PRESET)
    settings.failNext()
    // A selection change that is otherwise acceptable: only the settings write
    // can refuse it, and refusing it must leave everything as it was.
    const refused = await service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, timeoutMs: read.preferences.timeoutMs - 1000 },
    })

    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.failure).toBe('save-failed')
    // No drain happened: the preset is still published and the Session still
    // selects it, so the gate was never dropped.
    expect(presets.names).toContain(AUTO_PRESET)
    expect(presets.current(session)).toBe(AUTO_PRESET)
    expect((await statusOf(service)).preferences.enabled).toBe(true)

    // And the gate still reviews, which is the behaviour the failed write had
    // to leave untouched.
    const decision = await dispatch(ctx, pendingExec(session, CALL1))
    expect(decision).toEqual({ kind: 'allow' })
    expect(llm.probe.prepares).toHaveLength(1)
  })
})

describe('auto review decision gate', () => {
  it('reviews one native call and executes it on a low allow', async () => {
    const session = reviewableSession()
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)

    const decision = await dispatch(ctx, pendingExec(session, CALL1))

    expect(decision).toEqual({ kind: 'allow' })
    expect(llm.probe.prepares).toHaveLength(1)
    expect(llm.probe.prepares[0]).toMatchObject({
      provider: 'opl-gateway',
      model: 'codex::codex-auto-review',
      temperature: 0,
      maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    })
    const request = llm.probe.requests[0]!
    expect(request['tools']).toBeUndefined()
    expect(request['sessionId']).toBe(session.id)
    expect(request['purpose']).toBe('auto-review')
    expect(llm.probe.prepares[0]).not.toHaveProperty('sessionId')
    expect(llm.probe.prepares[0]).not.toHaveProperty('purpose')
    expect(String(request['system'])).toContain('REVIEW_POLICY')
  })

  it('does not inherit native chat effort into the dedicated reviewer', async () => {
    const session = createSession('session-auto')
    recordHeader(session, { reasoningEffort: 'high' })
    appendPrompt(session, 'm-1', 'go')
    beginStep(session)
    recordCall(session, { callId: 'call-1', arguments: '{}' })
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)

    await dispatch(ctx, pendingExec(session, { callId: 'call-1', arguments: {} }))

    expect(llm.probe.prepares[0]).toMatchObject({
      provider: 'opl-gateway',
      model: 'codex::codex-auto-review',
    })
  })

  it('fails closed instead of falling back when the current route is excluded', async () => {
    const session = createSession('session-auto')
    recordHeader(session, { provider: 'minimax-official', model: 'MiniMax-M3' })
    appendPrompt(session, 'm-1', 'go')
    beginStep(session)
    recordCall(session, { callId: 'call-1', arguments: '{}' })
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)

    const decision = await dispatch(ctx, pendingExec(session, { callId: 'call-1', arguments: {} }))

    expect(decision.kind).toBe('deny')
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('fails closed when the registration-bound preparation throws', async () => {
    const session = reviewableSession()
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)
    llm.failPrepare()

    const decision = await dispatch(ctx, pendingExec(session, CALL1))

    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).not.toContain('NO_ADAPTER')
  })

  it('denies a high-risk allow, extra fields, repeated members, bad JSON and truncation', async () => {
    const cases: { answer: string; reason: string }[] = [
      { answer: '{"risk":"high","decision":"allow"}', reason: 'protocol' },
      { answer: '{"risk":"low","decision":"allow","reason":"because"}', reason: 'protocol' },
      { answer: '{"risk":"low","risk":"low","decision":"allow"}', reason: 'repeats' },
      { answer: '{"risk":"low","decision":', reason: 'JSON' },
      { answer: 'Sure! {"risk":"low","decision":"allow"}', reason: 'JSON' },
    ]

    for (const testCase of cases) {
      const session = reviewableSession()
      const { ctx, presets, llm } = await mount({ session })
      selectAuto(presets, session)
      llm.answer(testCase.answer)

      const decision = await dispatch(ctx, pendingExec(session, CALL1))
      expect(decision.kind, testCase.answer).toBe('deny')
      if (decision.kind === 'deny')
        expect(decision.reason, testCase.answer).toContain('did not complete')
    }

    // A stream that stops for any reason other than `stop` is not a decision.
    const truncated = reviewableSession('session-truncated')
    const { ctx, presets, llm } = await mount({ session: truncated })
    selectAuto(presets, truncated)
    llm.answer(LOW_ALLOW)
    // Replace the terminal chunk by asking for an answer the parser never sees
    // completed: an empty text block yields no decidable object.
    llm.answer('')
    const decision = await dispatch(ctx, pendingExec(truncated, CALL1))
    expect(decision.kind).toBe('deny')
  })

  it('turns an explicit reviewer denial into an ask under ask, and a final denial under never', async () => {
    const asked = reviewableSession()
    const first = await mount({ session: asked })
    selectAuto(first.presets, asked)
    first.llm.answer('{"risk":"medium","decision":"deny","reason":"no authorization"}')

    const ask = await dispatch(first.ctx, pendingExec(asked, CALL1))
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') {
      expect(ask.reason).toContain('no authorization')
      expect(ask.displayReason?.zh).toContain('Auto review')
    }

    const denied = reviewableSession('session-never')
    const second = await mount({ session: denied })
    selectAuto(second.presets, denied)
    setApprovalPolicy(denied, 'never')
    second.llm.answer('{"risk":"medium","decision":"deny","reason":"no authorization"}')

    const final = await dispatch(second.ctx, pendingExec(denied, CALL1))
    expect(final.kind).toBe('deny')
    if (final.kind === 'deny') expect(final.info?.code).toBe('AUTO_REVIEW_DENIED')
  })

  it('respects another gate that denies, asks or cancels, and never upgrades it', async () => {
    for (const downstream of [
      { kind: 'deny', reason: 'other gate' },
      { kind: 'ask', reason: 'other gate asks' },
      { kind: 'cancel' },
    ] as PreToolDecision[]) {
      const session = reviewableSession()
      const { ctx, presets } = await mount({ session })
      selectAuto(presets, session)
      const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => downstream)
      expect(decision).toEqual(downstream)
    }
  })

  it('skips the outer run_code transport but reviews every started inner call', async () => {
    const session = createSession('session-ptc')
    recordHeader(session)
    appendPrompt(session, 'm-1', 'refactor')
    beginStep(session)
    recordCall(session, { callId: 'call-1', name: 'run_code', arguments: '{"code":"bash(1)"}' })
    recordPtcStart(session, {
      rootCallId: 'call-1',
      parentCallId: 'call-1',
      subCallId: 'call-1:ptc:1',
      arguments: { command: 'ls' },
    })
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)

    const outer = await dispatch(
      ctx,
      pendingExec(session, { callId: 'call-1', name: 'run_code', arguments: { code: 'bash(1)' } }),
    )
    expect(outer).toEqual({ kind: 'allow' })
    expect(llm.probe.prepares).toHaveLength(0)

    const inner = await dispatch(
      ctx,
      pendingExec(session, {
        callId: 'call-1:ptc:1',
        rootCallId: 'call-1',
        parent: true,
        arguments: { command: 'ls' },
        schema: {
          name: 'bash',
          description: 'Run one shell command',
          parameters: { type: 'object' },
        },
      }),
    )
    expect(inner).toEqual({ kind: 'allow' })
    expect(llm.probe.prepares).toHaveLength(1)
  })

  it('denies a PTC inner call whose logged action does not match exactly', async () => {
    const session = createSession('session-ptc')
    recordHeader(session)
    appendPrompt(session, 'm-1', 'refactor')
    beginStep(session)
    recordCall(session, { callId: 'call-1', name: 'run_code', arguments: '{"code":"bash(1)"}' })
    recordPtcStart(session, {
      rootCallId: 'call-1',
      parentCallId: 'call-1',
      subCallId: 'call-1:ptc:1',
      arguments: { command: 'ls' },
    })
    const { ctx, presets } = await mount({ session })
    selectAuto(presets, session)

    const decision = await dispatch(
      ctx,
      pendingExec(session, {
        callId: 'call-1:ptc:1',
        rootCallId: 'call-1',
        parent: true,
        arguments: { command: 'rm -rf /' },
        schema: {
          name: 'bash',
          description: 'Run one shell command',
          parameters: { type: 'object' },
        },
      }),
    )
    expect(decision.kind).toBe('deny')
  })

  it('blocks on timeout and on a stream that never finishes', async () => {
    const session = reviewableSession()
    const { ctx, presets, llm } = await mount({ session, config: { timeoutMs: 1000 } })
    selectAuto(presets, session)
    const release = llm.hold()

    const decision = await dispatch(ctx, pendingExec(session, CALL1))
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('deadline')
    release()
  }, 15000)

  it('cancels an in-flight review when the integration unloads', async () => {
    const session = reviewableSession()
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)
    const release = llm.hold()

    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => llm.probe.prepares.length === 1)
    ctx.fiber.dispose()
    const decision = await pending
    release()

    expect(decision.kind).toBe('cancel')
  })

  it('refuses a decision whose facts changed during the review, even at the same surface length', async () => {
    const session = reviewableSession()
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)
    const release = llm.hold()

    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => llm.probe.prepares.length === 1)
    // A second instruction of the same length: the surface grows, but the
    // authorization it carries is different.
    appendPrompt(session, 'm-2', 'wipe the repo')
    release()
    const decision = await pending

    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.info?.code).toBe('AUTO_REVIEW_STALE')
  })

  it('refuses an allow whose facts moved while the rest of the pipeline ran', async () => {
    const session = reviewableSession()
    const { ctx, presets } = await mount({ session })
    selectAuto(presets, session)

    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      // A model switch lands inside the downstream gate.
      session.append('request/header', {
        header: {
          config: { provider: 'deepseek', model: 'deepseek-flash' },
          tools: [
            { name: 'bash', description: 'Run one shell command', parameters: { type: 'object' } },
          ],
        },
        reason: 'change',
      })
      appendPrompt(session, 'm-9', 'and also do this')
      return { kind: 'allow' }
    })

    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.info?.code).toBe('AUTO_REVIEW_STALE')
  })

  it('refuses a decision whose selected configuration moved, even back to the same value', async () => {
    const session = reviewableSession()
    const settings = createSettings()
    const { ctx, presets } = await mount({ session, settings })
    selectAuto(presets, session)

    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      // An external write moves the settings revision; the value comes back to
      // what it was (ABA), which a content digest alone could not detect.
      settings.moveRevision()
      settings.moveRevision()
      return { kind: 'allow' }
    })

    expect(decision.kind).toBe('deny')
  })
})

describe('auto review durable record', () => {
  it('records the exact request and the fixed outcome around every review', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const { ctx, presets } = await mount({ session, ledger })
    selectAuto(presets, session)

    await dispatch(ctx, pendingExec(session, CALL1))

    expect(ledger.entries).toHaveLength(2)
    const begin = ledger.entries[0]!
    expect(begin['kind']).toBe('begin')
    expect(begin['sessionId']).toBe('session-auto')
    expect(begin['pending']).toMatchObject({
      turn: 1,
      step: 1,
      callId: 'call-1',
      rootCallId: 'call-1',
      mode: 'native',
      name: 'bash',
    })
    expect(begin['authorization']).toMatchObject({
      preset: AUTO_PRESET,
      sandbox: 'danger-full-access',
      approval: 'ask',
    })
    expect(begin['request']).toMatchObject({ system: expect.stringContaining('REVIEW_POLICY') })
    expect(String((begin['request'] as { messages: string }).messages)).toContain('PENDING_ACTION')
    expect(ledger.entries[1]).toMatchObject({
      kind: 'result',
      record: begin['record'],
      status: 'allow',
    })
  })

  it('does not execute a call whose review could not be recorded', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const { ctx, presets, llm } = await mount({ session, ledger })
    selectAuto(presets, session)
    ledger.failNext()
    let reached = 0

    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(reached).toBe(0)
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('recorded durably')
    // The reviewer was never even asked.
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('refuses to review when neither a ledger sink nor a storage facility is available', async () => {
    const session = reviewableSession()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('sessions', { get: () => session, list: () => [session] })
    const llm = createLlm(DEFAULT_ROUTES)
    ctx.provide('llm', llm)
    ctx.provide('shell', { sandboxMode: 'workspace-write' })
    ctx.provide('agents', { list: () => [] })
    ctx.provide('tools', {})
    ctx.provide('approval', {
      config: { policy: 'ask' },
      overrideOf: () => 'ask',
      setPolicy: () => {},
    })
    ctx.provide('settings', createSettings())
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(PermissionPresetService, {
      presets: {
        'workspace-write': {
          sandbox: 'workspace-write',
          approval: 'ask',
          name: 'w',
          description: '',
        },
        'danger-full-access': {
          sandbox: 'danger-full-access',
          approval: 'never',
          name: 'd',
          description: '',
        },
      },
    })
    ctx.provide(MAINTENANCE_SERVICE, createMaintenance())
    // No `oplAutoReviewLedger` sink and no `storageDomain` facility are
    // composed, which is the shape of a composition where the durable record
    // cannot be committed at all.
    await ctx.plugin(OplAutoReviewService, { ...DEFAULT_FLAT })
    const presets = (ctx as unknown as { permissionPresets: PermissionPresetService })
      .permissionPresets
    selectAuto(presets, session)
    let reached = 0

    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(reached).toBe(0)
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('recorded durably')
    // The reviewer was never asked, because the record could not be committed.
    expect(llm.probe.prepares).toHaveLength(0)
  })
})

describe('auto review lifecycle', () => {
  it('refuses to disable while an auto Session remains, then allows it after an explicit switch', async () => {
    const session = reviewableSession()
    const { presets, service } = await mount({ session })
    const enabled = await enableFixed(service, 'deepseek', 'deepseek-flash')
    expect(enabled.ok).toBe(true)
    selectAuto(presets, session)

    const current = await statusOf(service)
    expect(current.autoSessions).toBe(1)
    const refused = await service.save({
      expectedRevision: current.revision,
      preferences: { ...current.preferences, enabled: false },
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.failure).toBe('auto-sessions-remain')
      expect(refused.status.preferences.enabled).toBe(true)
    }
    expect(presets.current(session)).toBe(AUTO_PRESET)

    presets.set(session, 'workspace-write')
    const after = await statusOf(service)
    expect(after.autoSessions).toBe(0)
    const accepted = await service.save({
      expectedRevision: after.revision,
      preferences: { ...after.preferences, enabled: false },
    })
    expect(accepted.ok).toBe(true)
    if (accepted.ok) {
      expect(accepted.status.state).toBe('disabled')
      expect(presets.names).not.toContain(AUTO_PRESET)
    }
  })

  it('refuses a changed save while a review is in flight and reports the count', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, llm } = await mount({ session })
    selectAuto(presets, session)
    const release = llm.hold()

    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => llm.probe.prepares.length === 1)

    const inFlight = await statusOf(service)
    expect(inFlight.activeReviews).toBe(1)
    const changed = await service.save({
      expectedRevision: inFlight.revision,
      preferences: { ...inFlight.preferences, timeoutMs: 4500 },
    })
    expect(changed.ok).toBe(false)
    if (!changed.ok) expect(changed.failure).toBe('sessions-active')

    release()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await statusOf(service)).activeReviews).toBe(0)
  })

  it('narrows a pinned never approval to ask before auto disappears on unload', async () => {
    const session = reviewableSession()
    const { ctx, presets, service } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')
    expect(lastApprovalPolicy(session)).toBe('never')

    ctx.fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(lastApprovalPolicy(session)).toBe('ask')
    const presetsSeen = (
      session.snapshotEvents() as unknown as { type: string; data: Record<string, unknown> }[]
    )
      .filter((event) => event.type === 'permission/preset')
      .map((event) => event.data['preset'])
    expect(presetsSeen.at(-1)).toBe(AUTO_PRESET)
    expect(presetsSeen).not.toContain('danger-full-access')
  })

  it('never reports a conservative unload it could not write', async () => {
    const session = reviewableSession()
    const { ctx, presets, service } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')

    // The durable write refuses: the unload must not silently claim success.
    const attempts: string[] = []
    const realAppend = session.append.bind(session)
    ;(session as unknown as { append: unknown }).append = (type: string) => {
      if (type === 'approval/policy') {
        attempts.push('approval/policy')
        throw new Error('synthetic: durable write refused')
      }
      return realAppend(type as never, undefined as never)
    }

    ctx.fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(attempts).toEqual(['approval/policy'])
    // Nothing was narrowed, so nothing may be reported as safe either.
    expect(lastApprovalPolicy(session)).toBe('never')
  })

  it('leaves no residual gate behind after dispose', async () => {
    const session = reviewableSession()
    const { ctx, presets, llm } = await mount({ session })
    selectAuto(presets, session)

    ctx.fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const decision = await dispatch(ctx, pendingExec(session, CALL1))
    expect(decision).toEqual({ kind: 'allow' })
    expect(llm.probe.prepares).toHaveLength(0)
  })
})

/**
 * A storage-domain facility double whose open, put and close can each be held,
 * so the ledger's ownership across those windows is observable. The close is
 * never immediate: a double that resolves at once would hide the races this
 * exists to catch.
 */
function createDomainFacility() {
  const puts: { key: string; value: unknown }[] = []
  let opens = 0
  let closes = 0
  let closeEntered = 0
  let putsEntered = 0
  let openGate: Promise<void> | undefined
  let putGate: Promise<void> | undefined
  let closeGate: Promise<void> | undefined
  let releaseOpen: (() => void) | undefined
  let releasePut: (() => void) | undefined
  let releaseClose: (() => void) | undefined
  let openFailure: Error | undefined
  const table = {
    put: async (key: string, value: unknown) => {
      putsEntered += 1
      // The real backend accepts only ^[a-zA-Z0-9_-]+$ control keys.
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('synthetic: backend rejected control key')
      if (putGate !== undefined) await putGate
      puts.push({ key, value })
    },
  }
  const domain = {
    name: 'opl_auto_review',
    global: {},
    table: () => table,
    close: async () => {
      closeEntered += 1
      if (closeGate !== undefined) await closeGate
      closes += 1
    },
  }
  return {
    puts,
    get opens() {
      return opens
    },
    get closes() {
      return closes
    },
    get closeEntered() {
      return closeEntered
    },
    get putsEntered() {
      return putsEntered
    },
    holdOpen: () => {
      openGate = new Promise<void>((resolve) => {
        releaseOpen = resolve
      })
      return () => releaseOpen?.()
    },
    holdPut: () => {
      putGate = new Promise<void>((resolve) => {
        releasePut = resolve
      })
      return () => releasePut?.()
    },
    holdClose: () => {
      closeGate = new Promise<void>((resolve) => {
        releaseClose = resolve
      })
      return () => releaseClose?.()
    },
    rejectOpen: () => {
      openFailure = new Error('synthetic: backend open rejected')
    },
    facility: {
      open: async () => {
        opens += 1
        if (openFailure !== undefined) {
          const failure = openFailure
          openFailure = undefined
          throw failure
        }
        if (openGate !== undefined) await openGate
        // A real backend resolves asynchronously; the concurrency contract must
        // hold across that window.
        await new Promise((resolve) => setTimeout(resolve, 0))
        return domain
      },
    },
  }
}

/** One valid begin record, built through the shared schema. */
function beginRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'begin',
    seq: 1,
    record: 'k1',
    at: '2026-10-11T00:00:00.000Z',
    policyVersion: 'p1',
    sessionId: 'session-auto',
    selectionRevision: '1',
    reviewer: {
      mode: 'current',
      provider: 'deepseek',
      model: 'deepseek-flash',
      reasoningEffort: null,
      timeoutMs: 5000,
      maxOutputTokens: 4096,
    },
    pending: {
      turn: 1,
      step: 1,
      callId: 'call-1',
      rootCallId: 'call-1',
      mode: 'native',
      name: 'bash',
    },
    authorization: {
      preset: 'auto',
      sandbox: 'danger-full-access',
      approval: 'ask',
      surfaceLength: 3,
      sessionRoute: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: null },
    },
    request: { system: 'REVIEW_POLICY', messages: 'ENVIRONMENT' },
    ...overrides,
  }
}

describe('auto review settings publication transaction', () => {
  it('refuses the save and writes nothing when the exclusion is busy', async () => {
    const settings = createSettings()
    const maintenance = createMaintenance()
    const { service } = await mount({ settings, maintenance })
    const read = await statusOf(service)
    const before = settings.writes
    maintenance.failNext()

    const result = await service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, timeoutMs: 4500 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('sessions-active')
    expect(settings.writes - before).toBe(0)
  })

  it('refuses the save when the composition provides no exclusion at all', async () => {
    const settings = createSettings()
    const { service } = await mount({ settings, withoutMaintenance: true })
    const read = await statusOf(service)
    const before = settings.writes

    const result = await service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, timeoutMs: 4500 },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('unavailable')
    expect(settings.writes - before).toBe(0)
  })

  it('refuses the save when native activity begins during catalog resolution', async () => {
    const agents: AgentFixture[] = []
    const settings = createSettings()
    const { ctx, service } = await mount({ settings, agents })
    const read = await statusOf(service)

    const llm = ctx.llm as unknown as { listModels: (provider: string) => Promise<unknown> }
    const original = llm.listModels.bind(llm)
    let entered = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    llm.listModels = async (provider: string) => {
      entered = true
      await held
      return original(provider)
    }
    const before = settings.writes
    const pending = service.save({
      expectedRevision: read.revision,
      preferences: { ...read.preferences, timeoutMs: read.preferences.timeoutMs + 1000 },
    })
    await until(() => entered)
    // The agent starts while the exclusion is already held for validation.
    agents[0]!.status = 'running'
    release()
    const result = await pending

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('sessions-active')
    expect(settings.writes - before).toBe(0)
  })

  it('keeps an unchanged save working inside the exclusion', async () => {
    const session = createSession('session-running')
    const { service, maintenance } = await mount({
      session,
      agents: [liveAgent(session, 'running')],
    })
    const read = await statusOf(service)

    const result = await service.save({
      expectedRevision: read.revision,
      preferences: read.preferences,
    })

    expect(result.ok).toBe(true)
    expect(maintenance.runs).toBeGreaterThan(0)
  })
})

describe('auto review late result commit', () => {
  it('refuses an allow whose facts moved while the final result commit was held', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const original = ledger.append.bind(ledger)
    let commits = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    ledger.append = async (entry: Record<string, unknown>) => {
      if (entry['kind'] === 'result' && entry['status'] === 'allow') {
        commits += 1
        await held
      }
      await original(entry)
    }
    const { ctx, presets } = await mount({ session, ledger })
    selectAuto(presets, session)

    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => commits === 1)
    // A real instruction lands while the durable outcome is being committed.
    appendPrompt(session, 'late', 'do not run this tool')
    release()
    const decision = await pending

    expect(decision.kind).not.toBe('allow')
    if (decision.kind === 'deny') expect(decision.info?.code).toBe('AUTO_REVIEW_STALE')
    // The durable record never claims an executed allow: the first result is
    // amended by one that names the outcome that actually stood.
    const results = ledger.entries.filter((entry) => entry['kind'] === 'result')
    expect(results).toHaveLength(2)
    expect(results.at(-1)).toMatchObject({ status: 'stale', reviewer: 'allow' })
    // The amendment still names the begin record it belongs to, and it points
    // at the outcome it replaced.
    expect(results.at(-1)).toMatchObject({ record: results[0]!['record'] })
    expect(typeof results.at(-1)!['supersedes']).toBe('string')
  })

  it('records the real turn and step and separates the reviewer from execution', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const { ctx, presets } = await mount({ session, ledger })
    selectAuto(presets, session)
    await dispatch(ctx, pendingExec(session, CALL1))

    const result = ledger.entries[1]!
    expect(result['pending']).toMatchObject({ turn: 1, step: 1, callId: 'call-1', mode: 'native' })
    expect(result).toMatchObject({ reviewer: 'allow', status: 'allow' })
    // Distinct records never share a storage key.
    const seqs = ledger.entries.map((entry) => entry['seq'])
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('separates the reviewer decision from the outcome that actually stood', async () => {
    const asked = reviewableSession()
    const first = await mount({ session: asked, ledger: createLedger() })
    selectAuto(first.presets, asked)
    first.llm.answer('{"risk":"high","decision":"deny","reason":"exfiltration"}')

    const ask = await dispatch(first.ctx, pendingExec(asked, CALL1))

    // Under `ask` the reviewer's denial reaches the human instead of running.
    expect(ask.kind).toBe('ask')
    expect(first.ledger.entries.at(-1)).toMatchObject({
      reviewer: 'deny',
      status: 'ask',
      risk: 'high',
    })

    const denied = reviewableSession('session-never')
    const second = await mount({ session: denied, ledger: createLedger() })
    selectAuto(second.presets, denied)
    setApprovalPolicy(denied, 'never')
    second.llm.answer('{"risk":"high","decision":"deny","reason":"exfiltration"}')

    const final = await dispatch(second.ctx, pendingExec(denied, CALL1))

    expect(final.kind).toBe('deny')
    expect(second.ledger.entries.at(-1)).toMatchObject({
      reviewer: 'deny',
      status: 'deny',
      risk: 'high',
    })
  })
})

describe('auto review root guard', () => {
  /** Break the durable narrowing on one Session. */
  function breakNarrowing(session: Session): void {
    const original = session.append.bind(session)
    ;(session as unknown as { append: unknown }).append = (...args: unknown[]) => {
      if (args[0] === 'approval/policy') throw new Error('synthetic: durable narrowing failure')
      return original(...(args as Parameters<Session['append']>))
    }
  }

  it('keeps refusing after a Host-only unload whose durable narrowing failed', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')
    breakNarrowing(session)

    // Only the Host fiber goes away; the root, the permission service and every
    // Session stay exactly as they were.
    serviceFork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The catalog publication died with the Host, so the live resolution
    // degrades to the configured full/never preset; only the durable identity
    // still says `auto`.
    expect(presets.current(session)).not.toBe(AUTO_PRESET)

    let reached = 0
    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(reached).toBe(0)
    expect(decision.kind).toBe('deny')
    // Nothing was narrowed, so nothing may be reported as narrowed either.
    expect(lastApprovalPolicy(session)).toBe('never')
    expect(reviewLeaseOf(ctx)?.conservative).toBe(true)
  })

  it('refuses an unreadable permission state while the lease is conservative', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')
    breakNarrowing(session)
    serviceFork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The guard cannot rule the call out as non-auto, so it must refuse it.
    const original = presets.current.bind(presets)
    ;(presets as unknown as { current: unknown }).current = () => {
      throw new Error('synthetic: permission state unreadable')
    }
    let reached = 0
    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })
    ;(presets as unknown as { current: unknown }).current = original

    expect(reached).toBe(0)
    expect(decision.kind).toBe('deny')
  })

  it('leaves ordinary non-auto Sessions untouched while the lease is conservative', async () => {
    const auto = reviewableSession('session-auto')
    const plain = reviewableSession('session-plain')
    plain.append('permission/preset', { preset: 'workspace-write' })
    const { ctx, presets, service, serviceFork } = await mount({
      session: auto,
      extraSessions: [plain],
    })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, auto)
    setApprovalPolicy(auto, 'never')
    breakNarrowing(auto)
    serviceFork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    let reached = 0
    const decision = await dispatch(ctx, pendingExec(plain, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(reached).toBe(1)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('releases the lease only after a proven unload and reloads without stacking a guard', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')

    const lease = reviewLeaseOf(ctx)
    expect(lease).toBeDefined()
    serviceFork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The durable narrowing is the release condition, and it really happened.
    expect(lastApprovalPolicy(session)).toBe('ask')
    expect(lease?.conservative).toBe(false)

    // Reloading adopts the same lease instead of installing a second guard.
    await ctx.plugin(OplAutoReviewService, { ...DEFAULT_FLAT })
    expect(reviewLeaseOf(ctx)).toBe(lease)

    const plain = reviewableSession('session-plain')
    let reached = 0
    const decision = await dispatch(ctx, pendingExec(plain, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })
    expect(reached).toBe(1)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('cancels an in-flight review and still refuses afterwards when the unload cannot narrow', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork, llm } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')
    const release = llm.hold()
    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => llm.probe.prepares.length === 1)

    breakNarrowing(session)
    serviceFork.dispose()
    const decision = await pending
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(decision.kind).not.toBe('allow')
    let reached = 0
    const later = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })
    expect(reached).toBe(0)
    expect(later.kind).toBe('deny')
  })
})

describe('auto review storage domain ledger', () => {
  it('opens the review domain once under concurrent appends', async () => {
    const facility = createDomainFacility()
    const ledger = createDomainLedger(() => facility.facility as never)

    await Promise.all([
      ledger.append(beginRecord({ sessionId: 'a', seq: 1 }) as ReviewRecord),
      ledger.append(beginRecord({ sessionId: 'b', seq: 2 }) as ReviewRecord),
    ])

    expect(facility.opens).toBe(1)
    expect(facility.puts).toHaveLength(2)
    await ledger.close()
    expect(facility.closes).toBe(1)
  })

  it('stores a record the declared schema accepts and rejects one it does not', () => {
    expect(reviewRecordSchema.safeParse(beginRecord()).success).toBe(true)
    // A record missing its real identity, or one inventing an outcome, is not a
    // review fact the domain will persist.
    expect(reviewRecordSchema.safeParse(beginRecord({ pending: { turn: 0 } })).success).toBe(false)
    expect(reviewRecordSchema.safeParse(beginRecord({ seq: undefined })).success).toBe(false)
    const result = { ...beginRecord({ kind: 'result' }), reviewer: 'allow', status: 'executed' }
    expect(reviewRecordSchema.safeParse(result).success).toBe(false)
  })
})

describe('auto review storage key and backend contract', () => {
  /** The control-key grammar a real backing store accepts. */
  const CONTROL_KEY = /^[a-zA-Z0-9_-]+$/

  it('keeps every review key inside the backend control-key grammar', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const { ctx, presets } = await mount({ session, ledger })
    selectAuto(presets, session)

    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => ledger.entries.length === 2)
    await pending

    for (const entry of ledger.entries) {
      const key = reviewRecordKey(entry as ReviewRecord)
      expect(key, JSON.stringify(entry)).toMatch(CONTROL_KEY)
    }
    // A timestamp-and-separator key is exactly what a real backend refuses.
    expect(CONTROL_KEY.test('2026-10-11T00:00:00.000Z:session-auto:call-1:begin:1')).toBe(false)
  })

  it('is deterministic per review phase and distinct across phases and records', async () => {
    const one = beginRecord() as ReviewRecord
    const two = beginRecord({ seq: 2 }) as ReviewRecord
    const other = beginRecord({ sessionId: 'session-other' }) as ReviewRecord

    expect(reviewRecordKey(one)).toBe(reviewRecordKey(beginRecord() as ReviewRecord))
    expect(reviewRecordKey(one)).not.toBe(reviewRecordKey(two))
    expect(reviewRecordKey(one)).not.toBe(reviewRecordKey(other))
    // Identities that differ only by their separators must not collide.
    const colon = beginRecord({ pending: { ...one.pending, callId: 'a:b' } }) as ReviewRecord
    const plain = beginRecord({ pending: { ...one.pending, callId: 'a' } }) as ReviewRecord
    expect(reviewRecordKey(colon)).not.toBe(reviewRecordKey(plain))
  })

  it('refuses to record when no storage facility is composed', async () => {
    const ledger = createDomainLedger(() => undefined)
    await expect(ledger.append(beginRecord() as ReviewRecord)).rejects.toThrow(
      /storage domain facility/,
    )
  })

  it('surfaces a backend rejection instead of reporting a stored record', async () => {
    const facility = createDomainFacility()
    const ledger = createDomainLedger(() => facility.facility as never)
    // The facility double enforces the same grammar a real store does, so a key
    // that would be refused at the backend can never look stored here.
    await ledger.append(beginRecord() as ReviewRecord)
    expect(facility.puts[0]!.key).toMatch(CONTROL_KEY)

    const broken = {
      open: async () => ({
        name: 'opl_auto_review',
        table: () => ({
          put: async () => {
            throw new Error('synthetic: backend refused the write')
          },
        }),
        close: async () => {},
      }),
    }
    const refusing = createDomainLedger(() => broken as never)
    await expect(refusing.append(beginRecord() as ReviewRecord)).rejects.toThrow(/backend refused/)
  })
})

describe('auto review guard against a lost catalog', () => {
  it('keeps refusing a durably-auto Session after the permission catalog is gone', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork, presetFork } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')

    const original = session.append.bind(session)
    ;(session as unknown as { append: unknown }).append = (...args: unknown[]) => {
      if (args[0] === 'approval/policy') throw new Error('synthetic: narrowing failure')
      return original(...(args as Parameters<Session['append']>))
    }
    serviceFork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The whole permission catalog leaves the application: there is no live
    // resolution and no namespace left to look a reviewer up in.
    presetFork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))

    let reached = 0
    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(reached).toBe(0)
    expect(decision.kind).toBe('deny')
    // The Session's own durable identity is still `auto`; nothing rewrote it.
    let preset: string | undefined
    for (const event of session.snapshotEvents() as unknown as {
      type: string
      data: { preset?: string }
    }[]) {
      if (event.type === 'permission/preset') preset = event.data.preset
    }
    expect(preset).toBe(AUTO_PRESET)
  })
})

describe('auto review ledger ownership windows', () => {
  it('closes a domain whose initial open was pending when close began', async () => {
    const facility = createDomainFacility()
    const release = facility.holdOpen()
    const ledger = createDomainLedger(() => facility.facility as never)

    const writing = ledger.append(beginRecord() as ReviewRecord)
    await until(() => facility.opens === 1)
    const closing = ledger.close()
    // The close owns the pending open: it must not return while a handle is
    // still about to exist.
    expect(facility.closes).toBe(0)
    release()
    await Promise.allSettled([writing, closing])

    expect(facility.closes).toBe(1)
    await expect(ledger.append(beginRecord() as ReviewRecord)).rejects.toThrow(/closed/)
  })

  it('drains an in-flight append before closing the handle', async () => {
    const facility = createDomainFacility()
    const ledger = createDomainLedger(() => facility.facility as never)
    const release = facility.holdPut()

    const writing = ledger.append(beginRecord() as ReviewRecord)
    await until(() => facility.putsEntered === 1)
    const closing = ledger.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(facility.closes).toBe(0)
    expect(facility.puts).toHaveLength(0)
    release()
    await Promise.all([writing, closing])

    expect(facility.puts).toHaveLength(1)
    expect(facility.closes).toBe(1)
  })

  it('shares one completion across concurrent closes and stays idempotent', async () => {
    const facility = createDomainFacility()
    const ledger = createDomainLedger(() => facility.facility as never)
    await ledger.append(beginRecord() as ReviewRecord)

    const release = facility.holdClose()
    const first = ledger.close()
    const second = ledger.close()
    await until(() => facility.closeEntered === 1)
    // The close is genuinely pending: a double that resolves immediately would
    // hide the shared-completion race.
    expect(facility.closes).toBe(0)
    release()
    await Promise.all([first, second])
    await ledger.close()

    expect(facility.closeEntered).toBe(1)
    expect(facility.closes).toBe(1)
  })

  it('leaves no handle behind when the open is rejected, and never re-opens', async () => {
    const facility = createDomainFacility()
    const ledger = createDomainLedger(() => facility.facility as never)
    facility.rejectOpen()

    await expect(ledger.append(beginRecord() as ReviewRecord)).rejects.toThrow(
      /backend open rejected/,
    )
    expect(facility.opens).toBe(1)
    expect(facility.closes).toBe(0)

    // The failure is terminal for this ledger: no silent retry, no reopen.
    await expect(ledger.append(beginRecord() as ReviewRecord)).rejects.toThrow(
      /could not be opened/,
    )
    expect(facility.opens).toBe(1)

    await ledger.close()
    expect(facility.closes).toBe(0)
    await expect(ledger.append(beginRecord() as ReviewRecord)).rejects.toThrow(/closed/)
    expect(facility.opens).toBe(1)
  })
})

describe('auto review unload window', () => {
  /** Break the durable narrowing on one Session. */
  function breakNarrowing(session: Session): void {
    const original = session.append.bind(session)
    ;(session as unknown as { append: unknown }).append = (...args: unknown[]) => {
      if (args[0] === 'approval/policy') throw new Error('synthetic: narrowing failure')
      return original(...(args as Parameters<Session['append']>))
    }
  }

  it('refuses new auto calls during unload before an abort-ignoring stream settles', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork, llm } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')
    const release = llm.hold()
    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => llm.probe.requests.length === 1)
    breakNarrowing(session)

    serviceFork.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The unload is parked on the stream that ignores abort, and the
    // conservative protection is already in force: it is set before the first
    // await, so there is no window in which the gate is gone and the guard is
    // still passive.
    expect(reviewLeaseOf(ctx)?.conservative).toBe(true)

    let reached = 0
    let decision: PreToolDecision | undefined
    try {
      decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
        reached += 1
        return { kind: 'allow' }
      })
    } finally {
      release()
      await pending
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect({ reached, decision: decision?.kind }).not.toEqual({ reached: 1, decision: 'allow' })
    expect(reviewLeaseOf(ctx)?.conservative).toBe(true)
  })

  it('still refuses after the held stream finally settles, and never migrates the Session', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork, llm } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')
    const release = llm.hold()
    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => llm.probe.requests.length === 1)
    breakNarrowing(session)

    const unloading = Promise.resolve(serviceFork.dispose())
    release()
    await Promise.allSettled([pending, unloading])
    await new Promise((resolve) => setTimeout(resolve, 0))

    let reached = 0
    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })

    expect(reached).toBe(0)
    expect(decision.kind).toBe('deny')
    expect(lastApprovalPolicy(session)).toBe('never')
    const presetsSeen = (
      session.snapshotEvents() as unknown as { type: string; data: Record<string, unknown> }[]
    )
      .filter((event) => event.type === 'permission/preset')
      .map((event) => event.data['preset'])
    expect(presetsSeen).not.toContain('danger-full-access')
  })

  it('keeps ordinary Sessions on their own gate through the whole unload window', async () => {
    const auto = reviewableSession('session-auto')
    const plain = reviewableSession('session-plain')
    const { ctx, presets, service, serviceFork, llm } = await mount({
      session: auto,
      extraSessions: [plain],
    })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, auto)
    setApprovalPolicy(auto, 'never')
    const release = llm.hold()
    const pending = dispatch(ctx, pendingExec(auto, CALL1))
    await until(() => llm.probe.requests.length === 1)
    breakNarrowing(auto)
    serviceFork.dispose()

    let reached = 0
    const decision = await dispatch(ctx, pendingExec(plain, CALL1), async () => {
      reached += 1
      return { kind: 'allow' }
    })
    release()
    await pending

    expect(reached).toBe(1)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('releases the lease only after a successful narrow and drain', async () => {
    const session = reviewableSession()
    const { ctx, presets, service, serviceFork, llm } = await mount({ session })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')
    const release = llm.hold()
    const pending = dispatch(ctx, pendingExec(session, CALL1))
    await until(() => llm.probe.requests.length === 1)

    const unloading = Promise.resolve(serviceFork.dispose())
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Conservative while the stream is still open, even though narrowing will
    // succeed: the lease is released only after the drain.
    expect(reviewLeaseOf(ctx)?.conservative).toBe(true)
    release()
    await Promise.allSettled([pending, unloading])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(lastApprovalPolicy(session)).toBe('ask')
    expect(reviewLeaseOf(ctx)?.conservative).toBe(false)
  })

  it('refuses restoring a durable auto identity while its integration is not mounted', async () => {
    const session = reviewableSession()
    session.append('permission/preset', { preset: AUTO_PRESET })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    setApprovalPolicy(session, 'never')
    const before = session.snapshotEvents()
    const ledger = createLedger()

    // The official preset service refuses to publish a stored `auto` Session
    // without its live integration; that refusal is the expected fail-closed
    // behaviour, not something to work around.
    await expect(mount({ session, ledger, config: { enabled: false } })).rejects.toThrow(
      /permission: cannot restore preset "auto" without its active integration/,
    )
    expect(session.snapshotEvents()).toEqual(before)
    expect(ledger.entries).toHaveLength(0)
  })
})

describe('review failures retain durable outcomes', () => {
  it('records a downstream gate failure without exposing its error or allowing the call', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const { ctx, presets, service } = await mount({ session, ledger })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
      throw new Error('owned private downstream diagnostic')
    })
    expect(decision.kind).toBe('deny')
    expect(JSON.stringify(decision)).not.toContain('owned private')
    expect(ledger.entries).toHaveLength(2)
    expect(ledger.entries[1]).toMatchObject({ kind: 'result', reviewer: 'allow', status: 'deny' })
  })
  for (const [label, answer] of [
    ['malformed', '{broken'],
    ['invalid-protocol', '{"risk":"high","decision":"allow"}'],
  ] as const) {
    it(
      'records ' + label + ' as a refused call without an accepted reviewer decision',
      async () => {
        const session = reviewableSession()
        const ledger = createLedger()
        const { ctx, presets, service, llm } = await mount({ session, ledger })
        await enableFixed(service, 'deepseek', 'deepseek-flash')
        selectAuto(presets, session)
        llm.answer(answer)
        let bodies = 0
        const decision = await dispatch(ctx, pendingExec(session, CALL1), async () => {
          bodies++
          return { kind: 'allow' }
        })
        expect(bodies).toBe(0)
        expect(decision.kind).toBe('deny')
        expect(ledger.entries).toHaveLength(2)
        expect(ledger.entries[1]).toMatchObject({
          kind: 'result',
          reviewer: 'none',
          status: 'deny',
          record: ledger.entries[0]?.record,
        })
      },
    )
  }
  it('records prepare failure after its committed input', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const { ctx, presets, service, llm } = await mount({ session, ledger })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)
    llm.failPrepare()
    expect((await dispatch(ctx, pendingExec(session, CALL1))).kind).toBe('deny')
    expect(ledger.entries).toHaveLength(2)
    expect(ledger.entries[1]).toMatchObject({ kind: 'result', reviewer: 'none', status: 'deny' })
  })
})

/**
 * A first-party OpenAI/Codex route as the OPL Gateway advertises it, including
 * the dedicated reviewer the native route policy prefers. The reviewer
 * advertises only `medium`, so a chat effort it does not publish is dropped
 * rather than invented.
 */
const CODEX_ROUTES: RouteSpec[] = [
  {
    provider: 'opl-gateway',
    name: 'OPL Gateway',
    models: [
      {
        id: 'codex::gpt-6-sol',
        name: 'GPT-6 Sol',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
      {
        id: 'codex::codex-auto-review',
        name: 'Codex Auto Review',
        efforts: ['medium'],
        defaultEffort: 'medium',
      },
    ],
  },
]

/** The same Gateway catalog with the dedicated reviewer advertising `high`. */
const CODEX_ROUTES_WITH_HIGH: RouteSpec[] = [
  {
    provider: 'opl-gateway',
    name: 'OPL Gateway',
    models: [
      { id: 'codex::gpt-6-sol', name: 'GPT-6 Sol', efforts: ['high'], defaultEffort: 'high' },
      {
        id: 'codex::codex-auto-review',
        name: 'Codex Auto Review',
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ],
  },
]

/** An OpenAI/Codex Session whose own route is the Gateway's Codex family. */
function openAiSession(id = 'session-codex'): Session {
  const session = createSession(id)
  recordHeader(session, {
    provider: 'opl-gateway',
    model: 'codex::gpt-6-sol',
    reasoningEffort: 'high',
  })
  appendPrompt(session, 'm-1', 'tidy the workspace')
  beginStep(session)
  recordCall(session, { callId: 'call-1', arguments: '{"command":"ls"}' })
  return session
}

describe('auto review native route policy', () => {
  it('reviews a native OpenAI/Codex Session with the dedicated Gateway reviewer, tool-free', async () => {
    const session = openAiSession()
    const ledger = createLedger()
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES, ledger })
    selectAuto(presets, session)

    const decision = await dispatch(ctx, pendingExec(session, CALL1))

    expect(decision).toEqual({ kind: 'allow' })
    expect(llm.probe.prepares).toHaveLength(1)
    expect(llm.probe.prepares[0]).toMatchObject({
      provider: 'opl-gateway',
      model: 'codex::codex-auto-review',
      temperature: 0,
    })
    // A chat effort the dedicated reviewer does not advertise is dropped, never
    // invented and never carried over from the chat route.
    expect(llm.probe.prepares[0]!.reasoningEffort).toBeUndefined()
    const request = llm.probe.requests[0]!
    expect(request['tools']).toBeUndefined()
    expect(request['sessionId']).toBe(session.id)
    expect(request['purpose']).toBe('auto-review')
    expect(llm.probe.prepares[0]).not.toHaveProperty('sessionId')
    expect(llm.probe.prepares[0]).not.toHaveProperty('purpose')
    // The durable record names both the exact route and the rule that chose it.
    expect(ledger.entries[0]).toMatchObject({
      kind: 'begin',
      pending: { mode: 'native', step: 1 },
      reviewer: {
        mode: 'current',
        source: 'native-auto-review',
        provider: 'opl-gateway',
        model: 'codex::codex-auto-review',
        reasoningEffort: null,
      },
      authorization: { sessionRoute: { provider: 'opl-gateway', model: 'codex::gpt-6-sol' } },
    })
  })

  it('uses the reviewer default even when the chat effort is advertised', async () => {
    const session = openAiSession()
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES_WITH_HIGH })
    selectAuto(presets, session)

    await dispatch(ctx, pendingExec(session, CALL1))

    expect(llm.probe.prepares[0]).toMatchObject({
      provider: 'opl-gateway',
      model: 'codex::codex-auto-review',
    })
  })

  it('fails closed with a real diagnostic when the dedicated reviewer is not advertised', async () => {
    const session = openAiSession()
    const { ctx, presets, llm } = await mount({
      session,
      // The gateway registers, but publishes no codex-auto-review model.
      routes: [
        {
          provider: 'opl-gateway',
          name: 'OPL Gateway',
          models: [{ id: 'codex::gpt-6-sol', name: 'GPT-6 Sol', efforts: ['high'] }],
        },
      ],
    })
    selectAuto(presets, session)

    const decision = await dispatch(ctx, pendingExec(session, CALL1))

    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny')
      expect(decision.reason).toContain('dedicated OpenAI auto-review model')
    // No silent substitution onto the Session's own chat model.
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('fails closed when the Gateway provider itself is not registered', async () => {
    const session = openAiSession()
    const { ctx, presets, llm } = await mount({
      session,
      routes: DEFAULT_ROUTES.filter((route) => route.provider !== 'opl-gateway'),
    })
    selectAuto(presets, session)

    const decision = await dispatch(ctx, pendingExec(session, CALL1))

    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny')
      expect(decision.reason).toContain('dedicated OpenAI auto-review model')
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('uses the dedicated reviewer for native DeepSeek too', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const { ctx, presets, llm } = await mount({
      session,
      routes: [...CODEX_ROUTES, ...DEFAULT_ROUTES],
      ledger,
    })
    selectAuto(presets, session)

    await dispatch(ctx, pendingExec(session, CALL1))

    expect(llm.probe.prepares[0]).toMatchObject({
      provider: 'opl-gateway',
      model: 'codex::codex-auto-review',
    })
    expect(ledger.entries[0]).toMatchObject({
      reviewer: { mode: 'current', source: 'native-auto-review', provider: 'opl-gateway' },
    })
  })

  it('keeps an explicit fixed selection authoritative over the policy preference', async () => {
    const session = openAiSession()
    const { ctx, presets, llm, service } = await mount({
      session,
      routes: [...CODEX_ROUTES, ...DEFAULT_ROUTES],
    })
    await enableFixed(service, 'deepseek', 'deepseek-flash')
    selectAuto(presets, session)

    await dispatch(ctx, pendingExec(session, CALL1))

    expect(llm.probe.prepares[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
    })
  })
})

// ── External-Harness permission bridge ──────────────────────────────────────────────

/** A binding as a composition would read it out of a live ACP connection. */
function zcodeBinding(overrides: Partial<ExternalReviewBinding> = {}): ExternalReviewBinding {
  return {
    harness: 'zcode',
    callId: 'external-call-1',
    acpSessionId: 'acp-session-1',
    generation: 3,
    turn: 1,
    turnId: 'turn-op-1',
    action: { name: 'bash', parameters: { command: 'rm -rf build' } },
    authorization: {
      sessionId: 'session-auto',
      preset: 'auto',
      sandbox: 'full-access',
      combination: 'ofm-zcode-glm',
    },
    ...overrides,
  }
}

/** A recording binding port that answers each `bind` from a fixed sequence. */
interface BindingPortStub extends ExternalReviewBindingPort {
  readonly calls: number
}

function createBindingPort(sequence: readonly (ExternalReviewBinding | null)[]): BindingPortStub {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    bind: () => {
      calls += 1
      const index = Math.min(calls - 1, sequence.length - 1)
      return sequence[index] ?? null
    },
  } as unknown as BindingPortStub
}

/** The approval-waterfall payload one external Harness ask produces. */
function zcodeAsk(session: Session, toolName = 'zcode'): Record<string, unknown> {
  return {
    agent: { session } as unknown as Agent,
    toolName,
    callId: 'external-call-1',
    reason: 'ZCode · bash\nrm -rf build',
  }
}

/** Dispatch the real `approval/request` waterfall the approval service drives. */
async function dispatchApproval(
  ctx: Context,
  request: Record<string, unknown>,
  fallback: () => Promise<string> = async () => 'unavailable',
): Promise<string> {
  const waterfall = ctx as unknown as {
    waterfall(thisArg: unknown, name: string, ...args: unknown[]): Promise<string>
  }
  return await waterfall.waterfall(request['agent'], 'approval/request', request, fallback)
}

describe('auto review external Harness permission bridge', () => {
  it('does not borrow a different pending approval identity', async () => {
    const session = reviewableSession()
    const port = createBindingPort([zcodeBinding({ callId: 'other-call' })])
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)
    expect(await dispatchApproval(ctx, zcodeAsk(session))).toBe('unavailable')
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('sends durable human instructions with the exact external action', async () => {
    const session = reviewableSession()
    appendPrompt(
      session,
      'authorization',
      'Delete only the generated build folder; never delete source files.',
    )
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)
    expect(await dispatchApproval(ctx, zcodeAsk(session))).toBe('allowed-once')
    const serialized = JSON.stringify(llm.probe.requests[0])
    expect(serialized).toContain('Delete only the generated build folder')
    expect(serialized).toContain('human-instruction')
    expect(serialized).toContain('external-call-1')
  })

  it('rejects external allow if instructions change during durable result commit', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const append = ledger.append.bind(ledger)
    let entered = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    ledger.append = async (entry: Record<string, unknown>) => {
      if (entry['kind'] === 'result' && entry['status'] === 'allow') {
        entered = true
        await held
      }
      await append(entry)
    }
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets } = await mount({
      session,
      routes: CODEX_ROUTES,
      bindingPort: port,
      ledger,
    })
    selectAuto(presets, session)
    const pending = dispatchApproval(ctx, zcodeAsk(session))
    await until(() => entered)
    appendPrompt(session, 'revocation', 'Stop; do not delete the build folder.')
    release()
    expect(await pending).toBe('rejected')
    expect(ledger.entries.at(-1)).toMatchObject({ kind: 'result', status: 'stale' })
  })

  it('refuses to answer a ZCode ask when the composition offers no binding port', async () => {
    const session = reviewableSession()
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES })
    selectAuto(presets, session)

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    // The ask reached the ordinary answerer chain untouched, and no reviewer ran.
    expect(outcome).toBe('unavailable')
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('never claims an ask from a Harness this bridge does not own', async () => {
    const session = reviewableSession()
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)

    const outcome = await dispatchApproval(ctx, zcodeAsk(session, 'codex'))

    expect(outcome).toBe('unavailable')
    expect(port.calls).toBe(0)
  })

  it('never claims an ask for a Session that does not select auto', async () => {
    const session = reviewableSession()
    const port = createBindingPort([zcodeBinding()])
    const { ctx, llm } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    expect(outcome).toBe('unavailable')
    expect(port.calls).toBe(0)
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('never claims an ask whose Session pinned the closed never policy', async () => {
    const session = reviewableSession()
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)
    setApprovalPolicy(session, 'never')

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    expect(outcome).toBe('unavailable')
    expect(port.calls).toBe(0)
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('refuses a binding that is missing its connection generation', async () => {
    const session = reviewableSession()
    const incomplete = zcodeBinding({ generation: undefined as unknown as number })
    const port = createBindingPort([incomplete])
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    expect(outcome).toBe('unavailable')
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('claims one fully bound ask and answers it from the shared, tool-free reviewer', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets, llm } = await mount({
      session,
      routes: CODEX_ROUTES,
      ledger,
      bindingPort: port,
    })
    selectAuto(presets, session)

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    expect(outcome).toBe('allowed-once')
    expect(llm.probe.prepares[0]).toMatchObject({
      provider: 'opl-gateway',
      model: 'codex::codex-auto-review',
      temperature: 0,
    })
    expect(llm.probe.requests[0]).toMatchObject({
      sessionId: session.id,
      purpose: 'auto-review',
    })
    expect(llm.probe.requests[0]!['tools']).toBeUndefined()
    expect(llm.probe.prepares[0]).not.toHaveProperty('sessionId')
    expect(ledger.entries[0]).toMatchObject({
      kind: 'begin',
      pending: { mode: 'external-approval', name: 'bash', callId: 'external-call-1' },
      reviewer: { source: 'native-auto-review', provider: 'opl-gateway' },
    })
    expect(ledger.entries[1]).toMatchObject({
      kind: 'result',
      reviewer: 'allow',
      status: 'allow',
    })
  })

  it('rejects a bound ask whose reviewer denied it', async () => {
    const session = reviewableSession()
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)
    llm.answer('{"risk":"high","decision":"deny","reason":"irreversible"}')

    expect(await dispatchApproval(ctx, zcodeAsk(session))).toBe('rejected')
  })

  it('rejects when the ask moved before the reviewer was called', async () => {
    const session = reviewableSession()
    const port = createBindingPort([zcodeBinding(), zcodeBinding({ generation: 4 })])
    const { ctx, presets, llm } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    expect(outcome).toBe('rejected')
    expect(llm.probe.prepares).toHaveLength(0)
  })

  it('rejects an answer whose binding moved while the reviewer was answering', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const port = createBindingPort([
      zcodeBinding(),
      zcodeBinding(),
      zcodeBinding({ generation: 9 }),
    ])
    const { ctx, presets, llm } = await mount({
      session,
      routes: CODEX_ROUTES,
      ledger,
      bindingPort: port,
    })
    selectAuto(presets, session)

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    expect(outcome).toBe('rejected')
    expect(llm.probe.prepares).toHaveLength(1)
    expect(ledger.entries[1]).toMatchObject({
      kind: 'result',
      reviewer: 'none',
      status: 'stale',
      pending: { mode: 'external-approval' },
    })
  })

  it('rejects when the reviewer cannot run at all', async () => {
    const session = reviewableSession()
    const ledger = createLedger()
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets, llm } = await mount({
      session,
      routes: CODEX_ROUTES,
      ledger,
      bindingPort: port,
    })
    selectAuto(presets, session)
    llm.failPrepare()

    const outcome = await dispatchApproval(ctx, zcodeAsk(session))

    expect(outcome).toBe('rejected')
    expect(ledger.entries[1]).toMatchObject({ kind: 'result', reviewer: 'none', status: 'deny' })
  })

  it('leaves a native tool approval ask on the ordinary human chain', async () => {
    const session = reviewableSession()
    const port = createBindingPort([zcodeBinding()])
    const { ctx, presets } = await mount({ session, routes: CODEX_ROUTES, bindingPort: port })
    selectAuto(presets, session)
    let reached = 0

    const outcome = await dispatchApproval(ctx, zcodeAsk(session, 'bash'), async () => {
      reached += 1
      return 'rejected'
    })

    expect(outcome).toBe('rejected')
    expect(reached).toBe(1)
    expect(port.calls).toBe(0)
  })
})

describe('auto review RPC contract', () => {
  it('keeps the generated read/save codecs valid against the unchanged status DTO', async () => {
    const { TYPERT } = await import('../../src/generated/host.mjs')
    const invocations = (TYPERT as { invocations: { namespace: string; method: string }[] })
      .invocations
    const read = invocations.find(
      (item) => item.namespace === 'oplAutoReview' && item.method === 'read',
    ) as { result: { create(): { parse(value: unknown): unknown } } }
    const save = invocations.find(
      (item) => item.namespace === 'oplAutoReview' && item.method === 'save',
    ) as { parameters: { codec: { create(): { parse(value: unknown): unknown } } }[] }
    const { service } = await mount({ config: { enabled: false } })
    const status = await statusOf(service)

    // The unchanged wire contract still accepts the real status, and still
    // rejects a reviewer mode this build never generated.
    expect(read.result.create().parse(status)).toEqual(status)
    expect(() =>
      save.parameters[0]!.codec.create().parse({
        expectedRevision: '1',
        preferences: {
          enabled: true,
          reviewer: { mode: 'preferred' },
          timeoutMs: 5000,
          maxOutputTokens: 64,
        },
      }),
    ).toThrow()
  })
})
