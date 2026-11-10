import { invokeHostRemote } from '../../compat/host/remote-invocation.ts'
/** Real official conversations for delegated Harness tasks; importing history never executes it. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  type ModelMessageSource,
  createToolResultMessage,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionId, Session, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { setHarnessPermissions } from './permissions.ts'
import type { HarnessSession, HarnessTurn } from '../contracts/sessions.ts'
import { HARNESS_TRANSCRIPT_TOOL, harnessToolOutput } from '../contracts/tool-display.ts'

/** Stable identity shared by import and live admission, including operation retries. */
export function harnessRequestId(record: HarnessSession, turn: HarnessTurn): SessionRequestId {
  return ('opl-external-' +
    createHash('sha256')
      .update(JSON.stringify([record.id, turn.operationId]))
      .digest('hex')) as SessionRequestId
}

function endReason(turn: HarnessTurn): TurnEndReason {
  switch (turn.state) {
    case 'completed':
      return { kind: 'completed' }
    case 'cancelled':
      return { kind: 'aborted', reason: { kind: 'legacy' } }
    case 'failed':
      return {
        kind: 'error',
        error: { code: 'HARNESS_FAILED', message: turn.error ?? '外部任务未完成' },
      }
    default:
      return { kind: 'interrupted' }
  }
}

/** Uses the official Session controller and persistence lifecycle, without touching application resources. */
export class NativeHarnessConversations {
  private readonly jobs = new Map<string, Promise<void>>()
  constructor(private readonly ctx: Context) {}

  /** Namespaced tool identity is stable across partial updates and restart reads. */
  toolId(record: HarnessSession, turn: HarnessTurn, id: string): ToolCallId {
    return ('external-' +
      createHash('sha256')
        .update(JSON.stringify([record.id, turn.operationId, id]))
        .digest('hex')) as ToolCallId
  }

  /** Project a real ACP tool update into the official open conversation step. Never invokes a tool. */
  tool(sessionId: string, record: HarnessSession, turn: HarnessTurn, update: Record<string, any>) {
    if (typeof update.toolCallId !== 'string') return
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (!session) throw Error('外部工具的官方会话已关闭')
    const events = session.snapshotEvents()
    const step = events.findLast((event) => event.type === 'step/start')?.data
    if (!step) throw Error('外部工具必须在官方会话的活动步骤中展示')
    const callId = this.toolId(record, turn, update.toolCallId)
    const tool = {
      id: update.toolCallId,
      title: typeof update.title === 'string' ? update.title : record.harnessRef,
      kind: typeof update.kind === 'string' ? update.kind : 'other',
      status: typeof update.status === 'string' ? update.status : 'pending',
      ...turn.tools.find((item) => item.id === update.toolCallId),
    }
    for (const [wire, field] of [
      ['rawInput', 'inputJson'],
      ['rawOutput', 'outputJson'],
      ['content', 'contentJson'],
      ['locations', 'locationsJson'],
      ['_meta', 'metadataJson'],
    ] as const)
      if (update[wire] !== undefined) tool[field] = JSON.stringify(update[wire])
    if (typeof update.status === 'string') tool.status = update.status
    const prior = events.find((event) => event.type === 'tool/call' && event.data.callId === callId)
    if (!prior) {
      const name = HARNESS_TRANSCRIPT_TOOL
      const args = JSON.stringify({ version: 1, harness: record.harnessRef, tool })
      session.append(
        'assistant/message',
        {
          ...step,
          message: createAssistantMessage({
            source: record.modelRef as Omit<ModelMessageSource, 'kind'>,
            content: [{ type: 'tool-call', id: callId, name, arguments: args }],
          }),
          stream: [],
        },
        { surfaceOp: 'append' },
      )
      session.append('tool/call', { ...step, callId, name, arguments: args })
    }
    if (
      ['completed', 'failed'].includes(update.status) &&
      !events.some(
        (event) => event.type === 'tool/result' && event.data.message.toolCallId === callId,
      )
    ) {
      const text = harnessToolOutput(tool)
      session.append(
        'tool/result',
        {
          ...step,
          message: createToolResultMessage({
            callId,
            isError: update.status === 'failed',
            content: [{ type: 'text', text }],
          }),
          meta: JSON.parse(JSON.stringify({ oplHarness: tool })),
        },
        { surfaceOp: 'append' },
      )
    }
  }

  /** Create/adopt the exact project Session and import its settled historical operations once. */
  ensure(record: HarnessSession, persist: () => Promise<void>): Promise<void> {
    if (record.harnessRef === 'dsh' || record.origin.kind === 'dsh') return Promise.resolve()
    const pending = this.jobs.get(record.id)
    if (pending) return pending
    const job = this.prepare(record, persist).finally(() => this.jobs.delete(record.id))
    this.jobs.set(record.id, job)
    return job
  }

  private native(method: string, request: object) {
    return invokeHostRemote(this.ctx, { namespace: 'session', method, args: { request } })
  }

