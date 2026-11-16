# 通用协作实现与验收

本轮使用同一 HarnessService 管理内部协作和新的外部 Codex delegate 任务。内部 DSH 工具与每个外部 Harness 的私有 MCP capability 均绑定真实父会话；外部 Codex 桥接独立成模块，可单独关闭。旧 dispatch 反馈接口保留兼容。

已实现同项目委派、同步等待与异步交付、报告与验收分离、要求修改后继续原子对话、取消后代、显式重叠写入范围互斥、只读并行、重启不重发，以及持久交付去重。普通会话不会只因共享 cwd 而排队；并行 Git 写任务使用官方 worktree。主界面保持官方 DSH 会话列表、消息流和输入框；外部任务的组合、父子关系、交付与验收由后台 `HarnessService` 持久化，设置页只保留执行组合与外部接入维护。

发送每条协作通知前重新读取回执；已领取的通知不再投递。尚未送出的审批或问题通知在确认解决后退役，记录保留在 outbox；并行审批按各自的审批 ID 核对。已经交给 Codex 队列的消息无法撤回，因此等待通知描述的是记录时的事件。接收方先 `receive`，仅在 `review` 或 `resume` 时读取最新会话，确认对应审批或问题仍待处理后才请用户操作；`skip` 或 `busy` 不再转述。

`taskFeedbackFacts` 投影缓存版本为 2，新增待处理审批 ID 和最后审批事件位置；旧缓存从原始会话日志重新投影，不修改会话日志或 task/outbox/receipt 格式。

## 验收

2026-09-27，在未改资源和签名的官方 macOS 桌面 0.1.7-rc.2、隔离 profile 中，GPT-6 Sol＋Codex 自主调用工具委派 DeepSeek＋DSH。DeepSeek 读取 input.txt、执行复制生成 output.txt，并调用 report_harness_task。Sol 独立读取和比较两文件，再调用 review_harness_task，结果 accepted。两个文件均为 21 字节，逐字节一致；完整摘要见 [验收记录](evidence/collaboration-20260927.json)。

早期探针分别验证了 MCP 配置断点和只读权限等待；没有用脚本伪造父对话验收。官方 Codex 的 OPL 私有 MCP 使用文档支持的 default_tools_approval_mode 与 tool_timeout_sec 配置，文件工具仍受保存的 sandbox 限制。模型最初混淆了任务 ID 与原生会话 ID，边界校验拒绝了错误请求；修正 ID 后由 Sol 成功验收。最终接口另外显式返回 sessionId 并补充工具说明，减少这种歧义。

Host/Client 类型检查、构建及 172 项测试通过。行为测试覆盖修改续接、过期验收拒绝、幂等、越权父任务拒绝、显式重叠范围互斥、同 cwd 并发、只读并行、取消后代、取消后不自动唤醒、重启不重派和回传去重。外部开关隔离与最终包重启回读已在官方桌面实测。本轮没有重跑其他所有模型/Harness 配对或 Windows 桌面。

## 后续模块化整合边界

功能改动保持现有路径，主要写集仍由 Host、Client、契约、Skill 和测试模块承担；独立的 `HarnessPanel`、任务列表 dock 及其专用 CSS 已移除，避免维护第二套会话 UI。README 与架构文档同步说明当前行为，没有进行结构搬迁或改写官方会话格式。

本机日常 profile 已更新至最终包 afdc86968764，安装包 SHA-256 与构建产物一致；官方桌面正常启动、八个执行组合可用，当前没有执行中的任务。已打开“协作与自动化”供检查。

## 模块化整合说明

本文中的真实模型证据来自结构重构前的协作功能验收；后续模块化继续保留该行为，最终目录、契约生成与独立官方桌面资格入口见 [开发与验证](development.md) 和 [兼容验证](compatibility.md)。历史证据不替代新构建的资格结果。
