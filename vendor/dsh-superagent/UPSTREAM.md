# SuperAgent 来源与适配

来源：<https://github.com/deepseek-ai/dsh-superagent-prototype>

固定提交：`6337fc823ce20251c8de8085948165c81aaa701e`，原型版本 `0.1.0`，MIT 许可。

OPL 保留上游源码、测试、管理面板、GitHub／飞书 Source、提示词和 Skill。
本地适配包括：依赖统一到官方 DSH 0.2.2-rc.1；工单会话历史改用官方活动会话与持久化读取接口；设置表单从旧 `mode` 切换到官方 `writable`；HTTP 在官方端口尚未绑定时拒绝请求；测试按当前品牌类型和表单合同更新。离线提示指向 OPL 的独立窗口恢复入口。另修复飞书消费者 stdout／stderr 到达顺序不定时，较晚的 ready 提示覆盖已有解析错误的问题；重连后的新消费者仍可恢复就绪。

构建与依赖锁统一由根目录 npm workspace 管理，原版 pnpm lock 仅保留为来源记录，不参与 OPL 构建。
安装与独立官方桌面启动入口归 OPL；调度、策略、工单、会话、数据库和回传仍归原版 bundle。
原型使用 POSIX 账户 wrapper 与执行命令，OPL 本版仅在 macOS 提供启动入口。

本地测试保留 Linux/macOS 的完整 POSIX 检查；Windows 仅跳过依赖 Unix 信号、权限、服务控制或可执行 Shell wrapper 的测试，继续运行共享逻辑。文档路径按本机路径 API 比较并接受 CRLF，提示词文件 fixture 与包内提示词保持同一磁盘卷，Git 配置按 Git 解析值检查，目录别名在 Windows 使用 junction。Worker 回合结束后的 `blocked`、`failed`、`ready` 报告保留检查按状态分别建例，各自使用独立运行时、数据库和默认测试时限；这些测试适配不增加 Windows 运行支持。
