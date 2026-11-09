/**
 * 停止后编辑入口的纯逻辑：可见性、幂等身份、结果播报与待填草稿。
 *
 * 这里不碰 React、Remote 或官方输入框，只把“允许显示什么”“同一个意图只发一次”
 * “结果该怎么讲”“旧结果能不能写进当前会话的输入框”固定下来，便于按边界逐条验证。
 *
 * 所有“当前处于什么状态”的事实都来自 Host 的 `StopEditState`：客户端不猜 Harness 能力、
 * 不细化 Host 没有报告过的进度，也不把一次失败解释成“什么都没发生”。
 */
import type {
  StopEditBoundary,
  StopEditHarness,
  StopEditResult,
  StopEditState,
  StopEditUnrestored,
} from '../contracts/stop-edit.ts'
import { STOP_EDIT_COPY } from './stop-edit-locales.ts'

export type StopEditPhase =
  'idle' | 'loading' | 'choosing' | 'stopping' | 'rewinding' | 'done' | 'error'

export interface StopEditView {
  phase: StopEditPhase
  /** Host 明确判定能力可用。false 时不再列出可回退边界。 */
  supported: boolean
  /**
   * Host 判定本次落入首批范围的 Harness；未落入时缺省。
   *
   * 它的唯一用途是区分两种 `supported: false`：有值时必须展示 Host 给出的原因，
   * 缺省时客户端完全不渲染——范围外的 Harness 不该出现任何解释。
   */
  harness?: StopEditHarness
  /** 不可用原因，由 Host 给出并直接展示。 */
  reason?: string
  busy: boolean
  /** Host 报告这个会话上仍有一次编辑请求没有落定（在途或被阻断）。 */
  pending: boolean
  boundaries: StopEditBoundary[]
  /** 上一次回退留下的原文，等客户端放回普通输入框。 */
  pendingDraft?: { text: string; clientRequestId: string }
  editBranch?: { sessionId: string; title: string }
  /** 已提交结果中保存的原会话导航身份。 */
  editSourceSessionId?: string
  /** 正在飞行的请求；状态刷新不会解除它，重复点击也只会得到同一个身份。 */
  inFlight?: { clientRequestId: string; boundaryId: string }
  /** 本次视图所属的会话；迟到的结果必须与它一致才允许落地。 */
  sessionId?: string
  result?: StopEditResult
  error?: string
}

export const INITIAL_STOP_EDIT: StopEditView = {
  phase: 'idle',
  supported: false,
  busy: false,
  pending: false,
  boundaries: [],
}

let minted = 0
/** 一次用户意图一个身份；同一次意图的重试必须复用它。 */
export function mintClientRequestId(): string {
  minted += 1
  return `stop-edit-${Date.now().toString(36)}-${minted.toString(36)}`
}

/**
 * 入口是否可见。
 *
 * 只有真的存在可回退边界时才渲染这个按钮：范围外的 Harness 什么都不渲染，首批范围内
 * 但暂时没有消息的会话由 {@link waitingStatus} 给出解释，而不是无解释地消失。
 */
export function entryVisible(view: StopEditView): boolean {
  return view.supported && view.boundaries.length > 0
}

/**
 * 支持的首批 Harness 此刻却没有任何可回退边界时的准确状态。
 *
 * 两种事实分开讲：仍然在运行（Host 报告的 `busy`），和还没有发送过消息。两者都不猜消息
 * 身份，也不触发任何请求——这里只返回一句话，是否显示由调用方决定。
 */
export function waitingStatus(view: StopEditView): string | undefined {
  if (!view.supported || view.boundaries.length > 0) return undefined
  return view.busy ? STOP_EDIT_COPY.waitingRunning : STOP_EDIT_COPY.waitingEmpty
}

/**
 * 首批 Harness 但此刻不可用时的解释。
 *
 * 范围外的 Harness 返回 undefined：它们的 `harness` 缺省，客户端连一句话都不该写。
 * 有值时必须把 Host 给的原因原样展示——能力未就绪、会话被阻断都是真实状态。
 */
