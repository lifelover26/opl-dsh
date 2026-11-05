# 模型、Harness 与组合

OPL DSH 在官方桌面上提供账号自动配置、Harness 管理和组合选择。模型配置继续由 DSH 保存，官方 DSH 和外部 Harness 分别执行各自的 Agent 循环。

## 数据职责

| 对象               | 唯一配置位置                   | 内容                                                         |
| ------------------ | ------------------------------ | ------------------------------------------------------------ |
| Gateway 账号与分组 | Gateway 账号服务、DSH 凭据服务 | 登录、用量、分组权限、本机激活、各分组 Key、同步错误         |
| 模型               | DSH profile 设置与 LLM 注册表  | 来源、模型 ID、名称、能力、分组路由和协议                    |
| Harness            | OPL Harness 目录               | 程序身份、可执行文件、适配器；安装路径和版本来自本机检测     |
| 组合               | `execution-catalog.json`       | `modelRef`、`harnessRef`、`permissionPolicy`、默认与启用状态 |
| 对话               | 官方 Session 或外部 ACP 会话   | 项目、实际模型与 Harness、权限、历史及协作关联               |

组合不再保存连接或协议。模型列表是 DSH 注册表的只读投影，不写入组合文件。DSH 原生模型页中的 OPL Gateway 子树通过官方 `settings.mutate` 保存模型：DeepSeek 分组位于 `opl-suite.gateway.models`，其他分组位于官方 `llm-pi-ai` 的对应 Provider profile。编辑和运行读取同一份配置。

## Gateway 分组

第三方模型插件同样通过官方 LLM 注册表进入组合目录。Our Free Model 原样安装，保留全部渠道与虚拟模型；OPL 只保存组合引用，不接管它的账号、模型路由或更新。详见[第三方模型插件](model-plugins.md)。

账号页管理 DeepSeek、OpenAI 协议、Grok、Gemini、AWS、Kiro 六种分组的独立凭据。没有某一组的权限不阻止账号登录，也不影响其他已授权组。页面区分未配置、未授权、凭据就绪和同步错误；凭据就绪不等于真实模型调用已经验收。

登录、刷新时按分组尝试获取模型目录。首次导入和未被用户修改的自动目录可以更新；已有用户模型列表保留。模型页也可手动获取候选模型并保存。自动导入失败时保留已有配置。模型目录所有权摘要保存在原生设置中，不另存一份模型表。

目录状态与 Key 状态分开记录；模型页按分组说明缺凭据、认证、网络、超时、设置冲突或服务未就绪，不把全部失败归因于 Key。目录读取使用该组的有效地址、部署前缀与凭据引用，不借用其他分组。AWS/Kiro 的 Anthropic 默认地址不带 `/v1`，由官方 SDK 追加消息路径；旧套件默认地址和 Opus 5.5 缺失的 adaptive 配置会迁移，用户自定义地址、凭据引用和显式兼容设置保持原值。

用户只看到一个 OPL Gateway 来源，账号页控制本机激活分组，模型页获取目录并勾选所需模型。停用分组保留 Key、模型配置和已有对话，但阻止新的调用。新加入的 Kiro 默认未激活；升级保留原分组的激活行为。分组路由显式映射，绝不按模型名字猜测，也不在错误后换组：

| 分组        | 默认执行接口                               | 凭据         |
| ----------- | ------------------------------------------ | ------------ |
| DeepSeek    | 官方 DeepSeek adapter / Messages           | DeepSeek Key |
| OpenAI 协议 | 官方 pi-ai 协议适配库 / OpenAI Responses   | Codex Key    |
| Grok        | OpenAI Responses；Grok Build 通过 ACP 执行 | Grok Key     |
| Gemini      | OpenAI Chat Completions，可在模型页调整    | Gemini Key   |
| Kiro        | 官方 pi-ai 协议适配库 / Anthropic Messages | Kiro Key     |
| AWS         | Anthropic Messages                         | AWS Key      |

上述协议是套件默认配置，实际服务支持以端点为准。官方 `dsh-llm-pi-ai` 仅转换模型协议，不负责 Agent 循环。

同名模型具有不同身份：DeepSeek 分组保持历史 ID `deepseek-flash`，OpenAI 协议分组使用 `codex::deepseek-flash`。线上请求仍发送 `deepseek-flash`；组合引用同时确定分组，用户不需要输入内部限定 ID。GPT 通过 OpenAI 协议分组直接调用。默认自动目录不会将 DeepSeek Flash 复制到该渠道，用户可在模型页主动加入。

