# 官方 MiniMax 账号与 mcode

DSH 通过官方 MiniMax CLI `mcode` 的 ACP 模式接入 MiniMax 官方账号。登录由官方 CLI 自己完成，DSH 不读取、不保存、不回显 MiniMax 凭据；不使用 OPL Gateway 的 MiniMax 密钥，也不驱动 MiniMax Code 图形界面。

官方 Desktop 本体复用未修改的官方应用。Windows Git Bash 需要下述具有 Shell 能力回读的独立 mcode 候选版；标准 CLI 不能用设置环境变量代替能力验证。

MiniMax 的新轮次在普通 DSH 会话中显示官方 mcode 发送的思考片段、正文和工具记录；思考使用 DSH 原生 reasoning 展示，CLI 标题更新同步到侧边栏。命令使用终端卡片，结构化文件变更使用差异卡片，其他工具优先显示 CLI 的文本预览；原始入参和结果保留在可展开的“原始记录”中。展示不执行工具或文件修改。CLI 未发送的思考不会生成，旧轮次未保存的思考与标题不会补造。

运行中的思考预览随实际片段更新，可展开查看收到的全文。官方 rc.2 把同一步的工具调用记录当作已结束正文时，OPL 通过公开 Conversation 扩展显示被遮蔽的实时思考与进度；重连后恢复，轮次结束后由官方正文接管。如果官方版本已经保留实时正文，不显示额外内容。验收须在工具结束、模型仍运行时检查，并覆盖重连；仅检查完成后的正文不足以确认实时显示。

## 官方账号入口

设置 → 模型供应商底部的「MiniMax 官方账号（mcode）」按「中国大陆」与「国际版」分别显示本机登录状态。已登录时提供退出登录，未登录时提供官方网页登录。状态来自 mcode 的账号状态元数据，不读取令牌；它不代表在线额度或认证有效性，令牌刷新仍由官方 CLI 负责。无法确认状态时显示未知，可刷新。

登录和退出调用执行引擎中配置的 mcode，并明确传入所选地区。切换页面地区只切换查看范围，不注销账号。授权期间可点击「取消登录」请求官方 CLI 清理本次授权并退出；无法协作退出时才结束本页启动的进程；取消不会退出已登录账号，结果重新读取。关闭浏览器标签页无法通知本页，授权倒计时采用官方返回的有效期（本轮 CN 实测为五分钟），尚未拿到授权时保留十分钟保护上限。登录和退出要求任务空闲，失败不自动重试。

## 模型与推理设置

DSH 只为 MiniMax 提供两个模型组合，推理设置可在官方模型菜单中选择：

| 模型       | 推理设置                     | 说明                                   |
| ---------- | ---------------------------- | -------------------------------------- |
| M3.1-Flash | 开启思考，effort 默认 `max`  | 可选 `low/medium/high/xhigh/max`       |
| M3         | 默认开启思考，无 effort 档位 | 可选思考开启或关闭，模型不提供推理档位 |

两个组合在 DSH 模型选择器中按“模型 · Harness”显示，与其他外部组合一样在当前官方会话的消息流中回写结果。M3 没有 effort 档位是官方 CLI 的能力边界；DSH 不伪造档位，也不会因为档位缺失静默改用其他模型。

M3.1-Flash 的当前官方模型 ID 为 `MiniMax-M3.1-Flash`，已移除 `-Preview`。旧历史保留原始引用；新任务选择当前模型，旧版 CLI 未公告该 ID 时会明确停止，不静默换用其他模型。

转交当前用户输入时，DSH 注入的技能目录和运行时提醒作为上下文保留，不替代用户任务；继续同一会话只转交新的用户输入及其附带上下文。

## 安装官方 CLI

Windows（PowerShell）：

```powershell
irm https://filecdn.minimax.chat/public/install.ps1 | iex
```

macOS / Linux / WSL：

```bash
curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash
```

默认安装目录为 Windows 的 `%USERPROFILE%\.minimax-code`（启动器 `mcode.cmd` / `mcode.ps1`）或 macOS / Linux / WSL 的 `~/.minimax-code`。安装后重新打开终端确认：

```sh
mcode --version
mcode --help
```

DSH 从该官方安装目录识别 `mcode`，无需在 DSH 中填写 MiniMax 地址或密钥。

## Windows Git Bash 后端

Windows 增强适配器在启动 mcode 前解析并实际执行 Git for Windows 的 Bash，随后通过进程级 `MCODE_SHELL_PATH` 固定 Shell。优先使用显式 `OPL_GIT_BASH_PATH`，否则查找 Git 安装目录和 PATH；显式路径错误时停止，不自动改用别的安装。ACP 初始化须返回 `_meta["minimax-code/shell"]`（version=1、type=bash、同一可执行文件和 `["-c"]` 参数），新建、跨进程恢复和每次发送前都核对。设置 `SHELL` 或工具名叫 `bash` 不能证明实际后端。