export function unavailableReason(view: StopEditView): string | undefined {
  if (view.supported || view.harness === undefined) return undefined
  return view.reason
}

/**
 * 是否提供只读的“重新读取会话历史”。
 *
 * 只有两种情形需要它：这次读取本身失败了（`error`），或 Host 报告这个会话上还有一次
 * 未落定的编辑（`pending`）——结果不确定时唯一安全的动作就是重新核对持久状态。范围外的
 * Harness 与仅仅“未就绪”的能力不在这里：前者不渲染，后者不能靠点按钮变好。
 */
export function recoveryReadVisible(view: StopEditView): boolean {
  if (view.error !== undefined) return true
  return !view.supported && view.harness !== undefined && view.pending
}

/** 无法恢复的内容必须逐条展示；附件在变更之前就会被拒绝，这里只兜底展示。 */
export function unrestoredNotice(unrestored: readonly StopEditUnrestored[]): string {
  if (unrestored.length === 0) return ''
  const named = unrestored.filter((item) => item.name).map((item) => item.name!)
  const rest = unrestored.length - named.length
  const files = named.length ? `（${named.join('、')}）` : ''
  const more = rest > 0 ? `，另有 ${rest} 项` : ''
  return `${unrestored.length} 项内容无法自动放回输入框${files}${more}：${unrestored[0].reason}`
}

/**
 * 原文最终去了哪里。
 *
 * `input` 只表示“这一刻输入框是空的，原文确实被填了进去”；输入框里已经有用户自己的草稿
 * 时必须是 `kept`，否则结果播报会声称一件没有发生的事。
 */
export type StopEditDraftPlacement = 'input' | 'kept'

/**
 * 一次成功回退的对外说明。
 *
 * 明确区分五件事：对话上下文已回退、原会话仍在、原文这次到底放回了输入框还是没有覆盖
 * 已有草稿、磁盘文件没有被撤销、这次只发起了一次新的 operation。被移除的历史尾部是用户
 * 自己的选择，不当成错误逐条报。
 */
export function describeOutcome(
  result: StopEditResult,
  placement: StopEditDraftPlacement = 'input',
): string {
  const head = result.moved
    ? `已回退到新分支会话「${result.branchTitle}」，原会话已保留；打开编辑分支后再次发送。`
    : placement === 'kept'
      ? '已回退到该条消息之前；输入框里已有你的草稿，原文没有覆盖它，仍保留为待填原文。'
      : '已回退到该条消息之前，原文已放回输入框；再次发送即可。'
  const review = `模型 ${result.review.model}${
    result.review.effort ? `，推理档位 ${result.review.effort}` : ''
  }，权限 ${result.review.permissions}，项目 ${result.review.cwd || '未知'}。`
  const removed = result.removedTurns ? `已移除 ${result.removedTurns} 轮对话记录。` : ''
  const tail = unrestoredNotice(result.unrestored)
  return [head, review, removed, tail, STOP_EDIT_COPY.filePreserved].filter(Boolean).join('\n')
}

export interface StopEditStateStoreOptions {
  load: (sessionId: string) => Promise<StopEditState>
  run: (request: {
    clientRequestId: string
    sessionId: string
    boundaryId: string
  }) => Promise<StopEditResult>
  /**
   * 清除持久草稿的公开响应。
   *
   * 这里刻意保留 Remote 上的真实响应类型而不是 `unknown`：`acknowledged` 就是结论，
   * `false` 与抛错同样是“没有确认”，两者都必须给出固定诊断，绝不能当成成功。
   */
  acknowledge: (request: {
    sessionId: string
    clientRequestId: string
  }) => Promise<{ acknowledged: boolean }>
  /**
   * 失败提示。
   *
   * 第二个参数是这次失败真正所属的会话：调用方据此把晚到的旧会话失败挡在当前界面之外，
   * 不把提示写进已经切走的会话。
   */
  onError: (message: string, sessionId: string) => void
}

