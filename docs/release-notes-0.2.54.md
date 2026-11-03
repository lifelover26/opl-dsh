官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新扩展了可用的 Harness 与 OFM 模型组合，并改进了用量展示和模型可用状态管理。

### 变更

- 新增 OFM 转发组合：OpenCode 的 EAC MiniMax M3.1 Flash、StepCode 的 EAC Step 5 Preview、Mistral Vibe 的 EAC Mistral Large 4，以及 Kilo Code 的 Ling 3.1 Flash。
- 修复 MiniMax Code 在 MCode 0.7.4 下的用量读取；支持显示符合当前会话和模型的 token 用量，并将 token 用量与上下文占用分开展示。
- 外部 Harness 的上下文读数接入官方上下文圆环；模型切换、运行中或读数不完整时不沿用旧值。
- 模型发现列表与已启用组合统一显示不可用状态及悬停原因；不可用组合不会出现在选择列表中，可单独移除。取消全选或按 Harness 取消，也会停用对应隐藏组合。
- MiniMax Code 的编辑重发只替换对话历史，不撤销已产生的文件修改；编辑后的普通消息可独立结束并继续会话。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Mistral Vibe 组合需自行安装官方 Vibe 3.0.4，并登记 vibe-acp 路径；当前没有一键安装，仅支持明确授权的完全访问，不提供推理档位设置。
- StepCode 和 Mistral Vibe 的上下文读数可能是估算值或 CLI 生效预算，并非对接口最大容量的探测；缺少可靠用量数据时不显示账单统计或补造数值。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->
