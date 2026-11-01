# SuperAgent 仓库协作

OPL DSH 随套件提供 [DeepSeek SuperAgent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)，版本 `0.1.0`，固定源码提交 `6337fc823ce20251c8de8085948165c81aaa701e`。本版官方桌面与开发 API 均为 `0.2.1-rc.5`，上游仍属候选阶段。

## 使用

macOS 打开 **设置 → 协作与自动化 → SuperAgent 仓库协作 → 打开 SuperAgent**。首次准备插件后会打开独立官方桌面；点击侧栏 **Superagent** 进入原版管理面板。

1. 在独立窗口配置模型，可使用 OPL Gateway 或官方模型来源。日常窗口的登录与会话不会复制进来。
2. 在 SuperAgent 的 GitHub 来源中填写一个 `owner/repo` 和机器人专用 `gh` wrapper。机器人账号需要该仓库写权限；wrapper 使用独立的 `GH_CONFIG_DIR`，先由用户完成 `gh auth login`。
3. 在授权策略中选择允许请求工作的成员、团队规则和主动评估方式；在执行设置中配置工单目录、工作目录准备命令与并发数。
4. 需要飞书时，在官方插件管理中启用 `dsh-superagent-feishu`，再在其来源页配置仅允许 bot 身份的 `lark-cli` wrapper。

首次未配置仓库时，面板显示等待设置；不会用当前个人 GitHub 账号自动接单。任务运行使用上游完整访问执行预设，账号 wrapper 负责选择身份，独立 profile 不等于操作系统账号隔离。具体账号与策略说明见[上游部署指南](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/006-deployment.md)。

## 继承的能力与维护边界

| 用户任务                                             | 实现与状态负责人                 |
| ---------------------------------------------------- | -------------------------------- |
| 从 GitHub Issue、PR、通知和可选飞书会话接收请求      | 原版 GitHub／飞书 Source         |
| 判断授权、评估主动工作、接受或忽略请求               | 原版 Policy、Eval 与主 Session   |
| 工单、关联线程、工作目录、并发、续作、停止与人工处理 | 原版 Ticket、Executor 和管理面板 |
| 进展、结果和原会话回复                               | 原版回传队列与收据               |
| 提示词、团队规则、Source Skill、设置历史             | 原版版本化存储与编辑界面         |
| 模型、工具和会话执行                                 | 官方 DSH Session／Agent          |
| 构建、安装、独立启动与更新                           | OPL 套件交付与协作入口           |

OPL 保留原版完整管理面板，只在日常协作设置增加一个打开入口。仓库、账号、策略和工单不复制到 OPL 协作任务表。源码与本地适配记录位于 `vendor/dsh-superagent`，MIT 许可随 bundle 分发。

## 数据与更新

独立实例位于安装回执 `suiteRoot` 下的 `superagent/`：`home/` 保存官方 profile、模型登录与会话，`state/` 保存 SuperAgent 数据库、账户 wrapper 和工单目录，`electron/` 保存独立窗口数据。用户自定义 `stateDir` 后，以原版插件设置为准。备份应同时包含独立 profile 和实际状态目录。

窗口运行时再次点击会提示切换到已有窗口，不安装更新。关闭独立窗口后再次打开，入口从当前 OPL 安装回执读取已验证的 bundle，保留用户配置与数据库并更新插件。独立窗口不运行日常 profile 的自动更新器。升级或回退前先备份状态；上游数据库不支持降级到较旧 Schema。

本版入口支持 macOS。上游账户 wrapper、执行命令和目录校验依赖 POSIX；Windows 仍提供其他 OPL 功能，SuperAgent 按钮显示支持范围。外部 GitHub／飞书收发需要用户完成对应机器人账号与授权配置。