/** 入口状态所有者：一次只允许一个在途请求，重复点击不会发出第二次回退。 */
export class StopEditStateStore {
  private value: StopEditView = INITIAL_STOP_EDIT
  private sessionId: string | undefined
  /** 每次 load 的自增代号；只有最新一次的结果才允许发布。 */
  private generation = 0
  /**
   * 最近一次尝试的身份，按会话保存。
   *
   * 它独立于界面状态：一次失败的尝试在状态刷新之后重试时必须复用同一个身份，否则
   * Host 会把它当成一次全新的意图，可能真的再回退一次。
   */
  private readonly attempts = new Map<string, { clientRequestId: string; boundaryId: string }>()
  /** 在途请求与界面状态分离，避免一次 load 就把互斥解除掉。 */
  private readonly running = new Set<string>()
  private readonly listeners = new Set<() => void>()
  /**
   * 拥有这段状态的界面已经不在了。
   *
   * 卸载之后既不能把结果交给调用方（它会去写已经关闭的输入框），也不能回传任何提示。
   */
  private detached = false

  constructor(private readonly options: StopEditStateStoreOptions) {}

  getSnapshot = (): StopEditView => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 所属组件卸载或改属别的会话：停止交付结果与提示，但保留 Host 侧的持久草稿，
   * 等下一次安全恢复时重新读取。
   */
  detach(): void {
    this.detached = true
  }

  /**
   * 读取入口可见性；不支持时入口不渲染，而不是渲染一个坏掉的按钮。
   *
   * 每次读取都会认领一个代号：同一会话上的多次并发读取，只有最后一次能发布结果，
   * 先发后到的旧响应不会把新边界覆盖掉。
   *
   * 读取失败只给固定诊断：它同样是一次“重新读取 Host 持久状态”的入口，界面据此提供
   * 重试，而不是把底层异常文本反射出来。
   */
  async load(sessionId: string): Promise<void> {
    const generation = (this.generation += 1)
    this.sessionId = sessionId
    // 会话订阅本身就会触发 load；在途请求绝不能因此被解除互斥或丢失重试身份。
    const inflight = this.running.has(sessionId) ? this.attempts.get(sessionId) : undefined
    this.publish({
      ...this.value,
      sessionId,
      ...(inflight ? { inFlight: inflight } : {}),
    })
    try {
      const state = await this.options.load(sessionId)
      if (generation !== this.generation || this.sessionId !== sessionId) return
      const still = this.running.has(sessionId) ? this.attempts.get(sessionId) : undefined
      // 读完之后入口收起：可回退消息不应该在每次打开会话时都铺在输入框上方。
      // 回退在途时保持 busy 语义，不因为刷新就重新变成可点。
      this.publish({
        phase: still ? (state.busy ? 'stopping' : 'rewinding') : 'idle',
        sessionId,
        supported: state.supported,
        ...(state.harness === undefined ? {} : { harness: state.harness }),
        ...(state.reason === undefined ? {} : { reason: state.reason }),
        busy: state.busy,
        pending: state.pending,
        boundaries: state.boundaries,
        ...(still ? { inFlight: still } : {}),
        ...(state.pendingDraft === undefined ? {} : { pendingDraft: state.pendingDraft }),
        ...(state.editBranch === undefined ? {} : { editBranch: state.editBranch }),
        ...(state.editSourceSessionId === undefined
          ? {}
          : { editSourceSessionId: state.editSourceSessionId }),
      })
    } catch {
      if (generation !== this.generation || this.sessionId !== sessionId) return
      // 读取失败：清空可回退边界，避免拿着一份可能已经过期的历史继续回退。
      this.publish({
        ...INITIAL_STOP_EDIT,
        sessionId,
        phase: 'error',
        error: STOP_EDIT_COPY.readFailed,
      })
    }
  }

  /** 展开可选消息列表。 */
  open(): void {
    if (this.value.phase === 'choosing') return
    this.publish({ ...this.value, phase: 'choosing' })
  }

  close(): void {
    if (this.value.phase === 'stopping' || this.value.phase === 'rewinding') return
    this.publish({ ...this.value, phase: 'idle' })
  }

