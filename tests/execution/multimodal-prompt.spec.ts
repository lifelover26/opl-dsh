import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  offloadedImageText,
  ToolCallId,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import {
  AttachmentId,
  type AttachmentStore,
  type ImageAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import type { HarnessSession } from '../../src/execution/contracts/sessions.ts'
import type { HarnessPromptPart } from '../../src/execution/contracts/prompt.ts'
import {
  HISTORY_NOTICE,
  assertPromptImages,
  conversationInput,
  resolvePromptContent,
  validPromptContent,
} from '../../src/execution/host/multimodal-prompt.ts'
import { HarnessSessionStore } from '../../src/execution/host/session-store.ts'
import { HARNESS_INPUT_MAX_LENGTH } from '../../src/execution/host/harness-input.ts'

const tempDirectory = tmpdir()
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function temporary() {
  await mkdir(tempDirectory, { recursive: true })
  const root = await mkdtemp(join(tempDirectory, 'prompt-'))
  roots.push(root)
  return root
}

function image(digit: string, name = digit + '.png'): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:' + digit.repeat(64)),
    mediaType: 'image/png',
    bytes: 4,
    width: 2,
    height: 2,
    name,
  }
}

const first = image('1')
const second = image('2')
const picture = (attachment: ImageAttachmentRef): HarnessPromptPart => ({
  type: 'image',
  attachment,
})
const text = (value: string): HarnessPromptPart => ({ type: 'text', text: value })

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('external prompt projection', () => {
  it('validates current text before history or role labels can hide blank or malformed input', () => {
    const older = createUserMessage({ source: { kind: 'user' }, content: [text('old input')] })
    const current = structuredClone(
      createUserMessage({ source: { kind: 'user' }, content: [text(' \n\t')] }),
    )
    expect(() => conversationInput([older, current], current)).toThrow(
      'stage=conversation-current; reason=blank',
    )
    ;(current.content[0] as { text: unknown }).text = { secret: 'never-print-input' }
    expect(() => conversationInput([older, current], current)).toThrow(
      'stage=conversation-current; reason=type',
    )
    expect(() => conversationInput([older, current], current)).not.toThrow('never-print-input')
  })

  it('refuses non-text historical blocks without coercing them into the transcript', () => {
    const older = structuredClone(
      createUserMessage({ source: { kind: 'user' }, content: [text('old input')] }),
    )
    const current = createUserMessage({ source: { kind: 'user' }, content: [text('运行')] })
    ;(older.content[0] as { text: unknown }).text = 42
    expect(() => conversationInput([older, current], current)).toThrow(
      'stage=conversation-first-binding; reason=type; currentTextLength=2',
    )
  })

  it('refuses oversized saved text before reading any image bytes', async () => {
    const readImage = vi.fn<AttachmentStore['readImage']>()
    const content = [picture(first), text('x'.repeat(HARNESS_INPUT_MAX_LENGTH + 1))]
    await expect(resolvePromptContent({ readImage }, content)).rejects.toMatchObject({
      code: 'HARNESS_INPUT',
      message: expect.stringContaining('stage=stored-prompt; reason=too-long'),
    })
    expect(readImage).not.toHaveBeenCalled()
  })

  it('keeps the existing text transcript, including injected context, tool calls and failed results', () => {
    const injected = createUserMessage({
      source: { kind: 'working-directory' },
      content: [text('project context')],
    })
    const earlier = createUserMessage({
      source: { kind: 'user' },
      content: [text('first request')],
    })
    const assistant = createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture-model' },
      content: [
        { type: 'reasoning', text: 'not transcript text' },
        text('earlier response'),
        {
          type: 'tool-call',
          id: ToolCallId('call-1'),
          name: 'shell',
          arguments: '{"command":"pwd"}',
        },
      ],
    })
    const tool = createToolResultMessage({
      callId: ToolCallId('call-1'),
      isError: true,
      content: [text('permission denied')],
    })
    const current = createUserMessage({
      source: { kind: 'user' },
      content: [text('current request')],
    })
    const messages: GenerateOptions['messages'] = [
      createSystemMessage('system stays outside transcript'),
      createDeveloperMessage({
        source: { kind: 'tool-registry' },
        content: [text('developer stays outside transcript')],
      }),
      injected,
      earlier,
      assistant,
      tool,
      current,
    ]
    expect(conversationInput(messages, current)).toEqual({
      text:
        '会话上下文：\nuser: project context\n\n' +
        HISTORY_NOTICE +
        '\n\nuser: first request\n\nassistant: earlier response\n历史工具调用 shell (call-1): {"command":"pwd"}' +
        '\n\ntool (call-1, failed): permission denied\n\n当前用户请求：\nuser: current request',
    })
    expect(conversationInput([current], current)).toEqual({ text: 'user: current request' })
    expect(conversationInput([injected, current], current)).toEqual({
      text: '会话上下文：\nuser: project context\n\n当前用户请求：\nuser: current request',
    })
  })

  it('retains image order among history and current text without mutating official blocks', () => {
    const older = createUserMessage({
      source: { kind: 'user' },
      content: [text('earlier'), picture(first)],
    })
    const current = createUserMessage({
      source: { kind: 'user' },
      content: [text('before'), picture(second), text('after')],
    })
    const before = JSON.stringify([older, current])
    const input = conversationInput([older, current], current)
    expect(input.content).toEqual([
      text(HISTORY_NOTICE + '\n\nuser: earlier\n'),
      picture(first),
      text('\n\n当前用户请求：\nuser: before\n'),
      picture(second),
      text('\nafter'),
    ])
    expect(input.text).toBe(
      HISTORY_NOTICE +
        '\n\nuser: earlier\n[图片附件]\n\n当前用户请求：\nuser: before\n[图片附件]\nafter',
    )
    expect(JSON.stringify([older, current])).toBe(before)
    expect(input.content?.[1]).not.toBe(older.content[1])
    expect(input.text).not.toContain(first.attachmentId)
  })

  it('keeps offloaded images as the official omission text and never rereads their bytes', async () => {
    const current = createUserMessage({
      source: { kind: 'user' },
      content: [text('describe'), { type: 'image', attachment: first, offloaded: true }],
    })
    const input = conversationInput([current], current)
    expect(input).toEqual({ text: 'user: describe\n' + offloadedImageText(first) })
    const readImage = vi.fn<AttachmentStore['readImage']>()
    await expect(resolvePromptContent({ readImage }, [text(input.text)])).resolves.toEqual([
      text(input.text),
    ])
    expect(readImage).not.toHaveBeenCalled()
    expect(() => assertPromptImages([text(input.text)], false, undefined)).not.toThrow()
  })

  it.each([
    [false, true, '模型来源'],
    [undefined, true, '模型来源'],
    [true, false, 'Harness'],
    [true, undefined, 'Harness'],
  ] as const)(
    'requires both source (%s) and connected CLI (%s) image support',
    (source, cli, message) => {
      expect(() =>
        assertPromptImages(
          [picture(first)],
          source,
          cli === undefined
            ? undefined
            : { agentCapabilities: { promptCapabilities: { image: cli } } },
        ),
      ).toThrow(message)
    },
  )

  it('admits images only when both capabilities are explicit and leaves text routes usable', () => {
    expect(() =>
      assertPromptImages([picture(first)], true, {
        agentCapabilities: { promptCapabilities: { image: true } },
      }),
    ).not.toThrow()
    expect(() => assertPromptImages([text('text only')], undefined, undefined)).not.toThrow()
    expect(() =>
      assertPromptImages([picture(first)], true, { promptCapabilities: { image: true } }),
    ).toThrow('Harness')
  })

  it('reads immutable references in order and carries only encoded bytes on the ACP wire', async () => {
    const signal = new AbortController().signal
    const readImage = vi.fn<AttachmentStore['readImage']>(async (ref) => ({
      ref,
      data: Buffer.from(ref === first ? 'one!' : 'two!'),
    }))
    const content = [
      text('before'),
      picture(first),
      text('between'),
      picture(second),
      text('after'),
    ]
    await expect(resolvePromptContent({ readImage }, content, signal)).resolves.toEqual([
      text('before'),
      { type: 'image', data: Buffer.from('one!').toString('base64'), mimeType: 'image/png' },
      text('between'),
      { type: 'image', data: Buffer.from('two!').toString('base64'), mimeType: 'image/png' },
      text('after'),
    ])
    expect(readImage.mock.calls).toEqual([
      [first, signal],
      [second, signal],
    ])
    expect(content).toEqual([
      text('before'),
      picture(first),
      text('between'),
      picture(second),
      text('after'),
    ])
  })

  it('stops before a read if cancelled and rechecks cancellation before exposing completed bytes', async () => {
    const entered = deferred(),
      release = deferred(),
      controller = new AbortController()
    const reason = Error('cancelled image request')
    const readImage = vi.fn<AttachmentStore['readImage']>(async (ref) => {
      entered.resolve()
      await release.promise
      return { ref, data: Buffer.from('one!') }
    })
    const pending = resolvePromptContent(
      { readImage },
      [picture(first), picture(second)],
      controller.signal,
    )
    await entered.promise
    controller.abort(reason)
    release.resolve()
    await expect(pending).rejects.toBe(reason)
    expect(readImage).toHaveBeenCalledTimes(1)
    readImage.mockClear()
    await expect(
      resolvePromptContent({ readImage }, [picture(first)], controller.signal),
    ).rejects.toBe(reason)
    expect(readImage).not.toHaveBeenCalled()
  })

  it('fails missing storage or an unavailable attachment without skipping that image', async () => {
    await expect(resolvePromptContent(undefined, [picture(first)])).rejects.toMatchObject({
      code: 'HARNESS_INPUT',
    })
    const unavailable = Error('immutable attachment is missing')
    const readImage = vi.fn<AttachmentStore['readImage']>().mockRejectedValue(unavailable)
    await expect(
      resolvePromptContent({ readImage }, [picture(first), picture(second)]),
    ).rejects.toBe(unavailable)
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('uses attachment storage rather than local paths or URLs attached as display metadata', async () => {
    const root = await temporary()
    const filename = join(root, 'local-only.txt')
    await writeFile(filename, 'must never become image bytes')
    const fileUrl = pathToFileURL(filename).href
    const ref = image('3', fileUrl)
    const foreign = { ...picture(ref), url: fileUrl, path: filename }
    const fetch = vi.fn(() => {
      throw Error('unexpected URL read')
    })
    vi.stubGlobal('fetch', fetch)
    const readImage = vi.fn<AttachmentStore['readImage']>(async (attachment) => ({
      ref: attachment,
      data: Buffer.from('safe'),
    }))
    await expect(resolvePromptContent({ readImage }, [foreign])).resolves.toEqual([
      { type: 'image', data: Buffer.from('safe').toString('base64'), mimeType: 'image/png' },
    ])
    expect(readImage).toHaveBeenCalledWith(ref, undefined)
    expect(fetch).not.toHaveBeenCalled()
    expect(validPromptContent([{ type: 'image', url: fileUrl }])).toBe(false)
    const file = createUserMessage({
      source: { kind: 'user' },
      content: [
        {
          type: 'file',
          attachment: { attachmentId: first.attachmentId, name: filename, bytes: 1 },
        },
      ],
    })
    expect(() => conversationInput([file], file)).toThrow('不支持直接文件附件')
  })
})

