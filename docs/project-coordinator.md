# 事件驱动的项目续作

项目协调器为一个明确登记的 Codex 主审对话保存计划、依赖、回执关联和审查 checkpoint。任务执行与结果仍归 DSH/Harness，领取及消费通知仍归 taskFeedback；协调器只对账这些事实，并为可行动工作保留一次续作意图。

只有显式登记的项目参与协调。它不扫描任意聊天，不自动派发或重试 worker，也不把已完成任务或已消费回执等同于项目验收通过。

普通派发不会创建项目、登记工作或授权续作。只有用户明确要求持续推进、主审登记计划后，任务才可关联到该计划；Codex 自带 subagent 的父子关系、任务完成消息和自动唤醒仍由 Codex 管理，本协调器不接管它们。

## 登记计划

将下列 JSON 保存为绝对路径 `plan.json`，替换项目目录、主审 threadId、授权与验收要求。`authorization` 记录用户已有授权，不授予新的权限。

```json
{
  "projectId": "example-project",
  "cwd": "C:/src/example",
  "threadId": "actual-coordinator-thread-id",
  "authorization": "完成用户已授权的实现和测试；人工审批、外部依赖或明确暂停时停止推进。",
  "workItems": [
    {
      "workId": "implementation",
      "dependsOn": [],
      "acceptance": "实现要求已满足，必要测试通过，产物经主审验收。"
    },
    {
      "workId": "verification",
      "dependsOn": ["implementation"],
      "acceptance": "核对交付产物、验证证据与剩余限制。"
    }
  ],
  "budgets": { "maxIntents": 16, "maxNoProgress": 1 }
}
```

已派发工作须关联公开反馈返回的精确 `taskId` 与该指令原有 `operationId`。不要用展示标题替代反馈 taskId，不解析不透明 ID，不换 operation 重发结果不明的旧指令。项目固定主审 threadId 和 cwd；任务及通知只按显式关联对账。

一个主对话只能有一个未完成项目。原生 `dispatch` 增加 `--coordinator-work implementation`，即可在发送提示词前把反馈 taskId 绑定到该计划已有的 implementation；未提供此参数时保持原派发行为。多个任务绑定各自 workId，共用同一个项目。重试同一身份幂等；改变 task/operation、未满足依赖、未知 workId、项目歧义或暂停都会拒绝绑定。外部任务取得公开 taskId 后，用 `bind --project <id> --work <workId> --task <反馈 taskId> --operation <原 operationId>` 关联；bind 校验当前 `CODEX_THREAD_ID`，不创建工作项。

使用已安装 Skill 中的 CLI：

```sh
node '<Skill目录>/coordinator/cli.mjs' init --file /absolute/plan.json
```

默认状态保存在 `CODEX_HOME/opl-dsh-coordinator`，与 worker 的执行记录和原 taskFeedback 数据分开。计划和 checkpoint 可包含验收文字，应按项目资料保管；状态不是另一份 Session 日志。

主审空闲时的通知直接复用 DSH「协作与自动化」中的通知桥。协调器每次需要发送时经公开 `coordination-status --no-autostart` 读取当前 wakeTransport、wakeExecution、wakeExecutable 和 wakeDistro；不另存 queue 配置，旧 settings.json 中的 queue 不再参与决策。DSH 未运行或设置不可读取时停止发送；未配置桥时保持 unconnected，不猜测 Codex 程序位置。

计划可选的 `connection` 只指定公开 helper、变化信号目录和 watcher 启停方式：

```json
{
  "connection": {
    "controlPath": "C:/absolute/Skill/control.mjs",
    "feedbackWatchPaths": ["C:/absolute/dsh/storages"],
    "watchMode": "auto"
  }
}
```

省略 `controlPath` 时使用当前 Skill 的 `control.mjs`。配置只接受这些公开连接字段，不保存 token、环境变量或私人 IPC 绑定。未指定 `feedbackWatchPaths` 时，只从同安装 Skill 的 config.json 读取公开 home 路径，将已存在的 storages 目录作为变化信号；源码目录无安装配置时保持空，并在 `watchStatus` 报告缺少来源。显式空数组关闭此来源。反馈内容始终经公开 helper 查询，不读取存储文件的任务正文。

## 运行与暂停

