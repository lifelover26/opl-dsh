官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次增强 OPL 对 OFM 2.8.0 的模型接入，并改进对话统计和编辑重发恢复体验。

### 变更

- 新增多条 OFM 模型接入与推荐，包括 EAC Nemotron 3.5、Flint 40B、DeepSeek V4.1 Flash，以及 Inkling 和 Gemma 4 31B；模型发现列表按 OFM 当前目录展示。
- 新增“轮次与步数”统计范围设置，可选当前对话或历史累计。计数按已结束步骤计算；切换范围不影响耗时和 Token 用量统计。
- 旧会话编辑重发前会检查实际连接；对于已准备但尚未提交替换消息的编辑，可重新选择原消息发送，不会重放上次请求或再次回退历史。
- 发送和编辑重发前会核对所选 OFM 模型状态；目录中缺少模型或状态无法确认时，会提示用户而不发送任务。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 与 Windows x64 未修改官方桌面隔离验收：通过
- 两平台验收同一增强包字节，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- OFM 目录读取失败时只能标记模型状态未确认，不能据此判断模型已下架。
- Gemma 4 31B 保留渠道默认思考设置，不提供可选思考档位；Kilo 和 OpenCode 当前不提供推理档位选择。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->
