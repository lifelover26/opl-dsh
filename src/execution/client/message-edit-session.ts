/** One Session's message-edit selection, shared by message actions and recovery UI. */
import type { ExecutionCall } from '../../shared/client/remote-call.ts'
import type {
  MessageEditChoice,
  MessageEditState,
  MessageEditUnavailable,
} from '../contracts/message-edit.ts'

export interface EditSelection {
  seq: number
  head: number
  previousDraft: string
}

export interface MessageEditSnapshot {
  state?: MessageEditState | undefined
  selection?: EditSelection | undefined
  error?: string | undefined
  /** Latest read status; unavailable choices cannot acquire a selection. */
  unavailable?: MessageEditUnavailable | undefined
}

export const messageEditCopy = {
  cancel: '取消编辑',
  conflict: '输入框已有草稿，请先发送或清空',
  failed: '无法读取可编辑消息，请重试',
  storage: '无法保存编辑状态，请重试',
  stop: '请先停止当前对话',
  recover: '重试未确认的编辑',
  retry: '重试编辑',
  unavailable: '暂不可编辑',
} as const

export const messageEditUnavailableCopy: Record<MessageEditUnavailable['reason'], string> = {
  'history-unavailable': '无法读取可编辑消息',
  'history-busy': '消息历史尚未就绪',
  'mapping-unavailable': '消息身份尚未确认，请新建会话继续',
  'model-unavailable': '当前模型不可用于编辑',
}

const keyFor = (sessionId: string) => `opl-message-edit-v1:${sessionId}`

function restored(sessionId: string): EditSelection | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyFor(sessionId)) ?? 'null')
    if (
      !value ||
      typeof value !== 'object' ||
      !('seq' in value) ||
      !('head' in value) ||
      !('previousDraft' in value)
    )
      return
    if (
      typeof value.seq === 'number' &&
      Number.isSafeInteger(value.seq) &&
      value.seq >= 0 &&
      typeof value.head === 'number' &&
      Number.isSafeInteger(value.head) &&
      value.head >= value.seq &&
      typeof value.previousDraft === 'string'
    )
      return { seq: value.seq, head: value.head, previousDraft: value.previousDraft }
  } catch {
    /* A damaged local selection cannot acquire edit ownership. */
  }
  return
}

/**
 * Own one Session's editable choices and selected target.
 *
 * Every message action and the exceptional recovery control observe this store,
 * so the row icon, the composer draft, and the prompt interceptor cannot drift
 * into separate selections.
 */
export class MessageEditSession {
  private snapshot: MessageEditSnapshot
  private readonly listeners = new Set<() => void>()
  private loadFlight: Promise<void> | undefined
  private loadGeneration = 0
  private loadAgain = false
  private lastChoices: MessageEditChoice[] = []
  private recoveryFlight: Promise<boolean> | undefined

  constructor(
    readonly sessionId: string,
    private readonly call: ExecutionCall,
  ) {
    this.snapshot = { selection: restored(sessionId) }
  }

  readonly getSnapshot = () => this.snapshot

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  choice(seq: number): MessageEditChoice | undefined {
    const choices = this.snapshot.unavailable ? this.lastChoices : this.snapshot.state?.choices
    return choices?.find((choice) => choice.seq === seq)
  }

  /** Retry a read without queuing another copy of a read already in progress. */
  retry(): Promise<void> {
    return this.loadFlight ?? this.load()
  }

  async load(): Promise<void> {
    if (this.loadFlight) {
      this.loadAgain = true
      return this.loadFlight
    }
    const generation = ++this.loadGeneration
    const flight = this.call('message-edit-state', { sessionId: this.sessionId })
      .then((state) => {
        if (generation !== this.loadGeneration || this.loadAgain) return
        const selection = this.snapshot.selection
        if (
          selection &&
          !state.busy &&
          !state.pending &&
          !state.unavailable &&
          !state.choices.some((choice) => choice.seq === selection.seq)
        )
          this.removeSelection()
        if (!state.unavailable) this.lastChoices = state.choices
        this.publish({
          ...this.snapshot,
          state,
          unavailable: state.unavailable,
          error: undefined,
        })
      })
      .catch(() => {
        if (generation === this.loadGeneration && !this.loadAgain)
          this.publish({
            ...this.snapshot,
            unavailable:
              this.snapshot.state?.supported === false && !this.snapshot.unavailable?.retryable
                ? undefined
                : { reason: 'history-unavailable', retryable: true },
          })
      })
      .finally(() => {
        if (this.loadFlight === flight) this.loadFlight = undefined
        if (this.loadAgain) {
          this.loadAgain = false
          return this.load()
        }
      })
    this.loadFlight = flight
    return flight
  }

  async select(seq: number, draft: string): Promise<boolean> {
    if (draft) {
      this.publish({ ...this.snapshot, error: messageEditCopy.conflict })
      return false
    }
    if (!this.snapshot.state) await this.load()
    if (this.snapshot.unavailable) return false
    const state = this.snapshot.state
    const choice = state?.choices.find((candidate) => candidate.seq === seq)
    if (!state || !choice || !state.supported) {
      this.publish({ ...this.snapshot, error: messageEditCopy.failed })
      return false
    }
    if (state.busy || state.pending) {
      this.publish({ ...this.snapshot, error: messageEditCopy.stop })
      return false
    }
    const selection = { seq: choice.seq, head: state.head, previousDraft: draft }
    try {
      localStorage.setItem(keyFor(this.sessionId), JSON.stringify(selection))
    } catch {
      this.publish({ ...this.snapshot, error: messageEditCopy.storage })
      return false
    }
    this.publish({ ...this.snapshot, selection, error: undefined })
    return true
  }

  cancel(): EditSelection | undefined {
    const selection = this.snapshot.selection
    if (!selection) return
    try {
      localStorage.removeItem(keyFor(this.sessionId))
    } catch {
      this.publish({ ...this.snapshot, error: messageEditCopy.storage })
      return
    }
    this.removeSelection()
    return selection
  }

  accepted(): void {
    this.removeSelection()
  }

  recover(): Promise<boolean> {
    if (this.recoveryFlight) return this.recoveryFlight
    const recovery = this.snapshot.state?.recovery
    if (!recovery || this.snapshot.state?.busy || this.snapshot.unavailable)
      return Promise.resolve(false)
    const flight = this.call('message-edit-send', recovery)
      .then(async () => {
        this.publish({ ...this.snapshot, error: undefined })
        await this.load()
        return true
      })
      .catch(() => {
        this.publish({ ...this.snapshot, error: messageEditCopy.failed })
        return false
      })
      .finally(() => {
        if (this.recoveryFlight === flight) this.recoveryFlight = undefined
      })
    this.recoveryFlight = flight
    return flight
  }

  dismissError(): void {
    if (!this.snapshot.error) return
    this.publish({ ...this.snapshot, error: undefined })
  }

  private removeSelection(): void {
    try {
      localStorage.removeItem(keyFor(this.sessionId))
    } catch {
      /* The in-memory owner must still release so a failed local write cannot send an edit. */
    }
    this.publish({ ...this.snapshot, selection: undefined })
  }

  private publish(next: MessageEditSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
