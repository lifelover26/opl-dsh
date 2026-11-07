# OPL DSH 发布约定

OPL DSH 使用一个联合稳定版本表示一套可安装组合。版本号只递增，不复用，不在稳定渠道发布 `-rc`、`-beta` 或 nightly。

本页是发布合同，定义稳定版本的触发、身份、资产和更新边界。按时间顺序执行发布、回读和恢复时，使用[稳定发布 SOP](release-sop.md)；不要从 README、旧 Release Note 或历史命令推导当前流程。

## 每日自动发布

OPL DSH 是官方桌面的打包增强层，采用与 OPL 智能体相同的每日云端巡检发布策略。用户持续授权 GitHub Actions 在 `gaofeng21cn/opl-dsh` 内自动准备版本、提交主线、创建发布 tag、运行既有稳定发布工作流并公开合格资产，无需用户逐次手动触发或批准。

`.github/workflows/stable-release.yml` 每日北京时间 02:37 检查 `main` 与最新公开稳定 tag 之间的增强层改动，同时读取官方 macOS arm64、Windows x64 更新清单，并与最新公开联合清单的官方 DSH 版本比较；GitHub 调度可能延迟。插件源码、配置、协作 Skill、安装器、构建入口和依赖有未发布更新或修复，或官方两平台一致的版本发生变化时，自动递增 OPL patch 版本并生成中文发布说明。上游单独更新也会重新构建和验收联合版本，无需先制造增强层源码改动；开发 API 依赖仍按实际接口需要维护。维护者已准备的更高稳定版本和对应说明予以沿用。只有文档、测试、发布流程或 Homebrew 派生元数据变化，且官方版本也未变化时跳过，不制造空版本。

官方版本比较使用 GitHub Latest 中经资产摘要校验的 `release-manifest.json`，不解析 Release Note 作为版本依据。两平台清单不一致、读取失败或公开清单校验失败时，不写新版本或 tag。新候选的 annotated tag 固定本次官方版本；打包再次核对实时 feed，发布前继续核对联合清单。上游在未完成候选期间变化时，从主线准备新的 OPL patch，保留旧 tag；显式恢复旧 tag 时若官方版本已变化则拒绝混用。

检查后直接在同一工作流内打包、双平台验收、公开发布、资产回读和 Homebrew 跟随。未公开的候选已有 canonical tag 且产品源码无需改变时续作该版本，不分配新版本、不覆盖 tag 或公开资产。若验收确认必须修改产品代码，保留失败候选的 tag 与证据，为修正后的产品递增版本并建立新 tag；不把新产品字节写入旧候选身份。版本准备与人工 tag 发布共享同一串行组；主线竞争、认证、源码或资格检查失败时明确报告断点，保留上一个可用 Release。手动触发 `main` 可立即执行一次同样的检查；选择 canonical tag 可恢复该候选。

DSH 与 OPL App Stable/Nightly 共用 [Framework 发布说明策略](https://github.com/gaofeng21cn/one-person-lab/blob/main/scripts/release-note-writer/policy.json)及同目录调用实现。中央主线修改自动影响下一次准备，单次准备固定中央提交与配置摘要，已冻结正文不追新；中文提示词、结构校验与机械正文仍归本仓，共享代码不进入增强包。共享源码下载或校验失败直接使用机械说明。当前自动 Release Note 按四个入口顺序生成：先由 Copilot CLI 使用 `--model auto` 与 Actions 自带 `GITHUB_TOKEN` 撰写中文用户说明；额度不足、认证、安装、调用或结果校验失败时，降级到 OPL App 已使用的 Gateway 接口的 `deepseek-flash`，失败后再调用 `gpt-6-luna`；仍失败时，使用带提交链接的原始改动记录和发布门禁事实生成机械说明。模型只读取本次公开 Git 证据，不执行工具；正文标注最终生成方式，工作流记录尝试顺序，维护者已准备的说明不覆盖。Copilot 消耗仓库所有者的包含额度，不承诺无限免费，不自动开启额外付费预算。Gateway 凭据保存在仓库 Secret `OPL_RELEASE_NOTES_CODEX_API_KEY`，不进入源码、日志、Copilot 子进程或发布资产。输入超过写作预算时直接生成机械说明。Release Note 的模型质量或可用性不构成发布阻断项；资格与版本事实由发布工作流填入，模型不得代替验收证据。

每日触发改变的是发布时机与授权，不取消官方签名、摘要、隔离运行和两平台资格验收。只使用已进入主线的 OPL 增强实现；未合并提案不会直接发布。官方上游更新先走现有双平台兼容资格，实际接口不兼容时保留上一可用 Release，修复主线后再发布。

## 命名

- Git tag：`opl-dsh-v<OPL版本>`，例如 `opl-dsh-v0.2.18`。
- Release 名称：`OPL DSH v<OPL版本>`。
- Release channel：GitHub stable release，`draft=false`、`prerelease=false`、`latest=true`。
- GitHub Release 名称作为页面标题，Release Note 正文不再重复该标题；正文顺序固定为：联合版本、官方 DSH 版本、变更、验证、已知限制、升级方式。

每个稳定 Release 必须同时提供 `release-manifest.json`、`OPL-DSH-Enhancements.zip`、macOS DMG、Windows EXE、`SHA256SUMS` 和官方兼容验收记录。`release-manifest.json` 是 DSH 与 OPL 版本配对的权威清单，要求 tag、清单、增强资产摘要和构建产物彼此一致。

## 联合版本

`releaseVersion` 与 `enhancement.version` 相同，`official.version` 记录本次验收所针对的官方 DeepSeek Harness。官方桌面仍由 DeepSeek 更新清单负责下载和签名校验，OPL 安装器不修改官方应用资源。新的官方桌面版本必须先完成隔离资格验收，再生成新的联合 Release。

## 自动更新

OPL Host 启动后异步检查 GitHub `releases/latest`，随后每六小时检查一次；用户可在通用设置关闭自动检查或手动检查。发现新版本只显示提示，点击「下次启动时更新」才下载兼容增强包。更新器校验 stable channel、canonical tag、release manifest、GitHub 资产摘要、增强包摘要和逐文件清单，套件启动器在所有 profile 已退出后才安装已准备的包；失败保留安装和更新计划。

本地验收候选仍可检查新版本，但只有用户显式准备后才替换。延后更新要求原安装、目标包及清单声明 `updateProtocolVersion: 1`，且官方桌面版本完全一致；缺少协议声明或版本不同则使用完整安装包。

增强插件加载后即可检查更新；安装已准备的增强包仍须从套件入口启动。官方桌面自身继续按 DeepSeek 原生机制更新，OPL 不修改官方签名资源。

## 历史清理

默认保留历史 Release 与发布 tag，发布新版本只更新 Latest 指针，不自动清理旧版本。清理是独立维护操作，仅在用户明确要求并指定范围时执行，不是发布完成条件。删除前保存 release/tag 元数据和资产摘要；源码提交和本地安装回执仍保留用于追溯。

公开回读、Homebrew 跟随、失败恢复和发布前后清单见[稳定发布 SOP](release-sop.md)。
