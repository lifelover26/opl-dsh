import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarnessService } from '../../src/execution/host/harness.ts'
import { HarnessSessionStore } from '../../src/execution/host/session-store.ts'
import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import {
  NativeHarnessConversations,
  harnessRequestId,
} from '../../src/execution/host/native-conversations.ts'
import { testPeerConnection } from '../test-peer.ts'

function setup() {
  const sessions = new Map<string, Session>()
  const agents = new Map<string, any>()
  const create = vi.fn(async (options: any) => {
    const session = Session.create(options.sessionId, options.seed, {
      version: SESSION_FORMAT_VERSION,
      id: options.sessionId,
      createdAt: Date.now(),
      isSeeded: false,
      cwd: options.meta.cwd,
    })
    sessions.set(session.id, session)
    const agent = { session, status: 'idle', followup: vi.fn() }
    agents.set(session.id, agent)
    return { agent, dispose: vi.fn() }
  })
  const invoke = vi.fn(async () => ({}))
  const attachSession = vi.fn(async () => {})
  const permissionSet = vi.fn((session: Session, preset: string) => {
    session.append('permission/preset', { preset })
    setSandboxMode(session, preset as 'read-only' | 'workspace-write' | 'danger-full-access')
    setApprovalPolicy(session, preset === 'danger-full-access' ? 'never' : 'ask')
  })
  const ctx = {
    connection: testPeerConnection,
    get: (name: string) => (name === 'permissionPresets' ? { set: permissionSet } : undefined),
    effect: vi.fn(),
    sessions: { get: (id: string) => sessions.get(id), flush: vi.fn(async () => {}) },
    agents: { get: (id: string) => agents.get(id), create },
    sessionController: {
      resolveAgent: async (id: string) =>
        agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
    },
    workspaceRegistry: {
      create: vi.fn(async (path: string) => ({ id: 'workspace', path, attachSession })),
    },
    typertGateway: { invoke },
  } as unknown as Context
  const record: HarnessSession = {
    id: 'harness-history',
    combination: 'minimax-code/MiniMax-M3',
    harnessRef: 'minimax-code',
    modelRef: { provider: 'minimax-official', model: 'MiniMax-M3' },
    cwd: process.cwd(),
    origin: { kind: 'codex', sessionId: 'reviewer' },
    acpSessionId: 'mvs-original',
    title: '历史任务',
    sandbox: 'full-access',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [
      {
        operationId: 'initial',
        fingerprint: 'a',
        prompt: '原任务',
        text: '原回答',
        state: 'completed',
        tools: [{ id: 'bash1', title: 'bash', status: 'completed', kind: 'execute' }],
      },
      {
        operationId: 'followup',
        fingerprint: 'b',
        prompt: '原续作',
        text: '失败前输出',
        error: '真实失败',
        state: 'failed',
        tools: [],
      },
    ],
  }
  return {
    ctx,
    create,
    invoke,
    record,
    sessions,
    agents,
    bridge: new NativeHarnessConversations(ctx),
    permissionSet,
    attachSession,
  }
}

