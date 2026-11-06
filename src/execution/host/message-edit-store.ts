/** Owned edit admission records; official Session logs remain append-only. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { MessageEditSend } from '../contracts/message-edit.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { validPromptContent } from './multimodal-prompt.ts'

export interface EditIntent {
  version: 1
  input: MessageEditSend
  surface: number[]
  phase: 'prepared' | 'committed' | 'cancelled'
  /** Logged input expected after the official controller admits the retained image bytes. */
  expectedContent?: UserMessage['content']
}
/** Parse durable input without adopting a malformed target or submission. */
function parse(value: unknown): EditIntent {
  const item = value as Partial<EditIntent> | null
  if (
    !item ||
    item.version !== 1 ||
    !['prepared', 'committed', 'cancelled'].includes(item.phase ?? '') ||
    !Array.isArray(item.surface) ||
    !item.surface.every((seq) => Number.isSafeInteger(seq) && seq >= 0) ||
    !item.input ||
    !Number.isSafeInteger(item.input.targetSeq) ||
    item.input.targetSeq < 0 ||
    !Number.isSafeInteger(item.input.head) ||
    item.input.head < item.input.targetSeq ||
    typeof item.input.prompt?.sessionId !== 'string' ||
    !item.input.prompt.sessionId ||
    typeof item.input.prompt.requestId !== 'string' ||
    !item.input.prompt.requestId ||
    item.input.prompt.mode !== 'queue' ||
    !Array.isArray(item.input.prompt.content) ||
    !item.input.prompt.content.length ||
    (item.expectedContent !== undefined && !validPromptContent(item.expectedContent)) ||
    !item.input.prompt.content.every(
      (part) => part.type === 'text' && typeof part.text === 'string',
    )
  )
    throw Error('编辑消息的记录损坏，原文件已保留')
  return item as EditIntent
}
export class MessageEditStore {
  private readonly directory: string
  private readonly records = new Map<string, EditIntent>()
  private queue = Promise.resolve()
  constructor(home: string) {
    this.directory = join(home, 'profiles/desktop/message-edit-intents')
  }
  private filename(id: string) {
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json')
  }
  async load(): Promise<void> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const item = parse(JSON.parse(await readFile(join(this.directory, name), 'utf8')))
      if (this.filename(item.input.prompt.sessionId) !== join(this.directory, name))
        throw Error('编辑消息记录的身份不符')
      this.records.set(item.input.prompt.sessionId, item)
    }
  }
  get(id: string): EditIntent | undefined {
    return this.records.get(id)
  }
  async save(item: EditIntent): Promise<void> {
    this.records.set(item.input.prompt.sessionId, item)
    const write = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const filename = this.filename(item.input.prompt.sessionId)
      const temp = filename + '.' + randomUUID() + '.tmp'
      await writeFile(temp, JSON.stringify(item), { flag: 'wx', mode: 0o600 })
      await rename(temp, filename)
    })
    this.queue = write.catch(() => {
      /* The caller receives the failure; preserve in-memory refusal. */
    })
    await write
  }
  async drain(): Promise<void> {
    await this.queue
  }
}
