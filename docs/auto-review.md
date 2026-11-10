# Auto Review 工具审批

DSH 原生 Auto Review 由官方 `@deepseek-ai/dsh-experimental-auto-review` 插件负责，包括 `auto` 权限选项、工具执行前审查、风险规则、历史绑定和插件生命周期。套件在首次安装或本轮能力迁移时通过官方 profile bundle 启用它；此后保留用户在插件管理中的开关选择。每个会话仍须显式选择 Auto，安装和保存设置均不改变已有会话权限。

“执行与组合 → 审查模型路线”是默认关闭的 OPL 适配。它只提供独立 reviewer、请求预算、记录和外部 Harness 审批桥。关闭 OPL 适配后，官方 Auto 继续使用当前会话模型；本开关不启用、停用或卸载官方插件。

## 审查路线

开启 OPL 适配后，DSH 原生和 ZCode 默认使用 OPL Gateway 的专用 `codex-auto-review`，与聊天模型及其推理强度分开。也可以显式选择已注册的无工具 LLM reviewer 或决策模型。原生请求通过官方公开 `llm/stream` 的 `auto-review` 用途接入；OPL 保留官方生成的策略和逐条消息，只适配模型与预算，最终输出由官方插件解析并决定原生工具是否执行。

BambooNode StartLux 使用同步 decisions API，将请求转换为联合选择题；它不提供工具、不创建执行会话，也不进入普通聊天模型列表。Windows API Key 保存在 Credential Manager。缺少 Key、请求失败、未知选择或不确定结果均使审查失败。

同一下拉列表提供 **OpenCode · Jev / Jev 1.13 Free**，无需个人 API Key。它调用 OpenCode 发布的 System One 决策接口，不经过 OFM 聊天转发，也不进入普通聊天列表。只有选择概率、置信度和结果一致性均通过验证时才返回允许；限额或不可用使本次审查失败。详见 [Jev 决策模型](jev-auto-review.md)。

升级已有 profile 时，套件通过官方设置接口补入缺失的隐藏审查 provider，保留已有聊天 provider、模型列表与审查 provider。配置冲突保留原配置。开启 OPL 适配后，选定路线缺失、请求失败、超时、结果不完整或记录失败均使该次审查失败，不临时切换模型。其他原生执行检查仍生效。

## 外部 Harness

ZCode 的 Auto 新对话使用官方 `build` 模式。OPL 对原生会话、精确调用 ID、ACP 会话、连接代次、轮次、结构化工具参数和持久用户指令做绑定，通过独立 reviewer 回答外部权限询问，保存结果后再次核对。绑定不完整时保留人工审批，已认领审核失败则拒绝。官方 Auto 插件没有外部权限请求的公开 classifier，因此这部分仍由 OPL 实现。

Codex 与 Claude 使用各自官方审核接口，不经过此审查模型。未经验证的其他 Harness Auto 模式拒绝启动，其已有普通权限流程保留。外部对话创建时保存审核模式；改变模式后须新建对话，恢复不改变原权限。

## 设置与记录

开关、路线和预算点击保存才生效。过期 revision、在途审查或任一项目活动任务会使修改被拒绝。保存回执丢失时先重新读取，不重发结果不确定的保存。空闲 Auto 会话不阻止关闭 OPL 路线适配。

关闭或卸载 OPL 适配不修改会话权限，官方 Auto 的启停与卸载行为由官方插件负责。官方当前版本从运行中的应用移除 Auto 插件时，会将存活 Auto 会话迁移到 Full access；应用正常关闭则保留 Auto，恢复时需要该官方插件。管理权限应以官方界面显示和实际会话读回为准。

记录保存在当前 profile 的官方 `opl_auto_review` storage-domain。原生记录只保留官方请求、实际 reviewer 路线与原始响应，供核对，不声明工具已获准或已执行。外部审批记录另含其真实调用身份、绑定事实与桥接结果。旧记录保持可读，不重放历史工具或历史审查。
