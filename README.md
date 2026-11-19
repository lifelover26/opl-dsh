# OPL DSH

**官方 DeepSeek Harness 桌面 + OPL 增强，一次安装即可使用。**

在官方 DSH 中使用 OPL Gateway、免费模型和不同的模型 + Harness 组合，并与 Codex 协作。桌面、Agent 循环、官方 Team/Subagent、工具和权限由官方 DSH 或所选 Harness 提供，OPL 负责外部 Harness 接入、会话关联、跨 Harness 交付验收与安装更新。

## 下载安装

图形安装器支持 macOS Apple Silicon 和 Windows x64，无需预装 Git、Node.js 或其他 OPL 应用。Linux x64 另提供基于官方 DSH CLI/Web 的源码迁移入口，使用独立 profile，不安装或修改 Electron Desktop。

### 图形安装器

| 系统                  | 下载                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| macOS · Apple Silicon | [Mac 安装器（DMG）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-mac-arm64.dmg)       |
| Windows · x64         | [Windows 安装器（EXE）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-windows-x64.exe) |
| Linux · x64           | 源码构建 + 官方 CLI/Web，见下方“Linux 本地迁移”                                                                            |

打开安装器后，按提示选择 OPL Gateway、DeepSeek 官方或稍后登录。安装器会联网下载并校验官方桌面，通过官方插件管理器安装增强插件，并安装 Codex Skill。首次迁移会启用官方 Agent Team 与 Auto Review 插件；已有明确禁用及后续在官方插件管理器中的选择会保留。OPL 安装器未签名，首次可能需要按系统提示允许打开。

在“插件 → 已安装插件”中，OPL 显示为三个可分别启停的插件：**OPL DSH 基础增强**、**OPL 执行组合**和**OPL 跨引擎协作**。每个插件都有名称、说明、OPL 图标和离线详情；跨引擎协作需要启用执行组合。安装器统一更新三个包，并保留已有禁用选择。

安装或升级前请退出 DeepSeek Harness。已有登录、会话、设置和用户修改过的 Skill 会保留。安装完成后，macOS 和 Windows 日常直接打开官方 **DeepSeek Harness**；macOS 默认位于 `~/Applications/DeepSeek Harness.app`。Linux 使用上面的独立启动器，不启动或替换现有 Web Host。

### 终端安装

