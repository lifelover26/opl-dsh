# Windows 官方 Desktop 本地验证

本地增强补丁基于 OPL 轻量增强套件 0.2.20，复用未修改的官方 DeepSeek Harness Desktop 0.2.0-rc.2。控制桥将显式权限请求交给官方 preset 服务，读取实际 sandbox 与 approval 值；运行中的 Session 拒绝权限变更。按 cwd 创建任务时先解析官方 Workspace，再将新 Session 绑定该项目。

Windows 启动器为 EXE 路径加引号，安装器通过 Electron 读取 ASAR 内版本。构建与原生启动器由 Windows runner 验证。

原生 dispatch 支持 `--preset`。未指定时保留官方默认权限。Windows 增强包通过 Git for Windows 的 `bash.exe` 提供原生 Git Bash，并继续使用官方 sandbox 与 subprocess。Git Bash 缺失时会在启动阶段给出明确错误；可用 `OPL_GIT_BASH_PATH` 指定带空格的绝对路径。工作目录若因官方 Windows ACL 后端返回 Win32 5，可由用户在管理员 PowerShell 中运行 Skill 的 `repair-acl --cwd <目录> --confirm yes`，再创建新的 `workspace-write` Session 验证；该修复不会由 dispatch 自动执行。验证还发现官方 rc.2 的 Low-integrity restricted token 会阻止 MSYS2 外部程序创建 `\\BaseNamedObjects\\msys-2.0*`，所以 Git Bash 的 `workspace-write` 仍受 `0xC0000022` 限制；Git Bash 外部程序的可用路径是用户明确授权的 `danger-full-access`，直到官方后端支持 integrity-level 选择。

PR #4 的作者报告了本机真实渠道下的权限读取、创建时 danger-full-access、Skill 自动启动及 Git 命令验证。维护者的托管验证使用隔离 profile 与本地协议 fixture，不读取或修改用户凭据；Windows smoke 在显式 full-access Session 中通过真实 Bash 工具执行 `git --version`，并回读其工作目录中的标记文件。

Host/Client 类型检查、构建、权限与 bridge 聚焦测试、RPC 生成测试通过。ACL 校验按 Windows 路径规则处理，macOS/Linux 可运行同一校验 fixture；POSIX 安装器 fixture 仅在具有 `/bin/bash` 的宿主执行。Windows CI 执行含空格路径的 `.cmd/.bat` 原生 Harness 回归及 ACL 测试，官方 Windows 资格验证失败会直接使工作流失败。无需覆盖官方应用资源或迁移 Session 格式即可安装此增强补丁；CI 和隔离资格验证不等于发布或用户实际安装完成。

安装器将 Skill 备份保存在 Codex home 的 `skill-backups`，避免把旧备份当成同名活动 Skill；更新保留当前 ledger 与配置。官方 Skill 区分原生 dispatch 的同 task、新 operation 续作和旧 fork helper 的 continue，并规定反馈领取、独立验收、人工等待和 heartbeat 停止条件。

官方 Windows 0.2.0-rc.2 与本地增强包已通过隔离 profile 安装、四个设置页面挂载、Messages/Chat Completions 本地协议 fixture、工具调用和重启恢复检查。验收前后 app.asar 摘要一致；本地 fixture 不替代真实渠道凭据测试。

控制桥兼容原生 helper 的平铺 session.wait 参数与旧 CLI 的 request 封装，参数仍需 sessionId 与非负 turn。隔离官方实例验证创建时显式权限、权限回读与切换及精确 Workspace 归属。UI 验收先等待首次引导关闭；设置容器意外消失时最多重新打开一次，面板错误与运行异常仍会使验收失败。重启验证通过官方接口恢复保存的 Session 后，再读取它的执行组合。

| Harness       | Git Bash 后端                                                                                                                                                              | 完整访问与受限权限                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code   | 使用官方 `CLAUDE_CODE_GIT_BASH_PATH`，启动前验证 Git for Windows 路径                                                                                                      | 完整访问映射为官方 `bypassPermissions` 且关闭 sandbox；它允许工作目录外访问。Windows 受限任务若无可用官方 sandbox 后端则拒绝。                                               |
| Grok Build    | 使用官方 `GROK_SHELL=bash`；按 CLI 的候选顺序核对首个实际存在的 Git 安装，不匹配时拒绝                                                                                     | 显式完整访问映射为 `--sandbox off --permission-mode bypassPermissions`。Windows 只读/工作区任务在读取凭据和创建 profile 前拒绝；macOS/Linux 保留内建档，但尚未验证强制隔离。 |
| Codex CLI     | 官方 0.160.1/0.161.0 的无模型 Shell 探针仍为 PowerShell。自用候选版须显式设置 `OPL_NATIVE_CODEX_GIT_BASH=1`，桥接器用真实 `thread/shellCommand` 验证 Bash 后才发送模型请求 | 权限映射为官方 read-only/workspace-write/danger-full-access，审批策略 never。候选版 Bash 仅接受显式完整访问；受限请求不会自动放宽。                                          |
| MiniMax mcode | 需支持 Shell 回读的独立候选版，详见 [MiniMax 文档](minimax-code.md)                                                                                                        | 只接受显式完整访问，并回读官方 Full access 模式；不代答已有人工审批。                                                                                                        |

