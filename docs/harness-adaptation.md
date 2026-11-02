# 外部 Harness 适配准备

模型来源由现有模型供应商入口管理；执行程序、组合绑定、网络代理和工具审批统一位于“执行与组合”页。增加来源不需要增加设置页，也不自动改变现有模型的默认 Harness。

## 显式来源注册

`ctx.oplExternalModelSources.register(ctx, source)` 允许来源插件声明精确的模型与外部 Harness 配对。`source.provider` 使用官方 LLM 注册表的原始 Provider ID；`supports(harness, ref)` 声明配对，`resolve(harness, ref)` 在 Host 返回 `baseURL`、实际 `model`、`apiKey` 和 `protocol`。协议为 `responses`、`messages` 或 `chat`，必须与适配器一致。凭据由来源插件读取，不进入公开模型目录或组合配置。

注册通过来源插件的 effect 管理，卸载后拒绝新的解析；异步解析期间来源被替换或卸载也拒绝启动。OPL Gateway 保持已有配置读取路径。其他来源必须显式注册，不能按模型名称猜账号、拆解虚拟轮换链或复制插件私有设置。

外部适配器在解析前调用 `lease(harness, ref)`，在最后一次异步启动检查后调用 `assertCurrent()`；即使同一来源对象卸载后再次注册，旧 lease 也失效。lease 只核对注册生命周期与声明配对，实时模型目录和连接数据仍由来源 owner 校验；OPL Gateway 继续使用其原有路径。

只有声明 `customEndpoint` 的适配器接受新来源。Codex 支持 Responses，Claude 支持 Messages；仅有官方账号或固定端点的 Harness 不因为模型协议相似就接受任意来源。

## Our Free Model 组合

默认仅生成厂商官配。OpenCode、Pi、Kilo 和 ZCode 的已适配渠道在“添加执行组合”中提供推荐选项，选择后填入模型、执行引擎和名称，保存后才加入列表。推荐采用来源与模型的精确 ID，不按名称猜测；用户自定义默认组合、停用选择和权限保留。未知模型需手动配置，不可用组合不进入对话选择列表。

OFM 来源统一使用 `Our Free Model` 写法，区域渠道保留 `region-limited` 标识，OpenCode 官方免费通道保留独立来源名称。已保存的不可用组合显示具体状态：当前目录不再包含模型时显示“目录已移除”，停用时显示“未启用”，目录读取失败时显示“状态未确认”；其他执行准入失败显示“不可用”，悬停可查看原因。不可用模型不进入“选择与添加组合”；普通保存保留未操作的隐藏配置，“取消全选”及按 Harness 取消会同时停用对应的隐藏组合。不可用的已启用组合也可单独“移除”，只停用配置，不删除会话；来源恢复后不会自动重新启用。

套件通过 OFM 的公开 `/clients` 接口读取免费车道的运行端点、Key 与模型目录，并在启动前再次核对官方 LLM 注册表。先在 OFM 的「本地转发」启用免费车道；未启用、模型撤销、来源卸载或准入失败时拒绝启动。账号车道 `our-free-model-region` 不借用免费车道的端点。

| 模型                                                                       | 首选 Harness           | 协议      |
| -------------------------------------------------------------------------- | ---------------------- | --------- |
| Kimi K2.6、K3                                                              | Kimi Code              | Messages  |
| MiMo v2.6 Flash（mimo-v2.6-flash-free）                                    | OpenCode，官方免费通道 | Chat      |
| Laguna S、XS 2.1                                                           | Poolside               | Chat      |
| GLM 5.3、5.3 Flash（z-ai 原始 ID）                                         | ZCode                  | Chat      |
| EAC GLM 5.3 Flash Free（opencode/glm-5.3-flash-free）                      | OpenCode，经 OFM 转发  | Chat      |
| EAC DeepSeek V4.1 Flash Free（opencode/deepseek-v4.1-flash-free）          | OpenCode，经 OFM 转发  | Chat      |
| Big Pickle（big-pickle）                                                   | OpenCode，官方免费通道 | Chat      |
| Nemotron 3 Super 120B（nvidia/nemotron-3-super-120b-a12b:free）            | Kilo Code，经 OFM 转发 | Chat      |
| Flint v1.0 Free（recursive/flint-v1.0:free）                               | Kilo Code，经 OFM 转发 | Chat      |
| Flint 40B Free（flint-40b-free）                                           | OpenCode，经 OFM 转发  | Chat      |
| GPT-OSS 20B                                                                | Codex CLI              | Responses |
| Kilo Step 5 Preview（stepfun/step-5-preview-free）                         | StepCode               | Chat      |
| Ling、LongCat、North Mini Code、Nemotron 3.5、Space Bunny、OpenRouter Free | OpenCode               | Chat      |
| OPL Gateway Gemini 4 Argon、Gemini 3.8 Flash、Gemini 3.1 Pro               | OpenCode               | Chat      |
| Nemotron Nano Omni、LFM、Inkling Small                                     | Pi Coding Agent        | Chat      |
| Dots、Glyph、Kilo Auto Free、Kilo Beam、Xing 4.0                           | Kilo Code              | Chat      |

