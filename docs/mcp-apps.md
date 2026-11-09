# Agent 原生应用与 MCP Apps

OPL DSH 使用官方 DSH 会话、工具、MCP 连接与审批。Agent 可调用已配置 MCP 服务的业务工具，并读取其结构化结果。OPL 增强层当前提供 `inspect_mcp_app_host` 诊断入口；嵌入式标准 MCP Apps 渲染尚未接通。

## 当前可用路径

`inspect_mcp_app_host` 可不带参数读取 OPL 的展示能力，也可传入已在当前对话发现的精确 `toolName`。它按调用 Agent、当前 step admission 和官方工具限制回读该工具是否可调用，并列出同一作用域的资源读取工具。它不调用业务工具、不启动服务器、不打开链接。

诊断读取实际运行环境可解析的官方 MCP bridge 版本。无法取得版本时返回 `unavailable-version`，不能据此判断 profile 未安装；遇到未验收版本返回 `unverified-version`，不会沿用旧版缺口结论。它只描述 OPL 增强层，不能代替其他已安装 UI 插件的能力验收。

无嵌入式 UI 时，Agent 继续使用原 owner 的工具及结果。owner 的已执行结果如提供浏览器或专业应用入口，可将该精确引用交给用户。重新查看任务、编辑冲突或未知写入结果须使用原对象、revision 和 owner 查询入口；不能为重开 UI 重发发送、发布、应用或部署操作。凭据继续由原 provider/carrier 保管。

## 官方公开接口缺口

当前开发 cohort 是锁文件固定的 `@deepseek-ai/dsh-mcp-client` / `dsh-mcp-resources` `0.2.2-rc.1`。`tests/mcp-apps/host-status.spec.ts` 通过未修改的官方插件连接合成 stdio MCP 服务，验证以下实际行为：

- 初始化没有协商 MCP Apps 扩展能力。
- 上游工具 `_meta.ui.resourceUri` / `visibility` 没有进入公开 ToolDefinition；结果 `_meta` 也未保留。
- 业务 `structuredContent` 与同连接的 `resources/read` 仍可用。

官方 `McpResourceRuntime` 公开 `register`，读取经作用域资源工具分派；没有可供 AppBridge 取得同一连接的公开授权端口。仅凭工具名称或 UI 提交的 server/package ID，不能重建服务器权属与 app-only 工具权限。当前没有新增一套连接、会话、凭据或审批机制。

后续启用薄宿主的前提是官方或受支持插件提供：同连接的 MCP Apps capability negotiation、保留服务器 UI 元数据和 visibility 的发现、绑定 Agent/server/connection generation 的资源与工具分派。届时通过官方 Cordis 生命周期、tool slot 和 ext-apps AppBridge 接入，UI 调用仍经过官方审批。重新验收 Framework `ui://opl/apps.html` 与 Relay 原资源的精确对象、重开、旧 revision、撤权、未知结果和无 UI 路径；源码或协议测试不替代官方桌面隔离验收。

本地和发布验收方法见[官方桌面兼容验证](compatibility.md)。