## 设置与使用

- **Computer Use**：原生 DSH Agent 可通过单一 `computer_use` 工具调用本机 KimiCU 的原始 MCP 动作。KimiCU 继续拥有应用发现、截图、无障碍树和桌面输入；OPL 只负责会话绑定、参数透传、附件投影、取消与权限门禁。只读观察可直接使用，桌面变更要求当前会话显式选择“完全访问”。KimiCU 不可用或权限不足时工具失败，不伪造状态，也不新增独立设置页。

DeepSeek 4.1 Flash 的 DeepSeek 与 OpenAI 协议渠道默认推理档位为 `high`；GPT 模型默认 `medium`。MiniMax M3.1 默认 `max`，M3 默认开启思考。默认值仅在未选择档位时使用，同一对话按模型和渠道保存的选择优先，切换模型不沿用其他模型的档位。

- **OPL Gateway**：Gateway 登录、用量、分组权限与凭据。其他 Provider 保留官方的配置入口。
- **模型**：沿用官方模型页面；OPL Gateway 排在第一位，其他 Provider 和自定义 API 使用官方表单。Gateway 默认显示模型及必要的渠道选项，手动字段和协议放进高级编辑，不要求重填 Key。
- **Harness**：检测已接入 CLI 的安装、版本与路径；可登记其他程序。检测区分文件存在与版本验证成功，Windows npm 入口选择 `.cmd` 等可执行启动器；ZCode 的桌面入口不在检测时启动。安装与更新使用固定官方入口，npm 使用实际全局安装目录；维护完成后重新验证入口与版本。首次安装的默认入口保存为验证过的绝对路径，显式路径和自定义命令保持原值，发现的其他安装单独展示。内置 DSH 随官方桌面更新，不可删除。
- **组合**：从 DSH 模型目录选择模型，绑定 Harness 与权限。每个模型可指定一个默认组合；没有自定义默认时，GPT 默认 Codex CLI、Claude 默认 Claude Code，其他模型使用已配置的官方默认组合。

对话输入栏复用官方模型目录、模型选择投影、菜单组件与 Slot；OPL 的组合选择菜单显示“模型 · Harness”，来源仅作为展开菜单的分组标题。没有凭据的官方 DeepSeek 模型不作为可选项。DSH 原生组合调用官方 Session 的模型选择接口；外部 Harness 组合绑定到当前官方 Session，由 Host 在 `llm/stream` 阶段转发同一轮请求并把文本流回官方 Session。自动生成组合的权限只作为新委派任务的缺省值，切换模型保留当前会话选择的权限；显式只读组合通过官方只读预设同时设置 sandbox 与审批策略，不产生两者混用的 custom 状态，也不会静默扩大当前权限。原生会话列表不会出现第二套 OPL 管理页面；父子委派工具仍用于需要显式子任务、交付验收或跨 Harness 协作的场景。

自动组合只来自预先维护的“Harness + 官配模型”表，并在对应模型已经就绪后启用。DSH 的官配是 DeepSeek 自家模型；Codex、Claude、Grok Build、MiniMax、ZCode、Kimi、MiMo、Poolside、StepCode、Muse 只在厂商自家模型与对应 CLI 配对时自动生成。OpenCode、Kilo、Pi 等通用执行器没有自己的模型，官配列表为空，不会因为适配器支持某模型就生成内置组合；需要时可在“添加执行组合”中手动选择模型与执行器，跨厂商或通用执行器配对会标记为“自定义”。经 OFM 本地转发执行的手动外部组合还要求 OFM 本地转发已启用并运行。组合设置页会把“可启用但当前停用”的项目折叠；用户手动停用后，自动投影不会重新打开该组合。

每个原生对话选中的组合 ID 保存在 OPL 自有的 `combination-selection.json`，用于重启后区分同一模型的多个自定义组合。它只关联官方会话 ID，不改变官方会话格式。模型选择以官方 live/cold 投影为准，冷会话通过公开 `session.projections` 读取，不借用新建会话激活历史；组合停用或模型被其他入口切换后，不再采用失配的关联。