官方 mcode 0.6.3 默认优先 PowerShell，尚无上述公开接口。本机测试使用从官方 v0.6.3 源码构建的独立候选版 `0.6.3-opl-bash.20261008.1`，给共用 Shell 解析函数增加环境变量选择及 ACP 回读；官方 CLI、账号目录与官方 DSH 应用资源保持原样。候选版通过执行目录的 MiniMax Harness command 显式选择，不替换系统 PowerShell，也不修改官方 mcode 安装文件。后续官方版具备等价接口并通过实机验证后，可将该 command 切回官方启动器。当前未经该接口验证的 CLI 会在发送任务前停止，而不会悄悄改用 PowerShell、CMD 或 WSL。

固定 Git Bash 只决定命令解释器；下述完整访问和官方 mcode 审批限制仍然适用。

## 官方登录

中国大陆账号：

```sh
mcode login
```

Global 账号：

```sh
mcode login --region global
```

在浏览器中完成授权。只想查看授权链接时加 `--no-browser`；退出登录使用官方 `mcode logout`。凭据由官方 CLI 自己保存和刷新，DSH 不抓取、不复制、不输出 token。启动 `mcode` 后可用官方 `/status` 检查账号状态。

登录状态和额度由官方 CLI 决定。未安装 CLI、未登录或模型不可用时，DSH 报告未就绪，并给出可操作的原因；不会自动改用 OPL Gateway 密钥、其他渠道或其他 Harness，也不会把官方登录问题显示成 Gateway 凭据错误。

## 独立网络代理

Global 账号所在网络需要代理时，在设置 → 执行与组合 → 执行引擎与网络代理 → MiniMax Code → 网络代理中给 MiniMax Code 选择“指定代理”，填写例如 `http://127.0.0.1:7897`，再保存。该代理仅用于 DSH 启动的 mcode 及其子进程，其他 Harness 的代理和 Desktop 全局环境不变。地址只支持无账号密码的 HTTP/HTTPS 代理；本地监听端口须可用，设置本身不会启动代理或保证海外出口。

已运行的轮次不被保存操作打断，下一轮重连时恢复原 MiniMax 会话并使用新设置。选择“继承环境”恢复 Desktop 环境，选择“直连”清除 mcode 子进程的代理环境变量。CLI 另有配置时由其官方实现决定实际路由；本地 ACP/MCP 桥自动绕过指定代理。失败的旧 operation 不重发，应检查原因后以同 Session、同 task、新 operation 继续。终端中单独执行的 `mcode login` 不读取此设置，需要在那个终端自行设置代理环境。

## 权限限制

当前 mcode ACP 未提供可验证的 DSH 只读或工作区隔离接口；mcode 自身的文件与 shell 工具不受 DSH 的该标记约束。因此 MiniMax 仅支持用户明确授权的完整访问。官方对话需先选用 `danger-full-access` 权限预设；外部 Skill 委派须显式传 `--sandbox full-access`。未授权或受限任务在启动前拒绝，旧受限会话不自动升级权限，须由用户授权创建新会话。

明确授权的完整访问使用官方 `danger-full-access` 预设，其审批策略为 `never`；mcode ACP 同步为广告的 `bypassPermissions`（Full access），新建、恢复和每次发送前核对回读。官方接口会保存 mcode 的权限模式选择。显式拒绝规则保持原样，已挂起的审批仍由用户处理；派发方不代答。该映射不提供只读或工作区隔离。

Windows 关闭组合连接时结束仍存活的自有启动进程及其后代，覆盖 cmd 启动器和 Node CLI；不按进程名称结束其他用户任务。

## 在 DSH 中使用

1. 确认本机 `mcode` 已安装并完成官方登录。
2. 将当前官方会话权限设为已授权的 `danger-full-access`，再在模型选择器中选择 MiniMax 组合；或在 Codex Skill、对话内协作工具中委派子任务。
3. 模型、所选推理设置和完整访问未确认时，DSH 不发送模型请求；登录或额度错误按官方 CLI 的反馈处理。

## 从 Skill 委派

组合 ID 以实际查询结果为准，不要写死或猜测。先列出本机可用组合：

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-list
```

再用返回的精确组合 ID 派发；返回 JSON 的 `id` 是组合会话标识，不是原生 `acpSessionId`，也不是任务绑定的官方 DSH 会话 id：

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate \
  --combination <delegate-list 返回的 MiniMax 组合 ID> --sandbox full-access \
  --task stable-task-id --operation initial \
  --cwd /absolute/project --prompt-file /absolute/prompt.txt

ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-wait \
  --session <上一步返回的 id> --operation initial
```

`delegate-list` 没有列出 MiniMax 组合时视为未就绪：报告原因，不改用其他模型、分组或 Harness，也不回退到 Gateway 密钥。