  private async prepare(record: HarnessSession, persist: () => Promise<void>) {
    const id = record.nativeSessionId ?? `session-${record.id}`
    const resolved = await this.ctx.sessionController.resolveAgent(SessionId(id))
    if ('error' in resolved) {
      if (resolved.error.code !== 'session/not-found') throw resolved.error
      // Seed before the official driver is constructed. Appending historical turns
      // to an already-created driver would leave its next-turn counter stale.
      const seed = Session.create(SessionId(id))
      setHarnessPermissions(this.ctx, seed, record.sandbox)
      seed.append('model/selection', record.modelRef)
      for (const turn of record.turns) {
        if (
          ['queued', 'running', 'waiting_child', 'waiting_approval', 'waiting_input'].includes(
            turn.state,
          )
        )
          throw Error('活动外部会话不能迁移')
        this.importTurn(seed, record, turn)
      }
      // agentPresets is an optional public service, also used by the official
      // Session controller. Its mounted composition must match ordinary chats.
      const presets = this.ctx.get('agentPresets') as
        | {
            resolve(id?: string): Promise<{ id: string }>
            mount(ctx: Context, id: string): Promise<unknown>
          }
        | undefined
      const preset = presets && (await presets.resolve())
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(id),
        meta: { cwd: record.cwd, ...(preset ? { agentPreset: preset.id } : {}) },
        seed: seed.snapshotEvents(),
        agentOptions: record.modelRef,
        ...(preset && presets
          ? {
              setup: async (agentCtx: Context) => {
                await presets.mount(agentCtx, preset.id)
              },
            }
          : {}),
      })
      this.ctx.effect(() => () => handle.dispose())
      await this.ctx.sessions.flush(handle.agent.session)
    }
    const workspace = await this.ctx.workspaceRegistry.create(record.cwd)
    await workspace.attachSession(SessionId(id))
    const session = this.ctx.sessions.get(SessionId(id))
    if (!session || session.header.cwd !== record.cwd) throw Error('外部任务的官方会话项目不一致')
    if (this.ctx.agents.get(session.id)?.status === 'running')
      throw Error('官方会话仍在运行，不能迁移历史')
    if (!record.nativeSessionId) {
      await this.native('rename', { sessionId: id, title: record.title })
      record.nativeSessionId = id
      await persist()
    }
    await this.ctx.sessions.flush(session)
  }

  private importTurn(session: Session, record: HarnessSession, turn: HarnessTurn) {
    const requestId = harnessRequestId(record, turn)
    const events = session.snapshotEvents()
    const user = events.find(
      (event) =>
        event.type === 'user/message' &&
        event.data.source.kind === 'user' &&
        'rpcId' in event.data.source &&
        event.data.source.rpcId === requestId,
    )
    const start = user && events.slice(0, user.seq).findLast((event) => event.type === 'turn/start')
    if (
      start &&
      events.some((event) => event.type === 'turn/end' && event.data.turn === start.data.turn)
    )
      return
    // A crash during import leaves a recognizable user identity. Resume the same
    // append sequence rather than duplicating the prompt or any completed message.
    const number =
      start?.data.turn ??
      (events.findLast((event) => event.type === 'turn/start')?.data.turn ?? 0) + 1
    if (!start) session.append('turn/start', { turn: number })
    if (!start) session.append('step/start', { turn: number, step: 1 })
    // The official driver replaces this protected head with its mounted prompt.
    // Historical user messages must not occupy the first surface node.
    if (!events.some((event) => event.type === 'system/message'))
      session.append(
        'system/message',
        {
          turn: number,
          step: 1,
          message: createSystemMessage(''),
        },
        { surfaceOp: 'append' },
      )
    if (!user)
      session.append(
        'user/message',
        createUserMessage({
          source: { kind: 'user', rpcId: requestId },
          content: [{ type: 'text', text: turn.prompt }],
        }),
        { surfaceOp: 'append' },
      )
    const current = session
      .snapshotEvents()
      .filter((event) => event.seq > (user?.seq ?? events.length))
    if (
      !current.some((event) => event.type === 'assistant/message' && event.data.turn === number)
    ) {
      if (
        turn.contextUsage?.size !== undefined &&
        session.requestContext?.()?.contextWindow !== turn.contextUsage.size
      )
        session.append('request/context', {
          provider: record.modelRef.provider,
          model: record.modelRef.model,
          contextWindow: turn.contextUsage.size,
        })
      const summary = turn.tools.length
        ? '\n\n历史工具记录（原记录只保存名称和状态）：\n' +
          turn.tools.map((tool) => `${tool.title} · ${tool.status}`).join('\n')
        : ''
      const content = turn.content?.map((block) => ({ ...block })) ?? [
        { type: 'text' as const, text: turn.text },
      ]
      const suffix = summary + (turn.error ? '\n\n' + turn.error : '')
      if (suffix) {
        const last = content.at(-1)
        if (last?.type === 'text') last.text += suffix
        else content.push({ type: 'text', text: suffix })
      }
      if (content.some((block) => block.text))
        session.append(
          'assistant/message',
          {
            turn: number,
            step: 1,
            message: createAssistantMessage({
              source: record.modelRef as Omit<ModelMessageSource, 'kind'>,
              content,
            }),
            stream: [],
            ...(turn.usage ? { usage: turn.usage } : {}),
          },
          { surfaceOp: 'append' },
        )
    }
    session.append('step/end', { turn: number, step: 1 })
    session.append('turn/end', { turn: number, reason: endReason(turn) })
  }
}
