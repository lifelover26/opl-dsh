/** Whole-log transcript reads keep durable event positions across live and cold Sessions. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionAccess, SessionHandle, SessionHandleReadResult, SessionPersistenceOpenOptions } from '@deepseek-ai/dsh-session-persistence'
import { readResource, type ResourceHost } from '../src/app/resources.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })

function fixture(live = false) {
  const ctx = new Context(); contexts.push(ctx)
  const ticketId = 'transcript-ticket', sessionId = SessionId(`worker-${ticketId}`)
  const session = Session.create(sessionId)
  const agents = new Map(live ? [[sessionId, { session }]] : [])
  const read = vi.fn<SessionHandle['read']>(async (_offset, _length, options) => {
    options?.signal?.throwIfAborted()
    return { events: session.snapshotEvents(), eventState: 'shared-frozen' }
  })
  const close = vi.fn(async () => {})
  const handle = { read, [Symbol.asyncDispose]: close } satisfies Pick<SessionHandle, 'read' | typeof Symbol.asyncDispose>
  const open = vi.fn(async (_id: SessionId, _access: SessionAccess, options?: SessionPersistenceOpenOptions) => {
    options?.signal?.throwIfAborted()
    return handle
  })
  const resolveAgent = vi.fn(() => { throw new Error('Transcript reads must not activate an Agent') })
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('sessionPersistence', { open })
  ctx.reflect.provide('sessionController', { resolveAgent })
  const host = { context: ctx, masterId: 'orchestrator', store: { tickets: { get: (id: string) => id === ticketId ? { id } : undefined } } } as unknown as ResourceHost
  const resource = async (suffix: string, signal?: AbortSignal) =>
    await readResource(host, `ticket/${ticketId}/${suffix}`, 0, 100000, undefined, signal) as { text: string }
  const user = (text: string) => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' })
  const assistant = (text: string) => session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text }], source: { provider: 'p', model: 'm' },
  }) }, { surfaceOp: 'append' })
  const cards = async (signal?: AbortSignal) => (await resource('transcript', signal)).text.split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; preview: string; read: string })
  return { sessionId, ticketId, session, read, open, handle, close, resolveAgent, resource, user, assistant, cards }
}

it('reads every cold message in reverse order while retaining positions of non-message events', async () => {
  const h = fixture(), positions: number[] = []
  h.session.append('turn/start', { turn: 1 })
  for (let step = 1; step <= 55; step++) {
    h.session.append('step/start', { turn: 1, step })
    positions.push(h.user(`Question ${step}`).seq, h.assistant(`Answer ${step}`).seq)
    h.session.append('step/end', { turn: 1, step })
  }
  h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const signal = new AbortController().signal
  const cards = await h.cards(signal)
  expect(cards.map(card => card.read)).toEqual(positions.reverse().map(index => `ticket/${h.ticketId}/message/${index}`))
  expect(cards[0]).toMatchObject({ type: 'assistant/message', preview: 'Answer 55' })
  expect(cards.at(-1)).toMatchObject({ type: 'user/message', preview: 'Question 1' })
  expect(h.open).toHaveBeenCalledExactlyOnceWith(h.sessionId, 'read', { signal })
  expect(h.read).toHaveBeenCalledExactlyOnceWith(0, undefined, { signal })
  expect(h.close).toHaveBeenCalledOnce()
  expect(h.resolveAgent).not.toHaveBeenCalled()
  const message = JSON.parse((await h.resource(`message/${positions[0]}`)).text)
  expect(message).toEqual({ type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer 55' }] } })
  await expect(h.resource('message/0')).rejects.toThrow('Unknown transcript entry')
})

it('uses one live snapshot with fresh messages and stable references after later appends', async () => {
  const h = fixture(true)
  h.session.append('turn/start', { turn: 1 })
  const user = h.user('First question')
  const callId = ToolCallId('read-file')
  h.session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
  const tool = h.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'File contents' }], isError: false }) }, { surfaceOp: 'append' })
  const assistant = h.assistant('First answer')
  const reading = h.cards()
  h.assistant('Later answer')
  const cards = await reading
  expect(cards.map(card => card.read)).toEqual([assistant, tool, user].map(event => `ticket/${h.ticketId}/message/${event.seq}`))
  expect(JSON.parse((await h.resource(`message/${assistant.seq}`)).text).message.content).toEqual([{ type: 'text', text: 'First answer' }])
  expect((await h.cards())[0]).toMatchObject({ preview: 'Later answer' })
  expect(h.open).not.toHaveBeenCalled()
  expect(h.resolveAgent).not.toHaveBeenCalled()
})

it('returns an empty transcript for an empty cold Session', async () => {
  const h = fixture()
  expect(await h.resource('transcript')).toMatchObject({ text: '' })
  expect(h.close).toHaveBeenCalledOnce()
  await expect(h.resource('message/0')).rejects.toThrow('Unknown transcript entry')
})

it.each([false, true])('rejects a canceled transcript before reading (live=%s)', async live => {
  const h = fixture(live), controller = new AbortController(), reason = new Error('canceled')
  controller.abort(reason)
  await expect(h.resource('transcript', controller.signal)).rejects.toBe(reason)
  expect(h.open).not.toHaveBeenCalled()
  expect(h.read).not.toHaveBeenCalled()
})

it('disposes a handle returned after cancellation before starting its read', async () => {
  const h = fixture(), controller = new AbortController(), reason = new Error('canceled while opening')
  h.open.mockImplementationOnce(async () => { controller.abort(reason); return h.handle })
  await expect(h.resource('transcript', controller.signal)).rejects.toBe(reason)
  expect(h.read).not.toHaveBeenCalled()
  expect(h.close).toHaveBeenCalledOnce()
})

it('forwards cancellation into a pending cold read and waits for its disposal', async () => {
  const h = fixture(), controller = new AbortController(), reason = new Error('canceled while reading')
  const entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  h.read.mockImplementationOnce(async (_offset, _length, options) => {
    const signal = options!.signal!
    const reading = Promise.withResolvers<SessionHandleReadResult>()
    const abort = () => reading.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    entered.resolve()
    try { return await reading.promise }
    finally { signal.removeEventListener('abort', abort) }
  })
  h.close.mockImplementationOnce(async () => { closed.resolve(); await release.promise })
  let settled = false
  const reading = h.resource('transcript', controller.signal).finally(() => { settled = true })
  const assertion = expect(reading).rejects.toBe(reason)
  try {
    await entered.promise
    expect(h.read).toHaveBeenCalledWith(0, undefined, { signal: controller.signal })
    controller.abort(reason)
    await closed.promise
    expect(settled).toBe(false)
  } finally {
    controller.abort(reason)
    release.resolve()
    await assertion
  }
  expect(h.close).toHaveBeenCalledOnce()
})

it('propagates a cold read failure after releasing its handle', async () => {
  const h = fixture(), error = new Error('stored Session is corrupt')
  h.read.mockRejectedValueOnce(error)
  await expect(h.resource('message/0')).rejects.toBe(error)
  expect(h.close).toHaveBeenCalledOnce()
})
