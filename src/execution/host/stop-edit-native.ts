/**
 * 原生 DSH 的停止后编辑：精确前缀分叉，原会话保留。
 *
 * 边界只来自官方会话日志。`session/fork` 的 `atSeq` 是**包含**该事件的切点，所以回退到
 * 某条用户消息之前，使用的就是紧邻它之前那条事件的 seq；首条消息则新建空分支，避免
 * 带入原轮次的 start 等事件。
 */
import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { HarnessSession, HarnessTurn } from '../contracts/sessions.ts'
import type { StopEditBoundary } from '../contracts/stop-edit.ts'
import {
  contentHead,
  StopEditError,
  type StopEditPlan,
  type StopEditRuntime,
  type StopEditTail,
} from './stop-edit.ts'
import { harnessRequestId } from './native-conversations.ts'
import { validPromptContent } from './multimodal-prompt.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** OPL 自己注入的续轮消息不是用户发送的消息，不能成为可回退边界。 */
const RESERVED_REQUEST_PREFIX = 'task-feedback-resume:'

/** 日志中一条已发送的用户消息。 */
export interface NativeUserMessage {
  seq: number
  /** 该条用户消息在日志中的位置；`prevSeq` 是它之前那条事件的 seq。 */
  prevSeq: number | undefined
  rpcId?: string
  text: string
  /** Exact immutable blocks retained for in-place text editing with the original images. */
  content?: UserMessage['content']
  /** 随消息一起持久化的附件；官方没有公开的“放回草稿”接口，因此只能据此拒绝。 */
  attachments: { name?: string }[]
  index: number
}

/**
 * 从官方会话日志里读出真实用户发送的消息。
 *
 * 注入的续轮消息按 rpcId 前缀精确排除，其余 `user/message` 都是用户实际发送的内容。
 * 官方会话日志自带严格递增的 seq，顺序与首条判定都直接来自它，不做任何推断。
 */
export function readNativeUserMessages(events: readonly SessionEvent[]): NativeUserMessage[] {
  const messages: NativeUserMessage[] = []
  let previousSeq: number | undefined
  for (const event of events) {
    const seq = Number(event.seq)
    if (event.type === 'user/message') {
      const source = event.data.source
      const rpcId = 'rpcId' in source && typeof source.rpcId === 'string' ? source.rpcId : undefined
      if (source.kind === 'user' && !rpcId?.startsWith(RESERVED_REQUEST_PREFIX)) {
        const attachments: { name?: string }[] = []
        let text = ''
        for (const block of event.data.content) {
          if (block.type === 'text') text += block.text
          else if (block.type === 'image')
            attachments.push(
              block.attachment.name === undefined ? {} : { name: block.attachment.name },
            )
          else if (block.type === 'file') attachments.push({ name: block.attachment.name })
        }
        messages.push({
          seq,
          prevSeq: previousSeq,
          ...(rpcId === undefined ? {} : { rpcId }),
          text,
          content: event.data.content,
          attachments,
          index: messages.length,
        })
      }
    }
    // 跳过的事件同样占据日志位置：切点必须是紧邻目标消息之前的那一条真实事件。
    previousSeq = seq
  }
  return messages
}

/** Only image references can be retained by message editing; file attachments remain excluded. */
export function editableNativeMessage(message: NativeUserMessage): boolean {
  return !message.attachments.length || validPromptContent(message.content)
}

/** 官方会话日志与控制器的最小接入面，便于按边界独立验证。 */
export interface NativeSessionSource {
  /** 官方会话快照事件；会话不存在时返回 undefined。 */
  events(sessionId: string): readonly SessionEvent[] | undefined
  /** 官方会话是否仍在运行。 */
  running(sessionId: string): boolean
  /** 等待真正静止。 */
  whenIdle(sessionId: string): Promise<void>
  /** 会话的 cwd；新建空分支时必须沿用同一个项目。 */
  cwd(sessionId: string): string | undefined
  /** Validate model and permission inheritance before creating a branch. */
  validateBranch?(sessionId: string): void
  /** 按包含该 seq 的切点分叉，返回新会话身份；原会话保留。 */
  fork(sessionId: string, atSeq: number): Promise<string>
  /** 新建空分支；官方接口没有“切点在第一条之前”的表达。 */
  create(sessionId: string, cwd: string): Promise<string>
  /** 把模型、内置权限与标题逐项写到新分支；返回实际复核到的事实。 */
  rebind(
    sessionId: string,
    previousSessionId: string,
    editedHead: string,
  ): Promise<NativeReviewFacts>
}

export interface NativeReviewFacts {
  model: string
  effort?: string
  permissions: string
  cwd: string
  workspaceId: string
  project?: string
  /** 新分支的人类可读标题；界面用它给出可点击的入口。 */
  title: string
}

/** 一条 OPL 轮次在官方日志中的稳定身份。 */
export function turnRequestIds(record: HarnessSession, turn: HarnessTurn): string[] {
  return [
    String(harnessRequestId(record, turn)),
    'opl-harness-' + hash([record.id, turn.operationId]),
  ]
}

/**
 * 把官方投影会话回退到锚点之前。
 *
 * 只认导入时写进用户消息 source 的稳定 requestId，因此不会把别的轮次误删。没有锚点
 * 就返回 undefined，让调用方在变更 Runtime 之前就拒绝，而不是留下旧投影。
 */
