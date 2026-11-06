/** Codex vendor history driver for the shared same-conversation edit transaction. */
import type {
  ExternalEditBoundary,
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'

export const OPL_EDIT_META = 'opl/message-edit'
export const OPL_EDIT_READ = 'opl/message-edit/read'
export const OPL_EDIT_REWIND = 'opl/message-edit/rewind'

export type ExternalEditFailure =
  | 'aborted'
  | 'capability-missing'
  | 'history-changed'
  | 'history-unreadable'
  | 'mapping-mismatch'
  | 'unsupported'
  | 'unknown-target'
  | 'target-unavailable'
  | 'rewind-failed'
  | 'reconnect-failed'

/** Fixed failure identity; callers may journal the reason but must not retry blindly. */
export class ExternalEditError extends Error {
  constructor(
    readonly reason: ExternalEditFailure,
    message: string,
  ) {
    super(message)
    this.name = 'ExternalEditError'
  }
}

/** Refuse to call a bridge that did not announce the exact private edit methods. */
export function requireBridgeCapability(context: ExternalEditContext, method: string): void {
  const meta = (context.snapshot().agent as any)?.agentCapabilities?._meta?.[OPL_EDIT_META]
  if (!meta || meta.version !== 1 || !Array.isArray(meta.methods) || !meta.methods.includes(method))
    throw new ExternalEditError('capability-missing', '当前原生桥接未公告消息编辑历史能力')
}

/** Parse only the exact public shape; unknown or damaged payloads are refused. */
export function parseExternalHistory(value: unknown): ExternalEditHistory {
  const body = value as { sessionId?: unknown; token?: unknown; boundaries?: unknown } | undefined
  if (
    !body ||
    typeof body.sessionId !== 'string' ||
    !body.sessionId ||
    typeof body.token !== 'string' ||
    !body.token ||
    !Array.isArray(body.boundaries)
  )
    throw new ExternalEditError('history-unreadable', '消息编辑历史返回的形状无效')
  const boundaries: ExternalEditBoundary[] = []
  for (const item of body.boundaries) {
    const entry = item as
      | { id?: unknown; text?: unknown; imageCount?: unknown; unavailableReason?: unknown }
      | undefined
    if (!entry || typeof entry.id !== 'string' || !entry.id)
      throw new ExternalEditError('history-unreadable', '消息编辑边界缺少稳定身份')
    if (entry.text !== undefined && typeof entry.text !== 'string')
      throw new ExternalEditError('history-unreadable', '消息编辑边界文本无效')
    if (
      entry.imageCount !== undefined &&
      (typeof entry.imageCount !== 'number' ||
        !Number.isSafeInteger(entry.imageCount) ||
        entry.imageCount < 0)
    )
      throw new ExternalEditError('history-unreadable', '消息编辑边界图片数量无效')
    if (entry.unavailableReason !== undefined && typeof entry.unavailableReason !== 'string')
      throw new ExternalEditError('history-unreadable', '消息编辑边界限制无效')
    boundaries.push({
      id: entry.id,
      ...(entry.text === undefined ? {} : { text: entry.text }),
      ...(entry.imageCount === undefined ? {} : { imageCount: entry.imageCount }),
      ...(entry.unavailableReason === undefined
        ? {}
        : { unavailableReason: entry.unavailableReason }),
    })
  }
  return { sessionId: body.sessionId, token: body.token, boundaries }
}

export function parseExternalResult(value: unknown): ExternalEditResult {
  const body = value as { sessionId?: unknown; retained?: unknown; ephemeral?: unknown } | undefined
  if (
    !body ||
    typeof body.sessionId !== 'string' ||
    !body.sessionId ||
    !Array.isArray(body.retained)
  )
    throw new ExternalEditError('rewind-failed', '消息编辑回退返回的身份无效')
  const retained: { previousId: string; nextId: string }[] = []
  for (const item of body.retained) {
    const pair = item as { previousId?: unknown; nextId?: unknown } | undefined
    if (
      !pair ||
      typeof pair.previousId !== 'string' ||
      !pair.previousId ||
      typeof pair.nextId !== 'string' ||
      !pair.nextId
    )
      throw new ExternalEditError('rewind-failed', '消息编辑保留边界映射无效')
    retained.push({ previousId: pair.previousId, nextId: pair.nextId })
  }
  if (body.ephemeral !== undefined && typeof body.ephemeral !== 'boolean')
    throw new ExternalEditError('rewind-failed', '消息编辑临时身份标记无效')
  return {
    sessionId: body.sessionId,
    retained,
    ...(body.ephemeral === true ? { ephemeral: true } : {}),
  }
}

function target(context: ExternalEditContext): string {
  const id = context.record.acpSessionId
  if (typeof id !== 'string' || !id)
    throw new ExternalEditError('history-unreadable', '当前 Codex 会话没有可编辑的 vendor 身份')
  return id
}

function aborted(context: ExternalEditContext): void {
  if (context.signal.aborted) throw new ExternalEditError('aborted', '消息编辑已取消')
}

/** Codex driver: read exact turns; rewind before the target turn and verify the prefix. */
export function createCodexMessageEditDriver(): ExternalMessageEditDriver {
  return {
    async read(context) {
      aborted(context)
      requireBridgeCapability(context, OPL_EDIT_READ)
      try {
        const value = await context
          .transport()
          .request(OPL_EDIT_READ, { sessionId: target(context) }, 30_000)
        return parseExternalHistory(value)
      } catch (error) {
        if (error instanceof ExternalEditError) throw error
        throw new ExternalEditError('history-unreadable', 'Codex 历史读取失败，未做任何改动')
      }
    },
    async rewind(context, input) {
      aborted(context)
      requireBridgeCapability(context, OPL_EDIT_REWIND)
      if (input.expected.sessionId !== target(context))
        throw new ExternalEditError('history-changed', 'Codex 会话身份在读取后发生变化')
      try {
        const value = await context.transport().request(
          OPL_EDIT_REWIND,
          {
            sessionId: target(context),
            operationId: input.operationId,
            targetId: input.targetId,
            expectedToken: input.expected.token,
          },
          60_000,
        )
        const result = parseExternalResult(value)
        if (context.signal.aborted)
          throw new ExternalEditError('aborted', '消息编辑已取消，vendor 结果不确定')
        return result
      } catch (error) {
        if (error instanceof ExternalEditError) throw error
        throw new ExternalEditError('rewind-failed', 'Codex 回退未完成，结果不确定')
      }
    },
  }
}

export const codexMessageEditDriver: ExternalMessageEditDriver = createCodexMessageEditDriver()
