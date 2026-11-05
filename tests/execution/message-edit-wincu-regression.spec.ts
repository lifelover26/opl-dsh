import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { HarnessSession, HarnessTurn } from '../../src/execution/contracts/sessions.ts'
import type { MessageEditSend } from '../../src/execution/contracts/message-edit.ts'
import { HarnessService } from '../../src/execution/host/harness.ts'
import {
  AcpProcess,
  HarnessRequestError,
  HarnessTransportError,
} from '../../src/execution/host/acp.ts'
import { openCodeStreamFailure } from '../../src/execution/host/adapters/opencode/stream-failure.ts'
import type {
  ExternalEditContext,
  ExternalMessageEditDriver,
} from '../../src/execution/host/message-edit-driver.ts'
import type {
  ExternalEditIntent,
  ExternalMessageEditTransactions,
} from '../../src/execution/host/message-edit-external.ts'
import type { FileExternalEditJournal } from '../../src/execution/host/message-edit-external-store.ts'
import { createOpenCodeMessageEditDriver } from '../../src/execution/host/message-edit-opencode.ts'
import { createKiloMessageEditDriver } from '../../src/execution/host/message-edit-kilo.ts'
import type {
  VendorControl,
  VendorMessage,
} from '../../src/execution/host/message-edit-opencode-common.ts'
import { testPeerConnection } from '../test-peer.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

interface FixtureActive {
  acp: Pick<AcpProcess, 'request' | 'closed' | 'dispose' | 'terminate' | 'cancel'>
  turn?: HarnessTurn | undefined
  cancelled?: boolean
  inputReceiptWrite?: Promise<void>
  inputReceiptError?: string
  approvals: Map<string, never>
  sessionInfo: { sessionId: string }
}

interface Owner {
  ready: Promise<void>
  records: Map<string, HarnessSession>
  active: Map<string, FixtureActive>
  externalEditJournal: FileExternalEditJournal
  externalMessageEdits: ExternalMessageEditTransactions
  externalDriver(record: HarnessSession): ExternalMessageEditDriver
  externalContext(record: HarnessSession, signal: AbortSignal): ExternalEditContext
  stopEditTarget(sessionId: string): { record: HarnessSession; harness: string } | undefined
  connectAdmitted(record: HarnessSession): Promise<void>
  openConnection(record: HarnessSession): Promise<void>
  pinSession(): Promise<void>
  syncNotification(): Promise<void>
  drainQueue(): void
  run(record: HarnessSession, active: FixtureActive, turn: HarnessTurn): Promise<void>
  update(record: HarnessSession, active: FixtureActive, value: unknown): void
  save(record: HarnessSession): Promise<void>
}

function messages(
  sessionId: string,
  inputId: string,
  text: string,
  completed = false,
): VendorMessage[] {
  return [
    {
      info: { id: inputId, sessionID: sessionId, role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text, sessionID: sessionId, messageID: inputId }],
    },
    {
      info: {
        id: inputId + '-reply',
        sessionID: sessionId,
        role: 'assistant',
        parentID: inputId,
        time: { created: 2, ...(completed ? { completed: 3 } : {}) },
        ...(completed ? { finish: 'stop' } : {}),
      },
      parts: [],
    },
  ]
}

