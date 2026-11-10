# Gateway Gemini 使用官方 Antigravity

Gemini 3.8 Flash 与 4 Argon 默认使用 Antigravity 的原生 Gemini 接口及 OPL 分组凭据，不引入 Google 账号。OpenCode 继续作为明确选择的备选，已有绑定及用户默认保留；失败不切换渠道或重发任务。

新建与恢复均认证后固定模型、推理档位并核对回读。Windows 使用独占 profile 的官方 Hook 调用 Git Bash；每轮确认 Hook 已运行才允许发送上游请求。流转发只接受所选模型，保留 JSON 数据及用量，跳过空 SSE 事件，明确的接口错误立即结束本轮。缓存和思考用量不重复计数。

ACP 不提供中途 fork/rewind，因此只开放首条编辑重开；旧会话与文件保留。官方 CLI 协议或 Hook 变化必须重新验证，不以 TUI 命令存在推断 ACP 能力。执行元数据只用于持久化观察，不作为工具执行输入。

Windows 安装器依赖系统架构环境变量；维护进程的白名单保留 `PROCESSOR_ARCHITECTURE` 与 `PROCESSOR_ARCHITEW6432`，包括 WOW64 的原生架构。PowerShell 安装输出固定 UTF-8，避免中文错误丢失。安装验收使用官方脚本和隔离目录，关闭 PATH 与别名修改后回读真实 CLI 版本。
