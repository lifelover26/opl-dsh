/** Public, browser-safe vocabulary shared by generated Remote consumers. */
export type * from '../gateway/contracts/account.ts'
export type * from '../gateway/contracts/models.ts'
export type * from '../execution/contracts/sessions.ts'
export type * from '../execution/contracts/usage.ts'
export type * from '../execution/contracts/stop-edit.ts'
export type * from '../execution/contracts/message-edit.ts'
export type * from '../execution/contracts/catalog.ts'
export type * from '../execution/contracts/installations.ts'
export type * from '../execution/contracts/views.ts'
export type * from '../execution/contracts/limits.ts'
export type * from '../execution/contracts/minimax-account.ts'
export type * from '../collaboration/host/feedback/types.ts'
export type * from '../setup/contracts.ts'
export type * from '../credentials/contracts/windows-keyring.ts'
export type * from '../auto-review/contracts/settings.ts'
export interface GatewayModelEdit {
  group: string
  revision: number
  models: import('../gateway/contracts/models.ts').ModelDraft[]
  api?: string
}
export interface HarnessSelection {
  current: import('@deepseek-ai/dsh-api-session-controller/types').ModelSelection | null
  groups: import('@deepseek-ai/dsh-api-session-controller/types').ModelCatalog['groups']
  combination?: string
  /** External CLI effort must not be overwritten by the native provider projection. */
  effortSource?: 'harness'
}
/** Live reasoning values advertised by the selected external Harness. */
export interface HarnessReasoningPreflight {
  status: 'known' | 'unavailable' | 'not-applicable'
  efforts: Array<{ id: string; name: string }>
}
export interface SessionRequest {
  sessionId: string
}
export interface HarnessStartRequest {
  combination: string
  cwd: string
  existingSessionId?: string
  taskId?: string
  origin?: import('../execution/contracts/sessions.ts').HarnessOrigin
  sandbox?: 'read-only' | 'workspace' | 'full-access'
}
export interface HarnessPromptRequest {
  sessionId: string
  text: string
  operationId: string
  /** Files/directories owned by this operation; omitted means exclusive project writes. */
  writeScope?: string[]
}
/** Remote 读取普通侧栏会话的停止后编辑入口状态。 */
export type { StopEditStateRequest } from '../execution/contracts/stop-edit.ts'
export interface CooperationSettings {
  autoReview: boolean
  maxRevisions: number
  externalCodex: boolean
}
export interface DelegateRequest {
  cwd?: string
  origin: import('../execution/contracts/sessions.ts').HarnessOrigin
  combination?: string
  task: string
  taskId: string
  operationId: string
  sessionId?: string
  acceptance?: string
  wait?: boolean
  sandbox?: 'read-only' | 'workspace' | 'full-access'
  /** Files/directories owned by this operation, independently of its sandbox permission. */
  writeScope?: string[]
}
export interface ReviewRequest {
  origin: import('../execution/contracts/sessions.ts').HarnessOrigin
  sessionId: string
  operationId: string
  decision: 'accepted' | 'changes_requested'
  note: string
}
export interface ReportRequest {
  origin: import('../execution/contracts/sessions.ts').HarnessOrigin
  summary: string
  artifacts: string[]
  checks: string[]
  remaining: string[]
}
export interface WakeSettings {
  wakeTransport: 'unconnected' | 'codex-queue'
  wakeExecution: 'native' | 'wsl'
  wakeExecutable: string
  wakeDistro: string
}
export interface CoordinationStatus extends WakeSettings {
  installed: boolean
  autoStart: boolean
  version: string
  enhancementVersion: string
  superagentSupported?: boolean
  update: { state?: string; checkedAt?: string; message?: string; checkTrigger: string }
  paths: { suiteRoot: string; profileHome: string; skillDir: string }
}
export type {
  MiniMaxCandidateRequest,
  MiniMaxCandidateResult,
} from '../execution/contracts/candidate.ts'

export type * from '../execution/contracts/codex-runtime.ts'
export type * from '../execution/contracts/capabilities.ts'
