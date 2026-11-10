/**
 * zh/en dictionary of the Auto Review settings section. Every product string the
 * panel can render lives here, so no call site assembles prose; `zh` is the key
 * source of truth and `en` is typed to the same key set.
 *
 * This section controls only OPL's optional reviewer route adapter and its
 * external-Harness approval bridge. The official Auto plugin owns native
 * permission, policy, history and lifecycle behavior.
 *
 * The state and failure copy also keeps what is effective apart from what is
 * only a draft, and never claims a transport-level save failure definitely did
 * not take effect.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const zh = {
  sectionLabel: '审查模型路线',
  title: 'Auto Review 路线适配',
  intro:
    '官方 Auto 插件负责 DSH 原生工具审查。启用 OPL 适配后，可为官方请求指定独立审查模型和预算，并为已绑定的外部 Harness 审批提供同一路线。关闭 OPL 适配后，官方 Auto 继续使用当前会话模型。',
  distinction:
    'DSH 原生权限、风险规则和审查生命周期由官方插件拥有；OPL 不重复执行决策。ZCode 外部审批只有在身份、调用和授权均可精确绑定时才会接入。',
  boundaryNative:
    '官方 Auto 可在 profile 插件管理中独立启停，每个会话仍须显式选择 Auto。OPL 路线只改变官方审查请求的模型与预算，不改变其策略或结论。',
  boundarySandbox:
    '官方 Auto 的权限效果由官方插件说明和会话权限选择器展示。本页只控制 OPL 路线适配和外部 Harness 审批桥。',
  presetNotice:
    '本开关不启用或卸载官方 Auto，也不修改会话权限。官方 Auto 由 profile 插件管理，且必须在目标会话中显式选择。',
  enableTitle: '启用',
  enableLabel: '启用 OPL 路线适配',
  enableAria: '启用 OPL 审查路线适配',
  effectiveLabel: 'OPL 适配状态（Host）',
  effectiveOn: '已启用',
  effectiveOff: '已关闭',
  draftPending: '草稿尚未保存，生效状态仍以 Host 返回值为准。',
  statusTitle: 'Host 状态',
  stateLabel: '运行状态',
  'state.disabled': '已关闭',
  'state.ready': '可用',
  'state.unavailable': '不可用',
  'state.draining': '停用进行中',
  activeReviews: '在途审查',
  autoSessions: '处于 Auto 的会话',
  revision: 'revision',
  routeTitle: '审查模型路线',
  routeSourceNote:
    '普通 reviewer 与决策模型分开列出；只有 Host 已注册并确认可用的路线才会出现在对应选项中。这里不从外部 Harness 的执行组合菜单拼装路线。',
  routeCurrent: 'Codex Auto Review（适配默认）',
  routeFixed: '使用独立 reviewer 路线',
  routeDecision: '使用决策模型',
  routesEmpty: '没有可用的审查路线，请检查账号与模型配置。',
  routeUnavailable:
    'Host 报告 OPL 路线适配当前不可用，该次审查会失败。你可以更换已广告路线，或关闭 OPL 适配以使用官方当前会话模型。',
  routeMissing: '当前记录的独立路线不在 Host 返回的列表中，无法在此编辑；请先重新读取。',
  provider: '提供方',
  model: '模型',
  decisionModel: '决策模型',
  effort: '推理强度',
  effortNone: '该路线未提供可选推理强度',
  noRanking: '不推荐未经评测的模型排名；这里只呈现 Host 已注册并可用的路线。',
  limitsTitle: '请求预算',
  timeoutMs: '超时（毫秒）',
  maxOutputTokens: '最大输出 token',
  limitsRange:
    '可保存范围：超时 {timeoutMin}–{timeoutMax} 毫秒，输出 {outputMin}–{outputMax} token。Host 会再次校验；超出范围或字段非法的组合会被拒绝。',
  invalidNumber: '超时与输出预算都必须是正数，当前草稿无法提交。',
  draftTitle: '草稿',
  draftDirty: '有未保存的修改。',
  draftClean: '当前显示与 Host 返回一致，没有未保存的修改。',
  save: '保存 OPL 路线设置',
  saveHint:
    '设置不会自动保存：开关、路线与预算都要按此按钮一次提交。保存成功后以 Host 返回的状态为准。',
  saving: '正在保存…',
  refresh: '重新读取 Host 状态',
  statusLoading: '正在读取 Host 状态…',
  statusReloading: '正在重新读取 Host 状态…',
  readFailed: '读取失败：未取得 Host 状态。',
  readFailedHint: '重试只重新读取，不修改任何设置，也不发送模型请求。',
  retry: '重试读取',
  saved: '已保存，界面已按 Host 返回的状态更新。',
  stale: 'Host 拒绝本次保存：草稿基于过期状态。请先重新读取，再保存。',
  conflict: '读取期间 Host 状态已变化；本地草稿已保留、未被覆盖，保存将以最新 revision 提交。',
  uncertainNotice:
    '本次保存结果未确认：可能已生效也可能未生效。不会自动重发；请先重新读取核对状态。',
  hostTruthNote:
    '被拒绝的修改不会先显示为已生效：生效状态以 Host 返回值为准，未保存的修改只作为草稿保留。',
  connectionLost: '连接代次未就绪或已丢失：读到的状态属于上一个 Host，不能当作当前状态。',
  failureTitle: '保存未生效',
  'failure.unavailable': '审查服务当前不可用，未保存。',
  'failure.invalid-settings': 'Host 拒绝这组设置（超出可保存范围或字段非法），未保存。',
  'failure.stale-settings': '状态已过期，未保存。请先重新读取。',
  'failure.sessions-active': '仍有全部项目中的活动在运行，未保存。请等待其结束。',
  'failure.auto-sessions-remain': '旧 Host 拒绝停用：仍有 Auto 会话。请更新 Host 后重新读取。',
  'failure.save-failed':
    '保存请求的结果未确认：可能已生效，也可能未生效。不会自动重发；请先重新读取核对，再决定是否重试。',
  disabledReasonLoading: '正在读取 Host 状态，所有入口暂不可用。',
  disabledReasonRefreshing: '正在刷新 Host 状态，暂不可修改或保存。',
  disabledReasonReadFailed: '读取失败，所有入口暂不可用；请先重试读取。',
  disabledReasonDisconnected: '连接代次未就绪或已丢失，暂不可修改或保存。',
  disabledReasonDraining: '停用进行中，所有入口暂不可用。',
  disabledReasonBusy: '正在保存，暂不可重复提交。',
  disabledReasonUncertain: '上次保存结果未确认；请先重新读取核对，再修改或重试。',
  disabledReasonStale: '状态已过期，请先重新读取再保存。',
  serviceNotReady: '真实服务尚未就绪，所有入口不可用。',
}

/** Every dictionary key of this namespace. */
export type AutoReviewLocaleKey = keyof typeof zh