async function fixture(harness: 'opencode' | 'kilo' = 'opencode') {
  const root = await mkdtemp(join(tmpdir(), 'opl-oc-recovery-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const session = Session.create(SessionId('wincu-recovery'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const user = createUserMessage({
    source: { kind: 'user', rpcId: 'quota-edit' },
    content: [{ type: 'text', text: 'replacement' }],
  })
  session.append('user/message', user, { surfaceOp: 'append' })
  const officialSeq = Number(session.seq) - 1
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', {
    turn: 1,
    reason: { kind: 'error', error: { code: 'HARNESS_FAILED', message: 'OpenCode quota failure' } },
  })
  const record: HarnessSession = {
    id: 'wincu-record',
    nativeSessionId: session.id,
    acpSessionId: 'ses_failed_edit',
    harnessRef: harness,
    modelRef: { provider: 'fixture', model: 'quota-model' },
    combination: 'fixture-' + harness,
    cwd: root,
    origin: { kind: 'dsh', sessionId: session.id },
    title: 'quota replacement',
    sandbox: 'full-access',
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    turns: [
      {
        operationId: 'message-edit:quota-edit',
        fingerprint: 'quota-edit',
        prompt: 'user: replacement',
        text: '',
        tools: [],
        state: 'failed',
        error: 'OpenCode 免费使用额度已达上限，已停止本轮请求；原任务未自动重发。',
        native: { officialSeq, userMessageId: 'msg_failed_edit' },
      },
    ],
  }
  const intent: ExternalEditIntent = {
    version: 1,
    sessionId: session.id,
    recordId: record.id,
    requestId: 'quota-edit',
    fingerprint: 'before-edit',
    previousSessionId: 'ses_original',
    targetId: 'msg_original',
    targetSeq: officialSeq,
    expected: {
      sessionId: 'ses_original',
      token: 'original-history',
      boundaries: [{ id: 'msg_original' }],
    },
    phase: 'prompting',
    result: { sessionId: record.acpSessionId, retained: [] },
  }
  const histories = new Map([
    [record.acpSessionId, messages(record.acpSessionId, 'msg_failed_edit', 'user: replacement')],
  ])
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
  const state = {
    status: 'idle' as 'idle' | 'busy',
    disconnectGate: undefined as Promise<void> | undefined,
    onDisconnect: undefined as (() => void) | undefined,
    withoutStatus: false,
    sessionAttached: true,
  }
  let nextFork = 1
  const startControl = async (): Promise<VendorControl> => ({
    ...(!state.withoutStatus
      ? {
          readStatus: async () => {
            calls.push('status')
            return state.status
          },
        }
      : {}),
    readMessages: async (id) => {
      calls.push('read:' + id)
      return structuredClone(histories.get(id) ?? [])
    },
    fork: async (id, inputId) => {
      calls.push('fork:' + id + ':' + inputId)
      const source = histories.get(id)!
      const target = source.findIndex((message) => message.info.id === inputId)
      if (target !== 0) throw Error('fixture only supports an exact empty-prefix fork')
      const sessionId = 'ses_retry_' + nextFork++
      histories.set(sessionId, [])
      return { sessionId }
    },
    close: async () => {
      calls.push('close')
    },
  })
  const driver =
    harness === 'opencode'
      ? createOpenCodeMessageEditDriver(startControl)
      : createKiloMessageEditDriver(startControl)
  let service: HarnessService
  let owner: Owner
  const acp: FixtureActive['acp'] = {
    closed: false,
    dispose: async () => {},
    terminate: vi.fn(async () => {}),
    cancel: vi.fn(),
    request: async (method, params) => {
      if (method === 'session/prompt') {
        const input = params as { sessionId: string; prompt: { text: string }[] }
        calls.push('prompt:' + input.sessionId)
        const inputId = 'msg_retry_' + nextFork
        histories.set(
          input.sessionId,
          messages(input.sessionId, inputId, input.prompt[0]!.text, true),
        )
        record.turns.at(-1)!.text = 'answer'
        return { stopReason: 'end_turn', userMessageId: inputId }
      }
      return { sessionId: record.acpSessionId }
    },
  }
  const active = (): FixtureActive => ({
    acp,
    approvals: new Map<string, never>(),
    sessionInfo: { sessionId: record.acpSessionId },
  })
  const prompt = vi.fn(async (input: MessageEditSend['prompt']) => {
    const replacement = createUserMessage({
      source: { kind: 'user', rpcId: input.requestId },
      content: input.content.flatMap((part) =>
        part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : [],
      ),
    })
    agent.inbox.nextTurn.push(replacement)
    await service.claimMessageEdit(agent as never, [replacement], 2, 1)
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    await service.commitMessageEdit(agent as never, 2, 1, new AbortController().signal)
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
    const current = owner.active.get(record.id)!
    current.turn = turn
    await owner.run(record, current, turn)
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    return { accepted: true as const }
  })
  const ctx = {
    connection: testPeerConnection,
    get: () => undefined,
    agents: { get: () => agent, list: () => [] },
    sessions: {
      get: (id: string) => (state.sessionAttached && id === session.id ? session : undefined),
      list: () => [],
      flush: async () => true,
    },
    sessionController: { resolveAgent: async () => ({ agent }), prompt },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  async function open() {
    service = new HarnessService(ctx, { home: root })
    owner = service as unknown as Owner
    const opened = service
    cleanups.push(() => opened.dispose())
    await owner.ready
    const persisted = owner.records.get(record.id)
    if (persisted) Object.assign(record, persisted)
    owner.records.set(record.id, record)
    vi.spyOn(owner, 'stopEditTarget').mockImplementation((id) =>
      id === session.id ? { record, harness } : undefined,
    )
    vi.spyOn(owner, 'externalDriver').mockReturnValue(driver)
    vi.spyOn(owner, 'pinSession').mockResolvedValue()
    vi.spyOn(owner, 'syncNotification').mockResolvedValue()
    vi.spyOn(owner, 'drainQueue').mockImplementation(() => {})
    vi.spyOn(owner, 'connectAdmitted').mockImplementation(async () => {
      if (!owner.active.has(record.id)) owner.active.set(record.id, active())
    })
    vi.spyOn(owner, 'openConnection').mockImplementation(async (allocation) => {
      allocation.acpSessionId = 'ses_empty_' + nextFork++
      histories.set(allocation.acpSessionId, [])
      owner.active.set(record.id, {
        ...active(),
        sessionInfo: { sessionId: allocation.acpSessionId },
      })
      calls.push('new:' + allocation.acpSessionId)
    })
    vi.spyOn(owner, 'externalContext').mockImplementation((current, signal) => ({
      record: current,
      signal,
      launch: { home: root, command: process.execPath, args: [], env: {} },
      transport: () => acp,
      snapshot: () => ({ agent: {}, session: {}, configOptions: [] }),
      disconnect: async () => {
        calls.push('disconnect')
        state.onDisconnect?.()
        await state.disconnectGate
        owner.active.delete(record.id)
        calls.push('disconnected')
      },
      reconnect: async () => {},
    }))
  }
  await open()
  await owner!.save(record)
  await owner!.externalEditJournal.save(intent)
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
    agent,
    histories,
    calls,
    state,
    prompt,
    driver,
    restart: async () => {
      await service.dispose()
      await open()
    },
  }
}