执行器使用官方 DSH、Grok Build、本机 Codex CLI 的 app-server，以及官方 Claude Agent SDK 驱动的本机 Claude Code。OPL 只做协议、权限、显示和协作映射，不实现 Agent 循环。Codex 与 Claude 的配置及会话保存在套件自有目录，不改日常 CLI 配置。OpenCode 也可承载 OPL Gateway Gemini 的三个固定组合：Gemini 4 Argon、Gemini 3.8 Flash 和 Gemini 3.1 Pro；它们仍从 Gateway 读取凭据和 OpenAI Chat Completions 路由，OpenCode 只负责 Agent 循环与工具执行。OFM 的 `big-pickle` 与官方 OpenCode 免费车道同样由 OpenCode 执行；OpenCode 不广告推理档位，这些组合不显示推理强度。Kilo 频道的 `nvidia/nemotron-3-super-120b-a12b:free` 和 `recursive/flint-v1.0:free` 由 Kilo 读取 OFM Chat 端点；`flint-40b-free` 由 OpenCode 读取 OFM Chat 端点。它们保留 OFM 作为模型来源。Antigravity 暂仅支持本机管理。

Claude Code 的官方 SDK 思考增量映射到对话中的思考流，正文增量仍独立显示；签名不显示，已完成的内容块不重复追加。只展示 SDK 实际发送的思考，渠道未发送时不补写。

图片经官方附件服务接收与读取；外部轮次只持久化附件引用，发送时才编码，不读取模型提供的 URI。只有模型来源声明支持图片且实际 CLI 公告图片能力时，Codex、Claude、OpenCode 或 Grok 桥才发送图片；文字和多张图片保持输入顺序。不支持的输入在发送前拒绝，不降成文字。图片消息编辑保留原图片，且要求持久引用与 CLI 历史的图片数量一致；无法确认的旧图片记录不提供编辑。此路径不扩展为音频或通用文件上传。

各已接入 Harness 的协作工具可以先查询可用组合，再使用组合 ID 派发同项目子任务。Codex Skill 同样通过组合目录派发。各 Harness 保留自己的上下文，交接依靠明确的任务说明。

## 迁移与验证

旧组合目录首次读取时先保留 `.v1.backup`，再转为模型引用。用户名称、默认选择、权限和原会话映射保留；旧自定义模型若未进入原生模型系统，会显示未配置，原声明仍在备份中。发现旧组合的连接与其模型来源冲突时停止迁移并保留文件，避免猜错账号。此迁移只涉及 OPL 组合文件，不改变官方会话格式。

隔离验收使用由官方 feed 确定的未修改桌面与本地模拟模型端点，覆盖原生设置写入、模型目录回读、DeepSeek Messages、Codex Chat Completions、官方工具执行及后续模型回复。真实 Gateway 新增分组模型和外部 CLI 的完整调用，需要对应服务和安装环境，不能由本地模拟验收替代。

## 模型与组合的界面规则

模型配置继续写入 DSH 原生设置。Gateway 账号页只管理账号、用量和分组凭据；模型页中的 OPL Gateway 卡片默认平铺模型，同名模型以必要的渠道标记区分，编辑时才展开各调用路由和协议。Key 同步状态不表示真实调用已验证。

新增组合只列出凭据就绪的模型。同名模型的不同计费渠道可分别选用：DeepSeek Flash 的 DeepSeek/OpenAI 协议，以及 Claude Opus 5.5 的 AWS/Kiro；DeepSeek Flash 的 OpenAI 协议渠道必须由用户主动加入。组合绑定精确渠道，不在失败后静默换组。倍率仅显示 Gateway 实际返回值。已有组合的精确模型引用和权限保持不变，失效组合保留并说明原因，不把不可用模型当作新增选项。对话按钮显示“模型 · Harness”，来源只在展开菜单中分组展示。

设置导航统一按账户与模型来源、执行与组合、协作与行为、应用扩展排列。BambooNode StartLux 与 TypeSafe Jev 注册到官方可配置提供商目录，复用“添加模型提供商”、原生编辑器与删除确认。官方编辑器仍只识别 DeepSeek 与 pi-ai 两种布局，因此兼容层扩展原有 `llm-pi-ai` 的公开 Schema，保留原条目和原版适配器；Jev 的固定模型发现只适配该 namespace 下的精确 provider 查询，其他发现交回官方实现，卸载恢复原方法。个人 Key 通过固定目标存入 Windows Credential Manager。官方设置、插件管理、Agent 预设和原版 OFM 的组件、配置与更新继续由各自维护者拥有；OPL 只统一导航和展示。

