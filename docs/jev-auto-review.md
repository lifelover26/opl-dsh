# Jev Auto Review 决策模型

在 **设置 → 执行与组合 → 审查模型路线** 中启用 OPL 路线适配，选择 **决策模型 → OpenCode · Jev / Jev 1.13 Free**，保存后用于选择 Auto 权限的 DSH 或 ZCode 会话。现有审查路线不会自动切换，保存也不改变会话权限。

这条路线使用 OpenCode 官方公布的 `https://opencode.ai/inference/systemone/v1/systemone`，模型为 `jev-1.13-free`，免费入口无需个人 API Key。Jev 接收冻结的审查策略、授权历史及待执行动作，返回固定选项、概率和置信度。它没有聊天、工具执行或推理档位接口，因而不出现在普通聊天或独立 reviewer 列表中。OFM 的同名聊天条目也不能作为审查路线。

适配器检查模型标识、选择类型、全部选项的概率、概率总和和最大项；允许结论还要求所选项概率与置信度都至少为 0.9。不确定选择、低置信度、字段缺失、矛盾结果、HTTP 错误和取消均不放行。已有的持久授权、新鲜度、超时、下游检查与审核记录仍由 Auto Review 负责。置信度阈值不能代替这些检查，也不代表已证明误放行率。

免费服务可能限流或调整开放范围；审核失败时不会借用其它账号、伪造客户端身份、重发动作或改用其他模型。此路线直接使用 System One 协议，不要求 OFM 实现该协议，也不使用 OpenCode CLI 来执行审核工具。

默认测试使用本地固定响应验证解析与失败路径。设置 `OPL_JEV_LIVE=1` 后可单独运行 `tests/auto-review/jev-live.spec.ts`，用合成的本地读取、精确授权删除、未授权删除、敏感外传及不可信授权内容验证真实接口；只向模型描述动作，不执行这些动作。少量合成案例是接入验证，不是完整的安全效果评测。

接口依据：[OpenCode Jev 文档](https://opencode.ai/v2/docs/console/models/#jev)、[TypeSafe Choice 响应](https://docs.typesafe.ai/primitives/choice)。

## 个人 TypeSafe API

在“设置 → 模型供应商”添加 **TypeSafe · Jev** 并保存自己的 API Key，然后在审查模型路线的“决策模型”下拉列表选择 **TypeSafe · Jev / Jev 1.13 · 个人 API**。密钥仅保存在 Windows Credential Manager 的 `OPLDSH:TypeSafeJev:ApiKey`，不保存到配置文件；未配置或无法读取密钥时不展示此路线。不支持 Windows Keyring 的平台不提供个人密钥存储。

个人路线固定调用 `https://api.typesafe.ai/v1/systemone` 和稳定版本 `jev-1.13.0`，按个人 TypeSafe 账户额度使用，与无需个人 Key 的 OpenCode 免费路线分开。删除密钥后路线撤下，在途请求发送前仍重新读取密钥；不会自动切换免费接口、环境变量或明文凭据。已发出的请求不能通过删除本地密钥撤回。

接口与版本依据：[TypeSafe System One](https://docs.typesafe.ai/api/system-one)、[官方模型列表](https://docs.typesafe.ai/models)。个人账户真实调用需要先在设置中保存有效 Key；本地固定响应测试不代表账户额度与实际连通性已验证。
