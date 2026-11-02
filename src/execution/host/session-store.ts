/** OPL-owned per-session persistence. The legacy journal is never changed or removed. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { HarnessSession } from '../contracts/sessions.ts'
import { DSH_COMBINATION } from '../contracts/sessions.ts'
import { harnessAllowsFullAccess } from './permissions.ts'

function parseRecord(raw: unknown): HarnessSession {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('组合会话记录损坏，原文件已保留')
  const item = raw as Record<string, any>
  if (
    ['id', 'combination', 'cwd', 'acpSessionId'].some((key) => typeof item[key] !== 'string') ||
    !item.id ||
    !item.combination ||
    !item.cwd
  )
    throw Error('组合会话记录损坏，原文件已保留')
  if (
    item.turns !== undefined &&
    (!Array.isArray(item.turns) ||
      item.turns.some(
        (turn: any) =>
          !turn ||
          typeof turn !== 'object' ||
          typeof turn.operationId !== 'string' ||
          typeof turn.state !== 'string' ||
          !Array.isArray(turn.tools),
      ))
  )
    throw Error('组合会话轮次损坏，原文件已保留')
  if (
    ['createdAt', 'updatedAt'].some(
      (key) => typeof item[key] !== 'string' || !Number.isFinite(Date.parse(item[key])),
    )
  )
    throw Error('组合会话时间记录无效，原文件已保留')
  if (item.harnessRef !== undefined && (typeof item.harnessRef !== 'string' || !item.harnessRef))
    throw Error('组合会话 Harness 引用无效，原文件已保留')
  if (item.title !== undefined && typeof item.title !== 'string')
    throw Error('组合会话标题无效，原文件已保留')
  if (item.titleFromHarness !== undefined && typeof item.titleFromHarness !== 'boolean')
    throw Error('组合会话标题来源无效，原文件已保留')
  if (
    item.sandbox !== undefined &&
    !['read-only', 'workspace', 'full-access'].includes(item.sandbox)
  )
    throw Error('组合会话权限记录无效，原文件已保留')
  if (item.externalAutoReview !== undefined && typeof item.externalAutoReview !== 'boolean')
    throw Error('官方审核模式记录无效，原文件已保留')
  if (item.zcodeMode !== undefined && !['build', 'yolo'].includes(item.zcodeMode))
    throw Error('ZCode 审批模式记录无效，原文件已保留')
  if (item.sandbox === 'full-access' && !harnessAllowsFullAccess(item.harnessRef))
    throw Error('组合会话权限与 Harness 不一致，原文件已保留')
  if (
    item.origin !== undefined &&
    (!item.origin ||
      !['codex', 'dsh', 'harness', 'desktop'].includes(item.origin.kind) ||
      typeof item.origin.sessionId !== 'string' ||
      !item.origin.sessionId)
  )
    throw Error('组合会话来源记录无效，原文件已保留')
  if (
    item.modelRef !== undefined &&
    (!item.modelRef ||
      typeof item.modelRef.provider !== 'string' ||
      !item.modelRef.provider ||
      typeof item.modelRef.model !== 'string' ||
      !item.modelRef.model)
  )
    throw Error('组合会话模型记录无效，原文件已保留')
  if (item.autoWakePaused !== undefined && typeof item.autoWakePaused !== 'boolean')
    throw Error('组合会话自动回传记录无效，原文件已保留')
  // Absent stays absent: a record written before reasoning was selectable keeps running
  // on the Harness default instead of being back-filled with a value the user never chose.
  if (
    item.reasoningEffort !== undefined &&
    (typeof item.reasoningEffort !== 'string' || !item.reasoningEffort.trim())
  )
    throw Error('组合会话推理设置无效，原文件已保留')
  if (
    item.nativeSessionId !== undefined &&
    (typeof item.nativeSessionId !== 'string' ||
      !item.nativeSessionId.trim() ||
      item.nativeSessionId.includes('\0'))
  )
    throw Error('组合会话的官方对话引用无效，原文件已保留')
  // 回退谱系必须完整：缺任何一项都会让恢复后的复核落空，因此整条拒绝而不是补默认值。
  if (item.stopEdit !== undefined) {
    const stopEdit = item.stopEdit
    if (
      !stopEdit ||
      typeof stopEdit !== 'object' ||
      [
        'clientRequestId',
        'previousSessionId',
        'sessionId',
        'boundaryId',
        'pendingOperationId',
      ].some((key) => typeof stopEdit[key] !== 'string' || !stopEdit[key]) ||
      !Number.isSafeInteger(stopEdit.removedTurns) ||
      stopEdit.removedTurns < 0 ||
      typeof stopEdit.at !== 'string' ||
      !Number.isFinite(Date.parse(stopEdit.at))
    )
      throw Error('组合会话的停止后编辑记录无效，原文件已保留')
  }
  if (item.assignment !== undefined) {
    const assignment = item.assignment
    if (
      !assignment ||
      ['taskId', 'objective', 'acceptance', 'createdAt'].some(
        (key) => typeof assignment[key] !== 'string',
      ) ||
      typeof assignment.autoReview !== 'boolean' ||
      !Number.isSafeInteger(assignment.maxRevisions) ||
      assignment.maxRevisions < 0 ||
      !Number.isSafeInteger(assignment.revisions) ||
      assignment.revisions < 0
    )
      throw Error('组合会话委派记录无效，原文件已保留')
  }
  const states = [
    'idle',
    'queued',
    'waiting_child',
    'running',
    'waiting_approval',
    'waiting_input',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]
  for (const turn of item.turns ?? []) {
    if (
      turn.content !== undefined &&
      (!Array.isArray(turn.content) ||
        turn.content.some(
          (block: any) =>
            !block || !['text', 'reasoning'].includes(block.type) || typeof block.text !== 'string',
        ))
    )
      throw Error('组合会话消息内容无效，原文件已保留')
    if (
      turn.writeScope !== undefined &&
      (!Array.isArray(turn.writeScope) ||
        !turn.writeScope.length ||
        turn.writeScope.some(
          (path: unknown) => typeof path !== 'string' || !path || !isAbsolute(path),
        ))
    )
      throw Error('组合会话写入范围无效，原文件已保留')
    if (
      turn.usage !== undefined &&
      (!turn.usage ||
        !Number.isSafeInteger(turn.usage.inputTokens) ||
        turn.usage.inputTokens < 0 ||
        !Number.isSafeInteger(turn.usage.outputTokens) ||
        turn.usage.outputTokens < 0 ||
        (turn.usage.totalTokens !== undefined &&
          (!Number.isSafeInteger(turn.usage.totalTokens) || turn.usage.totalTokens < 0)) ||
        ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].some(
          (key) =>
            turn.usage[key] !== undefined &&
            (!Number.isSafeInteger(turn.usage[key]) || turn.usage[key] < 0),
        ))
    )
      throw Error('组合会话 Token 用量记录无效，原文件已保留')
    if (
      turn.contextUsage !== undefined &&
      (!turn.contextUsage ||
        (turn.contextUsage.used !== undefined &&
          (!Number.isSafeInteger(turn.contextUsage.used) || turn.contextUsage.used < 0)) ||
        (turn.contextUsage.size !== undefined &&
          (!Number.isSafeInteger(turn.contextUsage.size) || turn.contextUsage.size <= 0)) ||
        (turn.contextUsage.used !== undefined &&
          turn.contextUsage.size !== undefined &&
          turn.contextUsage.used > turn.contextUsage.size &&
          turn.contextUsage.estimated !== true) ||
        (turn.contextUsage.estimated !== undefined &&
          typeof turn.contextUsage.estimated !== 'boolean'))
    )
      throw Error('组合会话上下文用量记录无效，原文件已保留')
    if (
      !states.includes(turn.state) ||
      typeof turn.prompt !== 'string' ||
      typeof turn.text !== 'string' ||
      typeof turn.fingerprint !== 'string'
    )
      throw Error('组合会话轮次状态无效，原文件已保留')
    if (
      turn.tools.some(
        (tool: any) =>
          !tool ||
          ['id', 'title', 'status', 'kind'].some((key) => typeof tool[key] !== 'string') ||
          ['inputJson', 'outputJson', 'contentJson', 'locationsJson'].some(
            (key) => tool[key] !== undefined && typeof tool[key] !== 'string',
          ),
      )
    )
      throw Error('组合会话工具记录无效，原文件已保留')
    if (
      turn.delivery !== undefined &&
      (!turn.delivery ||
        !['pending', 'delivering', 'delivered', 'blocked'].includes(turn.delivery.state))
    )
      throw Error('组合会话回传记录无效，原文件已保留')
    // 原生边界映射是精确事实：半个字段都不能补，否则会变成一次猜配出来的回退。
    if (
      turn.native !== undefined &&
      (!turn.native ||
        typeof turn.native !== 'object' ||
        ['userMessageId', 'turnId', 'historyVersion'].some(
          (key) => turn.native[key] !== undefined && typeof turn.native[key] !== 'string',
        ) ||
        (turn.native.officialSeq !== undefined &&
          (!Number.isSafeInteger(turn.native.officialSeq) || turn.native.officialSeq < 0)))
    )
      throw Error('组合会话的原生边界映射无效，原文件已保留')
  }
  return {
    ...item,
    origin: item.origin ?? { kind: 'desktop', sessionId: 'legacy' },
    sandbox: item.sandbox ?? 'read-only',
    title: item.title ?? 'Grok 4.7',
    turns: item.turns ?? [],
    harnessRef: item.harnessRef ?? (item.combination === DSH_COMBINATION ? 'dsh' : 'grok-build'),
    modelRef: item.modelRef ?? {
      provider: 'opl-gateway',
      model: item.combination === DSH_COMBINATION ? 'deepseek-flash' : 'grok::grok-4.7',
    },
  } as HarnessSession
}

export class HarnessSessionStore {
  readonly directory: string
  readonly legacyFilename: string
  private readonly persisted = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()
  constructor(home: string) {
    this.directory = join(home, 'profiles/desktop/harness-sessions')
    this.legacyFilename = join(home, 'profiles/desktop/harness-sessions.json')
  }
  filename(id: string): string {
    return join(this.directory, createHash('sha256').update(id).digest('hex') + '.json')
  }
  private async atomic(filename: string, bytes: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = filename + '.' + randomUUID() + '.tmp'
    await writeFile(temp, bytes, { mode: 0o600 })
    await rename(temp, filename)
  }
  async load(): Promise<HarnessSession[]> {
    const records = new Map<string, HarnessSession>()
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = parseRecord(JSON.parse(await readFile(join(this.directory, name), 'utf8')))
      if (this.filename(record.id) !== join(this.directory, name) || records.has(record.id))
        throw Error('组合会话身份冲突，原文件已保留')
      records.set(record.id, record)
      this.persisted.set(record.id, JSON.stringify(record))
    }
    const marker = join(this.directory, 'migration-complete.json')
    let migrated = false
    try {
      const value = JSON.parse(await readFile(marker, 'utf8'))
      if (value?.version !== 1) throw Error('组合会话迁移记录无效，原文件已保留')
      migrated = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!migrated) {
      let legacy: unknown
      try {
        legacy = JSON.parse(await readFile(this.legacyFilename, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (legacy !== undefined) {
        if (!Array.isArray(legacy)) throw Error('组合会话记录格式无效，原文件已保留')
        const originals = legacy.map(parseRecord)
        if (new Set(originals.map((record) => record.id)).size !== originals.length)
          throw Error('旧组合会话身份重复，原文件已保留')
        // An interrupted migration may already have durable newer session files.
        for (const record of originals) if (!records.has(record.id)) records.set(record.id, record)
        await this.saveChanged(records.values())
      }
      await this.atomic(
        marker,
        JSON.stringify({ version: 1, legacyFilename: this.legacyFilename }) + '\n',
      )
    }
    return [...records.values()]
  }
  /** Snapshot values at admission, serialize writes, and replace changed files only. */
  async saveChanged(records: Iterable<HarnessSession>): Promise<string[]> {
    const snapshots = [...records].map((record) => ({
      id: record.id,
      bytes: JSON.stringify(record),
    }))
    const changed: string[] = []
    const write = this.queue.then(async () => {
      for (const { id, bytes } of snapshots) {
        if (this.persisted.get(id) === bytes) continue
        await this.atomic(this.filename(id), bytes + '\n')
        this.persisted.set(id, bytes)
        changed.push(id)
      }
    })
    this.queue = write.catch(() => {})
    await write
    return changed
  }
  async dispose(): Promise<void> {
    await this.queue
  }
}
