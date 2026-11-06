import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageEditSend } from '../../src/execution/contracts/message-edit.ts'
import { messageEditMarker } from '../../src/execution/contracts/message-edit.ts'
import type { HarnessPromptPart } from '../../src/execution/contracts/prompt.ts'
import {
  MessageEditTransactions,
  messageEditState,
  unresolvedMessageEdit,
} from '../../src/execution/host/message-edit.ts'
import { MessageEditStore } from '../../src/execution/host/message-edit-store.ts'

const tempDirectory = tmpdir()
const roots: string[] = []
const stores: MessageEditStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.drain()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function image(digit: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:' + digit.repeat(64)),
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 2,
    name: digit + '.png',
  }
}

function agentFor(session: Session, queued: UserMessage[] = []): Agent {
  return {
    id: session.id,
    session,
    status: 'idle',
    inbox: { nextTurn: queued, nextStep: [], remove: vi.fn() },
  } as unknown as Agent
}

async function reloadStore(root: string) {
  const store = new MessageEditStore(root)
  stores.push(store)
  await store.load()
  return store
}

async function fixture() {
  await mkdir(tempDirectory, { recursive: true })
  const root = await mkdtemp(join(tempDirectory, 'edit-'))
  roots.push(root)
  const session = Session.create(SessionId('multimodal-message-edit'))
  const first = image('1'),
    second = image('2')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('instructions') },
    { surfaceOp: 'append' },
  )
  const original = session.append(
    'user/message',
    createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'original before' },
        { type: 'image', attachment: first },
        { type: 'text', text: 'original between' },
        { type: 'image', attachment: second },
      ],
    }),
    { surfaceOp: 'append' },
  )
  session.append(
    'user/message',
    createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'later input' }],
    }),
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const input: MessageEditSend = {
    targetSeq: Number(original.seq),
    head: Number(session.seq) - 1,
    prompt: {
      sessionId: session.id,
      requestId: 'multimodal-edit-request' as MessageEditSend['prompt']['requestId'],
      mode: 'queue',
      content: [{ type: 'text', text: 'edited question' }],
    },
  }
  const expected: HarnessPromptPart[] = [
    { type: 'text', text: 'edited question' },
    { type: 'image', attachment: first },
    { type: 'image', attachment: second },
  ]
  const queued: UserMessage[] = []
  const agent = agentFor(session, queued)
  const store = await reloadStore(root)
  const edits = new MessageEditTransactions(store)
  const admit = vi.fn(async () => {
    queued.push(
      createUserMessage({
        source: { kind: 'user', rpcId: input.prompt.requestId },
        content: structuredClone(expected),
      }),
    )
    return { accepted: true as const }
  })
  const eventFile = join(root, 'official-events.json')
  const flush = vi.fn(async () => {
    await writeFile(eventFile, JSON.stringify(session.snapshotEvents()))
    return true
  })
  const journalFile = join(
    root,
    'profiles/desktop/message-edit-intents',
    createHash('sha256').update(session.id).digest('hex') + '.json',
  )
  return {
    root,
    session,
    original,
    first,
    second,
    input,
    expected,
    queued,
    agent,
    store,
    edits,
    admit,
    flush,
    eventFile,
    journalFile,
  }
}