  /**
   * 选择一条已发送的消息并请求回退。
   *
   * 同一边界的重复点击复用同一个 `clientRequestId`，因此 Host 只会真正回退一次；换一个
   * 边界则是新的意图，必须换身份。迟到的结果只交给调用方判断，不会写进别的会话。
   *
   * 失败时先按持久状态重新读取一次：结果不确定的编辑在 Host 那边会给出阻断原因，客户端
   * 据此收起入口、保留重试身份，既不自行解除阻断，也不宣称会话没有被改动。
   */
  async choose(sessionId: string, boundaryId: string): Promise<StopEditResult | undefined> {
    // 在途互斥以真实的请求集合为准，与界面状态无关：一次刷新不能解锁第二次回退。
    if (this.running.has(sessionId)) return undefined
    // 同一条消息的重试复用同一个身份；换一个边界才是新意图。
    const attempt = this.attempts.get(sessionId)
    const clientRequestId =
      attempt?.boundaryId === boundaryId ? attempt.clientRequestId : mintClientRequestId()
    const identity = { clientRequestId, boundaryId }
    this.attempts.set(sessionId, identity)
    this.running.add(sessionId)
    const { error: _cleared, ...rest } = this.value
    // 进度措辞跟随 Host 报告的 busy：没有在运行的轮次就不说“正在停止”。
    this.publish({ ...rest, phase: this.value.busy ? 'stopping' : 'rewinding', inFlight: identity })
    try {
      const result = await this.options.run({ clientRequestId, sessionId, boundaryId })
      // 结果只交给它所属的那次会话。store 已经切到别的会话、或所属界面已经卸载时宁可
      // 什么都不返回，也不能让调用方把迟到的原文写进别的会话或已经关闭的输入框。
      if (this.sessionId !== sessionId || this.detached) return undefined
      // 成功即作废重试身份：之后的编辑是另一条消息或另一次意图。
      this.attempts.delete(sessionId)
      const { inFlight: _done, ...settled } = this.value
      this.publish({ ...settled, phase: 'done', result })
      return result
    } catch {
      if (this.sessionId !== sessionId) return undefined
      // 失败保留身份，重试同一个身份才不会被当成一次全新的回退。
      // 界面已经卸载就不再补读：没有界面要展示它，原文留在 Host 等下一次安全恢复。
      if (!this.detached) {
        await this.load(sessionId)
        if (this.sessionId !== sessionId) return undefined
      }
      this.publish({ ...this.value, phase: 'error', error: STOP_EDIT_COPY.rewindFailed })
      return undefined
    } finally {
      this.running.delete(sessionId)
      if (this.sessionId === sessionId && this.value.inFlight !== undefined) {
        const { inFlight: _cleared, ...settled } = this.value
        this.publish(settled)
      }
    }
  }

  /**
   * 原文已放回输入框后清除持久草稿，恢复后不会重复填入同一条。
   *
   * 公开响应里的 `acknowledged` 就是结论：`false` 与抛错同样是“没有确认”，一律给出固定
   * 诊断，绝不把响应当成成功。诊断只回传给这次失败真正所属的会话。
   */
  async acknowledge(sessionId: string, clientRequestId: string): Promise<boolean> {
    try {
      const response = await this.options.acknowledge({ sessionId, clientRequestId })
      if (response.acknowledged) return true
      this.reportAcknowledgementFailure(sessionId)
      return false
    } catch {
      this.reportAcknowledgementFailure(sessionId)
      return false
    }
  }

  /**
   * 清除草稿失败的固定诊断。
   *
   * 输入框里的原文不会被撤销，但持久草稿还在，因此必须让用户知道它可能再次出现。
   * 这次失败只能写回它所属的会话：界面已卸载、或 store 已经改属别的会话时一律丢弃，
   * 晚到的旧失败不得出现在新会话的提示里。
   */
  private reportAcknowledgementFailure(sessionId: string): void {
    if (this.detached) return
    if (this.sessionId !== undefined && this.sessionId !== sessionId) return
    this.options.onError(STOP_EDIT_COPY.acknowledgementFailed, sessionId)
  }

  private publish(next: StopEditView): void {
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}
