官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新将官方 DSH 的智能体团队、Subagent 与原生 Auto Review 交还官方插件管理；OPL DSH 继续提供外部 Harness 组合、跨 Harness 持久任务与交付验收，并改进任务状态恢复和审查路线适配。

### 变更

- 首次迁移会通过官方插件管理器启用官方 Agent Team 与 Auto Review；已有明确禁用项及后续在官方插件管理器中的选择会保留。
- DSH 内部子任务请使用官方 Team/Subagent；OPL 的委派工具现在仅创建跨 Harness 持久任务。已有 OPL DSH 子任务仍可通过原 sessionId 继续。
- Auto Review 原生权限、策略、预设和生命周期改由官方插件负责。每个会话仍需显式选择官方 Auto 权限；OPL 的“审查模型路线”默认关闭，启用后可配置独立 reviewer、预算及外部 Harness 审批桥，关闭后官方 Auto 使用当前会话模型。
- 任务反馈、轮次结束与等待状态改为读取官方 Session Controller，跨进程任务注册和恢复时可根据官方会话历史补齐状态。
- 安装或升级前请退出 DeepSeek Harness；日常继续直接打开官方 DeepSeek Harness。官方插件的启用、禁用和卸载请在官方插件管理器中操作。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 官方 Team 当前仅支持可继续的本地 provider；外部 Codex、Claude、ACP 等一次性 provider 不能作为持续队友。
- 官方 Team 的共享工作目录和 write scope 提示不能替代文件锁、隔离 worktree 或 OPL 的跨 Harness 写队列。
- OPL 审查路线适配默认关闭；启用后若选定路线不可用、请求失败、超时或记录不完整，该次审查会失败，不会临时切换模型。
- 官方 Auto 插件启用不会自动修改已有会话权限，目标会话仍需显式选择 Auto；官方插件被运行中的应用移除时，其会话权限迁移行为以官方界面和实际会话读回为准。
- 没有官方 DSH 基础 profile 的自定义 profile 不会执行 Agent Team 与 Auto Review bundle 的首次迁移。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:gpt-6-luna -->
