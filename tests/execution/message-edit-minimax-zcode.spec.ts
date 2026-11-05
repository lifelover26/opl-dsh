import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import {
  MINIMAX_EDIT_ERRORS,
  minimaxMessageEditDriver,
} from '../../src/execution/host/message-edit-minimax.ts'
import {
  ZCODE_EDIT_ERRORS,
  zcodeMessageEditDriver,
} from '../../src/execution/host/message-edit-zcode.ts'
import {
  ZCODE_EDIT_CODES,
  isZcodeForkableAssistant,
  verifyZcodeForkPrefix,
  zcodeHistoryToken,
  zcodeUserBoundaries,
  type ZcodeConversationRow,
} from '../../src/execution/host/adapters/zcode-protocol.ts'
import type {
  ExternalEditContext,
  ExternalEditHistory,
} from '../../src/execution/host/message-edit-driver.ts'

const minimaxMeta = {
  _meta: {
    'opl/session-history': {
      version: 1,
      methods: ['opl/session/history/list', 'opl/session/history/rewind'],
      notifications: ['opl/session/history/boundary'],
    },
  },
}
const zcodeMeta = {
  _meta: {
    'opl/zcode/edit': {
      version: 1,
      methods: ['opl/zcode/edit/read', 'opl/zcode/edit/fork'],
    },
  },
}

interface FakeContext {
  context: ExternalEditContext
  controller: AbortController
  disconnect: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
  requests: string[]
}

function fakeContext(input: {
  sessionId?: string
  agent?: Record<string, any>
  handler: (method: string, params: any) => Promise<unknown>
}): FakeContext {
  const controller = new AbortController()
  const disconnect = vi.fn(async () => undefined)
  const reconnect = vi.fn(async () => undefined)
  const requests: string[] = []
  const context: ExternalEditContext = {
    record: { acpSessionId: input.sessionId ?? 'session-1', turns: [] } as any,
    launch: {} as any,
    signal: controller.signal,
    transport: () => ({
      request: async (method, params) => {
        requests.push(method)
        return input.handler(method, params)
      },
    }),
    snapshot: () => ({
      agent: input.agent ?? minimaxMeta,
      session: { sessionId: input.sessionId ?? 'session-1' },
      configOptions: undefined,
    }),
    disconnect,
    reconnect,
  }
  return { context, controller, disconnect, reconnect, requests }
}

function minimaxEntries(
  entries: {
    id: string
    contentHead?: string
    assistantMessageId?: string
    fileChangeCount?: number
  }[],
) {
  return entries.map((entry, index) => ({
    userMessageId: entry.id,
    ...(entry.contentHead ? { contentHead: entry.contentHead } : {}),
    timestamp: index + 1,
    fileChangeCount: entry.fileChangeCount ?? 0,
    ...(entry.assistantMessageId ? { assistantMessageId: entry.assistantMessageId } : {}),
  }))
}