describe('durable multimodal input', () => {
  function record(root: string): HarnessSession {
    return {
      id: 'multimodal-persisted',
      combination: 'codex/fixture-model',
      harnessRef: 'codex',
      modelRef: { provider: 'fixture', model: 'fixture-model' },
      cwd: root,
      acpSessionId: 'fixture-acp',
      origin: { kind: 'desktop', sessionId: 'fixture-session' },
      title: 'image question',
      sandbox: 'read-only',
      createdAt: '2026-11-05T00:00:00.000Z',
      updatedAt: '2026-11-05T00:00:00.000Z',
      turns: [
        {
          operationId: 'image-operation',
          fingerprint: 'image-fingerprint',
          prompt: 'before[图片附件]after',
          promptContent: [text('before'), picture(first), text('after')],
          text: 'response',
          state: 'completed',
          tools: [],
        },
      ],
    }
  }

  it('reloads ordered attachment references while keeping base64 and image bytes off disk', async () => {
    const root = await temporary(),
      session = record(root),
      store = new HarnessSessionStore(root)
    const original = structuredClone(session)
    try {
      const writing = store.saveChanged([session])
      session.turns[0]!.promptContent!.push(picture(second))
      await writing
      const serialized = await readFile(store.filename(session.id), 'utf8')
      expect(serialized).not.toMatch(/"(?:data|base64|url|mimeType)"\s*:/)
      expect(JSON.parse(serialized)).toEqual(original)
      const loaded = await new HarnessSessionStore(root).load()
      expect(loaded).toEqual([original])
      const readImage = vi.fn<AttachmentStore['readImage']>(async (ref) => ({
        ref,
        data: Buffer.from('safe'),
      }))
      await expect(
        resolvePromptContent({ readImage }, loaded[0]!.turns[0]!.promptContent!),
      ).resolves.toEqual([
        text('before'),
        { type: 'image', data: Buffer.from('safe').toString('base64'), mimeType: 'image/png' },
        text('after'),
      ])
    } finally {
      await store.dispose()
    }
  })

  it('keeps older text-only turns without adding promptContent on reload', async () => {
    const root = await temporary(),
      session = record(root),
      store = new HarnessSessionStore(root)
    delete session.turns[0]!.promptContent
    session.turns[0]!.prompt = 'legacy text'
    try {
      await store.saveChanged([session])
      const [loaded] = await new HarnessSessionStore(root).load()
      expect(loaded).toEqual(session)
      expect(loaded!.turns[0]).not.toHaveProperty('promptContent')
    } finally {
      await store.dispose()
    }
  })

  it.each([
    { name: 'wire bytes', content: [{ type: 'image', data: 'c2FmZQ==', mimeType: 'image/png' }] },
    { name: 'file URL', content: [{ type: 'image', url: 'file:///untrusted/image.png' }] },
    {
      name: 'invalid byte length',
      content: [{ type: 'image', attachment: { ...first, bytes: -1 } }],
    },
    {
      name: 'null original dimensions',
      content: [{ type: 'image', attachment: { ...first, originalDimensions: null } }],
    },
  ])(
    'rejects $name in persisted image input and preserves the record for repair',
    async ({ content }) => {
      expect(validPromptContent(content)).toBe(false)
      const root = await temporary(),
        session = record(root),
        store = new HarnessSessionStore(root)
      try {
        await store.saveChanged([session])
        const bytes = JSON.stringify({
          ...session,
          turns: [{ ...session.turns[0], promptContent: content }],
        })
        await writeFile(store.filename(session.id), bytes)
        await expect(new HarnessSessionStore(root).load()).rejects.toThrow('图片输入记录无效')
        expect(await readFile(store.filename(session.id), 'utf8')).toBe(bytes)
      } finally {
        await store.dispose()
      }
    },
  )
})