async function stepReceiptFixture() {
  const f = await fixture()
  f.record.harnessRef = 'step-code'
  const turn = f.record.turns[0]!
  turn.state = 'running'
  delete turn.native!.userMessageId
  await f.owner.connectAdmitted(f.record)
  const active = f.owner.active.get(f.record.id)!
  active.turn = turn
  active.cancelled = false
  const receipt = {
    sessionId: f.record.acpSessionId,
    update: {
      sessionUpdate: 'session_info_update',
      _meta: {
        'opl/stepInputId': 'step-exact-input',
        'opl/clientRequestId': turn.operationId,
      },
    },
  }
  return Object.assign(f, { active, turn, receipt })
}

it('persists an exact Step receipt before terminal response without claiming the prompt settled', async () => {
  const f = await stepReceiptFixture()
  f.owner.update(f.record, f.active, f.receipt)
  await f.active.inputReceiptWrite
  expect(f.turn.native).toMatchObject({ userMessageId: 'step-exact-input', officialSeq: 2 })
  expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('prompting')
  expect(f.active.acp.terminate).not.toHaveBeenCalled()
  f.active.turn = undefined
  f.turn.state = 'failed'
  await f.owner.save(f.record)
  await f.restart()
  expect(f.record.turns[0]!.native?.userMessageId).toBe('step-exact-input')
  expect(f.prompt).not.toHaveBeenCalled()
})