表格描述适配器配对，不是当前在线可用性承诺；模型必须仍在来源目录中且通过启动前检查。Cat Jam、MiMo v2.6 Flash、Muse Spark 1.3、Longcat 2.5、OpenCode 的 DeepSeek/GLM/Beam/Nemotron 免费条目、Space Bunny 和 Big Pickle 的精确裸 ID 使用 OpenCode 官方免费通道。Kilo 频道的 Nemotron 3 Super 120B 使用 Kilo 执行器并经 OFM Chat 转发，不折叠成 OpenCode 路线。Flint 的 `flint-40b-free` 使用 OpenCode 执行器并经 OFM Chat 转发；它与 OpenCode 自己的 `opencode/flint-40b-free` 服务是不同线路。`recursive/flint-v1.0:free` 由 Kilo 执行并经 OFM 转发。带 EAC/Kilo 前缀的同名模型仍是独立 OFM 转发车道，不互相替换。

外部 Harness 只有在本轮边界和 Token buckets 都能由官方协议确认时才接入 DSH 的 Token 统计；缓存、输入、输出和思考字段缺失时保持缺失，不按上下文占用推算。OpenCode/Kilo 使用同一官方消息图的父级链和 `step-finish` 记录汇总，Pi、Codex、Claude、ZCode 使用各自桥接器的已验证字段；Kimi 只有 transcript steps 能拆出独立 cache buckets 时才记账。ACP `usage_update` 的 `used/size` 是上下文占用事实，和累计 Token 账单分开保存；没有精确 usage 响应时不显示账单统计，也不把上下文占用伪装成 Token 账单。外部 Harness 的上下文占用在官方统计栏下方以独立的上下文读数显示，未知数据保持不显示。

`step-5-preview-free` 与 `muse-spark-1.2-contributor-free` 当前从 OPL 选择器隐藏；Jev 与 Content Safety 不作为编码组合提供。MiMo Code、Muse Code 没有可用默认组合，不默认登记或提示安装，已有程序与显式配置保留。

OPL Gateway 的 Gemini 模型列表使用 `Gemini 4 Argon`、`Gemini 3.8 Flash` 和 `Gemini 3.1 Pro`；在添加组合时推荐 OpenCode，请求仍保留原始模型 ID，不自动加入列表。

MiniMax M3.1 Flash Free 使用正式 ID `minimax-m3.1-flash-free` 与 OpenCode 官方免费通道；Kilo 的 `minimax/minimax-m3.1-flash:free` 是独立的 OFM 转发车道，也使用 OpenCode，不与前者互换。旧 Space Bunny 会话保留原模型身份，不自动替换历史路由。

手动会话的初始标题取真实用户输入，不取交给外部 Harness 的历史上下文说明；CLI 原样回传内部历史说明时不覆盖标题。后续正常标题更新保持生效。

OpenCode 与 Kilo 的显式完全访问会话通过官方 `permission: "allow"` 配置执行工具，该配置只传给本次 CLI 进程；不会改写用户的配置文件。原生 DSH 组合同样支持显式完全访问，并使用官方持久化权限预设。受限权限与已有会话的权限不会因此升级。

经 OFM 本地端点转发给 OpenCode/Kilo 的 Chat 流会合并先到的工具编号与后续函数分片，以兼容官方 CLI 的响应校验；不生成函数名、参数或完成标记。上游返回非 2xx 响应头时，转发器立即把受控的认证、模型、限流、超时或接口失败及 HTTP 状态回传给 DSH，关闭本轮自有连接与 CLI，不等待响应体结束或 CLI 重试。连接中断、流截断或工具分片冲突也结束本轮，但不冒充收到上游 HTTP 状态。原始响应体不写入诊断，晚到的 CLI 输出不能覆盖失败结果。若没有任何可识别的上游错误，OpenCode 在九十秒内没有正文、思考、工具或授权进展时由 OPL 结束本轮；收到首个有效进展后不再使用这个保护时限。兼容进程使用临时回环端口与独立密钥，随 CLI 关闭；直接连接 OpenCode 免费通道和 OPL Gemini 的请求不经过此处理。

