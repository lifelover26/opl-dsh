官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新同步官方 DSH 行为，并扩展可选的模型组合与项目续作能力；官方默认设置保持优先，OPL 增强按需启用。

### 变更

- Windows 原生会话默认继续使用官方 PowerShell；Git Bash 改为可选增强，启用后需完全退出并重新打开桌面生效。新安装不再自动启用官方 Auto Review，需在插件管理中主动开启。
- 网关新增 Gemini 4 Argon、Gemini 3.8 Flash 路由，并补充 OFM 与网关模型的 Harness 组合。
- AMD Qwen3.8-27B 可选添加 Qwen Code 组合；原有 Pi 推荐保持不变。
- 新增可选的事件驱动项目续作：用户可登记项目与工作项，将派发任务关联到计划，并通过显式安装的 Codex Hook 对账进展；不改变未关联任务的原有派发方式。
- 改进权限选择、已保存组合默认值和项目外导航的保留行为；会话停止后 Todo 面板补充未完成状态提示，不接管官方 Todo 清单。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- 项目续作不会自动启用：需显式登记项目并安装 Hook，且须由用户在 Codex 中审阅并信任 Hook 配置。
- 协调器的进程与日志适配目前仅支持 Windows 上受支持的 Codex 环境；其他平台或未知版本不会据此自动推进。
- Qwen Code 组合仅支持文本输入和完全访问；Windows 使用该组合需要 Git Bash。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->
