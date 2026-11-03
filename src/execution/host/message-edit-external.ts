/** Journal vendor history changes before admitting a replacement into the official loop. */
import { createHash } from 'node:crypto'
import type {
  ExternalEditContext,
  ExternalEditHistory,
  ExternalEditResult,
  ExternalMessageEditDriver,
} from './message-edit-driver.ts'

export interface ExternalEditIntent {
  version: 1
  sessionId: string
  recordId: string
  requestId: string
  fingerprint: string
  previousSessionId: string
  targetId: string
  /** Exact official user event selected before the vendor fork; absent in older journals. */
  targetSeq?: number
  expected: ExternalEditHistory
  phase: 'invoking' | 'ready' | 'admitting' | 'prompting' | 'settled' | 'uncertain'
  result?: ExternalEditResult
}
export interface ExternalEditJournal {
  get(sessionId: string): ExternalEditIntent | undefined
  save(intent: ExternalEditIntent): Promise<void>
}

function knownTerminalFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'promptSettled') === true
}

/** Hash caller-owned binding facts; connection observations only refresh updatedAt. */
export function externalEditRecordFingerprint(record: ExternalEditContext['record']): string {
  const { updatedAt: _observedAt, ...binding } = record
  return createHash('sha256').update(JSON.stringify(binding)).digest('hex')
}

/** Reject incomplete/reused retained identities before publishing a changed vendor binding. */
export function validateExternalEditResult(
  expected: ExternalEditHistory,
  targetId: string,
  result: ExternalEditResult,
): void {
  const target = expected.boundaries.findIndex((entry) => entry.id === targetId)
  if (target < 0 || !result.sessionId) throw Error('编辑边界尚未确认')
  const prior = expected.boundaries.slice(0, target).map((entry) => entry.id)
  if (
    result.retained.length !== prior.length ||
    new Set(prior).size !== prior.length ||
    new Set(result.retained.map((entry) => entry.nextId)).size !== prior.length ||
    result.retained.some((entry, index) => entry.previousId !== prior[index] || !entry.nextId)
  )
    throw Error('编辑后的历史映射不一致')
  if (result.ephemeral && prior.length) throw Error('非空编辑历史不能使用临时会话身份')
}

/**
 * Only the shared Host owner may bind results or send prompts. Unknown vendor effects remain
 * blocked across restarts; loading this journal never invokes the vendor or resends a prompt.
 */
export class ExternalMessageEditTransactions {
  private readonly active = new Set<string>()
  constructor(private readonly journal: ExternalEditJournal) {}

  pending(sessionId: string): boolean {
    const intent = this.journal.get(sessionId)
    return Boolean(intent && intent.phase !== 'settled')
  }

  intent(sessionId: string): ExternalEditIntent | undefined {
    const intent = this.journal.get(sessionId)
    return intent && structuredClone(intent)
  }

  async prepare(
    context: ExternalEditContext,
    driver: ExternalMessageEditDriver,
    input: {
      requestId: string
      targetId: string
      targetSeq?: number
      expected: ExternalEditHistory
    },
  ): Promise<ExternalEditResult> {
    const sessionId = context.record.nativeSessionId
    if (!sessionId || !input.requestId || this.active.has(sessionId))
      throw Error('编辑消息正在处理或会话身份缺失')
    const fingerprint = externalEditRecordFingerprint(context.record)
    const prior = this.journal.get(sessionId)
    if (prior && prior.phase !== 'settled') {
      if (
        prior.phase === 'ready' &&
        prior.requestId === input.requestId &&
        prior.targetId === input.targetId &&
        prior.targetSeq === input.targetSeq &&
        prior.fingerprint === fingerprint &&
        JSON.stringify(prior.expected) === JSON.stringify(input.expected) &&
        prior.result
      )
        return structuredClone(prior.result)
      throw Error('上次编辑的结果尚未确认，请重新读取对话')
    }
    if (prior?.requestId === input.requestId) throw Error('编辑发送身份已经使用')
    if (
      input.expected.sessionId !== context.record.acpSessionId ||
      !input.expected.boundaries.some(
        (entry) => entry.id === input.targetId && !entry.unavailableReason,
      )
    )
      throw Error('要编辑的消息已变化，请重新选择')
    const intent: ExternalEditIntent = {
      version: 1,
      sessionId,
      recordId: context.record.id,
      requestId: input.requestId,
      fingerprint,
      previousSessionId: context.record.acpSessionId,
      targetId: input.targetId,
      ...(input.targetSeq === undefined ? {} : { targetSeq: input.targetSeq }),
      expected: structuredClone(input.expected),
      phase: 'invoking',
    }
    this.active.add(sessionId)
    try {
      context.signal.throwIfAborted()
      await this.journal.save(intent)
      context.signal.throwIfAborted()
      const result = await driver.rewind(context, {
        operationId: input.requestId,
        targetId: input.targetId,
        expected: structuredClone(input.expected),
      })
      context.signal.throwIfAborted()
      if (externalEditRecordFingerprint(context.record) !== fingerprint)
        throw Error('编辑期间会话绑定已变化')
      validateExternalEditResult(input.expected, input.targetId, result)
      await this.journal.save({ ...intent, phase: 'ready', result: structuredClone(result) })
      context.signal.throwIfAborted()
      if (externalEditRecordFingerprint(context.record) !== fingerprint)
        throw Error('编辑期间会话绑定已变化')
      return structuredClone(result)
    } catch (error) {
      // A failed durable save may still have reached disk; neither it nor a vendor exception
      // establishes that history stayed unchanged. Retain refusal even if this save also fails.
      await this.journal.save({ ...intent, phase: 'uncertain' })
      throw error
    } finally {
      this.active.delete(sessionId)
    }
  }

