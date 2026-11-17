/** Conversation choices for CLI effort IDs, separate from provider request controls. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { oplProfilePath } from '../../shared/host/profile-paths.ts'

export class ExternalEffortStore {
  private values: Record<string, string | null> = {}
  private queue: Promise<void> = Promise.resolve()
  private readonly filename: string
  readonly ready: Promise<void>
  constructor(home: string) {
    this.filename = oplProfilePath(home, 'external-effort-selection.json')
    this.ready = this.load()
  }
  private async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filename, 'utf8'))
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some(
          (v) => v !== null && (typeof v !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(v)),
        )
      )
        throw Error('外部推理档位记录无效，原文件已保留')
      this.values = value as Record<string, string | null>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  /** Read an exact Session/combination choice; null explicitly selects the CLI default. */
  get(sessionId: string, combination: string): string | null | undefined {
    return this.values[JSON.stringify([sessionId, combination])]
  }
  /** Publish only after the atomic write succeeds; validate current ownership before writing. */
  async set(
    sessionId: string,
    combination: string,
    effort: string | undefined,
    current: () => void,
  ): Promise<void> {
    await this.ready
    const write = this.queue.then(async () => {
      current()
      const values = { ...this.values, [JSON.stringify([sessionId, combination])]: effort ?? null }
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      const temp = this.filename + '.' + randomUUID()
      await writeFile(temp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 })
      current()
      await rename(temp, this.filename)
      this.values = values
    })
    this.queue = write.catch(() => {})
    await write
  }
  /** Drain owned persistence before Host disposal. */
  async drain(): Promise<void> {
    await this.queue
  }
}
