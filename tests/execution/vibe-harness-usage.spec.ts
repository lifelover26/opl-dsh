import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionLogOffset,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionFormatEvent, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessRequestError } from '../../src/execution/host/acp.ts'
import { vibeAdapter, VIBE_ALIAS, VIBE_MODEL } from '../../src/execution/host/adapters/vibe.ts'
import { defaultExecutionCatalog, ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { HarnessSessionStore } from '../../src/execution/host/session-store.ts'
import { testPeerConnection } from '../test-peer.ts'

const fixture = resolve('tests/execution/ofm-vibe-usage/fixtures/vibe-acp-agent.mjs')
const ref = { provider: 'our-free-model', model: VIBE_MODEL }
const combination = 'vibe-usage-fixture'
const roots: string[] = []
const stops: (() => Promise<void>)[] = []

afterEach(async () => {
  const stopped = await Promise.allSettled(
    stops
      .splice(0)
      .reverse()
      .map((stop) => stop()),
  )
  vi.restoreAllMocks()
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
  for (const result of stopped) if (result.status === 'rejected') throw result.reason
})

interface JournalEntry {
  method?: string
  event?: string
  params?: { configId?: string; value?: string; sessionId?: string }
}

/** Exercise the official physical codec and strict restore, including event relationships. */
async function restoreNative(session: Session, path: string): Promise<Session> {
  const rows = [
    sessionFormatCatalog.encodeCurrentHeader(
      JSON.parse(JSON.stringify(session.header)) as SessionFormatHeader,
      session.inheritedEventCount,
    ),
    ...session
      .snapshotEvents()
      .map((event) =>
        sessionFormatCatalog.encodeCurrentEvent(event as unknown as SessionFormatEvent),
      ),
  ]
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const [header, ...events] = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row))
  const restore = sessionFormatCatalog.createRestore(header, {
    recovery: 'strict',
    validation: 'current',
  })
  for (const event of events) restore.decodeRow(event)
  const artifact = restore.finish()
  return Session.fromRestore(
    SessionId(artifact.header.id),
    artifact.events as unknown as readonly SessionEvent[],
    artifact.header as unknown as SessionHeader,
    SessionLogOffset(artifact.inheritedEventCount),
    'detached',
  )
}

/** Deliver one already-decoded late ACP notification through the service's transport callback. */
function notifyContext(
  service: HarnessService,
  sessionId: string,
  size: number,
  counters = { input: 200, output: 40, cached: 60 },
) {
  const owner = service as unknown as {
    records: Map<string, { acpSessionId: string }>
    active: Map<string, unknown>
    update(record: unknown, active: unknown, value: unknown): void
  }
  const record = owner.records.get(sessionId)
  expect(record).toBeDefined()
  expect(owner.active.has(sessionId)).toBe(true)
  owner.update(record, owner.active.get(sessionId), {
    sessionId: record!.acpSessionId,
    update: {
      sessionUpdate: 'usage_update',
      used: 125,
      size,
      _meta: {
        promptTokens: counters.input,
        completionTokens: counters.output,
        cachedTokens: counters.cached,
        totalTokens: counters.input + counters.output,
      },
    },
  })
}

