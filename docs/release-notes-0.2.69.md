官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

新增独立的 OPL Gateway Claude 分组，支持在 Claude Code 中使用 Claude Opus 5.5 和 Claude Fable 5.2；同时修复无会话的首页输入区，保留官方空白首页体验。

### 变更

- Gateway 账号与模型设置新增 Claude 分组，可单独配置凭据，并按 Claude、AWS 或 Kiro 渠道选择支持的 Claude 模型。
- Claude Code Harness 新增对 Gateway Claude 渠道模型的支持；使用前需配置对应凭据并选择模型。
- 无会话时保留官方首页输入区；恢复会话身份但输入区尚未就绪时，仍显示恢复状态。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Claude、AWS、Kiro 是独立渠道，调用失败时不会自动切换渠道。
- 凭据就绪不代表实际模型调用已验证。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->