## 继续、恢复与等待

同一个会话和任务的新指令保留原 Session 和 task，只换新的 operation：

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-prompt \
  --session <id> --operation follow-up-1 --prompt-file /absolute/follow-up.txt

ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<本 Skill>/control.mjs' delegate-wait \
  --session <id> --operation follow-up-1
```

- 超时、断线或结果不明时先用 `delegate-snapshot --session <id>` 读取原会话，不换 ID 重发；Host 重启后的未完成轮次标记 `interrupted`，不自动重发。
- `waiting_approval` 或 `waiting_input` 交给用户：权限请求由用户在该任务绑定的官方 DSH 会话中决定，该会话的审批入口即 mcode 权限请求的入口；问题在同一会话中由用户回答。派发方不代答、不自动放宽未授权权限，不替用户决定已经挂起的请求。
- 认证、登录或额度失败来自官方 mcode：不重发同一 operation，不自动降级模型，也不切换渠道；先由用户完成官方登录或额度处理，再沿用原 Session 和 task，以新 operation 发送后续指令。
- 包含组合反馈支持的增强包把 MiniMax 的完成、失败及观察到的人工等待登记到 DSH `taskFeedback`，与其他外部 Harness 共用通知机制。启用自动回传并配置真实 Codex 队列桥后，可主动通知发起对话；旧包或未配置桥时用 `delegate-wait` / `delegate-snapshot` 读取，不能宣称已后台唤醒。升级后须用真实任务验证当前 Codex 对话收到通知。
- 通知到达后先 `receive`，仅在返回 `review` / `resume` 时检查对应组合会话和 operation 的产物；完成交付用 `delegate-review` 登记验收，最后以同一 consumer 和领取的 claimEpoch `consume`。消费通知不代表任务验收。反馈 taskId/deliveryId 取通知原值，不把组合会话或 ACP ID 当原生 DSH Session。
- `accepted=true` 只表示提示词已被接收，须核对实际工具结果与终态后才能报告完成。

## 相关

- 官方 CLI 与安装说明：[MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code)
- DSH 协作 Skill 用法：`installer/skill/SKILL.md`

## 外部会话与人工审批

从 Codex 派发的 MiniMax CLI 会话会绑定到一个真实的官方 DSH 会话：它在任务的项目目录下创建或复用普通 DSH 会话，出现在官方会话列表侧栏，与官方会话没有外观差别。已授权的完整访问对齐内置 `danger-full-access` 和审批策略 `never`，mcode 回读 `bypassPermissions`。已经挂起的人工请求和显式拒绝规则仍保留，由用户在该会话的审批入口决定；派发方不代答。设置中不再有独立的“外部任务”页面。

三类会话标识用途不同，不能互换：

- 组合会话 `id`：`delegate` 的返回值，也是 `delegate-prompt`、`delegate-wait`、`delegate-snapshot`、`delegate-cancel`、`delegate-review` 的 `--session` 值。
- `nativeSessionId`：绑定的普通 DSH 会话身份，只对应官方会话列表里的那个会话。
- `acpSessionId`：mcode CLI 自己的 ACP 会话，由后台维护，不作为用户可见身份。

已有外部会话的已结束轮次会按 operation 幂等导入该官方会话：导入只写会话记录，不发送模型 prompt，也不执行历史工具。原记录只保存工具名称和状态，导入消息中只有“名称 · 状态”清单，不含原参数、输出或可重放的调用。官方会话仍在运行、或项目目录与原任务不一致时停止导入并保留原记录。

通知记录对外部任务仍不借用 DSH Session id：`sessionId` 为 `null`，Harness 身份由 `execution` 给出。核验时按通知给出的组合会话和 operation 执行 `delegate-snapshot`，不猜 ID，原生 `snapshot` 可使用 `nativeSessionId` 查看官方消息流，但组合 `id` 和 `acpSessionId` 不能传给它。旧增强包没有绑定官方会话时仍需用 `delegate-wait` / `delegate-snapshot` 读取；退出 Desktop 升级时，先由用户处理未完成的审批或取消未处理轮次，升级后用同任务的新 operation 继续，不重放旧 prompt。

菜单只列具体档位，不提供“默认”。旧记录及 CLI 请求中的显式 `default` 仍保留官方语义，显示为“由 CLI 决定（旧记录）”，不改写为 `max`；用户可重新选择具体档位。M3 的关闭思考对应官方空模型 variant。恢复会话保留显式选择。

对话中切换模型时，按当前会话记录恢复该渠道、该模型上次选择的推理设置，不继承另一个模型的档位或开关。没有记录时使用目标模型的默认值：M3.1 为 `max`，M3 为开启思考。上次档位已不在当前模型目录中时使用当前默认值；没有推理功能的模型不携带推理参数。记忆保存在官方会话的模型选择记录中，重启后仍有效。