describe('ordinary official conversations for external tasks', () => {
  it('does not open already imported historical Sessions while restoring the task index', async () => {
    const { ctx, bridge, record } = setup()
    Object.assign(ctx, { logger: { warn: vi.fn() } })
    const resolveAgent = vi.spyOn(ctx.sessionController, 'resolveAgent')
    const root = await mkdtemp(join(tmpdir(), 'opl-bound-history-'))
    let service: HarnessService | undefined
    try {
      const store = new HarnessSessionStore(root)
      await store.saveChanged(
        Array.from({ length: 40 }, (_, i) => ({
          ...structuredClone(record),
          id: `history-${i}`,
          nativeSessionId: `session-history-${i}`,
        })),
      )
      service = new HarnessService(ctx, { home: root }, bridge)
      await service.sessions()
      expect(resolveAgent).not.toHaveBeenCalled()
      expect(ctx.workspaceRegistry.create).not.toHaveBeenCalled()
      expect(ctx.typertGateway.invoke).not.toHaveBeenCalled()
      expect(await store.load()).toHaveLength(40)
    } finally {
      await service?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores history without invoking the model picker or replacing a later user selection', async () => {
    const { ctx, bridge, record, invoke, sessions } = setup()
    Object.assign(ctx, { logger: { warn: vi.fn() } })
    const root = await mkdtemp(join(tmpdir(), 'opl-default-restore-'))
    let service: HarnessService | undefined
    try {
      const store = new HarnessSessionStore(root)
      await store.saveChanged([record])
      service = new HarnessService(ctx, { home: root }, bridge)
      await service.sessions()
      const session = sessions.get('session-' + record.id)!
      expect(
        session
          .snapshotEvents()
          .filter((e) => e.type === 'model/selection')
          .at(-1)?.data,
      ).toEqual(record.modelRef)
      expect(invoke.mock.calls.some(([request]) => request.method === 'selectModel')).toBe(false)
      await service.dispose()
      service = undefined
      session.append('model/selection', {
        provider: 'minimax-official',
        model: 'MiniMax-M3.1-Flash',
        reasoningEffort: 'high',
      } as never)
      const length = session.seq
      service = new HarnessService(ctx, { home: root }, bridge)
      await service.sessions()
      expect(session.seq).toBe(length)
      expect(invoke.mock.calls.some(([request]) => request.method === 'selectModel')).toBe(false)
      expect(
        session
          .snapshotEvents()
          .filter((e) => e.type === 'model/selection')
          .at(-1)?.data,
      ).toMatchObject({ model: 'MiniMax-M3.1-Flash', reasoningEffort: 'high' })
    } finally {
      await service?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['full-access', 'danger-full-access', 'never'],
    ['workspace', 'workspace-write', 'ask'],
    ['read-only', 'read-only', 'ask'],
  ] as const)(
    'creates %s with the official %s preset and its approval policy',
    async (sandbox, preset, approval) => {
      const { bridge, record, create, permissionSet } = setup()
      record.sandbox = sandbox
      await bridge.ensure(record, async () => {})
      expect(permissionSet).toHaveBeenCalledWith(expect.any(Session), preset)
      const seed = create.mock.calls[0]![0].seed
      expect(seed.filter((e: any) => e.type === 'permission/preset').at(-1)?.data).toEqual({
        preset,
      })
      expect(seed.filter((e: any) => e.type === 'approval/policy').at(-1)?.data).toEqual({
        policy: approval,
      })
    },
  )
  it('imports historical turns before driver creation without executing them and preserves all original identities', async () => {
    const { bridge, record, create, sessions, attachSession, invoke } = setup()
    const original = structuredClone(record)
    const persist = vi.fn(async () => {})
    await Promise.all([bridge.ensure(record, persist), bridge.ensure(record, persist)])
    expect(create).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(record).toEqual({ ...original, nativeSessionId: 'session-harness-history' })
    expect(attachSession).toHaveBeenCalledExactlyOnceWith('session-harness-history')
    expect(invoke.mock.calls.some(([request]) => request.method === 'create')).toBe(false)
    const seed = create.mock.calls[0]![0].seed
    expect(seed.find((event: any) => event.surfaceOp)?.type).toBe('system/message')
    const imported = sessions.get(record.nativeSessionId!)!
    const head = imported.snapshotEvents().find((event) => event.type === 'system/message')!
    imported.append('turn/start', { turn: 3 })
    imported.append('step/start', { turn: 3, step: 1 })
    imported.append(
      'system/message',
      {
        turn: 3,
        step: 1,
        message: head.data.message,
      },
      {
        surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq },
        sourceEventSeqs: [head.seq],
      },
    )
    expect(
      seed
        .filter((event: any) => event.type === 'turn/end')
        .map((event: any) => event.data.reason.kind),
    ).toEqual(['completed', 'error'])
    const session = sessions.get(record.nativeSessionId!)!
    const messages = session
      .snapshotEvents()
      .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    expect(
      messages.map((event) =>
        event.type === 'user/message' ? event.data.content[0] : event.data.message.content[0],
      ),
    ).toEqual([
      { type: 'text', text: '原任务' },
      {
        type: 'text',
        text: '原回答\n\n历史工具记录（原记录只保存名称和状态）：\nbash · completed',
      },
      { type: 'text', text: '原续作' },
      { type: 'text', text: '失败前输出\n\n真实失败' },
    ])
    const length = session.seq
    await bridge.ensure(record, persist)
    expect(session.seq).toBe(length)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('does not migrate an active turn or replace a conflict with a new identity', async () => {
    const { bridge, record, create } = setup()
    record.turns[0]!.state = 'running'
    await expect(bridge.ensure(record, async () => {})).rejects.toThrow('活动外部会话不能迁移')
    expect(create).not.toHaveBeenCalled()
  })

  it('preserves a human permission change when reopening an already bound conversation', async () => {
    const { bridge, record, sessions } = setup()
    await bridge.ensure(record, async () => {})
    const session = sessions.get(record.nativeSessionId!)!
    setSandboxMode(session, 'read-only')
    const length = session.seq
    await bridge.ensure(record, async () => {})
    expect(session.seq).toBe(length)
  })

  it('records real ACP tool input and output once without executing the tool itself', async () => {
    const { bridge, record, sessions } = setup()
    await bridge.ensure(record, async () => {})
    const session = sessions.get(record.nativeSessionId!)!
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    const turn = record.turns[0]!
    const update = {
      toolCallId: 'bash1',
      title: 'bash',
      status: 'completed',
      rawInput: { command: 'printf 中文' },
      rawOutput: { exitCode: 0, stdout: '中文' },
    }
    bridge.tool(session.id, record, turn, update)
    bridge.tool(session.id, record, turn, update)
    const events = session.snapshotEvents()
    expect(events.filter((event) => event.type === 'tool/call')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'tool/result')).toHaveLength(1)
    expect(JSON.parse(events.find((event) => event.type === 'tool/call')!.data.arguments)).toEqual({
      version: 1,
      harness: record.harnessRef,
      tool: {
        ...turn.tools[0],
        inputJson: JSON.stringify(update.rawInput),
        outputJson: JSON.stringify(update.rawOutput),
      },
    })
    expect(events.find((event) => event.type === 'tool/result')?.data.message.content).toEqual([
      { type: 'text', text: '中文' },
    ])
    expect(events.find((event) => event.type === 'tool/result')?.data.meta).toMatchObject({
      oplHarness: {
        inputJson: JSON.stringify(update.rawInput),
        outputJson: JSON.stringify(update.rawOutput),
      },
    })
    expect(harnessRequestId(record, turn)).not.toBe(
      harnessRequestId({ ...record, id: 'other' }, turn),
    )
  })
})
