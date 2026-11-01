官方 DeepSeek Harness：`{{OFFICIAL_VERSION}}` · OPL 增强：`{{VERSION}}`

本版接入 DeepSeek SuperAgent 仓库协作原型，并跟随 MiniMax 正式模型名称。

### 变更

- macOS“协作与自动化”新增 SuperAgent 入口，使用独立官方桌面、profile 与数据目录，保留原版管理面板、GitHub／可选飞书来源、授权策略、工单、执行、提示词和回传功能。
- SuperAgent 固定上游提交 `6337fc823ce20251c8de8085948165c81aaa701e`，随套件构建并校验摘要；设置、工单和调度仍由原版 bundle 持有，模型与工具使用官方 DSH Session。
- 独立窗口首次等待仓库与机器人账号配置；停止后再次打开可更新插件，保留已有配置和状态。
- MiniMax 官方账号的模型目录、ACP 选择、界面和协作 Skill 改用 `MiniMax-M3.1-Flash`，移除 `-Preview`；推理档位和权限要求保持原有合同。
- 双平台官方更新源仍为 DSH `0.2.1-rc.5`，开发依赖统一到同一版本。

### 验证

- Host／Client、SuperAgent 类型检查、RPC、模块边界、格式、构建与自动测试通过。
- macOS arm64 与 Windows x64 对同一交付增强包完成官方桌面隔离资格；macOS 另验 SuperAgent 独立 profile、原版面板与等待设置状态。
- 源提交：`{{SOURCE_COMMIT}}`；具体平台结果与摘要见随附资格 JSON 和联合清单。

### 已知限制

- SuperAgent 是上游研究原型，本版启动入口支持 macOS；其账户 wrapper 和执行命令需要 POSIX。
- GitHub／飞书真实收发需要专用机器人账号、仓库与授权名单；隔离验收使用本地 fixture，不连接个人账号或发送外部消息。
- 官方 DSH `0.2.1-rc.5` 仍为上游候选版；既有 MiniMax 历史保留原始模型引用，新任务请选择当前正式模型。
- 直接打开官方桌面不触发 OPL 外部更新器。

### 升级

退出 DeepSeek Harness 后运行最新安装器。macOS 用户在“设置 → 协作与自动化”打开 SuperAgent，首次完成独立窗口的模型和机器人设置。升级已有 SuperAgent 前关闭独立窗口并备份状态，再从更新后的日常窗口打开。