it('stops conflicting Step receipts and preserves their refusal after a late success and restart', async () => {
  const f = await stepReceiptFixture()
  f.active.acp.request = async (method) => {
    if (method === 'session/prompt') {
      f.owner.update(f.record, f.active, f.receipt)
      f.owner.update(f.record, f.active, {
        ...f.receipt,
        update: {
          ...f.receipt.update,
          _meta: { ...f.receipt.update._meta, 'opl/stepInputId': 'conflicting-step-input' },
        },
      })
      return { stopReason: 'end_turn' }
    }
    return {}
  }
  await f.owner.run(f.record, f.active, f.turn)
  expect(f.turn.native?.userMessageId).toBe('step-exact-input')
  expect(f.turn).toMatchObject({ state: 'failed', error: expect.stringContaining('相互冲突') })
  expect(f.turn.error).not.toContain('conflicting-step-input')
  expect(f.active.acp.terminate).toHaveBeenCalledTimes(1)
  await f.restart()
  expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('uncertain')
  expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
    pending: true,
    choices: [],
  })
  expect(f.prompt).not.toHaveBeenCalled()
})

it.each([
  'wrong-session',
  'wrong-operation',
  'old-active',
  'old-turn',
  'cancelled',
  'finished-turn',
  'wrong-harness',
  'missing-id',
  'wrong-active-session',
])('ignores an ineligible Step receipt for %s', async (reason) => {
  const f = await stepReceiptFixture()
  if (reason === 'wrong-session') f.receipt.sessionId = 'other-vendor'
  if (reason === 'wrong-operation')
    f.receipt.update._meta['opl/clientRequestId'] = 'other-operation'
  if (reason === 'old-active') f.owner.active.set(f.record.id, { ...f.active })
  if (reason === 'old-turn') f.record.turns.push({ ...f.turn, operationId: 'newer-operation' })
  if (reason === 'cancelled') f.active.cancelled = true
  if (reason === 'finished-turn') f.turn.state = 'failed'
  if (reason === 'wrong-harness') f.record.harnessRef = 'opencode'
  if (reason === 'missing-id') f.receipt.update._meta['opl/stepInputId'] = ''
  if (reason === 'wrong-active-session') f.active.sessionInfo.sessionId = 'other-vendor'
  f.owner.update(f.record, f.active, f.receipt)
  await f.active.inputReceiptWrite
  expect(f.turn.native?.userMessageId).toBeUndefined()
  expect(f.active.acp.terminate).not.toHaveBeenCalled()
  expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('prompting')
  f.owner.active.clear()
})

it.each([false, true])(
  'recovers the recorded quota edit only after owned cleanup and stable vendor history (completed=%s)',
  async (completedReply) => {
    const f = await fixture()
    f.histories.set(
      f.record.acpSessionId,
      messages(f.record.acpSessionId, 'msg_failed_edit', 'user: replacement', completedReply),
    )
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.state.onDisconnect = entered.resolve
    f.state.disconnectGate = release.promise
    let completed = false
    const read = f.service.messageEditState({ sessionId: f.session.id }).then((value) => {
      completed = true
      return value
    })
    await entered.promise
    expect(completed).toBe(false)
    expect(f.owner.externalMessageEdits.pending(f.session.id)).toBe(true)
    expect(f.prompt).not.toHaveBeenCalled()
    release.resolve()
    expect(await read).toMatchObject({
      pending: false,
      busy: false,
      choices: [{ seq: f.record.turns[0]!.native!.officialSeq, text: 'replacement' }],
    })
    expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('settled')
    expect(
      f.calls.filter((call) => call.startsWith('fork:') || call.startsWith('prompt:')),
    ).toEqual([])
    await f.restart()
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: false,
      choices: [{ text: 'replacement' }],
    })
    expect(f.prompt).not.toHaveBeenCalled()
  },
)

