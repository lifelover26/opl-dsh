/** Durable vendor-edit journal, separate from the official Session event format. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  validateExternalEditResult,
  type ExternalEditIntent,
  type ExternalEditJournal,
} from './message-edit-external.ts'

const nonempty = z.string().min(1)
const boundary = z.object({
  id: nonempty,
  text: z.string().optional(),
  unavailableReason: nonempty.optional(),
})
const schema = z
  .object({
    version: z.literal(1),
    sessionId: nonempty,
    recordId: nonempty,
    requestId: nonempty,
    fingerprint: nonempty,
    previousSessionId: nonempty,
    targetId: nonempty,
    targetSeq: z.number().int().nonnegative().optional(),
    expected: z.object({
      sessionId: nonempty,
      token: nonempty,
      boundaries: z.array(boundary),
      settledInputId: nonempty.optional(),
    }),
    phase: z.enum(['invoking', 'ready', 'admitting', 'prompting', 'settled', 'uncertain']),
    result: z
      .object({
        sessionId: nonempty,
        retained: z.array(z.object({ previousId: nonempty, nextId: nonempty })),
        ephemeral: z.boolean().optional(),
      })
      .optional(),
  })
  .strict()

/** Refuse malformed durable state without discarding its file or allowing a new prompt. */
export function parseExternalEditIntent(value: unknown): ExternalEditIntent {
  const result = schema.safeParse(value)
  if (!result.success) throw Error('外部编辑记录损坏，原文件已保留')
  const item = result.data
  if (
    item.previousSessionId !== item.expected.sessionId ||
    !item.expected.boundaries.some((entry) => entry.id === item.targetId) ||
    new Set(item.expected.boundaries.map((entry) => entry.id)).size !==
      item.expected.boundaries.length ||
    (['ready', 'admitting', 'prompting', 'settled'].includes(item.phase) && !item.result) ||
    (item.expected.settledInputId !== undefined &&
      item.expected.settledInputId !== item.expected.boundaries.at(-1)?.id)
  )
    throw Error('外部编辑记录的历史身份不一致')
  const { result: prepared, targetSeq, ...base } = item
  const { settledInputId, ...expected } = item.expected
  const parsed: ExternalEditIntent = {
    ...base,
    ...(targetSeq === undefined ? {} : { targetSeq }),
    expected: {
      ...expected,
      ...(settledInputId !== undefined ? { settledInputId } : {}),
      boundaries: item.expected.boundaries.map((entry) => ({
        id: entry.id,
        ...(entry.text !== undefined ? { text: entry.text } : {}),
        ...(entry.unavailableReason !== undefined
          ? { unavailableReason: entry.unavailableReason }
          : {}),
      })),
    },
    ...(prepared
      ? {
          result: {
            sessionId: prepared.sessionId,
            retained: prepared.retained,
            ...(prepared.ephemeral !== undefined ? { ephemeral: prepared.ephemeral } : {}),
          },
        }
      : {}),
  }
  if (parsed.result) validateExternalEditResult(parsed.expected, parsed.targetId, parsed.result)
  return parsed
}

export class FileExternalEditJournal implements ExternalEditJournal {
  private readonly directory: string
  private readonly rows = new Map<string, ExternalEditIntent>()
  private queue: Promise<void> = Promise.resolve()
  private failed = false

  constructor(home: string) {
    this.directory = join(home, 'profiles/desktop/external-message-edit-intents')
  }

  private filename(id: string): string {
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json')
  }

  async load(): Promise<void> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const next = new Map<string, ExternalEditIntent>()
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const item = parseExternalEditIntent(
        JSON.parse(await readFile(join(this.directory, name), 'utf8')),
      )
      if (this.filename(item.sessionId) !== join(this.directory, name))
        throw Error('外部编辑记录的会话身份不符')
      next.set(item.sessionId, item)
    }
    this.rows.clear()
    for (const [id, item] of next) this.rows.set(id, item)
  }

  get(sessionId: string): ExternalEditIntent | undefined {
    if (this.failed) throw Error('外部编辑记录未能保存，请重新启动后核对')
    const item = this.rows.get(sessionId)
    return item && structuredClone(item)
  }

  async save(input: ExternalEditIntent): Promise<void> {
    const item = parseExternalEditIntent(input)
    // Keep a conservative in-memory guard even if writing this stage fails.
    this.rows.set(item.sessionId, structuredClone(item))
    const write = this.queue.then(async () => {
      if (this.failed) throw Error('外部编辑记录未能保存，请重新启动后核对')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const filename = this.filename(item.sessionId)
      const temporary = filename + '.' + randomUUID() + '.tmp'
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(item))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, filename)
    })
    this.queue = write.catch(() => {
      this.failed = true
    })
    await write
  }

  async drain(): Promise<void> {
    await this.queue
    if (this.failed) throw Error('外部编辑记录未能保存')
  }
}