describe('MiniMax edit driver', () => {
  it('reads real boundaries without turning summaries into exact text', async () => {
    const entries = minimaxEntries([
      { id: 'msg-user-v1-a', contentHead: 'same head', assistantMessageId: 'msg-assistant-v1-a' },
      { id: 'msg-user-v1-b', contentHead: 'same head' },
    ])
    const fake = fakeContext({
      handler: async (method) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        throw Error('unexpected')
      },
    })
    const history = await minimaxMessageEditDriver.read(fake.context)
    expect(history.boundaries).toEqual([{ id: 'msg-user-v1-a' }, { id: 'msg-user-v1-b' }])
    expect(history.boundaries.every((boundary) => boundary.text === undefined)).toBe(true)
    expect(history.token).toMatch(/^[a-f0-9]{64}$/)
    expect(fake.requests).toEqual(['opl/session/history/list'])
  })

  it('rewinds only the target and tail, keeps the identity, and never sends a prompt', async () => {
    let entries = minimaxEntries([
      { id: 'msg-user-v1-a' },
      { id: 'msg-user-v1-b' },
      { id: 'msg-user-v1-c' },
    ])
    const fake = fakeContext({
      handler: async (method, params) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        if (method === 'opl/session/history/rewind') {
          const at = entries.findIndex((entry) => entry.userMessageId === params.userMessageId)
          if (at < 0) throw Error('missing')
          const deleted = entries.slice(at).map((entry) => entry.userMessageId)
          entries = entries.slice(0, at)
          return {
            version: 1,
            rewound: true,
            sessionId: 'session-1',
            userMessageId: params.userMessageId,
            clientRequestId: params.clientRequestId,
            deletedMessageIds: deleted,
          }
        }
        throw Error('unexpected')
      },
    })
    const expected = await minimaxMessageEditDriver.read(fake.context)
    const result = await minimaxMessageEditDriver.rewind(fake.context, {
      operationId: 'op-1',
      targetId: 'msg-user-v1-b',
      expected,
    })
    expect(result).toEqual({
      sessionId: 'session-1',
      retained: [{ previousId: 'msg-user-v1-a', nextId: 'msg-user-v1-a' }],
    })
    expect(fake.requests).toEqual([
      'opl/session/history/list',
      'opl/session/history/list',
      'opl/session/history/rewind',
      'opl/session/history/list',
    ])
    expect(fake.requests).not.toContain('session/prompt')
  })

  it('rejects an unknown target without calling rewind', async () => {
    const entries = minimaxEntries([{ id: 'msg-user-v1-a' }])
    const fake = fakeContext({
      handler: async (method) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        throw Error('unexpected')
      },
    })
    const expected = await minimaxMessageEditDriver.read(fake.context)
    await expect(
      minimaxMessageEditDriver.rewind(fake.context, {
        operationId: 'op-1',
        targetId: 'msg-user-v1-missing',
        expected,
      }),
    ).rejects.toMatchObject({ code: MINIMAX_EDIT_ERRORS.targetUnknown })
    expect(fake.requests).not.toContain('opl/session/history/rewind')
  })

  it('rejects a changed boundary token without calling rewind', async () => {
    let entries = minimaxEntries([{ id: 'msg-user-v1-a' }, { id: 'msg-user-v1-b' }])
    const fake = fakeContext({
      handler: async (method) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        throw Error('unexpected')
      },
    })
    const expected = await minimaxMessageEditDriver.read(fake.context)
    entries = minimaxEntries([
      { id: 'msg-user-v1-a', assistantMessageId: 'msg-assistant-v1-new' },
      { id: 'msg-user-v1-b' },
    ])
    await expect(
      minimaxMessageEditDriver.rewind(fake.context, {
        operationId: 'op-1',
        targetId: 'msg-user-v1-b',
        expected,
      }),
    ).rejects.toMatchObject({ code: MINIMAX_EDIT_ERRORS.historyChanged })
    expect(fake.requests).not.toContain('opl/session/history/rewind')
  })

  it('maps duplicate texts by id, not by text', async () => {
    let entries = minimaxEntries([
      { id: 'msg-user-v1-a', contentHead: 'same' },
      { id: 'msg-user-v1-b', contentHead: 'same' },
    ])
    const fake = fakeContext({
      handler: async (method, params) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        if (method === 'opl/session/history/rewind') {
          const at = entries.findIndex((entry) => entry.userMessageId === params.userMessageId)
          entries = entries.slice(0, at)
          return {
            version: 1,
            rewound: true,
            sessionId: 'session-1',
            userMessageId: params.userMessageId,
            clientRequestId: params.clientRequestId,
            deletedMessageIds: ['msg-user-v1-b'],
          }
        }
        throw Error('unexpected')
      },
    })
    const expected = await minimaxMessageEditDriver.read(fake.context)
    const result = await minimaxMessageEditDriver.rewind(fake.context, {
      operationId: 'op-1',
      targetId: 'msg-user-v1-b',
      expected,
    })
    expect(result.retained).toEqual([{ previousId: 'msg-user-v1-a', nextId: 'msg-user-v1-a' }])
  })

  it('turns a vendor failure into a fixed uncertain error without retrying or prompting', async () => {
    const entries = minimaxEntries([{ id: 'msg-user-v1-a' }, { id: 'msg-user-v1-b' }])
    let rewinds = 0
    const fake = fakeContext({
      handler: async (method) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        if (method === 'opl/session/history/rewind') {
          rewinds += 1
          throw Error('provider text must not leak')
        }
        throw Error('unexpected')
      },
    })
    const expected = await minimaxMessageEditDriver.read(fake.context)
    await expect(
      minimaxMessageEditDriver.rewind(fake.context, {
        operationId: 'op-1',
        targetId: 'msg-user-v1-b',
        expected,
      }),
    ).rejects.toMatchObject({ code: MINIMAX_EDIT_ERRORS.vendorUncertain })
    expect(rewinds).toBe(1)
    expect(fake.requests).not.toContain('session/prompt')
  })

  it('maps consecutive edits against the shrinking retained prefix', async () => {
    let entries = minimaxEntries([
      { id: 'msg-user-v1-a' },
      { id: 'msg-user-v1-b' },
      { id: 'msg-user-v1-c' },
    ])
    const fake = fakeContext({
      handler: async (method, params) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        if (method === 'opl/session/history/rewind') {
          const at = entries.findIndex((entry) => entry.userMessageId === params.userMessageId)
          const deleted = entries.slice(at).map((entry) => entry.userMessageId)
          entries = entries.slice(0, at)
          return {
            version: 1,
            rewound: true,
            sessionId: 'session-1',
            userMessageId: params.userMessageId,
            clientRequestId: params.clientRequestId,
            deletedMessageIds: deleted,
          }
        }
        throw Error('unexpected')
      },
    })
    const firstExpected = await minimaxMessageEditDriver.read(fake.context)
    const first = await minimaxMessageEditDriver.rewind(fake.context, {
      operationId: 'op-1',
      targetId: 'msg-user-v1-b',
      expected: firstExpected,
    })
    expect(first.retained).toEqual([{ previousId: 'msg-user-v1-a', nextId: 'msg-user-v1-a' }])
    const secondExpected = await minimaxMessageEditDriver.read(fake.context)
    const second = await minimaxMessageEditDriver.rewind(fake.context, {
      operationId: 'op-2',
      targetId: 'msg-user-v1-a',
      expected: secondExpected,
    })
    expect(second.retained).toEqual([])
  })

  it('token covers file-change history exposed by the vendor list', async () => {
    let entries = minimaxEntries([{ id: 'msg-user-v1-a', fileChangeCount: 0 }])
    const fake = fakeContext({
      handler: async (method) => {
        if (method === 'opl/session/history/list')
          return { version: 1, sessionId: 'session-1', entries }
        throw Error('unexpected')
      },
    })
    const before = await minimaxMessageEditDriver.read(fake.context)
    entries = minimaxEntries([{ id: 'msg-user-v1-a', fileChangeCount: 2 }])
    const after = await minimaxMessageEditDriver.read(fake.context)
    expect(after.token).not.toBe(before.token)
  })

  it('refuses an aborted request before any mutation', async () => {
    const entries = minimaxEntries([{ id: 'msg-user-v1-a' }])
    const fake = fakeContext({
      handler: async () => ({ version: 1, sessionId: 'session-1', entries }),
    })
    const expected: ExternalEditHistory = {
      sessionId: 'session-1',
      token: 'token',
      boundaries: [{ id: 'msg-user-v1-a' }],
    }
    fake.controller.abort()
    await expect(
      minimaxMessageEditDriver.rewind(fake.context, {
        operationId: 'op-1',
        targetId: 'msg-user-v1-a',
        expected,
      }),
    ).rejects.toMatchObject({ code: MINIMAX_EDIT_ERRORS.aborted })
    expect(fake.requests).not.toContain('opl/session/history/rewind')
  })

  it('refuses an unannounced capability', async () => {
    const fake = fakeContext({
      agent: {},
      handler: async () => ({ version: 1, sessionId: 'session-1', entries: [] }),
    })
    await expect(minimaxMessageEditDriver.read(fake.context)).rejects.toMatchObject({
      code: MINIMAX_EDIT_ERRORS.unsupported,
    })
  })
})