macOS · Apple Silicon：

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/gaofeng21cn/opl-dsh/main/install.sh)"
```

Windows · x64，在 PowerShell 中运行：

```powershell
& ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/gaofeng21cn/opl-dsh/main/install.ps1)))
```

也可使用 Homebrew：

```sh
brew tap gaofeng21cn/opl-dsh https://github.com/gaofeng21cn/opl-dsh.git
brew install --cask gaofeng21cn/opl-dsh/opl-dsh
```

### Linux 本地迁移

Linux x64 使用官方 `dsh` CLI/Web，目标 profile 默认为 `opl-linux`，不会改写现有 `web` profile。先准备 Node.js 24.9 或更新版本、pnpm，以及与 `dist/artifact.json` 中 `officialVersion` 相同的官方 DSH，然后执行：

```sh
git clone https://github.com/gaofeng21cn/opl-dsh.git
cd opl-dsh
npm ci --ignore-scripts
npm run build
node installer/install-linux.mjs "dist/OPL DSH 一键安装"
"$HOME/.local/share/OPL DSH Suite/launch-opl-linux.sh"
```

启动器在 `127.0.0.1:4180` 监听并打印带认证信息的地址。可用 `OPL_PROFILE_NAME` 指定另一个非 `desktop`、非 `web` 的独立 profile，用 `OPL_LINUX_PORT` 修改端口。安装仍通过官方插件管理器完成，KimiCU、Windows 会话清理 Skill 和增强层自动更新目前不提供 Linux 实现；更新时请重新构建并运行同一安装入口。

OPL 领域智能体预设是可选集成：需要另外安装 OPL Framework 和所需领域 Package，并让启动 DSH 的环境能通过 `PATH` 调用 `opl`。可在同一终端运行 `opl app state --profile fast --json` 核对当前 Package 投影；预设发现和缺少入口时的行为见[领域智能体预设](docs/cross-harness-team.md#opl-领域智能体预设)。Linux CLI/Web 安装本身不要求安装领域 Package。

首次使用见[首次启动与登录](docs/first-run.md)。

## 主要能力

- **OPL Gateway**：应用内登录，管理账户、余额和分组权限；可用模型进入统一选择器，左下角显示登录邮箱。
- **Our Free Model**：保留[上游插件](https://github.com/Ebony-Vinyl/dsh-our-free-model)的渠道、登录、模型发现和更新功能。执行设置提示新模型及适配状态，不自动启用未知路线。见[模型插件](docs/model-plugins.md)。
- **模型 + Harness 组合**：同一个输入框和消息流中使用 DSH、Codex CLI、Claude Code、OpenCode 等执行引擎；在“执行与组合”中按 Harness 批量选择，或手动添加已适配搭配。见[适配与支持范围](docs/harness-adaptation.md)。
- **DSH 官方智能体团队**：在“协作与自动化 → 角色与执行”给官方角色绑定 DSH、Codex 或 Claude Code 组合。角色、人设、Skills、成员身份、消息和任务板归官方管理，OPL 关联外部执行会话并接入官方协作工具。绑定适用于新会话与新成员。见[跨 Harness 团队接入](docs/cross-harness-team.md)。
- **OPL 领域智能体**：读取本机 App/Framework 的 `agent_packages` 投影，把已安装、已激活且允许启动的标准智能体注册为官方 Agent 预设。新会话选择 MAS、MAG、OBF 等预设，主 Skill 由官方 Skill 系统加载；在“角色与执行”为交互会话绑定已就绪的 DSH、Codex 或 Claude 组合，正式 StageRun 的 executor 仍由 Package 合同决定。未就绪或被隐藏的 Package 不会显示为可用，不复制 Package 清单或领域执行状态。见[跨 Harness 团队接入](docs/cross-harness-team.md#opl-领域智能体预设)。
- **Codex ↔ DSH 协作**：自动安装 `opl-dsh-official` Skill，支持跨 Harness 派发、续作、读取结果与交付验收；主动回传需配置通知桥。见[协作说明](docs/collaboration-implementation.md)。
- **SuperAgent 仓库协作**：继承 DeepSeek SuperAgent 原型的 GitHub／可选飞书接单、授权策略、工单、执行和管理面板。macOS 和 Linux 在“协作与自动化”打开独立页面后配置。见[SuperAgent](docs/superagent.md)。
- **Auto Review 工具审批**：使用官方自动审批，每个会话需选择官方 `auto` 权限预设。OPL reviewer 默认关闭，启用后可配置独立 reviewer、预算和 ZCode 外部审批；关闭后官方 Auto 继续使用当前会话模型。支持专用 codex-auto-review、[BambooNode StartLux](docs/bamboo-startlux-auto-review.md) 和 [Jev](docs/jev-auto-review.md) 决策模型。见[工具审批](docs/auto-review.md)。
- **MiniMax 官方账号**：通过 mcode 登录中国站或国际站，支持登录状态、退出、取消授权与超时处理。见[MiniMax 账号与 mcode](docs/minimax-code.md)。
- **对话体验**：不选工作区也可开始新对话；支持[编辑消息并原地重发](docs/stop-edit.md)，轮次与步数可选当前对话或历史累计；[Todo](docs/todo-status.md)展示真实记录状态；可启用[后台任务系统通知](docs/desktop-notifications.md)。
- **Agent 应用交接**：`inspect_mcp_app_host` 按当前对话检查工具和资源能力；无嵌入式 UI 时保留原 owner 的结构化结果与专业应用入口。见 [MCP Apps 支持范围](docs/mcp-apps.md)。
- **网页搜索**：登录 OPL Gateway 后，网页搜索默认通过 Gateway 使用 GPT-6.1 Sol。可在官方「网页搜索与获取」设置中选择其他搜索提供方。

### 常用执行组合

| 来源与模型                      | Harness                                | 使用前提                                                            |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| OPL DeepSeek V4.1 Flash         | DSH                                    | 对应 Gateway 分组可用                                               |
| OPL GPT                         | Codex CLI                              | 分组与 CLI 已就绪                                                   |
| OPL Claude Opus 5.5、Fable 5.2  | Claude Code                            | Claude、AWS、Kiro 渠道独立选择                                      |
| OPL Grok 4.7                    | Grok Build                             | 分组与 CLI 已就绪                                                   |
| OPL Gemini 4 Carbon、4 Hydrogen | Antigravity CLI（默认）；OpenCode 备选 | 使用 Gateway Gemini 分组凭据，无需 Google 登录；支持图片与 Git Bash |
| MiniMax M3.1-Flash、M3          | mcode                                  | 官方账号；仅支持明确授权的完全访问                                  |
| OFM 免费模型与虚拟路由          | 按来源选择已适配 Harness               | 见 [OFM 组合](docs/harness-adaptation.md#our-free-model-组合)       |

“已适配”表示实现了接入，不保证免费渠道随时可用。不同渠道保留独立身份，失败不会自动换模型或换源；外部 Harness 不支持当前权限时拒绝启动，不会自动提升权限。推理档位按模型与 CLI 实际能力提供。

外部 CLI 可分别设置继承环境、直连或 HTTP/HTTPS 代理，入口为 **设置 → 执行与组合 → 执行引擎与网络代理**。Windows Git Bash 能力因 Harness 而异，见[Windows 验证与限制](docs/windows-local-validation.md)及 [Codex Git Bash 候选版](docs/codex-gitbash-candidate.md)。

图片输入按模型来源与 CLI 实际能力开放，保留官方附件引用、输入顺序及编辑时的原图片；不支持图片的组合会在发送前拒绝。详见[模型与 Harness 架构](docs/model-harness-architecture.md)。

## 更新与数据

官方桌面通过 DeepSeek 自身的机制更新。OPL 增强在启动后异步检查正式 Release，运行期间每 6 小时检查一次；新版本在侧边栏提示，可在「通用设置 → 更新」手动检查、关闭自动检查或改为仅提醒。默认策略会自动下载兼容更新；完全退出应用后，一次性后台 watcher 等待官方 Desktop 与 Host 结束，安装并校验增强层，下次直接打开官方应用即使用新版本。需要升级官方桌面时使用完整安装包，也可重新运行最新安装器更新。Linux 不启用这套 Desktop watcher 或增强层自动安装，须重新构建并运行 `installer/install-linux.mjs`。Homebrew 用户可运行：

```sh
brew upgrade --cask gaofeng21cn/opl-dsh/opl-dsh
```

增强包和缓存保存在 OPL DSH Suite，官方 profile、登录、会话与设置位于 `~/.dsh`；重新安装保留已有数据。Linux 的 Suite 默认位于 `~/.local/share/OPL DSH Suite`，OPL 执行与会话数据跟随实际 CLI profile。Windows 上的 BambooNode 和 TypeSafe 个人 Key 使用 Windows Credential Manager；MiniMax 账号凭据由官方 mcode 管理。

准确版本、平台与资产摘要见[最新 Release](https://github.com/gaofeng21cn/opl-dsh/releases/latest)。运行中的 profile 不替换，更新校验失败时保留已安装版本。发布流程每日检查主线的未发布改动和官方 DSH 双平台版本变化，通过兼容验收后自动发布新的联合版本，详见[发布约定](docs/release-policy.md)与[发布 SOP](docs/release-sop.md)。

## 开发与文档

- [开发、数据位置与验证](docs/development.md)
- [官方桌面兼容验证](docs/compatibility.md)
- [模型与 Harness 架构](docs/model-harness-architecture.md)
- [官方能力复用检查](docs/dsh-reuse-audit.md)
- [外部 Harness 适配](docs/harness-adaptation.md)
- [Computer Use](docs/computer-use.md)
- [发布记录](https://github.com/gaofeng21cn/opl-dsh/releases)

## 关于

本仓库由 One Person Lab 独立维护，与 DeepSeek 官方无隶属关系。官方桌面与 Harness 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本仓库维护增强插件、协作 Skill 和安装更新工具。

采用 [MIT 许可](LICENSE)，来源声明见 [NOTICE](NOTICE)。