各 Harness 保留自己的工具与会话，不通过模型提示词包装 bash.exe 来伪装后端。显式 `OPL_GIT_BASH_PATH` 必须有效；Shell 选择不会授予额外权限。组合的 full-access 须来自用户授权；自动生成组合的只读默认值不会覆盖调用方显式授权的权限，未指定权限时保留该默认值。用户声明的只读组合保持受限，已保存的受限会话不能通过续作扩大权限；不会为了 Windows 可用性自动提权。

主审在 Windows 上通过真实 Grok 1.0.46 和本地模拟推理端点验证 Bash 工具输出 BASH_VERSION，PowerShell 对照无法执行同一 printf 命令；read-only 下的受控越界写入也实际成功，因此套件拒绝该平台的受限任务。这些探针不调用真实模型，不替代 Gateway 渠道验收。Codex 的官方与候选版能力分别记录，不能把本机补丁变量当作官方能力。

## 新对话默认模型与 Grok 配置

新对话模型按钮读取官方会话的有效默认模型；空的选择投影不会显示列表第一项。外部模型首次发送无需先点击模型菜单，按该模型精确匹配的默认执行组合使用对应 Harness，已保存的显式组合优先。恢复外部任务通过原生会话已有的模型选择与种子记录关联，不调用会保存全局默认值的模型菜单 RPC；不会用历史任务模型覆盖新对话默认值或用户的后续选择。

模型菜单切换组合时，推理设置按当前会话、Provider 与模型 ID 区分，恢复目标模型上次有效的选择或使用其当前默认值；不会把前一个模型的推理强度带给新模型。推理开关、显式默认档位与没有推理功能的模型分别按各自目录处理，历史记录无需转换。

Grok CLI 自动写入的 marketplace 初始化标记属于可接受布局，后续启动保留该标记；其他配置修改仍拒绝启动并保留文件。

## 桌面独立生命周期

Windows 的安装后自动启动与 Codex Skill 自动启动通过 WMI 创建套件启动器，再由同一 launch.vbs / setup.mjs 入口设置 profile 与应用路径。桌面不继承调用方的 Windows Job；关闭 Codex 启动进程不会通过该 Job 终止桌面。启动器按安装时选择的 Codex home 显式设置 CODEX_HOME，保证通知 CLI 使用正确的状态目录。WMI 不传递调用方的自定义环境块；原生 DSH 网络代理使用系统启动环境或 DSH 主目录 `.env` 中的 HTTP_PROXY/HTTPS_PROXY，修改后重启，项目 `.env` 不允许设置这些变量。执行引擎中的代理只影响对应外部 CLI 及其维护命令，不改变原生 DSH 的 fetch。系统策略禁用 WMI 或启动失败时自动启动明确拒绝，不回退到共享 Job；此时从 OPL DSH 快捷方式打开。官方应用资源保持原样，安装器不创建持久服务或计划任务，也不要求提权。

生命周期验收使用自有临时 Job、测试目标与 IPC，包含原 detached/unref 启动的负控和禁止 breakaway 的 Job；父子进程树关系与 Job 成员关系分别检查。真实关闭当前 Codex 的操作不作为自动验收步骤。

官方对话验收在外部 Harness 结束后，继续等待官方会话记录出现本轮 `turn/end`，再检查回答和工具结果。等待最多 30 秒；超时失败，不把外部任务终态当作官方消息流已经写完。

## OPL 登录密码

Windows 登录表单的“记住密码”默认关闭。勾选并成功登录后，邮箱与密码保存在当前用户的 Windows 凭据管理器条目 `OPLDSH:Gateway:RememberedLogin`；页面只回读保存状态与邮箱，点击登录时才由 Host 读取密码。取消勾选清除保存项，退出账号保留已记住的密码。其他平台不提供此选项，不回退到明文文件。
