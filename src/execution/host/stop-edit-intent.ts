/**
 * 停止后编辑的持久意图台账。
 *
 * 编辑请求在改动任何会话之前先落盘，提交之后再落一次：进程重启、回复丢失或 Runtime
 * 部分成功时，靠它区分“什么都没发生”“已经完成”和“结果不确定”，避免盲重发与错误
 * 上下文续发。候选 Runtime 的 operation 台账是进程内状态，不能替代这里。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { oplProfilePath } from '../../shared/host/profile-paths.ts'
import type { StopEditIntent, StopEditResult } from '../contracts/stop-edit.ts'
import { StopEditError } from './stop-edit.ts'

const PHASES: readonly StopEditIntent['phase'][] = [
  'planned',
  'rewinding',
  'committed',
  'uncertain',
]

/**
 * 逐字段校验；缺任何一项都拒绝整条记录，而不是补默认值——恢复期的判断必须基于事实。
 */
function parseIntent(raw: unknown): StopEditIntent {
  const item = raw as Record<string, any>
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw Error('停止后编辑意图记录损坏，原文件已保留')
  if (
    ['sessionId', 'clientRequestId', 'boundaryId', 'pendingOperationId'].some(
      (key) => typeof item[key] !== 'string' || !item[key],
    ) ||
    !PHASES.includes(item.phase) ||
    typeof item.preservedSessionId !== 'string' ||
    !Number.isFinite(Date.parse(item.at)) ||
    !Number.isFinite(Date.parse(item.updatedAt))
  )
    throw Error('停止后编辑意图记录无效，原文件已保留')
  if (item.phase === 'committed' && (!item.result || typeof item.result !== 'object'))
    throw Error('停止后编辑意图记录无效，原文件已保留')
  if (item.phase === 'uncertain' && typeof item.reason !== 'string')
    throw Error('停止后编辑意图记录无效，原文件已保留')
  return item as StopEditIntent
}

export class StopEditIntentStore {
  readonly directory: string
  private readonly persisted = new Map<string, string>()
  private readonly records = new Map<string, StopEditIntent>()
  private queue: Promise<void> = Promise.resolve()

  constructor(home: string) {
    this.directory = oplProfilePath(home, 'stop-edit-intents')
  }

  filename(sessionId: string): string {
    return join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.json')
  }

  /** 恢复读取；文件损坏时抛出，让调用方保持不确定而不是当作没有历史。 */
  async load(): Promise<StopEditIntent[]> {
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of names.filter((item) => /^[a-f0-9]{64}\.json$/.test(item))) {
      const intent = parseIntent(JSON.parse(await readFile(join(this.directory, name), 'utf8')))
      if (this.filename(intent.sessionId) !== join(this.directory, name))
        throw Error('停止后编辑意图身份冲突，原文件已保留')
      this.records.set(intent.sessionId, intent)
      this.persisted.set(intent.sessionId, JSON.stringify(intent))
    }
    return [...this.records.values()]
  }

  get(sessionId: string): StopEditIntent | undefined {
    return this.records.get(sessionId)
  }

  private async write(intent: StopEditIntent): Promise<void> {
    this.records.set(intent.sessionId, intent)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = this.filename(intent.sessionId) + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(intent), { mode: 0o600 })
    await rename(temp, this.filename(intent.sessionId))
  }

  /** 串行落盘并只写变化过的文件；失败时把最新值放回队列，绝不丢一次意图。 */
  private async enqueue(next: StopEditIntent): Promise<StopEditIntent> {
    const bytes = JSON.stringify(next)
    const write = this.queue.then(async () => {
      if (this.persisted.get(next.sessionId) === bytes) return
      await this.write(next)
      this.persisted.set(next.sessionId, bytes)
    })
    this.queue = write.catch(() => {})
    await write
    return next
  }

  /** 在任何会话变更之前记录这次编辑的意图。 */
  plan(input: Omit<StopEditIntent, 'phase' | 'at' | 'updatedAt'>): Promise<StopEditIntent> {
    const at = new Date().toISOString()
    return this.enqueue({ ...input, phase: 'planned', at, updatedAt: at })
  }

  /**
   * 已经发起变更但还不知道结果。
   *
   * 必须在调用 Runtime/fork **之前**落盘：只有先写下“正在改”，进程被杀之后才知道这次
   * 不能当作没发生过。
   */
  markRewinding(sessionId: string): Promise<StopEditIntent> {
    const previous = this.records.get(sessionId)!
    return this.enqueue({
      ...previous,
      phase: 'rewinding',
      updatedAt: new Date().toISOString(),
    })
  }

  /**
   * 变更确实完成。
   *
   * 落两份：新的目标会话带着待填原文，旧页面只留“这次已经做完”的事实、不带原文。
   * 这样打开分支会话能取回原文，旧页面又不会把旧草稿填进仍在使用的输入框。
   */
  async markCommitted(
    nextSessionId: string,
    preservedSessionId: string,
    result: StopEditResult,
  ): Promise<StopEditIntent> {
    const source = this.records.get(preservedSessionId)
    if (source === undefined)
      throw new StopEditError('rewind-failed', '编辑意图记录缺失，无法落盘结果')
    const at = new Date().toISOString()
    const next: StopEditIntent = {
      ...source,
      sessionId: nextSessionId,
      phase: 'committed',
      result,
      at,
      updatedAt: at,
    }
    await this.enqueue(next)
    if (nextSessionId !== preservedSessionId) {
      // 旧页面保留同样的结果用于幂等返回，但没有任何待填原文。
      await this.enqueue({
        ...next,
        sessionId: preservedSessionId,
        pendingDraft: '',
      })
    }
    return next
  }

  /** 结果不确定：保留记录并阻断后续编辑，绝不谎称会话未被改动。 */
  markUncertain(sessionId: string, reason: string): Promise<StopEditIntent> {
    const previous = this.records.get(sessionId)!
    return this.enqueue({
      ...previous,
      phase: 'uncertain',
      reason,
      updatedAt: new Date().toISOString(),
    })
  }

  /** 客户端已把原文放回输入框：清空待填草稿，但保留已完成状态。 */
  async acknowledge(sessionId: string, clientRequestId: string): Promise<void> {
    const previous = this.records.get(sessionId)
    if (!previous || previous.clientRequestId !== clientRequestId) return
    await this.enqueue({ ...previous, pendingDraft: '', updatedAt: new Date().toISOString() })
  }

  async dispose(): Promise<void> {
    await this.queue
  }
}
