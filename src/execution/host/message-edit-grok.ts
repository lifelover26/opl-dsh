/** Grok Build vendor history driver; conversation-only rewind by exact prompt index. */
import { createHash } from 'node:crypto'
import type {
  ExternalEditBoundary,
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'
import { ExternalEditError } from './message-edit-codex.ts'

const POINTS = '_x.ai/rewind/points'
const EXECUTE = '_x.ai/rewind/execute'

type GrokPoint = {
  prompt_index: number
  prompt_preview?: string | null
  has_file_changes?: boolean
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function target(context: ExternalEditContext): string {
  const id = context.record.acpSessionId
  if (typeof id !== 'string' || !id)
    throw new ExternalEditError('history-unreadable', '当前 Grok 会话没有可编辑的 vendor 身份')
  return id
}

function aborted(context: ExternalEditContext): void {
  if (context.signal.aborted) throw new ExternalEditError('aborted', '消息编辑已取消')
}

async function points(context: ExternalEditContext): Promise<GrokPoint[]> {
  let value: unknown
  try {
    value = await context.transport().request(POINTS, { sessionId: target(context) }, 30_000)
  } catch {
    throw new ExternalEditError('unsupported', '当前 Grok 进程未公告可用的 rewind 历史')
  }
  const body = value as { rewind_points?: unknown } | undefined
  if (!Array.isArray(body?.rewind_points))
    throw new ExternalEditError('history-unreadable', 'Grok rewind 历史返回的形状无效')
  const result: GrokPoint[] = []
  for (const item of body.rewind_points) {
    const point = item as
      { prompt_index?: unknown; prompt_preview?: unknown; has_file_changes?: unknown } | undefined
    if (
      !point ||
      typeof point.prompt_index !== 'number' ||
      !Number.isSafeInteger(point.prompt_index) ||
      point.prompt_index < 0
    )
      throw new ExternalEditError('history-unreadable', 'Grok rewind 边界缺少稳定索引')
    if (
      point.prompt_preview !== undefined &&
      point.prompt_preview !== null &&
      typeof point.prompt_preview !== 'string'
    )
      throw new ExternalEditError('history-unreadable', 'Grok rewind 预览形状无效')
    if (point.has_file_changes !== undefined && typeof point.has_file_changes !== 'boolean')
      throw new ExternalEditError('history-unreadable', 'Grok rewind 文件标记无效')
    result.push({
      prompt_index: point.prompt_index,
      ...(typeof point.prompt_preview === 'string' ? { prompt_preview: point.prompt_preview } : {}),
      ...(typeof point.has_file_changes === 'boolean'
        ? { has_file_changes: point.has_file_changes }
        : {}),
    })
  }
  return result
}

function boundaries(context: ExternalEditContext, history: GrokPoint[]): ExternalEditBoundary[] {
  const turns = context.record.turns
  if (history.length !== turns.length)
    throw new ExternalEditError('mapping-mismatch', 'Grok rewind 索引与当前 DSH 轮次不能一一对应')
  return history.map((point, index) => {
    const turn = turns[index]!
    const nativeId = turn.native?.userMessageId
    if (typeof nativeId !== 'string' || !nativeId)
      throw new ExternalEditError('mapping-mismatch', 'Grok 轮次缺少持久化的原生边界身份')
    if (point.prompt_index !== index)
      throw new ExternalEditError('mapping-mismatch', 'Grok rewind 索引顺序与 DSH 轮次不一致')
    if (
      point.prompt_preview !== undefined &&
      point.prompt_preview !== null &&
      !turn.prompt.startsWith(point.prompt_preview)
    )
      throw new ExternalEditError('mapping-mismatch', 'Grok rewind 预览与 DSH 轮次文本不一致')
    return { id: nativeId, text: turn.prompt }
  })
}

function token(context: ExternalEditContext, history: GrokPoint[]): string {
  return digest({
    kind: 'grok',
    sessionId: target(context),
    points: history.map((point) => ({
      index: point.prompt_index,
      preview: point.prompt_preview ?? null,
      hasFileChanges: point.has_file_changes ?? false,
    })),
    prompts: context.record.turns.map((turn) => turn.prompt),
    turns: context.record.turns.map((turn) => ({
      prompt: turn.prompt,
      tools: (turn.tools ?? []).map((tool) => ({
        id: tool.id,
        title: tool.title,
        status: tool.status,
        input: tool.inputJson ?? null,
        output: tool.outputJson ?? null,
        content: tool.contentJson ?? null,
        locations: tool.locationsJson ?? null,
      })),
    })),
  })
}

function samePrefix(left: GrokPoint[], right: GrokPoint[], count: number): boolean {
  if (left.length < count || right.length !== count) return false
  for (let index = 0; index < count; index++)
    if (
      left[index]!.prompt_index !== right[index]!.prompt_index ||
      (left[index]!.prompt_preview ?? null) !== (right[index]!.prompt_preview ?? null) ||
      (left[index]!.has_file_changes ?? false) !== (right[index]!.has_file_changes ?? false)
    )
      return false
  return true
}

/** Grok driver: read points; rewind conversation-only before the target prompt index. */
export function createGrokMessageEditDriver(): ExternalMessageEditDriver {
  return {
    async read(context) {
      aborted(context)
      const history = await points(context)
      aborted(context)
      const mapped = boundaries(context, history)
      return { sessionId: target(context), token: token(context, history), boundaries: mapped }
    },
    async rewind(context, input) {
      aborted(context)
      if (input.expected.sessionId !== target(context))
        throw new ExternalEditError('history-changed', 'Grok 会话身份在读取后发生变化')
      const before = await points(context)
      aborted(context)
      if (token(context, before) !== input.expected.token)
        throw new ExternalEditError('history-changed', 'Grok 历史在读取后发生变化，已拒绝回退')
      const index = input.expected.boundaries.findIndex((entry) => entry.id === input.targetId)
      if (index < 0) throw new ExternalEditError('unknown-target', '目标边界不在当前 Grok 历史中')
      const targetBoundary = input.expected.boundaries[index]
      if (!targetBoundary || targetBoundary.text === undefined)
        throw new ExternalEditError('target-unavailable', '目标消息没有可回填的精确文本')
      if (before[index]?.prompt_index !== index)
        throw new ExternalEditError('unknown-target', '目标 prompt 索引不在当前 Grok 历史中')
      aborted(context)
      let value: unknown
      try {
        value = await context.transport().request(
          EXECUTE,
          {
            sessionId: target(context),
            targetPromptIndex: index,
            force: true,
            mode: 'conversation_only',
          },
          60_000,
        )
      } catch {
        throw new ExternalEditError('rewind-failed', 'Grok 回退未完成，结果不确定')
      }
      const response = value as
        | {
            success?: unknown
            target_prompt_index?: unknown
            mode?: unknown
            prompt_text?: unknown
          }
        | undefined
      if (
        response?.success !== true ||
        response.target_prompt_index !== index ||
        response.mode !== 'conversation_only' ||
        response.prompt_text !== targetBoundary.text
      )
        throw new ExternalEditError('rewind-failed', 'Grok 未确认目标 prompt 的精确回退')
      if (context.signal.aborted)
        throw new ExternalEditError('aborted', '消息编辑已取消，vendor 结果不确定')
      const after = await points(context)
      aborted(context)
      if (!samePrefix(before, after, index))
        throw new ExternalEditError('rewind-failed', 'Grok 回退后的保留前缀与预期不一致')
      const retained = input.expected.boundaries.slice(0, index).map((entry) => ({
        previousId: entry.id,
        nextId: entry.id,
      }))
      return { sessionId: target(context), retained }
    },
  }
}

export const grokMessageEditDriver: ExternalMessageEditDriver = createGrokMessageEditDriver()