/** Keep the real transport and service; replace only the installed CLI launch. */
async function setup(mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'opl-vibe-harness-usage-'))
  roots.push(root)
  const home = join(root, 'host-state')
  const state = join(root, 'cli-state')
  await mkdir(state, { recursive: true })
  const prefix = [fixture, '--state', state, '--mode', mode]
  const store = new ExecutionCatalogStore(home)
  try {
    const catalog = defaultExecutionCatalog()
    catalog.harnesses = [
      ...catalog.harnesses.filter((item) => item.id !== 'vibe'),
      { id: 'vibe', name: 'Mistral Vibe fixture', kind: 'acp', command: process.execPath, prefix },
    ]
    catalog.combinations.push({
      id: combination,
      name: 'Vibe usage fixture',
      modelRef: ref,
      harnessRef: 'vibe',
      permissionPolicy: 'full-access',
      isDefault: true,
      enabled: true,
    })
    await store.set(catalog)
  } finally {
    await store.dispose()
  }

  const nativeId = SessionId('native-vibe-session')
  let nativeSession = Session.create(nativeId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: nativeId,
    createdAt: 0,
    cwd: root,
    isSeeded: false,
    delegationDepth: 0,
  })
  vi.spyOn(nativeSession, 'append')
  const ctx = {
    connection: testPeerConnection,
    effect: (effect: () => () => void) => effect(),
    get: () => undefined,
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => nativeSession },
    permissionPresets: { current: () => 'danger-full-access' },
    waterfall: async (_event: unknown, _request: unknown, next: () => Promise<unknown[]>) => next(),
    llm: {
      listProviders: () => [{ id: ref.provider, name: 'OFM fixture' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: VIBE_MODEL, name: 'Mistral Large 4 fixture' }],
    },
    sessionProjections: {
      snapshot: () => ({ values: { modelSelection: { next: ref } } }),
    },
    typertGateway: {
      invoke: async ({ method }: { method: string }) => {
        if (method === 'modelCatalog') return { default: ref, groups: [] }
        if (['selectModel', 'rename', 'cancel'].includes(method)) return {}
        throw Error(`Unexpected native invocation: ${method}`)
      },
    },
  } as unknown as Context
  const source = {
    provider: ref.provider,
    supports: (harness: string, candidate: typeof ref) =>
      harness === 'vibe' && candidate.provider === ref.provider && candidate.model === VIBE_MODEL,
    resolve: vi.fn(async () => ({
      baseURL: 'https://vibe-usage-fixture.example.test/v1',
      model: VIBE_MODEL,
      protocol: 'chat' as const,
      apiKey: 'vibe-usage-fixture-only',
      contextWindow: 131_072,
    })),
  }
  const checkpoint = Promise.withResolvers<void>()
  vi.spyOn(vibeAdapter, 'prepare').mockImplementation(async (_ctx, record, options) => {
    if (options.command !== process.execPath || options.prefix?.[0] !== fixture)
      throw Error('Only the isolated Vibe ACP fixture can launch here')
    const route = await options.modelSources!.resolve('vibe', record.modelRef, 'chat')
    if (route.model !== VIBE_MODEL) throw Error('Fixture model source changed')
    return {
      home: options.home,
      command: process.execPath,
      args: [...options.prefix],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      clientRequests: new Map([
        [
          'vibe-fixture/usage-observed',
          async () => {
            checkpoint.resolve()
            return {}
          },
        ],
      ]),
    }
  })

  const open = () => {
    const service = new HarnessService(ctx, { home, command: process.execPath })
    const removeSource = service.modelSources.register(ctx, source)
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      try {
        await service.dispose()
      } finally {
        removeSource()
      }
    }
    stops.push(stop)
    return { service, stop }
  }
  const start = (service: HarnessService, existingSessionId?: string, nativeSessionId?: string) =>
    service.start({
      combination,
      cwd: root,
      taskId: 'vibe-usage',
      origin: nativeSessionId
        ? { kind: 'dsh', sessionId: nativeSessionId }
        : { kind: 'desktop', sessionId: 'fixture-dispatcher' },
      sandbox: 'full-access',
      ...(existingSessionId ? { existingSessionId } : {}),
    })
  const ask = async (
    service: HarnessService,
    sessionId: string,
    text: string,
    operationId: string,
  ) => {
    await service.prompt({ sessionId, text, operationId })
    return service.wait({ sessionId, operationId }, AbortSignal.timeout(20_000))
  }
  const stream = (service: HarnessService, text: string) =>
    Array.fromAsync(
      service.conversationStream(
        {
          ...ref,
          sessionId: nativeSession.id,
          messages: [
            createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
          ],
        } as GenerateOptions,
        async function* () {
          throw Error('The native provider must not receive this Vibe route')
        },
      ),
    )
  const journal = async (): Promise<JournalEntry[]> =>
    (await readFile(join(state, 'journal.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const persisted = async () => {
    const records = new HarnessSessionStore(home)
    try {
      return await records.load()
    } finally {
      await records.dispose()
    }
  }
  return {
    root,
    open,
    start,
    ask,
    stream,
    journal,
    persisted,
    source,
    checkpoint,
    get nativeSession() {
      return nativeSession
    },
    restoreSession: (session: Session) => {
      nativeSession = session
    },
  }
}

const firstUsage = { inputTokens: 140, outputTokens: 40, totalTokens: 240, cacheReadTokens: 60 }
const nextUsage = { inputTokens: 200, outputTokens: 50, totalTokens: 350, cacheReadTokens: 100 }
const partialUsage = { inputTokens: 80, outputTokens: 20, totalTokens: 120, cacheReadTokens: 20 }

describe('Vibe usage through the real HarnessService', () => {
  it('streams and persists two distinct turns from an idle notification before new response', async () => {
    const test = await setup()
    const { service, stop } = test.open()
    const request = (text: string) =>
      ({
        ...ref,
        sessionId: test.nativeSession.id,
        messages: [
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
        ],
      }) as GenerateOptions
    const fallback = vi.fn(async function* () {
      throw Error('The native provider must not receive this Vibe route')
    })
    test.nativeSession.append('turn/start', { turn: 1 })
    test.nativeSession.append('step/start', { turn: 1, step: 1 })
    const first = await Array.fromAsync(service.conversationStream(request('first'), fallback))
    test.nativeSession.append('step/end', { turn: 1, step: 1 })
    test.nativeSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const secondOptions = request('second')
    test.nativeSession.append('turn/start', { turn: 2 })
    test.nativeSession.append('step/start', { turn: 2, step: 1 })
    const second = await Array.fromAsync(service.conversationStream(secondOptions, fallback))
    test.nativeSession.append('step/end', { turn: 2, step: 1 })
    test.nativeSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(first.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: firstUsage },
    ])
    expect(second.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: nextUsage },
    ])
    await Array.fromAsync(service.conversationStream(secondOptions, fallback))
    expect(fallback).not.toHaveBeenCalled()
    expect(await service.contextUsage({ sessionId: test.nativeSession.id })).toMatchObject({
      harness: 'vibe',
      provider: ref.provider,
      model: VIBE_MODEL,
      usage: nextUsage,
      contextUsage: { used: 122, size: 202_144, estimated: true },
    })
    expect(test.nativeSession.append).toHaveBeenCalledWith('request/context', {
      ...ref,
      contextWindow: 202_144,
    })
    const entries = await test.journal()
    expect(entries.filter((entry) => entry.method === 'session/prompt')).toHaveLength(2)
    expect(entries.filter((entry) => entry.method === 'session/new')).toHaveLength(1)
    expect(
      entries
        .filter((entry) => entry.method === 'session/set_config_option')
        .map((entry) => entry.params?.value),
    ).toEqual([VIBE_ALIAS, VIBE_ALIAS, VIBE_ALIAS])
    expect(test.source.resolve).toHaveBeenCalledExactlyOnceWith('vibe', ref)
    await stop()
    const [record] = await test.persisted()
    expect(record).toMatchObject({ harnessRef: 'vibe', modelRef: ref })
    expect(record?.turns.map((turn) => turn.usage)).toEqual([firstUsage, nextUsage])
    expect(record?.turns.map((turn) => turn.contextUsage)).toEqual([
      { used: 121, size: 202_144, estimated: true },
      { used: 122, size: 202_144, estimated: true },
    ])
    const resumed = await restoreNative(test.nativeSession, join(test.root, 'native-session.jsonl'))
    expect(resumed.requestContext()).toEqual({ ...ref, contextWindow: 202_144 })
  })

  it.each(['before-first-turn', 'after-closed-turn'])(
    'refuses a real official artifact with context written %s',
    async (placement) => {
      const root = await mkdtemp(join(tmpdir(), 'opl-vibe-invalid-context-'))
      roots.push(root)
      const id = SessionId('invalid-context-session')
      const session = Session.create(id, undefined, {
        version: SESSION_FORMAT_VERSION,
        id,
        createdAt: 0,
        isSeeded: false,
        delegationDepth: 0,
      })
      if (placement === 'after-closed-turn') {
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      }
      session.append('request/context', { ...ref, contextWindow: 202_144 })
      await expect(restoreNative(session, join(root, 'native-session.jsonl'))).rejects.toThrow(
        'request/context is outside an open turn',
      )
    },
  )

  it('restores native Session logs after idle new/load, open-turn updates and late closed-turn usage', async () => {
    const test = await setup()
    const original = test.open()
    const created = await test.start(original.service, undefined, test.nativeSession.id)
    expect(created.nativeSessionId).toBe(test.nativeSession.id)
    expect(test.nativeSession.snapshotEvents()).toEqual([])

    test.nativeSession.append('turn/start', { turn: 1 })
    test.nativeSession.append('step/start', { turn: 1, step: 1 })
    await test.stream(original.service, 'first')
    const completed = await original.service.snapshot({ sessionId: created.id })
    expect(completed.turns[0]?.usage).toEqual(firstUsage)
    expect(test.nativeSession.requestContext()).toEqual({ ...ref, contextWindow: 202_144 })
    notifyContext(original.service, created.id, 202_145)
    expect(test.nativeSession.requestContext()).toEqual({ ...ref, contextWindow: 202_145 })
    test.nativeSession.append('step/end', { turn: 1, step: 1 })
    test.nativeSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const closed = test.nativeSession.snapshotEvents()
    notifyContext(original.service, created.id, 202_146)
    expect(test.nativeSession.snapshotEvents()).toEqual(closed)
    expect(
      (await original.service.snapshot({ sessionId: created.id })).turns[0]?.contextUsage,
    ).toEqual({
      used: 125,
      size: 202_146,
      estimated: true,
    })
    await original.stop()

    test.restoreSession(
      await restoreNative(test.nativeSession, join(test.root, 'first-native.jsonl')),
    )
    const beforeLoad = test.nativeSession.snapshotEvents()
    const restored = test.open()
    const loaded = await test.start(restored.service, created.id, test.nativeSession.id)
    expect(loaded.acpSessionId).toBe(created.acpSessionId)
    expect(loaded.title).toBe('Vibe restored title')
    expect(loaded.turns[0]?.contextUsage).toEqual({ used: 121, size: 202_144, estimated: true })
    expect(test.nativeSession.snapshotEvents()).toEqual(beforeLoad)

    test.nativeSession.append('turn/start', { turn: 2 })
    test.nativeSession.append('step/start', { turn: 2, step: 1 })
    await test.stream(restored.service, 'second')
    const second = await restored.service.snapshot({ sessionId: created.id })
    expect(second.turns.map((turn) => turn.usage)).toEqual([firstUsage, nextUsage])
    expect(test.nativeSession.requestContext()).toEqual({ ...ref, contextWindow: 202_144 })
    test.nativeSession.append('step/end', { turn: 2, step: 1 })
    test.nativeSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await restored.stop()
    const resumed = await restoreNative(test.nativeSession, join(test.root, 'second-native.jsonl'))
    expect(
      resumed
        .snapshotEvents()
        .filter((event) => event.type === 'request/context')
        .map((event) => event.data),
    ).toEqual([
      { ...ref, contextWindow: 202_144 },
      { ...ref, contextWindow: 202_145 },
      { ...ref, contextWindow: 202_144 },
    ])
    const entries = await test.journal()
    expect(entries.filter((entry) => entry.method === 'session/new')).toHaveLength(1)
    expect(entries.filter((entry) => entry.method === 'session/load')).toHaveLength(1)
  })

  it('restores the exact session with early billing and title notifications before load response', async () => {
    const test = await setup()
    const original = test.open()
    const created = await test.start(original.service)
    await test.ask(original.service, created.id, 'first', 'first')
    await original.stop()

    const restored = test.open()
    const loaded = await test.start(restored.service, created.id)
    expect(loaded.acpSessionId).toBe(created.acpSessionId)
    expect(loaded.title).toBe('Vibe restored title')
    const completed = await test.ask(restored.service, created.id, 'second', 'second')
    expect(completed.turns.map((turn) => turn.usage)).toEqual([firstUsage, nextUsage])
    expect(test.source.resolve).toHaveBeenCalledTimes(2)
    const entries = await test.journal()
    expect(entries.filter((entry) => entry.method === 'session/load')).toHaveLength(1)
    expect(entries.find((entry) => entry.method === 'session/load')?.params?.sessionId).toBe(
      created.acpSessionId,
    )
    await restored.stop()
    const [record] = await test.persisted()
    expect(record?.title).toBe('Vibe restored title')
    expect(record?.turns.map((turn) => turn.usage)).toEqual([firstUsage, nextUsage])
  })

  it('replaces stale occupancy with a capacity-only restored bridge reading', async () => {
    const test = await setup('capacity-load')
    const original = test.open()
    const created = await test.start(original.service)
    const first = await test.ask(original.service, created.id, 'first', 'first')
    expect(first.turns[0]?.contextUsage?.used).toBe(121)
    await original.stop()

    const restored = test.open()
    const loaded = await test.start(restored.service, created.id)
    expect(loaded.turns[0]?.contextUsage).toEqual({ size: 202_144, estimated: true })
    await restored.stop()
    const [record] = await test.persisted()
    expect(record?.turns[0]?.contextUsage).toEqual({ size: 202_144, estimated: true })
  })

  it('withholds the first turn without an idle baseline and bills the following turn', async () => {
    const test = await setup('no-idle')
    const connection = test.open()
    const created = await test.start(connection.service)
    const first = await test.ask(connection.service, created.id, 'first', 'first')
    expect(first.turns[0]).not.toHaveProperty('usage')
    const second = await test.ask(connection.service, created.id, 'second', 'second')
    expect(second.turns[1]?.usage).toEqual(nextUsage)
    await connection.stop()
    const [record] = await test.persisted()
    expect(record?.turns[0]).not.toHaveProperty('usage')
    expect(record?.turns[1]?.usage).toEqual(nextUsage)
  })

  it('reloads persisted estimated occupancy above the CLI compaction threshold', async () => {
    const test = await setup('over-budget')
    const connection = test.open()
    const created = await test.start(connection.service)
    const completed = await test.ask(connection.service, created.id, 'first', 'first')
    expect(completed.turns[0]?.contextUsage).toEqual({
      used: 202_145,
      size: 202_144,
      estimated: true,
    })
    await connection.stop()
    const [record] = await test.persisted()
    expect(record?.turns[0]?.contextUsage).toEqual(completed.turns[0]?.contextUsage)
    const restored = test.open()
    await expect(test.start(restored.service, created.id)).resolves.toHaveProperty('id', created.id)
    const second = await test.ask(restored.service, created.id, 'second', 'second')
    expect(second.turns[1]?.usage).toEqual(nextUsage)
  })

  it('persists confirmed partial error spend and does not transfer the unknown remainder to another turn', async () => {
    const test = await setup()
    const connection = test.open()
    const created = await test.start(connection.service)
    const failed = await test.ask(connection.service, created.id, 'partial-error', 'failed')
    expect(failed.turns[0]).toMatchObject({ state: 'failed', usage: partialUsage })
    expect(failed.turns[0]?.contextUsage).toEqual({ used: 121, size: 202_144, estimated: true })
    const second = await test.ask(connection.service, created.id, 'second', 'second')
    expect(second.turns[1]).not.toHaveProperty('usage')
    const third = await test.ask(connection.service, created.id, 'third', 'third')
    expect(third.turns[2]?.usage).toEqual(nextUsage)
    await connection.stop()
    const [record] = await test.persisted()
    expect(record?.turns.map((turn) => turn.usage)).toEqual([partialUsage, undefined, nextUsage])
  })

  it('uses cancellation terminal counters once and keeps the next turn independent', async () => {
    const test = await setup()
    const connection = test.open()
    const created = await test.start(connection.service)
    await connection.service.prompt({
      sessionId: created.id,
      text: 'cancel',
      operationId: 'cancel',
    })
    await test.checkpoint.promise
    await connection.service.cancel({ sessionId: created.id })
    const cancelled = await connection.service.wait(
      { sessionId: created.id },
      AbortSignal.timeout(20_000),
    )
    expect(cancelled.turns[0]).toMatchObject({ state: 'cancelled', usage: partialUsage })
    const second = await test.ask(connection.service, created.id, 'second', 'second')
    expect(second.turns[1]?.usage).toEqual(nextUsage)
    await connection.stop()
    const [record] = await test.persisted()
    expect(record?.turns.map((turn) => turn.usage)).toEqual([partialUsage, nextUsage])
  })

  it('reconnects after transport loss and loads a fresh baseline without rebilling the failed turn', async () => {
    const test = await setup()
    const connection = test.open()
    const created = await test.start(connection.service)
    const failed = await test.ask(connection.service, created.id, 'disconnect', 'failed')
    expect(failed.turns[0]).toMatchObject({ state: 'failed', usage: partialUsage })
    const second = await test.ask(connection.service, created.id, 'second', 'second')
    expect(second.turns[1]?.usage).toEqual(nextUsage)
    const entries = await test.journal()
    expect(entries.filter((entry) => entry.event === 'exit-after-usage')).toHaveLength(1)
    expect(entries.filter((entry) => entry.method === 'session/prompt')).toHaveLength(2)
    expect(entries.filter((entry) => entry.method === 'session/load')).toHaveLength(1)
    await connection.stop()
    const [record] = await test.persisted()
    expect(record?.turns.map((turn) => turn.usage)).toEqual([partialUsage, nextUsage])
  })
})

describe('ACP prompt error statistics', () => {
  it('keeps only validated owned per-prompt usage from error data', () => {
    const data = {
      _meta: {
        'opl/turnUsage': { version: 1, usage: partialUsage },
        'opl/contextUsage': { used: 202_145, size: 202_144, estimated: true },
      },
    }
    expect(new HarnessRequestError('fixture', 'session/prompt', -32000, data).statistics).toEqual({
      usage: partialUsage,
      contextUsage: { used: 202_145, size: 202_144, estimated: true },
    })
    expect(new HarnessRequestError('fixture', 'session/load', -32000, data).statistics).toEqual({})
  })

  it('rejects malformed owned counts and unmarked cumulative error usage', () => {
    const malformed = {
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
      _meta: { 'opl/turnUsage': { version: 1, usage: { ...partialUsage, totalTokens: 119 } } },
    }
    expect(
      new HarnessRequestError('fixture', 'session/prompt', -32000, malformed).statistics,
    ).toEqual({})
  })
})