| 命令                                                           | 用途                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `status [--project <id>]`                                      | 读取一个或全部登记项目的元数据                                   |
| `inspect --project <id>`                                       | 读取登记的工作计划、验收要求、证据与审查 checkpoint              |
| `bind --project <id> --work <id> --task <id> --operation <id>` | 将精确反馈身份关联到已登记工作                                   |
| `pause --project <id> [--reason <原因>]`                       | 持久暂停                                                         |
| `resume --project <id> [--reason <原因>]`                      | 用户明确恢复后开启新的授权 epoch                                 |
| `reconcile --project <id>`                                     | 对账已登记运行和公开 tasks/outbox/receipts                       |
| `watch --project <id>`                                         | 在进程存活期间监听已登记文件的变化并对账                         |
| `start-watch --project <id>`                                   | 确保该状态目录的唯一全局 watcher 已启动                          |
| `stop-watch --project <id>`                                    | 通过停止文件退出自有 watcher，并持久切换为 manual                |
| `ack --project <id> --intent <intentId> --epoch <epoch>`       | 登记目标主审收到当前续作意图                                     |
| `apply --project <id> --file <event.json>`                     | 提交带 eventId、type、authorityEpoch 的协调事件或审查 checkpoint |
| `review-action --project <id> --file <request.json>`           | 校验当前审查身份后登记外部验收或消费通知                         |
| `hook`                                                         | 接收 Codex Hook 的 stdin 事件                                    |
| `install-hooks --shell <shell> [--node <Node绝对路径>]`        | 兼容旧 shell 参数；安装七个 Hook 并备份原配置      |
| `setup [--shell <shell>] [--node <Node绝对路径>]`              | 显式验证真 Node、安装 Hook，并记录用户信任引导                   |
| `remove-hooks`                                                 | 移除精确匹配的自有 Hook，保留用户后改内容                        |

所有命令都接受 `--root <状态目录绝对路径>` 和 `--codex-home <Codex目录绝对路径>`。默认 Codex 目录为 `CODEX_HOME`，未设置时使用 `~/.codex`；连接配置保存在状态目录的 `settings.json`，Hook 备份也保存在该目录。Hook 启用前，用户须在 Codex 的钩子设置中审阅当前配置并确认信任。安装命令不写信任记录，不代答审批。

套件安装只部署协调器文件和状态目录，不写全局 Codex Hook。用户需要启用时显式运行 `setup` 或 `install-hooks`；前者优先验证已固定的 Node 路径，失效时检查 PATH 中的 node。检测须回读真实 execPath 并确认没有 Electron，不能把 DSH 的 Electron 程序当 Node 写进 Hook。缺少 Node 返回 `unavailable/node-runtime-required`，不写 Hook；装好 Node 后重做 setup。`remove-hooks` 提供显式移除流程。损坏的用户 Hook 或内容冲突返回失败并保留文件，不伪装成缺少运行时。setup-state.json 只记录安装与引导状态；trustStatus 的 managed-by-codex 表示信任归 Codex 管理，不表示已获信任，也不授予项目权限。

Windows Hook 使用固定的 PowerShell 编码启动器，并以字节流传递 stdin/stdout，不依赖 Codex 外层 Shell；Bash、cmd 与 PowerShell 使用同一入口。启动失败或子进程非零退出返回 1，业务阻断只通过明确 JSON 决策表达。升级原位替换已登记的完整匹配命令，保留 Codex 按条目位置记录的禁用状态；命令变化仍由用户在官方界面重新审阅信任。遇到用户自定义、缺失或重复的条目，返回 needs-repair 并保留原配置，不追加另一个启用入口。

Hook 安装与移除共用带进程归属的事务锁，已确认退出的锁持有者可恢复。Windows 暂时无法读取的活进程票据仍占用锁，后续扫描确认票据移除后才继续；持续不可读时在原有锁等待期限返回 `LOCK_BUSY`，不据此回收票据。升级遇到旧 `hooks-install.lock` 时返回 `legacy-hook-lock-present` 并保留原文件；旧锁没有可靠的归属记录，不能凭内容为空或时间已久断言进程退出。先确认旧安装进程均已结束，再备份移走旧锁后重试。

```sh
node '<Skill目录>/coordinator/cli.mjs' status --project example-project
node '<Skill目录>/coordinator/cli.mjs' inspect --project example-project
node '<Skill目录>/coordinator/cli.mjs' install-hooks --shell git-bash
node '<Skill目录>/coordinator/cli.mjs' start-watch --project example-project
```