export function nativeProjectionAnchor(
  source: NativeSessionSource,
  sessionId: string,
  anchorRequestIds: readonly string[],
  officialSeq?: number,
): NativeUserMessage | undefined {
  const messages = readNativeUserMessages(source.events(sessionId) ?? [])
  if (officialSeq !== undefined) return messages.find((message) => message.seq === officialSeq)
  return messages.find(
    (message) => message.rpcId !== undefined && anchorRequestIds.includes(message.rpcId),
  )
}

/** 原生 DSH 运行时：不需要任何第三方扩展，因此能力恒为可用。 */
export function nativeStopEditRuntime(source: NativeSessionSource): StopEditRuntime {
  const locate = (sessionId: string) => {
    const events = source.events(sessionId)
    if (events === undefined)
      throw new StopEditError('not-bound', '官方会话已关闭，无法定位要编辑的消息')
    const messages = readNativeUserMessages(events)
    return { messages, headSeq: events.length ? Number(events.at(-1)!.seq) : 0 }
  }
  const findTarget = (sessionId: string, boundaryId: string) => {
    const { messages } = locate(sessionId)
    const target = messages.find((message) => `dsh:${message.seq}` === boundaryId)
    if (target === undefined)
      throw new StopEditError('stale-history', '要编辑的消息已不在当前历史中，请重新选择')
    return target
  }
  /** 只读校验：会话、边界、附件与投影锚点全部确认之后才允许任何变更。 */
  const planOf = (
    sessionId: string,
    boundaryId: string,
  ): { target: NativeUserMessage; cut: number } => {
    const target = findTarget(sessionId, boundaryId)
    if (target.attachments.length)
      throw new StopEditError(
        'attachments-unrestorable',
        `这条消息带有 ${target.attachments.length} 个附件；官方会话没有公开的附件回填接口，已在改动会话之前拒绝`,
      )
    source.validateBranch?.(sessionId)
    const cwd = source.cwd(sessionId)
    if (cwd === undefined) throw new StopEditError('rewind-failed', '无法确定项目目录，已放弃回退')
    return { target, cut: target.index === 0 ? 0 : target.prevSeq! }
  }
  return {
    harness: 'dsh',
    capability: () => ({ ready: true }),
    boundaries: async (_record, sessionId) => {
      const { messages, headSeq } = locate(sessionId)
      return messages.map(
        (message): StopEditBoundary => ({
          id: `dsh:${message.seq}`,
          contentHead: contentHead(message.text),
          attachmentCount: message.attachments.length,
          first: message.index === 0,
          // 日志头位置就是这一份历史的新鲜度；恢复后用它拒绝过期选择。
          historyVersion: String(headSeq),
        }),
      )
    },
    plan: async ({ sessionId, boundary }) => {
      const { target } = planOf(sessionId, boundary.id)
      const planned: StopEditPlan = { draft: target.text, unrestored: [] }
      return planned
    },
    rewind: async ({ record, sessionId, boundary }) => {
      const { messages } = locate(sessionId)
      const message = findTarget(sessionId, boundary.id)
      const { cut } = planOf(sessionId, boundary.id)
      const seqs = new Map<string, number>()
      for (const item of messages) if (item.rpcId !== undefined) seqs.set(item.rpcId, item.seq)
      // 投影锚点在变更之前确认：没有锚点就拒绝，而不是先改 Runtime 再留旧投影。
      let anchor: NativeUserMessage | undefined
      if (record?.nativeSessionId && record.nativeSessionId !== sessionId) {
        anchor = nativeProjectionAnchor(
          source,
          record.nativeSessionId,
          record.turns.flatMap((turn) => turnRequestIds(record, turn)),
        )
        if (anchor === undefined)
          throw new StopEditError(
            'missing-mapping',
            '官方投影里找不到这条消息的精确落点，已在改动 Runtime 之前拒绝',
          )
      }
      const cwd = source.cwd(sessionId)!
      const after =
        message.index === 0
          ? await source.create(sessionId, cwd)
          : await source.fork(sessionId, message.prevSeq!)
      const review = await source.rebind(after, sessionId, contentHead(message.text, 20))
      // 投影与新分支都建立在同一个切点上；没有投影时这一步只是跳过。
      if (anchor && record?.nativeSessionId) {
        const projected =
          anchor.index === 0
            ? await source.create(record.nativeSessionId, cwd)
            : await source.fork(record.nativeSessionId, anchor.prevSeq!)
        if (projected !== after && record.nativeSessionId !== after)
          await source.rebind(projected, sessionId, contentHead(message.text, 20))
      }
      const empty = message.index === 0
      const classify = (turn: HarnessTurn): StopEditTail => {
        if (empty) return 'after'
        if (record?.nativeSessionId === undefined) {
          // 没有委派投影时无从判断，按“全部保留”处理，交由调用方原样保留历史。
          return 'before'
        }
        const persisted = turn.native?.officialSeq
        const seq =
          typeof persisted === 'number'
            ? persisted
            : turnRequestIds(record, turn)
                .map((id) => seqs.get(id))
                .find((value): value is number => value !== undefined)
        if (seq === undefined) return 'unknown'
        return seq >= cut ? 'after' : 'before'
      }
      return {
        sessionId: after,
        preservedSessionId: sessionId,
        classify,
        draft: message.text,
        // 被移除的历史尾部是用户自己的选择，不是无法恢复的内容，因此不逐条报错。
        unrestored: [],
        review,
      }
    },
  }
}
