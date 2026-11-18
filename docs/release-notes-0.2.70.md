官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本次增强扩展了 Linux 上的 OPL DSH CLI/Web 使用方式，并新增 OPL 领域智能体预设；同时修复 Windows 提供方迁移期间可能阻塞启动的问题。

### 变更

- Linux x64 可通过独立 profile 使用官方 DSH CLI/Web，不会替换现有 web profile 或 Electron Desktop。需准备 Node.js 24.9 或更新版本、pnpm 和与增强包要求版本一致的官方 DSH，按文档构建并运行 Linux 安装入口；更新需重新构建并运行该入口。
- Linux 可在独立 CLI/Web 页面中使用 SuperAgent，状态与主 OPL profile 分开保存；再次打开会回到已有页面。
- 协作插件可将本机已安装、已激活且允许启动的 OPL 领域智能体显示为官方 Agent 预设。新会话可选择预设并加载其主 Skill；交互会话可绑定执行组合，正式 StageRun 执行器仍由对应 Package 决定。
- Windows 提供方迁移不再在启动期间执行可能造成死锁的迁移流程。

### 验证

- Host/Client 类型检查、RPC、模块边界、格式、构建与自动测试：通过
- macOS arm64 未修改官方桌面隔离验收：通过（发布硬门槛）
- Windows x64 使用自身官方 feed（`{{OFFICIAL_WINDOWS_VERSION}}`）完成隔离资格验收；资格失败或证据缺失会阻断发布
- macOS 与 Windows 使用同一冻结官方版本和增强包字节完成资格验收，覆盖 Client 设置、模型流、官方工具与重启恢复；源提交为 `{{SOURCE_COMMIT}}`
- 联合清单与验收记录随 Release 提供；发布后逐一回读公开资产摘要

### 已知限制

- Linux CLI/Web 不代表 Linux Electron Desktop 支持；Linux 暂不提供 KimiCU、Windows 会话清理 Skill 和增强层自动更新。
- 领域智能体预设需要另行安装 OPL Framework 和领域 Package，并确保启动 DSH 的环境可通过 PATH 调用 opl；只有就绪且可见的智能体会显示为预设。
- 官方桌面及其候选阶段以以上实际版本为准；开发 API 依赖与桌面 feed 分别记录。
- 本地模型 fixture 证明协议、工具和持久化链路，不代表真实 Gateway、外部模型质量或全部 Harness 组合已验收。
- Windows 受限 token 下的 Git Bash 外部程序仍有限制；验收的真实 Git Bash 工具路径使用显式授权的完整访问权限，不自动执行 ACL 修复。
- 新功能的适用范围与限制见对应功能文档及提交；直接打开官方桌面不会运行外部 OPL 更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器，或使用 OPL 维护启动入口。更新失败保留当前安装，不替换运行中的 profile；官方桌面由 DeepSeek 原生机制更新。

<!-- OPL_DSH_RELEASE_NOTES:online-ai:copilot-auto -->
