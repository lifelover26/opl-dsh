/** Admit edits while idle; commit the replacement at the official open-step request hook. */
import { createHash } from 'node:crypto'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPromptValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { editableNativeMessage, readNativeUserMessages } from './stop-edit-native.ts'
import {
  messageEditMarker,
  MESSAGE_EDIT_SOURCE,
  type MessageEditSend,
  type MessageEditState,
} from '../contracts/message-edit.ts'
import type { EditIntent } from './message-edit-store.ts'

export function unresolvedMessageEdit(events: readonly SessionEvent[]): boolean {
  const requests = new Set<string | undefined>(
    events.flatMap((event) =>
      event.type === 'user/message' && 'rpcId' in event.data.source
        ? [event.data.source.rpcId]
        : [],
    ),
  )
  return events.some(
    (event) =>
      event.type === 'system/message' &&
      (() => {
        const marker = messageEditMarker(event.data.message.source)
        return marker !== undefined && !requests.has(marker.requestId)
      })(),
  )
}
export function messageEditState(
  session: Session,
  busy: boolean,
  supported: boolean,
): MessageEditState {
  const events = session.snapshotEvents()
  const active = new Set<number>(session.surface.nodes)
  return {
    sessionId: session.id,
    supported,
    busy,
    head: Number(session.seq) - 1,
    pending: unresolvedMessageEdit(events),
    choices: supported
      ? readNativeUserMessages(events)
          .filter((message) => active.has(message.seq) && editableNativeMessage(message))
          .map((message) => ({ seq: message.seq, text: message.text }))
      : [],
  }
}
const digest = (input: MessageEditSend) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')
export interface EditStore {
  get(id: string): EditIntent | undefined
  save(intent: EditIntent): Promise<void>
}
/** Transactions match the exact queued user input and the official Agent instance. */
export class MessageEditTransactions {
  private readonly claims = new Map<
    string,
    { agent: Agent; turn: number; step: number; requestId: string }
  >()
  private readonly staging = new Set<string>()
  constructor(private readonly store: EditStore) {}
  pending(id: string): boolean {
    return this.store.get(id)?.phase === 'prepared'
  }
  recovery(session: Session): MessageEditSend | undefined {
    const intent = this.store.get(session.id)
    const events = session.snapshotEvents()
    if (!intent || !unresolvedMessageEdit(events)) return
    const marker = events
      .flatMap((event) =>
        event.type === 'system/message' ? [messageEditMarker(event.data.message.source)] : [],
      )
      .find((value) => value?.requestId === intent.input.prompt.requestId)
    return marker?.digest === digest(intent.input) ? structuredClone(intent.input) : undefined
  }
  private async admit(
    agent: Agent,
    intent: EditIntent,
    prompt: () => Promise<SessionPromptValue>,
  ): Promise<SessionPromptValue> {
    await this.store.save({ ...intent, phase: 'prepared' })
    try {
      return await prompt()
    } catch (error) {
      const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(
        (message) =>
          'rpcId' in message.source && message.source.rpcId === intent.input.prompt.requestId,
      )
      if (pending) agent.inbox.remove(pending.id)
      await this.store.save({ ...intent, phase: 'cancelled' })
      throw error
    }
  }
  async recoverUnadmitted(agent: Agent): Promise<void> {
    const intent = this.store.get(agent.id)
    if (
      !intent ||
      intent.phase !== 'prepared' ||
      this.staging.has(agent.id) ||
      agent.status !== 'idle' ||
      agent.inbox.nextTurn.length ||
      agent.inbox.nextStep.length ||
      unresolvedMessageEdit(agent.session.snapshotEvents())
    )
      return
    await this.store.save({ ...intent, phase: 'cancelled' })
  }
  async send(
    agent: Agent,
    input: MessageEditSend,
    prompt: () => Promise<SessionPromptValue>,
    expectedContent?: UserMessage['content'],
  ): Promise<SessionPromptValue> {
    if (this.staging.has(agent.id)) throw Error('编辑消息正在发送')
    this.staging.add(agent.id)
    try {
      const events = agent.session.snapshotEvents()
      const prior = events
        .flatMap((event) =>
          event.type === 'system/message' ? [messageEditMarker(event.data.message.source)] : [],
        )
        .find((marker) => marker?.requestId === input.prompt.requestId)
      if (prior) {
        if (prior.digest !== digest(input)) throw Error('发送身份已经用于另一次编辑')
        if (!unresolvedMessageEdit(events)) return { accepted: true }
        const intent = this.store.get(agent.id)
        if (
          !intent ||
          digest(intent.input) !== prior.digest ||
          agent.status !== 'idle' ||
          agent.inbox.nextTurn.length ||
          agent.inbox.nextStep.length
        )
          throw Error('发送结果尚未确认，请重新读取对话')
        // The official loop can reject prepareCall after our marker but before
        // user/message. Retry its exact missing admission, never the replacement.
        return await this.admit(agent, intent, prompt)
      }
      if (this.pending(agent.id) || unresolvedMessageEdit(events))
        throw Error('上次编辑发送尚未确认，请重新读取对话')
      if (
        events.some(
          (event) =>
            event.type === 'user/message' &&
            'rpcId' in event.data.source &&
            event.data.source.rpcId === input.prompt.requestId,
        )
      )
        throw Error('发送身份已经使用')
      if (Number(agent.session.seq) - 1 !== input.head)
        throw Error('对话已变化，请重新选择要编辑的消息')
      if (
        !messageEditState(agent.session, false, true).choices.some(
          (choice) => choice.seq === input.targetSeq,
        )
      )
        throw Error('这条消息当前不能编辑')
      if (
        input.prompt.mode !== 'queue' ||
        input.prompt.content.some((part) => part.type !== 'text') ||
        !input.prompt.content.some((part) => part.type === 'text' && part.text.trim())
      )
        throw Error('编辑消息需要非空文本，暂不支持附件')
      const intent: EditIntent = {
        version: 1,
        input,
        surface: [...agent.session.surface.nodes],
        phase: 'prepared',
        ...(expectedContent ? { expectedContent: structuredClone(expectedContent) } : {}),
      }
      return await this.admit(agent, intent, prompt)
    } finally {
      this.staging.delete(agent.id)
    }
  }
  claim(agent: Agent, messages: readonly UserMessage[], turn: number, step: number): void {
    const intent = this.store.get(agent.id)
    if (!intent || intent.phase !== 'prepared') return
    const message = messages.find(
      (message) =>
        'rpcId' in message.source && message.source.rpcId === intent.input.prompt.requestId,
    )
    if (
      !message ||
      JSON.stringify(message.content) !==
        JSON.stringify(intent.expectedContent ?? intent.input.prompt.content)
    )
      throw Error('编辑消息的发送内容尚未确认')
    this.claims.set(agent.id, { agent, turn, step, requestId: intent.input.prompt.requestId })
  }
  /** Called after official step/start and before the loop derives its request messages. */
  async commit(
    agent: Agent,
    turn: number,
    step: number,
    signal: AbortSignal,
    flush: () => Promise<boolean>,
  ): Promise<boolean> {
    const intent = this.store.get(agent.id)
    const claim = this.claims.get(agent.id)
    if (
      !intent ||
      !claim ||
      claim.agent !== agent ||
      claim.turn !== turn ||
      claim.step !== step ||
      claim.requestId !== intent.input.prompt.requestId
    ) {
      if (intent?.phase === 'prepared') throw Error('编辑消息尚未确认')
      return false
    }
    const events = agent.session.snapshotEvents()
    const prior = events.some(
      (event) =>
        event.type === 'system/message' &&
        messageEditMarker(event.data.message.source)?.requestId === claim.requestId,
    )
    signal.throwIfAborted()
    if (!prior) {
      if (JSON.stringify(agent.session.surface.nodes) !== JSON.stringify(intent.surface))
        throw Error('消息上下文已变化，请重新选择')
      const nodes = agent.session.surface.nodes.filter(
        (seq) => Number(seq) >= intent.input.targetSeq,
      )
      const start = nodes[0],
        end = nodes.at(-1)
      if (start === undefined || end === undefined) throw Error('消息上下文已变化')
      const empty = createSystemMessage('')
      const marker = {
        version: 1 as const,
        start: intent.input.targetSeq,
        end: intent.input.head,
        requestId: claim.requestId,
        digest: digest(intent.input),
      }
      const message = { ...empty, source: { ...empty.source, [MESSAGE_EDIT_SOURCE]: marker } }
      agent.session.append(
        'system/message',
        { turn, step, message },
        {
          surfaceOp: { op: 'replace', startSeq: start as SessionSeq, endSeq: end as SessionSeq },
          sourceEventSeqs: nodes,
        },
      )
    }
    if (!(await flush())) throw Error('编辑尚未保存，请重新读取对话')
    signal.throwIfAborted()
    await this.store.save({ ...intent, phase: 'committed' })
    return true
  }
}