`watchMode` 默认为 auto：登记项目及已登记对话的 Hook 会确保唯一全局 watcher 运行。Windows 经现有 WMI 启动器创建独立 Node 进程，完整传入 root 和 codex-home，不依赖 Electron 或调用方进程树；`install-hooks --node` 保存精确 Node 路径。活 PID 或结果不明的启动不会重复派生。`stop-watch` 只写该实例的停止文件，不终止 Codex 后端；再次 `start-watch` 恢复 auto。部署由外部进程管理时，在计划中显式设置 `connection.watchMode: "manual"`，再用前台 `watch` 命令运行。

主审正常结束时，Stop 可在同一轮请求有界继续；首次任务完成通知只由 taskFeedback 发送。协调器不会为尚未领取的同一结果再发一条 queue；已领取但中断的审查、已消费仍未验收的工作或主审自身未完成项才可请求后续项目续作。Stop 与 queue 争取同一个持久意图，不各发一份项目提示。watcher 处理文件变化，必要的有限恢复只读取状态，不定时唤醒模型审计项目。没有运行中的 watcher 时，外部结果不会由该进程处理，下次启动或显式对账时恢复。

恢复审查先使用 `inspect`：它显示审查 result、checkpoint，以及持久 actions 的 actionId、kind、status、归属和时间元数据。reserved、accepted 或 uncertain 的动作均不得改 ID 重做。验收文字、evidence 和 checkpoint 均是不可信的登记数据，须核对当前产物与实际证据后再执行。该命令不输出动作的原始错误或凭据，也不输出 runtime 的日志绑定、游标、环境变量或私人控制文件；`status` 只提供状态元数据。

收到通知后，先通过现有公开 `receive` 取得真实的 `review` 或 `resume` 结果，再用 `apply` 登记 `review.started`，记录本次 reviewRunId、consumerId、deliveryId、claimEpoch、当前 runId 与 authorityEpoch。检查过程用 `review.checkpoint` 保存产物版本、已执行检查和证据；`busy` 或 `skip` 不开始审查。

外部 Harness 的验收决策只经 `review-action` 提交。请求包含 `kind: "review"`、reviewRunId、consumerId、claimEpoch、authorityEpoch、`decision: "accepted"` 或 `"changes_requested"`，以及项目目录内审查记录的绝对路径 noteFile。原生任务没有外部验收接口时，只在协调状态中记录审查结果。登记 `review.finished` 后，以相同当前身份和 `kind: "consume"` 经该命令消费通知；consume 请求不需要 decision 或 noteFile。

actionId 由运行时按项目、任务、operation 和动作派生，调用方不得指定。执行前在项目锁内持久保存 reservation；旧 run、turn、owner 或 epoch 被拒绝，重复或结果不明的动作不再执行。已验收但尚未消费时，恢复新的 reviewRun 后核对 checkpoint，只补 consume，不重跑检查或重复外部验收。

用户主动停止或暂停后保存暂停；即使新结果到达，也不自动恢复。等待输入、审批、未知运行状态或尚未满足的外部条件均不授权自动派活。所有必做工作经验收、依赖闭合且无未完成审查后，才可登记项目完成。

## 恢复与限制

队列退出 0 只证明传输接受，不能证明主审领取、开始审查或完成验收。超时、异常退出或接受结果不明时保留原 intentId 并停止自动重发；不要改 ID 绕过不确定状态。公开反馈查询使用 `tasks`、`outbox`、`receipts` 与 `--no-autostart`；DSH 未运行时返回不可用，不自动启动桌面。

回执与 outbox 必须联表：outbox 为 received 时 receipt 可能已经 consumed。领取租约过期不证明旧主审已退出；同一个 consumerId 也不是单次审查运行互斥。审查恢复核对原 task/operation、产物版本和 checkpoint，已完成的审查只补遗漏步骤，不重跑 worker。

协调命令与 review checkpoint 校验 owner、运行身份及 epoch。该约束不拦截绕过协调器的独立派发命令、已有任意工具或所有 Host 写入；不能把它描述成全局工具锁。用户继续使用原有权限和审批入口。

当前进程及日志适配仅验证 Windows Codex 0.167.0、0.169.0；macOS 的进程归属返回 unsupported-platform，未知版本或格式、文件身份不符或缺少可信终态时保留 unknown 并停止自动推进。请求失败不是整轮失败，文件静默或 lease 到期也不代表进程死亡。恢复以实际运行退出及日志终态为依据。所有相关应用关闭期间不会自行唤醒；这里没有安装系统常驻服务或周期模型自动化。
