/** A held Step RPC fixture drives the real bridge and Host send guard; it makes no cloud calls. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { HarnessSession, HarnessTurn } from '../../src/execution/contracts/sessions.ts'
import type { MessageEditSend } from '../../src/execution/contracts/message-edit.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'
import type { AcpProcess } from '../../src/execution/host/acp.ts'
import { stepMessageEditDriver } from '../../src/execution/host/message-edit-step.ts'
import type {
  ExternalEditContext,
  ExternalEditHistory,
  ExternalMessageEditDriver,
} from '../../src/execution/host/message-edit-driver.ts'
import type {
  ExternalEditIntent,
  ExternalMessageEditTransactions,
} from '../../src/execution/host/message-edit-external.ts'
import type { FileExternalEditJournal } from '../../src/execution/host/message-edit-external-store.ts'
import { stepStorage } from '../../src/execution/host/adapters/step/step-config.ts'
import { STEP_MODEL_FREE } from '../../src/execution/host/adapters/step/step-models.ts'
import {
  startStepAgent,
  stepTempDir,
  stepTestCleanup,
  type StepAgent,
} from './ofm-step/fixtures/agent.ts'
import { testPeerConnection } from '../test-peer.ts'

vi.setConfig({ testTimeout: 30_000 })
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})
afterAll(stepTestCleanup)

interface Active {
  acp: AcpProcess
  turn?: HarnessTurn | undefined
  cancelled: boolean
  approvals: Map<string, never>
  sessionInfo: { sessionId: string }
}

interface Owner {
  ready: Promise<void>
  records: Map<string, HarnessSession>
  active: Map<string, Active>
  externalEditJournal: FileExternalEditJournal
  externalMessageEdits: ExternalMessageEditTransactions
  externalDriver(record: HarnessSession): ExternalMessageEditDriver
  externalContext(record: HarnessSession, signal: AbortSignal): ExternalEditContext
  stopEditTarget(): { record: HarnessSession; harness: string }
  connectAdmitted(record: HarnessSession): Promise<void>
  update(record: HarnessSession, active: Active, value: unknown): void
  pinSession(): Promise<void>
  syncNotification(): Promise<void>
  drainQueue(): void
  run(record: HarnessSession, active: Active, turn: HarnessTurn): Promise<void>
  save(record: HarnessSession): Promise<void>
}

async function fixture() {
  const home = stepTempDir('wincu-step-host-')
  const cwd = stepTempDir('wincu-step-workspace-')
  const storage = stepStorage(home)
  for (const path of Object.values(storage)) mkdirSync(path, { recursive: true })
  const scratch = join(home, 'tmp')
  mkdirSync(scratch, { recursive: true })
  const sourceId = 'wincu-step-original'
  const sourceFile = join(storage.sessionDir, 'original.jsonl')
  const modelProvider = 'opl-step-free-lane'
  const entry = (id: string, parentId: string | null, fields: object) => ({
    id,
    parentId,
    timestamp: '2026-11-04T00:00:00.000Z',
    ...fields,
  })
  const message = (role: string, content: string) => ({
    role,
    content,
    timestamp: 1,
    ...(role === 'assistant' ? { stopReason: 'stop' } : {}),
  })
  writeFileSync(
    sourceFile,
    [
      { type: 'session', version: 3, id: sourceId, cwd, timestamp: '2026-11-04T00:00:00Z' },
      entry('model', null, {
        type: 'model_change',
        provider: modelProvider,
        modelId: STEP_MODEL_FREE,
      }),
      entry('thinking', 'model', { type: 'thinking_level_change', thinkingLevel: 'high' }),
      entry('u1', 'thinking', { type: 'message', message: message('user', 'user: first request') }),
      entry('a1', 'u1', { type: 'message', message: message('assistant', 'first answer') }),
      entry('u2', 'a1', { type: 'message', message: message('user', 'user: old second request') }),
      entry('a2', 'u2', { type: 'message', message: message('assistant', 'old second answer') }),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  writeFileSync(
    join(storage.sessionIndexDir, sourceId + '.json'),
    JSON.stringify({ sessionFile: sourceFile }),
  )
  const env = {
    PATH: process.env.PATH ?? '',
    TEMP: scratch,
    TMP: scratch,
    OPL_STEP_COMMAND: process.execPath,
    OPL_STEP_PREFIX: JSON.stringify([
      fileURLToPath(new URL('./ofm-step/edit-rpc-fixture.mjs', import.meta.url)),
    ]),
    OPL_STEP_AGENT_DIR: storage.agentDir,
    OPL_STEP_CONFIG_ROOT: storage.configRoot,
    OPL_STEP_SESSION_DIR: storage.sessionDir,
    OPL_STEP_SESSION_INDEX_DIR: storage.sessionIndexDir,
    OPL_STEP_PROVIDER: modelProvider,
    OPL_STEP_MODEL: STEP_MODEL_FREE,
    OPL_STEP_BASE_URL: 'http://127.0.0.1:1/v1',
    OPL_STEP_API: 'openai-completions',
    OPL_STEP_REASONING: '1',
    OPL_STEP_THINKING: 'high',
    OPL_STEP_PRESET: '',
    STEPCODE_STORAGE_ROOT_DIR: storage.storageRoot,
  }
  const session = Session.create(SessionId('wincu-step-recovery'))
  const appendUser = (turn: number, requestId: string, text: string) => {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user', rpcId: requestId },
        content: [{ type: 'text', text }],
      }),
      { surfaceOp: 'append' },
    )
    return Number(session.seq) - 1
  }
  const firstSeq = appendUser(1, 'first-request', 'first request')
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const requestId = 'second-edit'
  const secondSeq = appendUser(2, requestId, 'second replacement')
  let service!: HarnessService
  let owner!: Owner
  let current: Active | undefined
  let runner!: StepAgent
  const drivers = stepMessageEditDriver()
  const start = async (sessionId?: string) => {
    runner = await startStepAgent({
      cwd,
      env,
      onUpdate: (value) => {
        if (current && owner) owner.update(record, current, value)
      },
    })
    await runner.acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    if (sessionId) await runner.acp.request('session/load', { sessionId, cwd, mcpServers: [] })
    const started = runner
    cleanups.push(() => started.dispose())
    return runner
  }
  const initial = await start(sourceId)
  const before = (await initial.acp.request('opl/edit/read', {
    sessionId: sourceId,
  })) as ExternalEditHistory
  const fork = (await initial.acp.request('opl/edit/rewind', {
    sessionId: sourceId,
    operationId: requestId,
    targetId: 'u2',
    expectedToken: before.token,
  })) as { sessionId: string; retained: { previousId: string; nextId: string }[] }
  const record: HarnessSession = {
    id: 'wincu-step-record',
    nativeSessionId: session.id,
    acpSessionId: fork.sessionId,
    harnessRef: 'step-code',
    modelRef: { provider: 'our-free-model', model: STEP_MODEL_FREE },
    combination: 'fixture-step',
    cwd,
    origin: { kind: 'dsh', sessionId: session.id },
    title: 'held second replacement',
    sandbox: 'full-access',
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z',
    turns: [
      {
        operationId: 'first-request',
        fingerprint: 'first-request',
        prompt: 'user: first request',
        text: 'first answer',
        tools: [],
        state: 'completed',
        native: { officialSeq: firstSeq, userMessageId: 'u1' },
      },
      {
        operationId: 'message-edit:' + requestId,
        fingerprint: requestId,
        prompt: 'user: second replacement',
        text: '',
        tools: [],
        state: 'running',
        native: { officialSeq: secondSeq },
      },
    ],
  }
  const intent: ExternalEditIntent = {
    version: 1,
    sessionId: session.id,
    recordId: record.id,
    requestId,
    fingerprint: 'before-edit',
    previousSessionId: sourceId,
    targetId: 'u2',
    targetSeq: secondSeq,
    expected: { sessionId: sourceId, token: before.token, boundaries: before.boundaries },
    phase: 'admitting',
    result: { sessionId: fork.sessionId, retained: fork.retained },
  }
  const state = {
    cleanupGate: undefined as Promise<void> | undefined,
    entered: undefined as (() => void) | undefined,
  }
  const calls: string[] = []
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx: { get: () => undefined },
    inbox: { nextTurn: [] as UserMessage[], nextStep: [], remove: vi.fn() },
    runMaintenance: async (fn: (signal: AbortSignal) => Promise<unknown>) =>
      fn(new AbortController().signal),
  }
  const makeActive = (): Active => ({
    acp: runner.acp,
    cancelled: false,
    approvals: new Map<string, never>(),
    sessionInfo: { sessionId: record.acpSessionId },
  })
  const prompt = vi.fn(async (input: MessageEditSend['prompt']) => {
    const replacement = createUserMessage({
      source: { kind: 'user', rpcId: input.requestId },
      content: input.content.filter((part) => part.type === 'text'),
    })
    agent.inbox.nextTurn.push(replacement)
    await service.claimMessageEdit(agent as never, [replacement], 3, 1)
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    await service.commitMessageEdit(agent as never, 3, 1, new AbortController().signal)
    session.append('user/message', replacement, { surfaceOp: 'append' })
    agent.inbox.nextTurn.length = 0
    const turn: HarnessTurn = {
      operationId: 'message-edit:' + input.requestId,
      fingerprint: input.requestId,
      prompt:
        'user: ' + input.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      text: '',
      tools: [],
      state: 'running',
      native: { officialSeq: Number(session.seq) - 1 },
    }
    record.turns.push(turn)
    current = owner.active.get(record.id)!
    current.turn = turn
    await owner.run(record, current, turn)
    session.append('step/end', { turn: 3, step: 1 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    return { accepted: true as const }
  })
  const ctx = {
    connection: testPeerConnection,
    get: () => undefined,
    agents: { get: () => agent, list: () => [] },
    sessions: { get: () => session, list: () => [], flush: async () => true },
    sessionController: { resolveAgent: async () => ({ agent }), prompt },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  async function open() {
    service = new HarnessService(ctx, { home })
    owner = service as unknown as Owner
    const opened = service
    cleanups.push(() => opened.dispose())
    await owner.ready
    const stored = owner.records.get(record.id)
    if (stored) Object.assign(record, stored)
    owner.records.set(record.id, record)
    vi.spyOn(owner, 'stopEditTarget').mockImplementation(() => ({ record, harness: 'step-code' }))
    vi.spyOn(owner, 'externalDriver').mockReturnValue(drivers)
    vi.spyOn(owner, 'pinSession').mockResolvedValue()
    vi.spyOn(owner, 'syncNotification').mockResolvedValue()
    vi.spyOn(owner, 'drainQueue').mockImplementation(() => {})
    vi.spyOn(owner, 'connectAdmitted').mockImplementation(async () => {
      if (!owner.active.has(record.id) || owner.active.get(record.id)!.acp.closed) {
        await start(record.acpSessionId)
        current = makeActive()
        owner.active.set(record.id, current)
      }
    })
    vi.spyOn(owner, 'externalContext').mockImplementation((currentRecord, signal) => ({
      record: currentRecord,
      signal,
      launch: { home, command: process.execPath, args: [], env },
      transport: () => owner.active.get(record.id)!.acp,
      snapshot: () => ({
        agent: {
          agentCapabilities: {
            _meta: {
              'opl/message-edit': {
                version: 1,
                methods: ['opl/edit/read', 'opl/edit/rewind'],
              },
            },
          },
        },
        session: {},
        configOptions: [],
      }),
      disconnect: async () => {
        calls.push('disconnect')
        state.entered?.()
        await state.cleanupGate
        await owner.active.get(record.id)?.acp.dispose()
        owner.active.delete(record.id)
        current = undefined
        calls.push('disconnected')
      },
      reconnect: async (sessionId) => {
        calls.push('reconnect:' + sessionId)
        await start(sessionId)
        current = makeActive()
        owner.active.set(record.id, current)
      },
    }))
  }
  await open()
  current = makeActive()
  current.turn = record.turns[1]!
  owner.active.set(record.id, current)
  await owner.save(record)
  await owner.externalEditJournal.save(intent)
  const knobs = (value: object) =>
    writeFileSync(join(storage.agentDir, 'edit-controls.json'), JSON.stringify(value))
  knobs({ holdPrompt: true })
  const running = owner.run(record, current, record.turns[1]!)
  await runner.waitForText('opl/stepInputId')
  await runner.acp.terminate('fixture no-progress deadline; original prompt was not retried')
  await running
  session.append('step/end', { turn: 2, step: 1 })
  session.append('turn/end', {
    turn: 2,
    reason: {
      kind: 'error',
      error: { code: 'HARNESS_FAILED', message: 'fixture no-progress deadline' },
    },
  })
  const commands = () =>
    readFileSync(join(storage.agentDir, 'edit-rpc-commands.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; entryId?: string })
  return {
    get service() {
      return service
    },
    get owner() {
      return owner
    },
    record,
    intent,
    session,
    state,
    calls,
    prompt,
    knobs,
    sourceFile,
    sessionFile: (sessionId: string) =>
      (
        JSON.parse(readFileSync(join(storage.sessionIndexDir, sessionId + '.json'), 'utf8')) as {
          sessionFile: string
        }
      ).sessionFile,
    commands,
    restart: async () => {
      await service.dispose()
      current = undefined
      await open()
    },
  }
}

it('recovers a second replacement after owned exit without inferring its input from position', async () => {
  const f = await fixture()
  const failed = f.record.turns[1]!
  expect(failed.state).toBe('failed')
  expect(failed.native?.userMessageId).toBeTruthy()
  expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('prompting')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.state.entered = entered.resolve
  f.state.cleanupGate = release.promise
  let finished = false
  const reading = f.service.messageEditState({ sessionId: f.session.id }).then((value) => {
    finished = true
    return value
  })
  await entered.promise
  expect(finished).toBe(false)
  expect(f.owner.externalMessageEdits.pending(f.session.id)).toBe(true)
  expect(f.prompt).not.toHaveBeenCalled()
  release.resolve()
  const recovered = await reading
  expect(recovered).toMatchObject({
    pending: false,
    busy: false,
    choices: [{ text: 'first request' }, { text: 'second replacement' }],
  })
  expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('settled')
  expect(f.commands().filter((command) => command.type === 'prompt')).toHaveLength(1)
  expect(f.commands().filter((command) => command.type === 'fork')).toHaveLength(1)
  await f.restart()
  expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
    pending: false,
    choices: [{ text: 'first request' }, { text: 'second replacement' }],
  })
  expect(f.prompt).not.toHaveBeenCalled()
})

it('keeps the old second-turn missing-id record blocked despite idle native history', async () => {
  const f = await fixture()
  delete f.record.turns[1]!.native!.userMessageId
  await f.owner.save(f.record)
  for (const restart of [false, true]) {
    if (restart) await f.restart()
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: true,
      busy: false,
      choices: [],
      unavailable: { reason: 'mapping-unavailable', retryable: false },
    })
    expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('prompting')
  }
  expect(f.calls).toEqual([])
  expect(f.commands().filter((command) => command.type === 'prompt')).toHaveLength(1)
  expect(f.commands().filter((command) => command.type === 'fork')).toHaveLength(1)
  expect(f.prompt).not.toHaveBeenCalled()
})

it('forks before the recovered second input and sends only its explicit replacement once', async () => {
  const f = await fixture()
  const source = readFileSync(f.sourceFile, 'utf8')
  const oldSessionId = f.record.acpSessionId
  const failedInputId = f.record.turns[1]!.native!.userMessageId!
  const failedFile = f.sessionFile(oldSessionId)
  const failedHistory = readFileSync(failedFile, 'utf8')
  const edit = await f.service.messageEditState({ sessionId: f.session.id })
  f.knobs({})
  const input: MessageEditSend = {
    targetSeq: edit.choices[1]!.seq,
    head: edit.head,
    prompt: {
      sessionId: f.session.id,
      requestId: 'explicit-second-retry' as never,
      mode: 'queue',
      content: [{ type: 'text', text: 'final second replacement' }],
    },
  }
  expect(await f.service.messageEditSend(input)).toEqual({ accepted: true })
  expect(f.record.acpSessionId).not.toBe(oldSessionId)
  expect(f.record.turns).toHaveLength(2)
  expect(f.record.turns[0]!.native?.userMessageId).toBe('u1')
  expect(f.record.turns[1]!.native?.userMessageId).toBeTruthy()
  expect(f.record.turns[1]!.native?.userMessageId).not.toBe(failedInputId)
  expect(f.record.turns[1]).toMatchObject({
    state: 'completed',
    stopReason: 'end_turn',
    text: 'fixture response',
  })
  expect(f.record.turns[1]!.error).toBeUndefined()
  expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('settled')
  expect(readFileSync(f.sourceFile, 'utf8')).toBe(source)
  expect(readFileSync(failedFile, 'utf8')).toBe(failedHistory)
  expect(
    f
      .commands()
      .filter((command) => command.type === 'fork')
      .map((command) => command.entryId),
  ).toEqual(['u2', failedInputId])
  expect(f.commands().filter((command) => command.type === 'prompt')).toHaveLength(2)
  expect(f.prompt).toHaveBeenCalledTimes(1)
  await expect(f.service.messageEditSend(input)).rejects.toThrow()
  expect(f.prompt).toHaveBeenCalledTimes(1)
  expect(f.commands().filter((command) => command.type === 'prompt')).toHaveLength(2)
})
