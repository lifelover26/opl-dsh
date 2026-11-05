import { expect, it } from 'vitest'
import { minimaxMessageEditDriver } from '../../../src/execution/host/message-edit-minimax.ts'
import {
  verifyZcodeForkPrefix,
  zcodeHistoryToken,
  type ZcodeConversationRow,
} from '../../../src/execution/host/adapters/zcode-protocol.ts'
import type { ExternalEditContext } from '../../../src/execution/host/message-edit-driver.ts'

it('accepts ZCode tool identity remapping only when each toolCallId equals its row entity', () => {
  const parent = [
    { rowId: 1, kind: 'userInput', entityId: 'first', origin: 'realUser', text: 'first' },
    {
      rowId: 2,
      kind: 'toolCall',
      entityId: 'call-original',
      toolCallId: 'call-original',
      input: { command: 'cat proof.txt' },
      output: { text: 'KEEP' },
    },
    { rowId: 3, kind: 'assistantText', entityId: 'answer', text: 'OLD', state: 'complete' },
    { rowId: 4, kind: 'userInput', entityId: 'target', origin: 'realUser', text: 'replace' },
  ] as ZcodeConversationRow[]
  const child = structuredClone(parent.slice(0, 3))
  Object.assign(child[1]!, { entityId: 'tool-fork', toolCallId: 'tool-fork' })
  expect(verifyZcodeForkPrefix(parent, child, 'target').retained).toEqual([
    { previousId: 'first', nextId: 'first' },
  ])
  const wrongId = structuredClone(child)
  wrongId[1]!.toolCallId = 'another-tool'
  expect(() => verifyZcodeForkPrefix(parent, wrongId, 'target')).toThrow()
  const wrongOutput = structuredClone(child)
  wrongOutput[1]!.output = { text: 'changed' }
  expect(() => verifyZcodeForkPrefix(parent, wrongOutput, 'target')).toThrow()
})

it('refuses a MiniMax success receipt when the old tail remains', async () => {
  const context = {
    record: { acpSessionId: 'm', turns: [] },
    signal: new AbortController().signal,
    snapshot: () => ({
      agent: {
        _meta: {
          'opl/session-history': {
            version: 1,
            methods: ['opl/session/history/list', 'opl/session/history/rewind'],
          },
        },
      },
    }),
    transport: () => ({
      request: async (method: string) =>
        method.endsWith('/list')
          ? {
              version: 1,
              sessionId: 'm',
              entries: ['a', 'b'].map((id, index) => ({
                userMessageId: id,
                timestamp: index,
                fileChangeCount: 0,
              })),
            }
          : { version: 1, sessionId: 'm', rewound: true, deletedMessageIds: ['b'] },
    }),
  } as unknown as ExternalEditContext
  const expected = await minimaxMessageEditDriver.read(context)
  await expect(
    minimaxMessageEditDriver.rewind(context, { operationId: 'edit', targetId: 'b', expected }),
  ).rejects.toThrow()
})
const rows: ZcodeConversationRow[] = [
  { rowId: 1, kind: 'userInput', origin: 'realUser', entityId: 'u1', text: 'first' },
  { rowId: 2, kind: 'assistantText', entityId: 'a1', text: 'answer' },
  { rowId: 3, kind: 'userInput', origin: 'realUser', entityId: 'u2', text: 'second' },
]
it('refuses a ZCode child which still contains the edited target and tail', () => {
  expect(() => verifyZcodeForkPrefix(rows, structuredClone(rows), 'u2')).toThrow()
})
it('includes structured tool results in ZCode freshness tokens', () => {
  const a = [...rows, { rowId: 4, kind: 'toolCall', toolCallId: 'call', result: { output: 'one' } }]
  const b = structuredClone(a)
  b[3] = { ...b[3]!, result: { output: 'changed' } }
  expect(zcodeHistoryToken('z', a, 1, 'epoch')).not.toBe(zcodeHistoryToken('z', b, 1, 'epoch'))
})