it.each(['opencode', 'kilo'] as const)(
  'forks before a persisted terminal failed input and sends its explicit replacement once (%s)',
  async (harness) => {
    const f = await fixture(harness)
    f.intent.phase = 'settled'
    f.record.turns[0]!.stopReason = 'error_response'
    await f.owner.externalEditJournal.save(f.intent)
    await f.owner.save(f.record)
    const oldSessionId = f.record.acpSessionId
    const original = structuredClone(f.histories.get(oldSessionId))
    const read = await f.service.messageEditState({ sessionId: f.session.id })
    const input: MessageEditSend = {
      targetSeq: read.choices[0]!.seq,
      head: read.head,
      prompt: {
        sessionId: f.session.id,
        requestId: 'explicit-retry' as never,
        mode: 'queue',
        content: [{ type: 'text', text: 'final replacement' }],
      },
    }
    expect(await f.service.messageEditSend(input)).toEqual({ accepted: true })
    expect(f.calls.filter((call) => call.startsWith('fork:'))).toEqual([
      'fork:' + oldSessionId + ':msg_failed_edit',
    ])
    expect(f.calls.filter((call) => call.startsWith('prompt:'))).toEqual([
      'prompt:' + f.record.acpSessionId,
    ])
    expect(f.record.acpSessionId).not.toBe(oldSessionId)
    expect(f.histories.get(oldSessionId)).toEqual(original)
    expect(
      f.histories
        .get(f.record.acpSessionId)
        ?.filter((item) => item.info.role === 'user')
        .map((item) => item.parts[0]!.text),
    ).toEqual(['user: final replacement'])
    expect(f.prompt).toHaveBeenCalledTimes(1)
    await expect(f.service.messageEditSend(input)).rejects.toThrow()
    const after = await f.service.messageEditState({ sessionId: f.session.id })
    await expect(
      f.service.messageEditSend({ ...input, head: after.head, targetSeq: after.choices[0]!.seq }),
    ).rejects.toThrow('发送身份已经使用')
    expect(f.prompt).toHaveBeenCalledTimes(1)
    expect(f.calls.filter((call) => call.startsWith('prompt:'))).toHaveLength(1)
    expect(f.calls.filter((call) => call.startsWith('fork:'))).toHaveLength(1)
  },
)

it.each(['opencode', 'kilo'] as const)(
  'rereads a settled terminal input instead of trusting an earlier cached history (%s)',
  async (harness) => {
    const f = await fixture(harness)
    f.intent.phase = 'settled'
    f.record.turns[0]!.stopReason = 'error_response'
    await f.owner.externalEditJournal.save(f.intent)
    await f.owner.save(f.record)
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: false,
      choices: [{ text: 'replacement' }],
    })
    const reads = f.calls.filter((call) => call.startsWith('read:')).length
    f.histories.set(
      f.record.acpSessionId,
      messages(f.record.acpSessionId, 'msg_foreign_input', 'user: replacement', true),
    )
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: true,
      choices: [],
    })
    expect(f.calls.filter((call) => call.startsWith('read:')).length).toBeGreaterThan(reads)
    await f.restart()
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: true,
      choices: [],
    })
    expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe('uncertain')
    await expect(f.service.assertConversationEditable(f.session.id)).rejects.toThrow('结果尚未确认')
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.calls.filter((call) => call.startsWith('fork:'))).toEqual([])
  },
)