Kilo Beam 的工具后续请求要求 `reasoning_content` 字段，即使本次思考为空。该组合使用官方 `interleaved` 配置回传已保存的思考，不补写思考正文或改变推理档位。

这些组合保留 OFM 的原始模型 ID，只有当前目录仍提供的模型才可启动。Free/Auto 虚拟路由保留其虚拟身份，不声称已固定到某个底层模型。程序仍在「执行与组合 → 执行引擎与网络代理」选择安装路径，凭据仍由 OFM 管理。MiMo Code 没有推理档位接口，模型菜单不显示其 provider 的原生档位；托管任务保留提交时的设置，不继承原生请求自动填入的档位。Big Pickle 使用 `our-free-model` 的精确 `big-pickle` 车道和官方 OpenCode 的 `opencode/big-pickle` wire 值；官方 OpenCode 适配器不广告推理档位，组合不显示推理强度，OFM 目录的 light/balanced/deep token budget 不会被映射成 `high`/`max`，显式档位会被拒绝。CLI 内部带 provider 前缀的模型 ID 由适配器显式映射，仍与回读值严格比对。新适配器支持明确选择的完全访问，缺少 Git Bash 时拒绝启动；不自动改变会话权限。Kimi 另可映射官方 Plan 模式，实测 Bash 写入被工具层拒绝，这不代表操作系统隔离。其余新适配器拒绝只读和工作区权限。它们不提供 DSH Auto Review。

Muse Code 1.4.7-R6101.1 使用独占设置中的 `endpoint_transport` 接入模型供应商的 Responses 端点。MSP 桥接负责会话、模型和思考档位回读，Git Bash 通过官方 MCP 工具接口执行；本机认证转发器转换工具命名与流事件，不替换官方执行循环。来源未提供端点或凭据、模型已移除或协议不匹配时拒绝启动。MiMo Code、Pi 和 StepCode 返回空正文且没有成功工具结果时，任务标为失败；官方未回报的上游错误不推测为某个 HTTP 状态。

独占官方 CLI 与受控 provider 检查覆盖工具、模型回读、恢复、取消和 Git Bash；这些检查不等同于 OFM 联网模型质量验收。执行插件配置 `ofmConnectionTimeoutMs` 控制公开连接读取超时，默认 10000 毫秒。

OpenCode/Kilo 的结构化错误类型可区分模型接口请求失败、上下文超限与结构化输出失败。Codex、ZCode 和 ACP 错误回传保留 CLI 明确报告的 HTTP 错误状态、已识别错误类别、RPC 错误码和结束状态；原始消息、响应正文、地址及凭据不进入此诊断。未知内部错误保持未定性；接口失败未提供 HTTP 状态时，不推测为认证或限额问题。

用户停止当前轮次后，即使 CLI 迟到返回 `end_turn`，外部任务仍记为取消；CLI 的原始结束原因单独保留。取消标记先于持久保存和子任务等待建立，后续停止操作不会落到新轮次。Codex 正文同时接收流式增量和官方完成事件中实际返回的文本，重复内容只展示一次；完成事件没有正文时不生成回答。

外部程序的过滤环境保留 Git 安装根目录与显式 `OPL_GIT_BASH_PATH`，即使 Desktop 的 PATH 不含 Git 也能解析后端。显式路径无效时拒绝启动，不改用其他 Shell。

## 能力与验收

每个适配器声明传输、认证、协议、自定义端点、权限、恢复、取消、推理档位和 Auto Review 类型。公开 Harness 检测结果返回这些声明，不包含密钥。声明描述接入接口，实际服务可用性仍由真实调用验证。

`HarnessAcceptance` 复用真实适配器的新建、恢复、模型与推理档位核对、真实工具事件和取消检查。调用者负责进程生命周期、独立读取产物以及向 `observe` 传入 ACP 通知。文本声称执行成功不通过；恢复必须保留会话身份，取消回执必须等待原 prompt 确认取消。

接入具体来源时依次验证：来源与协议负例、真实登录或 Key、真实模型工具调用、新建与恢复、取消、权限与人工审批、Auto Review、失败与卸载。不同 Harness 的协议适配仍需实现，通用注册和验收步骤不能代替这些证据。
Kimi Code 的 OFM 组合通过官方 `KIMI_LOOP_MAX_ATTEMPTS_PER_STEP=1` 限制每步仅发起一次请求，避免将来源层恢复叠加为 CLI 默认的十次尝试。请求失败后由用户决定是否重发；该设置不改变权限或模型。