function zcodeRows(): ZcodeConversationRow[] {
  return [
    {
      rowId: 1,
      kind: 'turnHeader',
      origin: 'userInput',
      entityId: 't1',
      turnId: 'turn-1',
      sourceCommandId: 'cmd-1',
    },
    {
      rowId: 2,
      kind: 'userInput',
      origin: 'realUser',
      entityId: 'u1',
      turnId: 'turn-1',
      text: 'same',
      sourceCommandId: 'cmd-1',
    },
    { rowId: 3, kind: 'assistantText', entityId: 'a1', turnId: 'turn-1', text: 'answer' },
    {
      rowId: 4,
      kind: 'turnHeader',
      origin: 'userInput',
      entityId: 't2',
      turnId: 'turn-2',
      sourceCommandId: 'cmd-2',
    },
    {
      rowId: 5,
      kind: 'userInput',
      origin: 'realUser',
      entityId: 'u2',
      turnId: 'turn-2',
      text: 'same',
      sourceCommandId: 'cmd-2',
    },
  ]
}

describe('ZCode edit protocol helpers', () => {
  it('tokens cover lineage and tool output state', () => {
    const rows = zcodeRows()
    const before = zcodeHistoryToken('sess', rows, 10, 'epoch')
    const changedText = rows.map((row) => ({ ...row }))
    changedText[4]!.text = 'changed'
    expect(zcodeHistoryToken('sess', changedText, 10, 'epoch')).not.toBe(before)
    const changedLineage = rows.map((row) => ({ ...row }))
    changedLineage[1]!.sourceCommandId = 'cmd-other'
    expect(zcodeHistoryToken('sess', changedLineage, 10, 'epoch')).not.toBe(before)
    const changedTool = rows.map((row) => ({ ...row }))
    changedTool[2] = {
      ...changedTool[2]!,
      kind: 'toolCall',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      status: 'completed',
    }
    expect(zcodeHistoryToken('sess', changedTool, 10, 'epoch')).not.toBe(before)
  })

  it('returns exact real-user boundaries in order', () => {
    expect(zcodeUserBoundaries(zcodeRows())).toEqual([
      { id: 'u1', text: 'same' },
      { id: 'u2', text: 'same' },
    ])
  })

  it('validates the fork prefix by structural lineage, not old entity ids', () => {
    const parent = zcodeRows()
    const child: ZcodeConversationRow[] = [
      {
        rowId: 1,
        kind: 'turnHeader',
        origin: 'userInput',
        entityId: 'c-t1',
        turnId: 'c-turn-1',
        sourceCommandId: 'cmd-1',
      },
      {
        rowId: 2,
        kind: 'userInput',
        origin: 'realUser',
        entityId: 'c-u1',
        turnId: 'c-turn-1',
        text: 'same',
        sourceCommandId: 'cmd-1',
      },
      { rowId: 3, kind: 'assistantText', entityId: 'c-a1', turnId: 'c-turn-1', text: 'answer' },
      {
        rowId: 4,
        kind: 'timelineMarker',
        lane: 'turnTailBoundary',
        marker: { type: 'forkNotice' },
        entityId: 'fork:sess:msg',
        turnId: 'c-turn-1',
      },
    ]
    expect(verifyZcodeForkPrefix(parent, child, 'u2')).toEqual({
      retained: [{ previousId: 'u1', nextId: 'c-u1' }],
    })
    const bad = child.map((row) => ({ ...row }))
    bad[2] = { ...bad[2]!, text: 'different answer' }
    expect(() => verifyZcodeForkPrefix(parent, bad, 'u2')).toThrowError(
      expect.objectContaining({ code: ZCODE_EDIT_CODES.forkMismatch }),
    )
  })

  it('compares tool output rows in the retained prefix', () => {
    const parent: ZcodeConversationRow[] = [
      {
        rowId: 1,
        kind: 'turnHeader',
        origin: 'userInput',
        entityId: 't1',
        sourceCommandId: 'cmd-1',
      },
      {
        rowId: 2,
        kind: 'userInput',
        origin: 'realUser',
        entityId: 'u1',
        text: 'run',
        sourceCommandId: 'cmd-1',
      },
      { rowId: 3, kind: 'assistantText', entityId: 'a1', text: 'running' },
      {
        rowId: 4,
        kind: 'toolCall',
        entityId: 'tool-1',
        toolCallId: 'call-1',
        toolName: 'Bash',
        status: 'completed',
        text: 'ok',
      },
      { rowId: 5, kind: 'assistantText', entityId: 'a2', text: 'done' },
      {
        rowId: 6,
        kind: 'turnHeader',
        origin: 'userInput',
        entityId: 't2',
        sourceCommandId: 'cmd-2',
      },
      {
        rowId: 7,
        kind: 'userInput',
        origin: 'realUser',
        entityId: 'u2',
        text: 'next',
        sourceCommandId: 'cmd-2',
      },
    ]
    const child: ZcodeConversationRow[] = [
      {
        rowId: 1,
        kind: 'turnHeader',
        origin: 'userInput',
        entityId: 'c-t1',
        sourceCommandId: 'cmd-1',
      },
      {
        rowId: 2,
        kind: 'userInput',
        origin: 'realUser',
        entityId: 'c-u1',
        text: 'run',
        sourceCommandId: 'cmd-1',
      },
      { rowId: 3, kind: 'assistantText', entityId: 'c-a1', text: 'running' },
      {
        rowId: 4,
        kind: 'toolCall',
        entityId: 'c-tool-1',
        toolCallId: 'call-1',
        toolName: 'Bash',
        status: 'completed',
        text: 'ok',
      },
      { rowId: 5, kind: 'assistantText', entityId: 'c-a2', text: 'done' },
      {
        rowId: 6,
        kind: 'timelineMarker',
        lane: 'turnTailBoundary',
        marker: { type: 'forkNotice' },
        entityId: 'fork:sess:msg',
      },
    ]
    expect(verifyZcodeForkPrefix(parent, child, 'u2').retained).toEqual([
      { previousId: 'u1', nextId: 'c-u1' },
    ])
    const changedTool = child.map((row) => ({ ...row }))
    changedTool[3] = { ...changedTool[3]!, status: 'failed' }
    expect(() => verifyZcodeForkPrefix(parent, changedTool, 'u2')).toThrowError(
      expect.objectContaining({ code: ZCODE_EDIT_CODES.forkMismatch }),
    )
  })

  it('requires the official canFork completed final assistant', () => {
    expect(
      isZcodeForkableAssistant({
        rowId: 3,
        kind: 'assistantText',
        state: 'complete',
        actions: { canFork: true },
      } as ZcodeConversationRow),
    ).toBe(true)
    expect(
      isZcodeForkableAssistant({
        rowId: 3,
        kind: 'assistantText',
        state: 'complete',
      } as ZcodeConversationRow),
    ).toBe(false)
    expect(
      isZcodeForkableAssistant({
        rowId: 3,
        kind: 'assistantText',
        state: 'running',
        actions: { canFork: true },
      } as ZcodeConversationRow),
    ).toBe(false)
    expect(
      isZcodeForkableAssistant({
        rowId: 3,
        kind: 'toolCall',
        state: 'complete',
        actions: { canFork: true },
      } as ZcodeConversationRow),
    ).toBe(false)
  })

  it('accepts real installed-fixture parent/child rows with re-keyed identities', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('./message-edit-minimax-zcode/zcode-rows.fixture.json', import.meta.url),
        'utf8',
      ),
    ) as { parent: ZcodeConversationRow[]; child: ZcodeConversationRow[]; targetId: string }
    const parentBoundary = fixture.parent.find(
      (row) => row.kind === 'userInput' && row.origin === 'realUser',
    )!
    const childBoundary = fixture.child.find(
      (row) => row.kind === 'userInput' && row.origin === 'realUser',
    )!
    expect(verifyZcodeForkPrefix(fixture.parent, fixture.child, fixture.targetId)).toEqual({
      retained: [{ previousId: parentBoundary.entityId, nextId: childBoundary.entityId }],
    })
  })

  it('rejects unknown targets and missing fork rows', () => {
    expect(() => verifyZcodeForkPrefix(zcodeRows(), [], 'missing')).toThrowError(
      expect.objectContaining({ code: ZCODE_EDIT_CODES.targetUnknown }),
    )
    expect(() => verifyZcodeForkPrefix(zcodeRows(), [], 'u2')).toThrowError(
      expect.objectContaining({ code: ZCODE_EDIT_CODES.forkMismatch }),
    )
  })
})

