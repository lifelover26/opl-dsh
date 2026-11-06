import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  AttachmentId,
  AttachmentStore,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessService } from '../../src/execution/host/harness.ts'
import type { MessageEditSend } from '../../src/execution/contracts/message-edit.ts'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
)
const image: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:' + createHash('sha256').update(png).digest('hex')),
  mediaType: 'image/png',
  bytes: png.length,
  width: 1,
  height: 1,
  name: 'fixture.png',
}

/** In-memory bytes with the official AttachmentStore batch admission implementation. */
class FixtureAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1024,
    maxImagePixels: 1,
    maxImageDimension: 1,
    mediaTypes: ['image/png'],
  }
  readonly validateImage = vi.fn(async (input: SaveImageAttachment) => {
    expect(Buffer.from(input.data)).toEqual(png)
    expect(input.mediaType).toBe('image/png')
  })
  readonly saveImage = vi.fn(async (input: SaveImageAttachment) => ({
    ...image,
    ...(input.name ? { name: input.name } : {}),
  }))
  readonly readImage = vi.fn(async (ref: ImageAttachmentRef, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    expect(ref).toEqual(image)
    return { ref, data: png }
  })
}

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

async function fixture(withAttachments = true) {
  const home = await mkdtemp(join(tmpdir(), 'opl-edit-context-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  let attachments: FixtureAttachments | undefined
  if (withAttachments)
    await root.plugin({
      name: 'fixture-attachments',
      apply(ctx: Context) {
        attachments = new FixtureAttachments(ctx)
      },
    })
  const session = Session.create(SessionId('image-edit-context'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const original = session.append(
    'user/message',
    createUserMessage({
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'original' },
        { type: 'image', attachment: image },
      ],
    }),
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const abort = new AbortController()
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    inbox: { nextTurn: [] as UserMessage[], nextStep: [], remove: vi.fn() },
    runMaintenance: async (run: (signal: AbortSignal) => Promise<unknown>) => run(abort.signal),
  }
  const prompt = vi.fn(async (request: SessionPromptRequest) => {
    const content = await attachments!.admitPromptContent(request.content)
    agent.inbox.nextTurn.push(
      createUserMessage({ source: { kind: 'user', rpcId: request.requestId }, content }),
    )
    return { accepted: true as const }
  })
  await root.plugin({
    name: 'fixture-session-services',
    apply(ctx: Context) {
      ctx.provide('sessions', { get: () => session, list: () => [] })
      ctx.provide('agents', { get: () => agent, list: () => [agent] })
      ctx.provide('sessionProjections', { snapshot: () => ({ values: {} }) })
      ctx.provide('sessionController', { resolveAgent: async () => ({ agent }), prompt })
    },
  })
  let service!: HarnessService
  let context!: Context
  await root.plugin({
    name: 'fixture-execution',
    inject: ['sessions', 'agents', 'sessionProjections', 'sessionController'],
    apply(ctx: Context) {
      context = ctx
      service = new HarnessService(ctx, { home })
      ctx.effect(() => () => service.dispose())
    },
  })
  const input: MessageEditSend = {
    targetSeq: Number(original.seq),
    head: Number(session.seq) - 1,
    prompt: {
      sessionId: session.id,
      requestId: 'replacement' as MessageEditSend['prompt']['requestId'],
      mode: 'queue',
      content: [{ type: 'text', text: 'edited question' }],
    },
  }
  return { service, context, attachments, session, agent, input, prompt, abort }
}

describe('image editing from an official Cordis plugin context', () => {
  it('admits the retained image without requiring a direct attachments injection', async () => {
    const f = await fixture()
    expect(() => f.context.attachments).toThrow('without inject')
    const before = f.session.snapshotEvents()
    await expect(f.service.messageEditSend(f.input)).resolves.toEqual({ accepted: true })
    expect(f.attachments!.readImage).toHaveBeenCalledTimes(1)
    expect(f.attachments!.saveImage).toHaveBeenCalledTimes(2)
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith(
      {
        ...f.input.prompt,
        content: [
          { type: 'text', text: 'edited question' },
          { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: image.name },
        ],
      },
      f.abort.signal,
    )
    expect(f.agent.inbox.nextTurn[0]!.content).toEqual([
      { type: 'text', text: 'edited question' },
      { type: 'image', attachment: image },
    ])
    expect(f.session.snapshotEvents()).toEqual(before)
  })

  it('refuses a missing attachment service before prompt admission or history changes', async () => {
    const f = await fixture(false)
    const before = f.session.snapshotEvents()
    await expect(f.service.messageEditSend(f.input)).rejects.toMatchObject({
      code: 'HARNESS_INPUT',
    })
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.agent.inbox.nextTurn).toEqual([])
    expect(f.session.snapshotEvents()).toEqual(before)
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: false,
    })
  })

  it('preserves official image policy refusal before prompt admission or history changes', async () => {
    const f = await fixture()
    f.attachments!.imageLimits.maxImagesPerMessage = 0
    const before = f.session.snapshotEvents()
    await expect(f.service.messageEditSend(f.input)).rejects.toMatchObject({
      code: 'TOO_MANY_IMAGES',
    })
    expect(f.attachments!.saveImage).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents()).toEqual(before)
    expect(await f.service.messageEditState({ sessionId: f.session.id })).toMatchObject({
      pending: false,
    })
  })

  it('stops after an image read completes under cancellation', async () => {
    const f = await fixture()
    const reason = Error('Edit maintenance cancelled')
    f.attachments!.readImage.mockImplementationOnce(async (ref) => {
      f.abort.abort(reason)
      return { ref, data: png }
    })
    const before = f.session.snapshotEvents()
    await expect(f.service.messageEditSend(f.input)).rejects.toBe(reason)
    expect(f.attachments!.saveImage).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents()).toEqual(before)
  })
})