华为云 MaaS 的模型目录、供应商入口、专属凭据迁移、请求转发及执行适配已撤除。旧用户配置、系统凭据和会话原样保留，但不再被 OPL 探测、迁移或自动恢复；已有组合保留为不可用引用。ZCode 继续服务已适配的 OFM 模型，使用 OFM 的连接与凭据。

系统通知属于本机通用偏好，通过官方 `settings.general.item` 条目复用通用设置页面；保留原偏好键、默认值和通知控制器，不增加独立导航或配置副本。对话的 token 用量和上下文占用使用官方 DSH 统计；旧上下文预算服务、Remote 与未挂载 UI 已删除。外部 Harness 的网络代理位于“执行与组合 → 执行引擎与网络代理”的现有卡片内，与路径、检测及维护共用页面操作状态；按 Harness 写入原组合目录中的同一字段，不在组合列表重复提供。工具审批也收在同一页的折叠区，使用原有路线、预算和保存流程，不占独立导航。检测接口返回所检测 Harness 的原配置引用投影，读取和编辑代理不要求先加载模型目录。Gateway 账户需要登录、用量与分组权限管理，OFM 需要保留原版多渠道、路由和更新功能，因此继续使用各自已有入口。

导航名称与顺序集中定义在 `src/shared/client/settings-navigation.ts`。设置导航统一只显示文字，官方入口与第三方入口使用相同的文字布局。当前官方没有导航展示设置接口，`src/compat/client/settings-navigation.ts` 调整公开 Slot 条目的标签与顺序，并通过局部样式隐藏设置导航图标，保留原条目身份、组件、注入参数和子 Slot；不改官方或 OFM 的包文件。适配随条目注册与热重载更新，卸载后恢复原元数据并移除样式，未列入名称规则的第三方入口保留原标签。官方提供对应接口后可替换这处兼容实现。

新增或吸收第三方能力时，按[功能接入与 UI 成本判断](development.md#功能接入与-ui-成本判断)决定能力 owner 和界面位置。当前设置信息架构中，供应商与凭据在模型来源入口，执行程序、组合绑定、网络代理和工具审批在“执行与组合”；OFM 的完整原版管理能力通过入口适配保留，决策模型配置复用原生供应商交互。这是当前合理落点，不排除未来依据新的用户任务调整或增加必要入口。

## 通用项目协作

`HarnessService` 是新协作任务的唯一 owner，`harness-sessions/` 同时保存父子关系、冻结的模型引用、任务要求、轮次、交付和验收。`control.ts` 注册官方 DSH 工具；每个外部 Harness 的私有 MCP capability 绑定真实父会话，两者调用相同的 delegate/result/report/review/cancel 方法。外部 Codex 入口单独放在 `coordination/external-codex.ts`，开关不会影响内部工具。旧 dispatch 反馈服务仅保留兼容旧记录。

执行状态与验收状态分开；完成轮次进入 pending 验收，父对话基于实际产物选择 accepted 或 changes_requested。后续修改沿用子会话和 taskId，使用新 operationId。原 operation 重试幂等，变更内容被拒绝。回传以持久 ID 和官方 prompt requestId 去重，只有用户显式重试创建新的交付尝试。重启不会自动重新执行未完成的轮次。

项目写队列覆盖 OPL 托管会话；同步委派时父对话处于 waiting_child，子任务可执行，异步任务在写占用解除后执行。只读任务可以并发。原生 DSH 父对话繁忙时异步写子任务等待，独立原生会话和外部编辑器不在此队列控制范围。

主界面只使用官方会话列表、消息流和输入框；组合、父子关系、子任务轮次、交付与验收仍由 `HarnessService` 后台持久化。没有注入独立会话管理面板，也没有修改官方会话格式或桌面资源。

## 实现边界

Gateway 模型读写由独立 `oplGatewayModels` Remote 负责，不经过首启或 Harness 服务。`oplExecution` 提供执行组合、执行、协作状态及分页读取；账号、首启和 Skill 维护分别挂载。所有 Remote 从同一份服务声明生成 Host 校验和 Client 类型。

会话目录按 ID 分文件保存，原全量文件保留为迁移来源；任务摘要与历史详情分别读取。程序身份、协议桥与环境构造位于各执行器适配模块；主服务管理会话关系、权限和协作规则。具体目录与恢复边界见[开发与验证](development.md)。