  async admit(sessionId: string, requestId: string, send: () => Promise<void>): Promise<void> {
    const intent = await this.transition(sessionId, requestId, 'ready', 'admitting')
    try {
      await send()
    } catch (error) {
      await this.journal.save({
        ...intent,
        phase: knownTerminalFailure(error) ? 'settled' : 'uncertain',
      })
      throw error
    }
  }

  /** Persist before the single replacement prompt crosses the vendor transport. */
  async beginPrompt(sessionId: string, requestId: string): Promise<void> {
    await this.transition(sessionId, requestId, 'admitting', 'prompting')
  }

  /** Reuse a verified fork only for an explicitly selected, confirmed unsent replacement. */
  async reuseUnsent(
    context: Pick<ExternalEditContext, 'record' | 'signal'> & { targetSeq?: number },
    previousRequestId: string,
    requestId: string,
    createEmpty?: () => Promise<ExternalEditResult>,
  ): Promise<ExternalEditResult> {
    const sessionId = context.record.nativeSessionId
    if (!sessionId || !requestId || requestId === previousRequestId || this.active.has(sessionId))
      throw Error('编辑消息正在处理或发送身份已使用')
    const intent = this.journal.get(sessionId)
    if (
      !intent ||
      intent.requestId !== previousRequestId ||
      !['ready', 'admitting', 'settled'].includes(intent.phase)
    )
      throw Error('编辑消息的发送阶段尚未确认')
    if (
      !intent.result ||
      intent.recordId !== context.record.id ||
      intent.result.sessionId !== context.record.acpSessionId
    )
      throw Error('未发送消息的会话绑定已变化')
    const fingerprint = externalEditRecordFingerprint(context.record)
    this.active.add(sessionId)
    try {
      context.signal.throwIfAborted()
      let result = intent.result
      if (createEmpty) {
        if (!result.ephemeral || result.retained.length) throw Error('未发送的分支不是空会话')
        await this.journal.save({ ...intent, requestId, fingerprint, phase: 'invoking' })
        context.signal.throwIfAborted()
        result = await createEmpty()
        if (!result.sessionId || result.retained.length) throw Error('新的空会话身份未确认')
      }
      await this.journal.save({
        ...intent,
        result,
        requestId,
        fingerprint,
        ...(context.targetSeq === undefined ? {} : { targetSeq: context.targetSeq }),
        phase: 'ready',
      })
      context.signal.throwIfAborted()
      if (externalEditRecordFingerprint(context.record) !== fingerprint)
        throw Error('编辑期间会话绑定已变化')
      return structuredClone(result)
    } finally {
      this.active.delete(sessionId)
    }
  }

  /** Only an observed terminal vendor turn can release the edit's send guard. */
  async settle(sessionId: string, requestId: string): Promise<void> {
    await this.transition(sessionId, requestId, 'prompting', 'settled')
  }

  private async transition(
    sessionId: string,
    requestId: string,
    from: ExternalEditIntent['phase'],
    to: ExternalEditIntent['phase'],
  ): Promise<ExternalEditIntent> {
    if (this.active.has(sessionId)) throw Error('编辑消息正在处理')
    this.active.add(sessionId)
    try {
      const intent = this.require(sessionId, requestId, from)
      await this.journal.save({ ...intent, phase: to })
      return intent
    } finally {
      this.active.delete(sessionId)
    }
  }

  private require(
    sessionId: string,
    requestId: string,
    phase: ExternalEditIntent['phase'],
  ): ExternalEditIntent {
    const intent = this.journal.get(sessionId)
    if (!intent || intent.requestId !== requestId || intent.phase !== phase)
      throw Error('编辑消息的发送阶段尚未确认')
    return structuredClone(intent)
  }
}