export const en: Record<AutoReviewLocaleKey, string> = {
  sectionLabel: 'Tool approval',
  title: 'Auto Review route adapter',
  intro:
    'The official Auto plugin reviews native DSH tools. Enabling the OPL adapter selects an independent reviewer and budget for official requests, and exposes the same route to exactly bound external Harness approvals. With the OPL adapter off, official Auto continues using the current Session model.',
  distinction:
    'The official plugin owns native permissions, risk rules, history and lifecycle. OPL does not make a second native decision. ZCode external approval is bridged only when its identity, call and authorization bind exactly.',
  boundaryNative:
    'Official Auto can be enabled or disabled independently in profile plugin management; each Session must still select Auto explicitly. OPL routing changes the model and budget of the official review request, not its policy or decision.',
  boundarySandbox:
    'The official plugin description and Session permission selector define the effects of Auto. This section controls only OPL routing and the external Harness approval bridge.',
  presetNotice:
    'This switch does not enable or uninstall official Auto and does not change Session permissions. Manage official Auto through the profile plugin manager, then select it explicitly in the target Session.',
  enableTitle: 'Enable',
  enableLabel: 'Enable OPL route adapter',
  enableAria: 'Enable OPL review route adapter',
  effectiveLabel: 'OPL adapter state (Host)',
  effectiveOn: 'Enabled',
  effectiveOff: 'Closed',
  draftPending: 'The draft is not saved; the effective state is still what the Host returned.',
  statusTitle: 'Host status',
  stateLabel: 'State',
  'state.disabled': 'Closed',
  'state.ready': 'Available',
  'state.unavailable': 'Unavailable',
  'state.draining': 'Disabling',
  activeReviews: 'Reviews in flight',
  autoSessions: 'Sessions on Auto',
  revision: 'revision',
  routeTitle: 'Reviewer route',
  routeSourceNote:
    'Reviewer and decision-model routes are listed separately; only routes registered and confirmed available by the Host appear in the matching option. Routes are never assembled from the external Harness execution combination menu.',
  routeCurrent: 'Codex Auto Review (adapter default)',
  routeFixed: 'Use an independent reviewer route',
  routeDecision: 'Use a decision model',
  routesEmpty: 'No reviewer route is available. Check the account and model configuration.',
  routeUnavailable:
    'The Host reports the OPL route adapter unavailable, so the review fails. Choose an advertised route, or disable the OPL adapter to use the official current Session model.',
  routeMissing:
    'The recorded independent route is not in the Host’s list and cannot be edited here; re-read first.',
  provider: 'Provider',
  model: 'Model',
  decisionModel: 'Decision model',
  effort: 'Reasoning effort',
  effortNone: 'This route offers no selectable reasoning effort',
  noRanking:
    'No unevaluated model ranking is offered; only routes the Host has registered and marked available appear here.',
  limitsTitle: 'Request budget',
  timeoutMs: 'Timeout (ms)',
  maxOutputTokens: 'Max output tokens',
  limitsRange:
    'Saveable range: timeout {timeoutMin}–{timeoutMax} ms, output {outputMin}–{outputMax} tokens. The Host revalidates; an out-of-range or invalid combination is rejected.',
  invalidNumber:
    'Timeout and output budget must both be positive numbers; the current draft cannot be submitted.',
  draftTitle: 'Draft',
  draftDirty: 'There are unsaved changes.',
  draftClean: 'What is shown matches the Host’s answer; there are no unsaved changes.',
  save: 'Save OPL route settings',
  saveHint:
    'Nothing is saved automatically: switch, route, and budget are submitted together only by this button. After a successful save the Host’s returned status is authoritative.',
  saving: 'Saving…',
  refresh: 'Re-read Host status',
  statusLoading: 'Reading Host status…',
  statusReloading: 'Re-reading Host status…',
  readFailed: 'Read failed: no Host status was obtained.',
  readFailedHint: 'Retrying only reads again; it changes no setting and sends no model request.',
  retry: 'Retry read',
  saved: 'Saved; the view now follows the Host’s returned status.',
  stale:
    'The Host rejected this save: the draft was based on stale state. Re-read first, then save.',
  conflict:
    'The Host status changed during the read; the local draft was kept and not overwritten, and the save submits under the latest revision.',
  uncertainNotice:
    'This save result is unconfirmed: it may or may not have taken effect. It is not resent automatically; re-read to verify the status first.',
  hostTruthNote:
    'A rejected change is never shown as applied first: the effective state is what the Host returned, and an unsaved change is kept only as a draft.',
  connectionLost:
    'The connection generation is not ready or was lost: the status read belongs to a previous Host and is not current.',
  failureTitle: 'Save did not take effect',
  'failure.unavailable': 'The review service is unavailable; nothing was saved.',
  'failure.invalid-settings':
    'The Host rejected these settings (out of the saveable range or an invalid field); nothing was saved.',
  'failure.stale-settings': 'The state is stale; nothing was saved. Re-read first.',
  'failure.sessions-active':
    'Activity across all projects is still running; nothing was saved. Wait for it to finish.',
  'failure.auto-sessions-remain':
    'An older Host refused disabling while Auto Sessions remain. Update the Host and re-read.',
  'failure.save-failed':
    'The save request result is unconfirmed: it may or may not have taken effect. It is not resent automatically; re-read to verify, then decide whether to retry.',
  disabledReasonLoading: 'Host status is being read; every entry is disabled.',
  disabledReasonRefreshing: 'Host status is being refreshed; editing and saving are disabled.',
  disabledReasonReadFailed: 'The read failed; every entry is disabled. Retry the read first.',
  disabledReasonDisconnected:
    'The connection generation is not ready or was lost; editing and saving are disabled.',
  disabledReasonDraining: 'Disabling is in progress; every entry is disabled.',
  disabledReasonBusy: 'A save is in flight; a duplicate submit is disabled.',
  disabledReasonUncertain:
    'The last save result is unconfirmed; re-read to verify before editing or retrying.',
  disabledReasonStale: 'The state is stale; re-read before saving.',
  serviceNotReady: 'The real service is not ready, so every entry is unavailable.',
}

/** Dictionary namespace registered by this Client feature. */
export const AUTO_REVIEW_NAMESPACE = 'settings.oplAutoReview'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Auto Review settings section copy, state labels, route labels, and failure wording. */
    'settings.oplAutoReview': AutoReviewLocaleKey
  }
}
