import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionCall } from '../../src/shared/client/remote-call.ts'
import type {
  MessageEditSend,
  MessageEditState,
} from '../../src/execution/contracts/message-edit.ts'
import { MessageEditSession } from '../../src/execution/client/message-edit-session.ts'

const state: MessageEditState = {
  sessionId: 'edit-session',
  supported: true,
  busy: false,
  pending: false,
  head: 5,
  choices: [{ seq: 3, text: '保留原文' }],
}

const stored = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
})
afterEach(() => stored.clear())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it('retains the selected edit and known action through unavailable history and a failed read', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(state)
    .mockResolvedValueOnce({
      ...state,
      choices: [],
      unavailable: { reason: 'history-unavailable', retryable: true },
    })
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValueOnce(state)
    .mockResolvedValueOnce({ ...state, choices: [] })
  const session = new MessageEditSession(state.sessionId, call as ExecutionCall)
  await session.load()
  expect(await session.select(3, '')).toBe(true)
  const selection = session.getSnapshot().selection
  const saved = stored.get('opl-message-edit-v1:edit-session')
  await session.load()
  expect(session.getSnapshot().selection).toBe(selection)
  expect(session.choice(3)?.text).toBe('保留原文')
  expect(await session.select(3, '')).toBe(false)
  await session.load()
  expect(session.getSnapshot().selection).toBe(selection)
  expect(stored.get('opl-message-edit-v1:edit-session')).toBe(saved)
  expect(session.getSnapshot().unavailable).toEqual({
    reason: 'history-unavailable',
    retryable: true,
  })
  await session.retry()
  expect(session.getSnapshot().selection).toBe(selection)
  expect(session.getSnapshot().unavailable).toBeUndefined()
  await session.load()
  expect(session.getSnapshot().selection).toBeUndefined()
  expect(stored.size).toBe(0)
  expect(call.mock.calls.every(([method]) => method === 'message-edit-state')).toBe(true)
})

it('coalesces repeated explicit retries while a history read is in flight', async () => {
  const read = deferred<MessageEditState>()
  const call = vi.fn(() => read.promise)
  const session = new MessageEditSession(state.sessionId, call as ExecutionCall)
  const first = session.retry()
  const second = session.retry()
  const third = session.retry()
  expect(call).toHaveBeenCalledTimes(1)
  read.resolve(state)
  await Promise.all([first, second, third])
  expect(call).toHaveBeenCalledTimes(1)
  expect(session.choice(3)).toEqual(state.choices[0])
})

it('preserves a restored edit through busy or temporarily unavailable initial history', async () => {
  const selection = { seq: 3, head: 5, previousDraft: '' }
  stored.set('opl-message-edit-v1:edit-session', JSON.stringify(selection))
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ...state, busy: true, choices: [] })
    .mockResolvedValueOnce({
      ...state,
      choices: [],
      unavailable: { reason: 'history-busy', retryable: true },
    })
  const session = new MessageEditSession(state.sessionId, call as ExecutionCall)
  await session.load()
  expect(session.getSnapshot().selection).toEqual(selection)
  await session.load()
  expect(session.getSnapshot().selection).toEqual(selection)
  expect(stored.get('opl-message-edit-v1:edit-session')).toBe(JSON.stringify(selection))
})

it('discards an outdated failed read after an official history invalidation', async () => {
  const read = deferred<MessageEditState>()
  const call = vi
    .fn()
    .mockImplementationOnce(() => read.promise)
    .mockResolvedValueOnce(state)
  const session = new MessageEditSession(state.sessionId, call as ExecutionCall)
  const changes: unknown[] = []
  session.subscribe(() => changes.push(session.getSnapshot().unavailable))
  const first = session.load()
  const refreshed = session.load()
  read.reject(Error('outdated offline result'))
  await Promise.all([first, refreshed])
  expect(call).toHaveBeenCalledTimes(2)
  expect(changes).toEqual([undefined])
  expect(session.getSnapshot().state).toEqual(state)
})

it('keeps unsupported engines free of a retry action after a transport failure', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ...state, supported: false, choices: [] })
    .mockRejectedValueOnce(Error('offline'))
  const session = new MessageEditSession(state.sessionId, call as ExecutionCall)
  await session.load()
  await session.load()
  expect(session.getSnapshot().unavailable).toBeUndefined()
  expect(session.choice(3)).toBeUndefined()
})

it('sends an unconfirmed recovery once while repeated explicit clicks wait for it', async () => {
  const recovery = {
    prompt: { sessionId: state.sessionId, requestId: 'recover-once' },
    targetSeq: 3,
    head: 5,
  } as MessageEditSend
  const send = deferred<{ accepted: true }>()
  const call = vi
    .fn()
    .mockResolvedValueOnce({ ...state, pending: true, recovery })
    .mockImplementationOnce(() => send.promise)
    .mockResolvedValueOnce(state)
  const session = new MessageEditSession(state.sessionId, call as ExecutionCall)
  await session.load()
  const first = session.recover()
  const second = session.recover()
  expect(call).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenNthCalledWith(2, 'message-edit-send', recovery)
  send.resolve({ accepted: true })
  expect(await first).toBe(true)
  expect(await second).toBe(true)
  expect(call.mock.calls.filter(([method]) => method === 'message-edit-send')).toHaveLength(1)
})
