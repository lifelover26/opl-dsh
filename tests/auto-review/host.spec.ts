/** Official native Auto plugin integration, OPL route transport and external approvals. */
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
import * as OfficialAutoReview from '@deepseek-ai/dsh-experimental-auto-review'
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

function createLlm(routes: RouteSpec[], ctx: Context): LlmStub {
  const probe: LlmProbe = { prepares: [], requests: [] }
  let answer = LOW_ALLOW
  let fail = false
  let held: Promise<void> | undefined
  let release: (() => void) | undefined
  const rawStream = (options: Record<string, unknown>) => {
    probe.requests.push(options)
    return (async function* () {
      if (held !== undefined) await held
      yield* chunksFor(answer)
    })()
  }
  const service = {
    stream: (options: Record<string, unknown>): AsyncIterable<StreamChunk> =>
      ctx.waterfall(
        service,
        'llm/stream',
        options as unknown as import('@deepseek-ai/dsh-llm').GenerateOptions,
        () => rawStream(options),
      ),
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
        stream: (options: Record<string, unknown>) => service.stream(options),
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
        Partial<FlatConfig> | undefined
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
  const llm = createLlm(options.routes ?? DEFAULT_ROUTES, ctx)
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
  ctx.provide('workingDirectory', { ensure: async (agent: Agent) => agent.session.header.cwd })
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
  const officialFork = await ctx.plugin(OfficialAutoReview)
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
    officialFork,
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

describe('official Auto Review ownership and OPL transport', () => {
  it('leaves the native gate and preset active when OPL routing is disabled', async () => {
    const session = reviewableSession()
    const f = await mount({ session, config: { enabled: false } })
    selectAuto(f.presets, session)
    expect(await dispatch(f.ctx, pendingExec(session, CALL1))).toEqual({ kind: 'allow' })
    expect(f.llm.probe.prepares).toHaveLength(0)
    expect(f.llm.probe.requests).toHaveLength(1)
    expect(f.llm.probe.requests[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      purpose: 'auto-review',
    })
    expect(f.ledger.entries).toHaveLength(0)
  })

  it('routes an official request once and preserves its policy and ordered messages', async () => {
    const session = reviewableSession()
    const f = await mount({ session })
    const observed: import('@deepseek-ai/dsh-llm').GenerateOptions[] = []
    f.ctx.on(
      'llm/stream',
      (options, next) => {
        observed.push(options)
        return next()
      },
      { prepend: true },
    )
    await enableFixed(f.service, 'deepseek', 'deepseek-flash', 'high')
    selectAuto(f.presets, session)
    expect(await dispatch(f.ctx, pendingExec(session, CALL1))).toEqual({ kind: 'allow' })
    expect(f.llm.probe.prepares).toHaveLength(1)
    expect(f.llm.probe.requests).toHaveLength(1)
    const request = f.llm.probe.requests[0]
    expect(observed).toHaveLength(2)
    expect(request.system).toBe(observed[0].system)
    expect(request.messages).toBe(observed[0].messages)
    expect(request.tools).toBeUndefined()
    expect(request).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      temperature: 0,
      purpose: 'auto-review',
    })
    expect(request.system).toContain('user-instruction')
    const messages = request.messages as { content: { text: string }[] }[]
    expect(messages.length).toBeGreaterThan(2)
    expect(messages[0].content[0].text).toContain('ENVIRONMENT')
    expect(messages.at(-1)!.content[0].text).toContain('tool-call')
    expect(f.ledger.entries.map((record) => record.kind)).toEqual([
      'native-request',
      'native-response',
    ])
    expect(f.ledger.entries[0]).toMatchObject({
      policyOwner: '@deepseek-ai/dsh-experimental-auto-review',
      request: { system: request.system, messages: JSON.stringify(request.messages) },
    })
    expect(f.ledger.entries[1]).toMatchObject({ status: 'finished', text: LOW_ALLOW })
  })

  it('keeps official deny/ask/never behavior and downstream refusal', async () => {
    const session = reviewableSession()
    const f = await mount({ session })
    await enableFixed(f.service, 'deepseek', 'deepseek-flash')
    selectAuto(f.presets, session)
    f.llm.answer('{"risk":"medium","decision":"deny","reason":"needs approval"}')
    expect(await dispatch(f.ctx, pendingExec(session, CALL1))).toMatchObject({ kind: 'ask' })
    expect(
      await dispatch(f.ctx, pendingExec(session, CALL1), async () => ({ kind: 'cancel' })),
    ).toEqual({ kind: 'cancel' })
    setApprovalPolicy(session, 'never')
    expect(await dispatch(f.ctx, pendingExec(session, CALL1))).toMatchObject({
      kind: 'deny',
      info: { code: 'AUTO_REVIEW_DENIED' },
    })
  })

  it('fails the official call when routing preparation or durable recording fails', async () => {
    for (const fail of ['prepare', 'ledger']) {
      const session = reviewableSession(`native-${fail}`)
      const f = await mount({ session })
      await enableFixed(f.service, 'deepseek', 'deepseek-flash')
      selectAuto(f.presets, session)
      if (fail === 'prepare') f.llm.failPrepare()
      else f.ledger.failNext()
      expect(await dispatch(f.ctx, pendingExec(session, CALL1))).toMatchObject({
        kind: 'deny',
        info: { code: 'AUTO_REVIEW_FAILED' },
      })
      expect(f.llm.probe.requests).toHaveLength(0)
    }
  })

  it('unloads only the OPL adapter and leaves official permissions and gate intact', async () => {
    const session = reviewableSession()
    const f = await mount({ session })
    await enableFixed(f.service, 'deepseek', 'deepseek-flash')
    selectAuto(f.presets, session)
    setApprovalPolicy(session, 'never')
    await f.serviceFork.dispose()
    expect(f.presets.current(session)).toBe('auto')
    expect(lastApprovalPolicy(session)).toBe('never')
    expect(await dispatch(f.ctx, pendingExec(session, CALL1))).toEqual({ kind: 'allow' })
    expect(f.llm.probe.prepares).toHaveLength(0)
  })

  it('allows disabling OPL routing while idle Auto sessions retain their official owner', async () => {
    const session = reviewableSession()
    const f = await mount({ session })
    await enableFixed(f.service, 'deepseek', 'deepseek-flash')
    selectAuto(f.presets, session)
    const current = await f.service.read()
    const result = await f.service.save({
      expectedRevision: current.revision,
      preferences: { ...current.preferences, enabled: false },
    })
    expect(result.ok).toBe(true)
    expect(f.presets.current(session)).toBe('auto')
    expect(await dispatch(f.ctx, pendingExec(session, CALL1))).toEqual({ kind: 'allow' })
    expect(f.llm.probe.prepares).toHaveLength(0)
  })
})

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
