官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新扩展了 OPL DSH 对 Kilo Ling 3.2 Flash 和多款 EAC AMD 模型的支持，并让 MiMo Code 可用于默认模型组合。

### 变更

- 新增 Kilo Ling 3.2 Flash，默认推荐通过 Kilo Code 使用 OFM Chat 转发。
- 新增 EAC AMD 模型适配：DeepSeek V4.1 Flash 和 V4 Flash 推荐 DSH；MiMo V2.6 Flash 推荐 MiMo Code；GLM 5.3 Flash 推荐 ZCode；Qwen3.8 27B、MiniCPM-V 4.7 35B-A3B、MiniCPM5 2B、Gemma 4 31B IT 和 MiniCPM-V 4.7 1B 推荐 Pi。模型保留各自的 AMD 命名空间 ID。
- MiMo Code 可用于默认组合，并支持 EAC AMD MiMo；AMD MiMo 与同名免费模型渠道分别识别。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Ling 3.2 Flash 和 AMD 路由沿用来源默认思考设置，不提供独立的推理档位菜单；DSH 的 light、balanced、deep 选项控制输出预算。
- AMD 模型的图片与上下文能力以来源实时声明为准，不根据模型名称推定。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->
