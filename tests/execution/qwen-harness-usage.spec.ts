import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { qwenCodeAdapter, QWEN_MODEL } from '../../src/execution/host/adapters/qwen/index.ts'
import { defaultExecutionCatalog, ExecutionCatalogStore } from '../../src/execution/host/catalog.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { HarnessSessionStore } from '../../src/execution/host/session-store.ts'
import { testPeerConnection } from '../test-peer.ts'

const roots: string[] = []
const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  const results = await Promise.allSettled(
    stops
      .splice(0)
      .reverse()
      .map((stop) => stop()),
  )
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  )
  for (const result of results) if (result.status === 'rejected') throw result.reason
})

it('projects Qwen request deltas per native turn and excludes restored ACP usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opl-qwen-harness-usage-'))
  roots.push(root)
  const home = join(root, 'host')
  const state = join(root, 'cli')
  const protocolCwd = join(root, 'protocol-workspace')
  await mkdir(state)
  const fixture = resolve('tests/execution/ofm-qwen/qwen-acp-agent.mjs')
  const ref = { provider: 'our-free-model', model: QWEN_MODEL }
  const combination = 'qwen-usage-fixture'
  const catalogStore = new ExecutionCatalogStore(home)
  try {
    const catalog = defaultExecutionCatalog()
    catalog.harnesses = [
      ...catalog.harnesses.filter((row) => row.id !== 'qwen-code'),
      {
        id: 'qwen-code',
        name: 'Qwen fixture',
        kind: 'acp',
        command: process.execPath,
        prefix: [fixture, state],
      },
    ]
    catalog.combinations.push({
      id: combination,
      name: 'Qwen usage fixture',
      modelRef: ref,
      harnessRef: 'qwen-code',
      permissionPolicy: 'full-access',
      isDefault: true,
      enabled: true,
    })
    await catalogStore.set(catalog)
  } finally {
    await catalogStore.dispose()
  }
  const nativeId = SessionId('native-qwen-session')
  const native = Session.create(nativeId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: nativeId,
    createdAt: 0,
    cwd: root,
    isSeeded: false,
    delegationDepth: 0,
  })
  const ctx = {
    connection: testPeerConnection,
    effect: (effect: () => () => void) => effect(),
    get: () => undefined,
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => native },
    permissionPresets: { current: () => 'danger-full-access' },
    waterfall: async (_event: unknown, _request: unknown, next: () => Promise<unknown[]>) => next(),
    llm: {
      listProviders: () => [{ id: ref.provider, name: 'OFM fixture' }],
      listConfigurableProviders: () => [],
      listModels: async () => [{ id: QWEN_MODEL, name: 'Qwen fixture' }],
    },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: ref } } }) },
    typertGateway: {
      invoke: async ({ method }: { method: string }) => {
        if (method === 'modelCatalog') return { default: ref, groups: [] }
        if (['selectModel', 'rename', 'cancel'].includes(method)) return {}
        throw Error(`Unexpected native invocation: ${method}`)
      },
    },
  } as unknown as Context
  vi.spyOn(qwenCodeAdapter, 'prepare').mockImplementation(async (_ctx, _record, options) => {
    if (options.command !== process.execPath || options.prefix?.[0] !== fixture)
      throw Error('Only the isolated Qwen ACP fixture can launch')
    return {
      home: options.home,
      acpCwd: protocolCwd,
      command: process.execPath,
      args: options.prefix,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        OPENAI_BASE_URL: 'https://qwen-usage-fixture.example.test/v1',
      },
    }
  })
  const configure = vi.spyOn(qwenCodeAdapter, 'configureSession')
  const open = () => {
    const service = new HarnessService(ctx, { home, command: process.execPath })
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      await service.dispose()
    }
    stops.push(stop)
    return { service, stop }
  }
  const stream = async (service: HarnessService, turn: number) => {
    native.append('turn/start', { turn })
    native.append('step/start', { turn, step: 1 })
    const chunks = await Array.fromAsync(
      service.conversationStream(
        {
          ...ref,
          sessionId: nativeId,
          messages: [
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: `turn ${turn}` }],
            }),
          ],
        } as GenerateOptions,
        async function* () {
          throw Error('Qwen route must not reach the native provider')
        },
      ),
    )
    native.append('step/end', { turn, step: 1 })
    native.append('turn/end', { turn, reason: { kind: 'completed' } })
    return chunks.filter((chunk) => chunk.type === 'usage')
  }
  const firstUsage = {
    inputTokens: 240,
    outputTokens: 60,
    totalTokens: 360,
    cacheReadTokens: 60,
    reasoningTokens: 10,
  }
  const secondUsage = {
    inputTokens: 590,
    outputTokens: 140,
    totalTokens: 840,
    cacheReadTokens: 110,
    reasoningTokens: 15,
  }
  const original = open()
  expect(await stream(original.service, 1)).toEqual([{ type: 'usage', usage: firstUsage }])
  const firstContext = await original.service.contextUsage({ sessionId: nativeId })
  expect(firstContext).toMatchObject({
    harness: 'qwen-code',
    usage: firstUsage,
    contextUsage: { used: 200, size: 128000 },
  })
  await original.stop()

  const records = new HarnessSessionStore(home)
  let record
  try {
    ;[record] = await records.load()
  } finally {
    await records.dispose()
  }
  const resumed = open()
  const loaded = await resumed.service.start({
    combination,
    cwd: root,
    taskId: 'qwen-usage',
    origin: { kind: 'dsh', sessionId: nativeId },
    sandbox: 'full-access',
    existingSessionId: record!.id,
  })
  expect(loaded.turns.map((turn) => turn.usage)).toEqual([firstUsage])
  expect(loaded.cwd).toBe(root)
  expect(native.header.cwd).toBe(root)
  expect(await stream(resumed.service, 2)).toEqual([{ type: 'usage', usage: secondUsage }])
  expect(await resumed.service.contextUsage({ sessionId: nativeId })).toMatchObject({
    harness: 'qwen-code',
    usage: secondUsage,
    contextUsage: { used: 400, size: 128000 },
  })
  expect(native.requestContext()).toEqual({ ...ref, contextWindow: 128000 })
  expect(
    (await resumed.service.snapshot({ sessionId: record!.id })).turns.map((turn) => turn.usage),
  ).toEqual([firstUsage, secondUsage])
  const journal = (await readFile(join(state, 'journal.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(journal.filter((row) => row.method === 'session/new')).toHaveLength(1)
  expect(journal.filter((row) => row.method === 'session/load')).toHaveLength(1)
  expect(
    journal
      .filter((row) => ['session/new', 'session/load'].includes(row.method))
      .map((row) => row.cwd),
  ).toEqual([protocolCwd, protocolCwd])
  expect(journal.filter((row) => row.method === 'session/prompt')).toHaveLength(2)
  expect(configure).toHaveBeenCalled()
})