describe('image-preserving edit admission', () => {
  it('admits text-only editing while durably retaining the selected original images', async () => {
    const f = await fixture(),
      before = f.session.seq
    expect(messageEditState(f.session, false, true).choices).toContainEqual({
      seq: f.input.targetSeq,
      text: 'original beforeoriginal between',
    })
    await f.edits.send(f.agent, f.input, f.admit, f.expected)
    expect(f.session.seq).toBe(before)
    const originalExpected = structuredClone(f.expected)
    const last = f.expected[2]
    if (last?.type === 'image') last.attachment = image('3')
    const restored = await reloadStore(f.root)
    expect(restored.get(f.session.id)?.expectedContent).toEqual(originalExpected)
    expect(restored.get(f.session.id)?.input.prompt.content).toEqual([
      { type: 'text', text: 'edited question' },
    ])
    const bytes = await readFile(f.journalFile, 'utf8')
    expect(bytes).not.toMatch(/"(?:data|base64|url|mimeType)"\s*:/)
    expect(JSON.parse(bytes).expectedContent).toEqual(originalExpected)
    const recovered = new MessageEditTransactions(restored)
    recovered.claim(f.agent, f.queued, 2, 1)
    f.session.append('turn/start', { turn: 2 })
    f.session.append('step/start', { turn: 2, step: 1 })
    expect(await recovered.commit(f.agent, 2, 1, new AbortController().signal, f.flush)).toBe(true)
    f.session.append('user/message', f.queued[0]!, { surfaceOp: 'append' })
    expect(f.session.deriveMessages().flatMap((message) => message.content)).toEqual([
      { type: 'text', text: 'instructions' },
      ...originalExpected,
    ])
    expect(f.session.snapshotEvents()).toContainEqual(f.original)
    expect(unresolvedMessageEdit(f.session.snapshotEvents())).toBe(false)
  })

  it.each(['missing-image', 'reordered-images', 'replaced-image', 'different-request'] as const)(
    'refuses %s before replacing history or flushing an image edit',
    async (kind) => {
      const f = await fixture()
      await f.edits.send(f.agent, f.input, f.admit, f.expected)
      const content: HarnessPromptPart[] = structuredClone(f.expected)
      if (kind === 'missing-image') content.pop()
      if (kind === 'reordered-images') [content[1], content[2]] = [content[2]!, content[1]!]
      if (kind === 'replaced-image') content[1] = { type: 'image', attachment: image('3') }
      const message = createUserMessage({
        source: {
          kind: 'user',
          rpcId: kind === 'different-request' ? 'unrelated-request' : f.input.prompt.requestId,
        },
        content,
      })
      const before = f.session.seq
      expect(() => f.edits.claim(f.agent, [message], 2, 1)).toThrow('发送内容尚未确认')
      await expect(
        f.edits.commit(f.agent, 2, 1, new AbortController().signal, f.flush),
      ).rejects.toThrow('尚未确认')
      expect(f.session.seq).toBe(before)
      expect(f.flush).not.toHaveBeenCalled()
      expect(unresolvedMessageEdit(f.session.snapshotEvents())).toBe(false)
      expect(f.store.get(f.session.id)?.expectedContent).toEqual(f.expected)
    },
  )

  it('claims the actual normalized admission metadata rather than the older image reference', async () => {
    const f = await fixture()
    const expected: HarnessPromptPart[] = structuredClone(f.expected)
    expected[1] = {
      type: 'image',
      attachment: {
        ...image('4'),
        bytes: 3,
        width: 1,
        height: 1,
        originalDimensions: { width: 2, height: 2 },
      },
    }
    const admit = async () => {
      f.queued.push(
        createUserMessage({
          source: { kind: 'user', rpcId: f.input.prompt.requestId },
          content: expected,
        }),
      )
      return { accepted: true as const }
    }
    await f.edits.send(f.agent, f.input, admit, expected)
    const oldMetadata = createUserMessage({
      source: { kind: 'user', rpcId: f.input.prompt.requestId },
      content: f.expected,
    })
    expect(() => f.edits.claim(f.agent, [oldMetadata], 2, 1)).toThrow('发送内容尚未确认')
    const restored = await reloadStore(f.root)
    expect(restored.get(f.session.id)?.expectedContent).toEqual(expected)
    expect(() => new MessageEditTransactions(restored).claim(f.agent, f.queued, 2, 1)).not.toThrow()
    expect(f.session.snapshotEvents()).toContainEqual(f.original)
  })

  it('cancels a failed official image admission without changing the original message', async () => {
    const f = await fixture(),
      before = f.session.seq
    await expect(
      f.edits.send(
        f.agent,
        f.input,
        async () => {
          throw Error('attachment admission failed')
        },
        f.expected,
      ),
    ).rejects.toThrow('attachment admission failed')
    const restored = await reloadStore(f.root)
    expect(restored.get(f.session.id)).toMatchObject({
      phase: 'cancelled',
      expectedContent: f.expected,
    })
    expect(f.session.seq).toBe(before)
    expect(f.session.snapshotEvents()).toContainEqual(f.original)
    expect(f.edits.pending(f.session.id)).toBe(false)
  })

  it('recovers the persisted image expectation after a marker was flushed but the official message was not logged', async () => {
    const f = await fixture()
    await f.edits.send(f.agent, f.input, f.admit, f.expected)
    f.edits.claim(f.agent, f.queued, 2, 1)
    f.session.append('turn/start', { turn: 2 })
    f.session.append('step/start', { turn: 2, step: 1 })
    await f.edits.commit(f.agent, 2, 1, new AbortController().signal, f.flush)
    const seed = JSON.parse(await readFile(f.eventFile, 'utf8')) as SessionEvent[]
    const session = Session.create(f.session.id, seed)
    const store = await reloadStore(f.root)
    const agent = agentFor(session)
    const recovered = new MessageEditTransactions(store)
    const recovery = recovered.recovery(session)
    const before = session.seq
    expect(recovery).toEqual(f.input)
    expect(recovery?.prompt.content).toEqual([{ type: 'text', text: 'edited question' }])
    await recovered.recoverUnadmitted(agent)
    expect(session.seq).toBe(before)
    expect(store.get(session.id)?.phase).toBe('committed')
    const admit = vi.fn(async () => {
      agent.inbox.nextTurn.push(
        createUserMessage({
          source: { kind: 'user', rpcId: f.input.prompt.requestId },
          content: structuredClone(store.get(session.id)!.expectedContent!),
        }),
      )
      return { accepted: true as const }
    })
    await expect(
      recovered.send(
        agent,
        {
          ...f.input,
          prompt: { ...f.input.prompt, content: [{ type: 'text', text: 'different retry' }] },
        },
        admit,
      ),
    ).rejects.toThrow('发送身份')
    expect(admit).not.toHaveBeenCalled()
    await recovered.send(agent, recovery!, admit)
    recovered.claim(agent, agent.inbox.nextTurn, 3, 1)
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    await recovered.commit(agent, 3, 1, new AbortController().signal, async () => true)
    session.append('user/message', agent.inbox.nextTurn[0]!, { surfaceOp: 'append' })
    expect(admit).toHaveBeenCalledTimes(1)
    expect(
      session
        .snapshotEvents()
        .filter(
          (event) =>
            event.type === 'system/message' && messageEditMarker(event.data.message.source),
        ),
    ).toHaveLength(1)
    expect(session.deriveMessages().flatMap((message) => message.content)).toEqual([
      { type: 'text', text: 'instructions' },
      ...f.expected,
    ])
    expect(session.snapshotEvents()).toContainEqual(f.original)
    expect(unresolvedMessageEdit(session.snapshotEvents())).toBe(false)
    expect(recovered.recovery(session)).toBeUndefined()
  })

  it('rejects a journal whose expected image content contains wire bytes instead of immutable references', async () => {
    const f = await fixture()
    await f.edits.send(f.agent, f.input, f.admit, f.expected)
    const raw = JSON.parse(await readFile(f.journalFile, 'utf8'))
    raw.expectedContent = [
      { type: 'text', text: 'edited question' },
      { type: 'image', mediaType: 'image/png', data: 'c2FmZQ==' },
    ]
    const bytes = JSON.stringify(raw)
    await writeFile(f.journalFile, bytes)
    await expect(reloadStore(f.root)).rejects.toThrow('记录损坏')
    expect(await readFile(f.journalFile, 'utf8')).toBe(bytes)
  })
})
