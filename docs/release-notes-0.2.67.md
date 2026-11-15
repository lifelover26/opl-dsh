官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次更新仅调整开发依赖版本，未发现 OPL DSH 面向用户的功能或配置变化。

### 变更

- 升级 Claude Agent SDK、Prettier、tsdown 及 @types/jsdom 的开发依赖版本。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制


- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:gpt-6-luna -->