describe('ZCode edit driver', () => {
  it('reads exact boundaries from the bridge', async () => {
    const fake = fakeContext({
      agent: zcodeMeta,
      handler: async () => ({
        ok: true,
        sessionId: 'session-1',
        token: 'token-1',
        boundaries: [{ id: 'u1', text: 'same' }],
      }),
    })
    await expect(zcodeMessageEditDriver.read(fake.context)).resolves.toEqual({
      sessionId: 'session-1',
      token: 'token-1',
      boundaries: [{ id: 'u1', text: 'same' }],
    })
  })

  it('forks, rebinds to the child, and returns the retained mapping without prompting', async () => {
    const fake = fakeContext({
      agent: zcodeMeta,
      handler: async (method) => {
        if (method === 'opl/zcode/edit/fork')
          return {
            ok: true,
            sessionId: 'child-1',
            retained: [{ previousId: 'u1', nextId: 'c-u1' }],
          }
        throw Error('unexpected')
      },
    })
    const result = await zcodeMessageEditDriver.rewind(fake.context, {
      operationId: 'op-1',
      targetId: 'u2',
      expected: {
        sessionId: 'session-1',
        token: 'token-1',
        boundaries: [
          { id: 'u1', text: 'same' },
          { id: 'u2', text: 'same' },
        ],
      },
    })
    expect(result).toEqual({
      sessionId: 'child-1',
      retained: [{ previousId: 'u1', nextId: 'c-u1' }],
    })
    // The driver returns the child identity; the shared owner persists it before
    // reconnecting. The driver must not change the binding itself.
    expect(fake.disconnect).not.toHaveBeenCalled()
    expect(fake.reconnect).not.toHaveBeenCalled()
    expect(fake.requests).not.toContain('session/prompt')
  })

  it('maps fixed bridge refusals without reconnecting', async () => {
    const fake = fakeContext({
      agent: zcodeMeta,
      handler: async () => ({ ok: false, code: ZCODE_EDIT_CODES.historyChanged }),
    })
    await expect(
      zcodeMessageEditDriver.rewind(fake.context, {
        operationId: 'op-1',
        targetId: 'u2',
        expected: { sessionId: 'session-1', token: 'token-1', boundaries: [] },
      }),
    ).rejects.toMatchObject({ code: ZCODE_EDIT_ERRORS.historyChanged })
    expect(fake.disconnect).not.toHaveBeenCalled()
    expect(fake.reconnect).not.toHaveBeenCalled()
  })

  it('treats a fork without a child identity as uncertain and does not retry', async () => {
    let forks = 0
    const fake = fakeContext({
      agent: zcodeMeta,
      handler: async () => {
        forks += 1
        return { ok: false, code: ZCODE_EDIT_CODES.vendorUncertain }
      },
    })
    await expect(
      zcodeMessageEditDriver.rewind(fake.context, {
        operationId: 'op-1',
        targetId: 'u2',
        expected: { sessionId: 'session-1', token: 'token-1', boundaries: [] },
      }),
    ).rejects.toMatchObject({ code: ZCODE_EDIT_ERRORS.vendorUncertain })
    expect(forks).toBe(1)
    expect(fake.requests).not.toContain('session/prompt')
  })

  it('signals abort to the bridge and treats a completed fork as uncertain', async () => {
    let resolveFork: ((value: unknown) => void) | undefined
    let aborts = 0
    const fake = fakeContext({
      agent: zcodeMeta,
      handler: async (method) => {
        if (method === 'opl/zcode/edit/abort') {
          aborts += 1
          return { ok: true }
        }
        if (method === 'opl/zcode/edit/fork')
          return await new Promise((resolve) => {
            resolveFork = resolve
          })
        throw Error('unexpected')
      },
    })
    const pending = zcodeMessageEditDriver.rewind(fake.context, {
      operationId: 'op-abort',
      targetId: 'u2',
      expected: { sessionId: 'session-1', token: 'token-1', boundaries: [] },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.controller.abort()
    resolveFork?.({ ok: true, sessionId: 'child-1', retained: [] })
    await expect(pending).rejects.toMatchObject({ code: ZCODE_EDIT_ERRORS.vendorUncertain })
    expect(aborts).toBe(1)
  })

  it('refuses an aborted fork and an unannounced capability', async () => {
    const aborted = fakeContext({
      agent: zcodeMeta,
      handler: async () => ({ ok: true, sessionId: 'child', retained: [] }),
    })
    aborted.controller.abort()
    await expect(
      zcodeMessageEditDriver.rewind(aborted.context, {
        operationId: 'op-1',
        targetId: 'u2',
        expected: { sessionId: 'session-1', token: 'token-1', boundaries: [] },
      }),
    ).rejects.toMatchObject({ code: ZCODE_EDIT_ERRORS.aborted })
    const unsupported = fakeContext({
      agent: {},
      handler: async () => ({ ok: true, sessionId: 'child', retained: [] }),
    })
    await expect(zcodeMessageEditDriver.read(unsupported.context)).rejects.toMatchObject({
      code: ZCODE_EDIT_ERRORS.unsupported,
    })
  })
})