it('offers an explicit fresh first edit after verified stopping without inventing a missing input id', async () => {
  const f = await fixture()
  delete f.record.turns[0]!.native!.userMessageId
  const oldSessionId = f.record.acpSessionId
  const original = structuredClone(f.histories.get(oldSessionId))
  const state = await f.service.messageEditState({ sessionId: f.session.id })
  expect(state).toMatchObject({ pending: false, choices: [{ text: 'replacement' }] })
  expect(f.record.turns[0]!.native!.userMessageId).toBeUndefined()
  expect(f.prompt).not.toHaveBeenCalled()
  expect(
    await f.service.messageEditSend({
      targetSeq: state.choices[0]!.seq,
      head: state.head,
      prompt: {
        sessionId: f.session.id,
        requestId: 'explicit-fresh' as never,
        mode: 'queue',
        content: [{ type: 'text', text: 'fresh input' }],
      },
    }),
  ).toEqual({ accepted: true })
  expect(f.record.acpSessionId).not.toBe(oldSessionId)
  expect(f.histories.get(oldSessionId)).toEqual(original)
  expect(f.calls.filter((call) => call.startsWith('fork:'))).toEqual([])
  expect(f.calls.filter((call) => call.startsWith('new:'))).toHaveLength(1)
  expect(f.calls.filter((call) => call.startsWith('prompt:'))).toEqual([
    'prompt:' + f.record.acpSessionId,
  ])
  expect(
    f.histories
      .get(f.record.acpSessionId)
      ?.filter((item) => item.info.role === 'user')
      .map((item) => item.parts[0]!.text),
  ).toEqual(['user: fresh input'])
})

it('keeps a stderr quota diagnostic distinct from a matched terminal response', async () => {
  const f = await fixture()
  const diagnostic =
    'level=ERROR message="stream error" session.id=ses_stderr small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached."'
  const program = `
    const { createInterface } = await import('node:readline')
    createInterface({ input: process.stdin }).on('line', () => {
      process.stderr.write(${JSON.stringify(diagnostic)} + '\\n')
    })
  `
  const process = new AcpProcess(
    globalThis.process.execPath,
    ['--input-type=module', '-e', program],
    f.record.cwd,
    {},
    () => {},
    () => {},
    () => {},
  )
  cleanups.push(() => process.dispose())
  const error: unknown = await process
    .request(
      'session/prompt',
      { sessionId: 'ses_stderr', prompt: [{ type: 'text', text: 'quota input' }] },
      5_000,
      {
        stderrFailure: (line) => openCodeStreamFailure(line, 'ses_stderr'),
      },
    )
    .catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(HarnessTransportError)
  expect(error).not.toBeInstanceOf(HarnessRequestError)
  expect((error as Error).message).toContain('额度已达上限')
  await process.dispose()
  expect(process.closed).toBe(true)
})

it('marks a known cold conversation retryable until official activation publishes its session', async () => {
  const f = await fixture()
  f.state.sessionAttached = false
  expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
    supported: false,
    busy: false,
    pending: true,
    head: -1,
    choices: [],
    unavailable: { reason: 'history-busy', retryable: true },
  })
  expect(f.calls).toEqual([])
  f.state.sessionAttached = true
  expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
    supported: true,
    pending: false,
    choices: [{ text: 'replacement' }],
  })
  expect(f.prompt).not.toHaveBeenCalled()
})

it('keeps an unknown cold session unsupported without advertising an engine or starting a CLI', async () => {
  const f = await fixture()
  expect(await f.service.messageEditState({ sessionId: 'unknown-session' })).toEqual({
    sessionId: 'unknown-session',
    supported: false,
    busy: false,
    pending: false,
    head: -1,
    choices: [],
  })
  expect(f.calls).toEqual([])
  expect(f.prompt).not.toHaveBeenCalled()
})

