import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { HarnessContextUsage } from './usage.ts'

/** OPL projections over native Harness sessions. No provider secrets cross this face. */
export const GROK_COMBINATION = 'grok-build/grok-4.7'
export const DSH_COMBINATION = 'dsh/deepseek-flash'
export type HarnessState =
  | 'idle'
  | 'queued'
  | 'waiting_child'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
export type HarnessOrigin = { kind: 'codex' | 'dsh' | 'harness' | 'desktop'; sessionId: string }
export interface HarnessApproval {
  id: string
  title: string
  /** Shell command supplied by the CLI for this pending human decision. */
  command?: string
  options: { optionId: string; name: string; kind: string }[]
}
export interface HarnessTurn {
  operationId: string
  fingerprint: string
  prompt: string
  /** Ordered request input with immutable official image references; absent on text-only turns. */
  promptContent?: import('./prompt.ts').HarnessPromptPart[]
  reasoningEffort?: string
  /** Canonical declared write paths for scheduling, not a sandbox restriction. */
  writeScope?: string[]
  text: string
  /** Provider-supplied text and reasoning in arrival order; absent on older records. */
  content?: { type: 'text' | 'reasoning'; text: string }[]
  /** Whole-turn accounting normalized to disjoint input/cache and inclusive output buckets. */
  usage?: TokenUsage
  /** Context occupancy reported by the external ACP session, when supplied. */
  contextUsage?: HarnessContextUsage
  state: HarnessState
  stopReason?: string
  error?: string
  report?: CollaborationReport
  review?: CollaborationReview
  delivery?: CollaborationDelivery
  tools: HarnessTool[]
  /**
   * 精确的原生边界身份，由 Harness 运行时回报或由官方会话日志推导。
   * 缺失表示这条轮次没有落进可定位的原生历史：停止后编辑必须拒绝按文本、时间或
   * 顺序猜配，而不是把一条猜出来的分支交给用户。
   */
  native?: HarnessTurnNative
}
/** 一条轮次在原生会话历史中的精确落点。 */
export interface HarnessTurnNative {
  /** 原生用户消息 id；MiniMax 由运行时边界通知回报。 */
  userMessageId?: string
  /** 原生 turn id。 */
  turnId?: string
  /** 官方会话日志中该条用户消息事件的 seq。 */
  officialSeq?: number
  /** 运行时提供的历史版本标识。 */
  historyVersion?: string
}
/** ACP tool data retained for transcript rendering, never for tool execution. */
export interface HarnessTool {
  id: string
  title: string
  status: string
  kind: string
  /** Verbatim ACP JSON; arbitrary CLI payloads stay outside the Remote type graph. */
  inputJson?: string
  outputJson?: string
  contentJson?: string
  locationsJson?: string
}
export interface HarnessSession {
  id: string
  combination: string
  harnessRef: string
  modelRef: import('./catalog.ts').ModelRef
  /**
   * Explicit reasoning setting for this combination, carried verbatim to the Harness.
   * An adapter decides what it means: an effort id, or a switch such as `on`/`off`.
   * Absent means the caller expressed no choice, and the Harness default applies. An
   * explicit value is never rewritten onto that default, including on reload.
   */
  reasoningEffort?: string
  cwd: string
  acpSessionId: string
  /** Ordinary official DSH conversation; distinct from the CLI's ACP session. */
  nativeSessionId?: string
  autoWakePaused?: boolean
  assignment?: CollaborationAssignment
  origin: HarnessOrigin
  title: string
  /** True when the official Harness supplied the title rather than the prompt fallback. */
  titleFromHarness?: boolean
  sandbox: 'read-only' | 'workspace' | 'full-access'
  /** Official ZCode mode frozen at creation; absent legacy records use yolo. */
  zcodeMode?: 'build' | 'yolo'
  /** Official reviewer enabled at creation; absent legacy records retain direct mode. */
  externalAutoReview?: boolean
  createdAt: string
  updatedAt: string
  turns: HarnessTurn[]
  /**
   * 最近一次停止后编辑的持久谱系。缺失表示这个会话从未被回退过。
   * `pendingOperationId` 是回退后下一次发送必须使用的 operation 身份；被回退轮次的
   * 旧身份一律不再复用，避免反馈落错目标。
   */
  stopEdit?: HarnessStopEdit
}
/** 一次成功回退留下的可复核谱系。 */
export interface HarnessStopEdit {
  /** 与 `StopEditResult.clientRequestId` 相同，用于重复点击的幂等判定。 */
  clientRequestId: string
  /** 回退前的会话身份，用户随时可以回去查看原记录。 */
  previousSessionId: string
  /** 回退后记录所指向的会话。 */
  sessionId: string
  /** 回退到的边界 id。 */
  boundaryId: string
  /** 下一次发送必须使用的 operation 身份。 */
  pendingOperationId: string
  /** 被移除的投影尾部轮次数。 */
  removedTurns: number
  at: string
}
export interface HarnessSnapshot extends HarnessSession {
  connected: boolean
  state: HarnessState
  approvals: HarnessApproval[]
}
export interface HarnessCatalog {
  combinations: {
    id: string
    name: string
    model: string
    modelId: string
    harness: string
    source: string
    available: boolean
    reason?: string
  }[]
  sessions: HarnessSnapshot[]
}

/** Task and delivery state live with the existing OPL session record. */
export interface CollaborationAssignment {
  taskId: string
  objective: string
  acceptance: string
  autoReview: boolean
  maxRevisions: number
  revisions: number
  createdAt: string
}
export interface CollaborationReport {
  summary: string
  artifacts: string[]
  checks: string[]
  remaining: string[]
}
export interface CollaborationReview {
  decision: 'pending' | 'accepted' | 'changes_requested'
  note?: string
  reviewedAt?: string
}
export interface CollaborationDelivery {
  id: string
  state: 'pending' | 'delivering' | 'delivered' | 'blocked'
  attempt: number
  error?: string
}
