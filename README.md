# OPL DSH

**官方 DeepSeek Harness 桌面 + OPL 增强，一次安装即可使用。**

在官方 DSH 中使用 OPL Gateway、免费模型和不同的模型 + Harness 组合，并与 Codex 协作。桌面、Agent 循环、工具和权限由官方 DSH 或所选 Harness 提供，OPL 负责接入、会话关联与安装更新。

## 下载安装

支持 macOS Apple Silicon 和 Windows x64，无需预装 Git、Node.js 或其他 OPL 应用。

### 图形安装器

| 系统                  | 下载                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| macOS · Apple Silicon | [Mac 安装器（DMG）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-mac-arm64.dmg)       |
| Windows · x64         | [Windows 安装器（EXE）](https://github.com/gaofeng21cn/opl-dsh/releases/latest/download/OPL-DSH-Installer-windows-x64.exe) |

打开安装器后，按提示选择 OPL Gateway、DeepSeek 官方或稍后登录。安装器会联网下载并校验官方桌面，再安装增强插件和 Codex Skill。OPL 安装器未签名，首次可能需要按系统提示允许打开。

安装或升级前请退出 DeepSeek Harness。已有登录、会话、设置和用户修改过的 Skill 会保留。安装完成后，日常直接打开官方 **DeepSeek Harness**；macOS 默认位于 `~/Applications/DeepSeek Harness.app`。

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

首次使用见[首次启动与登录](docs/first-run.md)。

## 主要能力

- **OPL Gateway**：应用内登录，管理账户、余额和分组权限；可用模型进入统一选择器，左下角显示登录邮箱。
- **Our Free Model**：保留[上游插件](https://github.com/Ebony-Vinyl/dsh-our-free-model)的渠道、登录、模型发现和更新功能。执行设置提示新模型及适配状态，不自动启用未知路线。见[模型插件](docs/model-plugins.md)。
- **模型 + Harness 组合**：同一个输入框和消息流中使用 DSH、Codex CLI、Claude Code、OpenCode 等执行引擎；在“执行与组合”中按 Harness 批量选择，或手动添加已适配搭配。见[适配与支持范围](docs/harness-adaptation.md)。
- **Codex ↔ DSH 协作**：自动安装 `opl-dsh-official` Skill，支持派发、续作、读取结果与交付验收；主动回传需配置通知桥。见[协作说明](docs/collaboration-implementation.md)。
- **SuperAgent 仓库协作**：继承 DeepSeek SuperAgent 原型的 GitHub／可选飞书接单、授权策略、工单、执行和管理面板。macOS 在“协作与自动化”打开独立窗口后配置。见[SuperAgent](docs/superagent.md)。
- **Auto Review 工具审批**：支持专用 codex-auto-review、独立 reviewer，以及 [BambooNode StartLux](docs/bamboo-startlux-auto-review.md) 和 [Jev](docs/jev-auto-review.md) 决策模型；默认关闭。见[工具审批](docs/auto-review.md)。
- **MiniMax 官方账号**：通过 mcode 登录中国站或国际站，支持登录状态、退出、取消授权与超时处理。见[MiniMax 账号与 mcode](docs/minimax-code.md)。
- **对话体验**：不选工作区也可开始新对话；原生 DSH 支持[编辑消息并原地重发](docs/stop-edit.md)；[Todo](docs/todo-status.md)展示真实记录状态；可启用[后台任务系统通知](docs/desktop-notifications.md)。
- **网页搜索**：登录 Gateway 后，原生 `web_search` 统一使用 GPT-6.1 Sol 搜索，无需额外配置。

### 常用执行组合

| 来源与模型                             | Harness                  | 使用前提                                                      |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| OPL DeepSeek V4.1 Flash                | DSH                      | 对应 Gateway 分组可用                                         |
| OPL GPT                                | Codex CLI                | 分组与 CLI 已就绪                                             |
| OPL Claude Opus 5.5                    | Claude Code              | AWS、Kiro 渠道独立选择                                        |
| OPL Grok 4.7                           | Grok Build               | 分组与 CLI 已就绪                                             |
| OPL Gemini 4 Argon、3.8 Flash、3.1 Pro | OpenCode                 | 在执行设置中添加组合，使用 Gateway Gemini 渠道                |
| MiniMax M3.1-Flash、M3                 | mcode                    | 官方账号；仅支持明确授权的完全访问                            |
| OFM 免费模型与虚拟路由                 | 按来源选择已适配 Harness | 见 [OFM 组合](docs/harness-adaptation.md#our-free-model-组合) |

“已适配”表示实现了接入，不保证免费渠道随时可用。不同渠道保留独立身份，失败不会自动换模型或换源；外部 Harness 不支持当前权限时拒绝启动，不会自动提升权限。推理档位按模型与 CLI 实际能力提供。

外部 CLI 可分别设置继承环境、直连或 HTTP/HTTPS 代理，入口为 **设置 → 执行与组合 → 执行引擎与网络代理**。Windows Git Bash 能力因 Harness 而异，见[Windows 验证与限制](docs/windows-local-validation.md)及 [Codex Git Bash 候选版](docs/codex-gitbash-candidate.md)。

## 更新与数据

官方桌面通过 DeepSeek 自身的机制更新；OPL 增强通过维护入口或已启用自动启动的 Codex Skill 检查联合 Release。**直接打开官方桌面不会触发 OPL 更新器**，也可重新运行最新安装器更新。Homebrew 用户可运行：

```sh
brew upgrade --cask gaofeng21cn/opl-dsh/opl-dsh
```

增强包和缓存保存在 OPL DSH Suite，官方 profile、登录、会话与设置位于 `~/.dsh`；重新安装保留已有数据。Windows 上的 BambooNode 和 TypeSafe 个人 Key 使用 Windows Credential Manager；MiniMax 账号凭据由官方 mcode 管理。

准确版本、平台与资产摘要见[最新 Release](https://github.com/gaofeng21cn/opl-dsh/releases/latest)。运行中的 profile 不替换，更新校验失败时保留已安装版本。发布流程每日检查主线的未发布改动，详见[发布约定](docs/release-policy.md)与[发布 SOP](docs/release-sop.md)。

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