it.each([
  'uncertain',
  'invoking',
  'running',
  'busy',
  'wrong-parent',
  'missing-reply',
  'wrong-input',
  'terminal-wrong-input',
  'terminal-wrong-input-kilo',
  'terminal-wrong-operation',
  'terminal-wrong-seq',
  'terminal-wrong-rpc',
  'terminal-wrong-record',
  'terminal-wrong-session',
  'terminal-missing-status',
  'terminal-busy',
  'terminal-active-tool',
  'changed-history',
  'missing-status',
  'completed-without-status',
  'active-tool',
])('retains the durable send guard for %s', async (reason) => {
  const f = await fixture(reason === 'terminal-wrong-input-kilo' ? 'kilo' : 'opencode')
  const history = f.histories.get(f.record.acpSessionId)!
  const terminal = reason.startsWith('terminal-')
  if (terminal) {
    f.record.turns[0]!.stopReason = 'error_response'
    f.intent.phase = 'settled'
  }
  if (reason === 'uncertain' || reason === 'invoking') f.intent.phase = reason
  if (reason === 'running') f.agent.status = 'running'
  if (reason === 'busy') f.state.status = 'busy'
  if (reason === 'wrong-parent') history[1]!.info.parentID = 'some-other-user'
  if (reason === 'missing-reply') history.pop()
  if (['wrong-input', 'terminal-wrong-input', 'terminal-wrong-input-kilo'].includes(reason))
    f.record.turns[0]!.native!.userMessageId = 'conflicting-input'
  if (reason === 'terminal-wrong-operation') f.record.turns[0]!.operationId = 'message-edit:other'
  if (reason === 'terminal-wrong-seq') f.record.turns[0]!.native!.officialSeq = 999
  if (reason === 'terminal-wrong-rpc') {
    const events = f.session.snapshotEvents().map((event) =>
      event.type === 'user/message'
        ? {
            ...event,
            data: {
              ...event.data,
              source: { kind: 'user', rpcId: 'other-request' } as never,
            },
          }
        : event,
    )
    vi.spyOn(f.session, 'snapshotEvents').mockReturnValue(events)
  }
  if (reason === 'terminal-wrong-record') f.intent.recordId = 'other-record'
  if (reason === 'terminal-wrong-session') f.intent.result!.sessionId = 'other-vendor-session'
  if (reason === 'terminal-missing-status') f.state.withoutStatus = true
  if (reason === 'terminal-busy') f.state.status = 'busy'
  if (reason === 'terminal-active-tool')
    history[1] = { ...history[1]!, parts: [{ type: 'tool', state: { status: 'running' } }] }
  if (reason === 'changed-history')
    f.state.onDisconnect = () => {
      history[1] = {
        ...history[1]!,
        parts: [{ type: 'text', text: 'late update ' + f.calls.length }],
      }
    }
  if (reason === 'missing-status') f.state.withoutStatus = true
  if (reason === 'completed-without-status') {
    f.state.withoutStatus = true
    history[1]!.info.time = { created: 2, completed: 3 }
    history[1]!.info.finish = 'stop'
  }
  if (reason === 'active-tool') {
    history[1] = { ...history[1]!, parts: [{ type: 'tool', state: { status: 'running' } }] }
  }
  await f.owner.externalEditJournal.save(f.intent)
  await f.owner.save(f.record)
  for (const restart of [false, true]) {
    if (restart) await f.restart()
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: true,
      choices: [],
    })
    expect(f.owner.externalMessageEdits.intent(f.session.id)?.phase).toBe(
      terminal ? 'uncertain' : f.intent.phase,
    )
    if (reason.includes('wrong-input'))
      expect(f.record.turns[0]!.native!.userMessageId).toBe('conflicting-input')
    await expect(f.service.assertConversationEditable(f.session.id)).rejects.toThrow('结果尚未确认')
  }
  expect(f.prompt).not.toHaveBeenCalled()
  expect(f.calls.filter((call) => call.startsWith('fork:') || call.startsWith('prompt:'))).toEqual(
    [],
  )
})