Kimi 的消息编辑边界读取需要临时断开 ACP 并恢复同一原生会话。轮次完成等待、后续发送和编辑入口读取都会等待该收尾结束，再使用恢复后的连接；收尾期间不能切换执行程序。读取编辑边界失败不会丢弃已经完成的回答，也不会自动重发提示词。

外部请求收到明确终态错误时，也先完成编辑台账持久化与历史收尾，再向对话流和编辑入口发布终态。收尾期间的元数据更新不会提前释放发送或编辑入口；未知传输结果继续阻断，不自动重放。

Pi 在 Windows 通过官方 `--append-system-prompt` 明示真实 Git Bash 语法与路径形式；该说明进入官方 CLI 的系统请求，不切换 Shell、不转换模型命令，也不承诺模型不会写错命令。

OpenCode 内置免费端点启用官方 `--print-logs`。Host 仅将当前在途会话的主推理 `AI_APICallError` 转换为固定失败提示；额度耗尽明确显示，不等待首次进展超时。标题任务、其他会话与普通日志不触发终止，原始诊断不回显。没有错误信号时仍保留无进展保护。

手动停止外部任务保留 cancelled 状态，不把取消引发的连接关闭显示成上游错误。ZCode 的结构化原因链仅提取已知错误类别及 HTTP 状态，不回显响应体。会话输入栏显示本地排队状态；排队时请求尚未发往模型，不能计为模型无进展。Pool 使用 `--settings=路径` 固定单个参数，避免配置路径解析歧义。

执行插件的 `executionLimits` 配置统一约束原生和外部请求：`firstProgressMs` 默认 90000，`idleProgressMs` 默认 90000，单位均为毫秒，设置页保存后对后续执行轮次生效，正在运行的轮次保留启动时快照。计时从实际执行开始，排队不计入；心跳和空更新不延长等待，重试不重置当前轮次预算。工具执行与公开人工等待暂停无进展计时。不设置单轮总时长上限；持续产生有效进展的任务不会因累计运行时间被终止，旧配置中的 `totalMs` 不再生效。无进展截止后停止本轮，不自动重发；未收到明确错误时只报告无进展，不推断上游原因。

模型菜单仅在已确认的执行组合提供可选档位时显示推理设置。组合已停用、目录缺失或预检未完成时，不使用供应商通用档位代替 Harness 能力；旧会话保存的档位不在当前选项中时也不展示为生效值。

普通对话的权限以输入框选择的官方会话权限为准，切换执行组合不会改变权限，组合编辑不再提供重复的权限选项。已有外部轮次仍保留原权限，权限不一致时不会自动扩大；派活接口继续校验显式权限和历史任务限制。

旧组合编号被移除后，若当前目录中只有一个启用的组合与原记录的模型来源、模型 ID 和 Harness 完全相同，旧对话自动接续该组合并恢复原外部会话，保留历史、权限和推理档位。原组合明确停用、匹配不唯一或来源发生变化时，提示用户重新选择，不自动改走 DSH。

普通对话的模型菜单与发送共用 Host 组合选择：优先保留明确绑定，其次使用同来源、同模型的唯一默认组合（包括 DSH）；没有默认项但只有一个启用组合时使用该组合。多个启用组合且无唯一默认项、或仅有停用组合时，发送前要求明确选择。首次发送固定已解析组合，后续修改默认项不改变该会话。菜单不根据模型名称猜测 Harness；外部 CLI 的推理档位不被原生模型投影覆盖。

模型切换与后续发送按同一官方会话串行执行：请求先等最新一次选择落定，再由官方请求流程生成模型参数。切换失败后，后续发送仍会被拒绝，直到用户重新选择成功；切换期间已经生成的旧模型请求也会被拒绝，需明确重新发送，不会自动改用旧模型或重发。

模型选择的官方目录与执行组合目录并行读取；同一目录快照的重叠可用性检查合并为一次。检查完成或失败即释放共享结果，后续刷新仍读取当前状态，不增加目录有效期。CLI 推理能力仍以当前连接或实际预检为准。

外部模型菜单区分官方模型选择保存的档位与 CLI 独立保存的档位。Codex、Claude 和 MiniMax 普通对话将当前官方请求的档位传入真实外部轮次；CLI 档位继续使用会话与组合的独立选择。能力预检等待或失败不清除 Host 已确认的 CLI 档位显示，发送前仍校验实际能力。
