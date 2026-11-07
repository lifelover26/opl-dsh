# 模块化与维护改造

本次保留一个仓库、一个增强包、一次安装与统一版本管理，把 Gateway、执行、协作和首启拆成可独立挂载的内部功能插件。官方 DSH 继续负责桌面、模型运行循环、工具与权限；OPL 不引入另一套框架或会话格式。

## 已落地的调整

| 原有维护问题                                  | 实现结果                                                            | 主要位置                                             |
| --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Host、Client、契约和装配混放                  | 按能力分目录，内部区分 host/client/contracts；装配与兼容层独立      | `src/suite`、各功能目录、`src/compat`                |
| 页面共用账户或通用控制入口                    | 独立类型化 Remote；模型写操作归 Gateway，执行操作归 Execution       | `src/generated`、各功能服务                          |
| RPC Schema 和声明手工同步                     | 官方 Typert 生成器从源码生成，CI 检查漂移                           | `scripts/generate-rpc.mjs`                           |
| 可选服务访问使整个插件加载失败                | 必需依赖明确 inject，可选 Remote 使用官方 get；真实 Cordis 装配回归 | `src/shared/client/remote-call.ts`、`tests/client`   |
| 执行器启动细节集中在主服务                    | DSH、Grok、Codex、Claude 分别适配；模型目录投影独立                 | `src/execution/host/adapters`、`execution-models.ts` |
| 反馈状态、持久化、投递集中                    | 拆成事件事实、状态决策、回执与投递模块，保留单一编排者              | `src/collaboration/host/feedback`                    |
| 每次保存或刷新完整会话历史                    | 按会话文件保存变更；列表与任务卡片用摘要，详情与历史分页            | `session-store.ts`、`contracts/views.ts`             |
| 最终状态在正常关闭时可能漏存                  | 先更新状态与时间再保存；关闭等待任务收尾并重试未落盘记录            | `src/execution/host/harness.ts`                      |
| 安装目录、profile、Skill 账本混淆             | 统一路径解析和 v3 回执；升级、回滚、启动显式传递原 profile          | `installer/installation-paths.mjs`                   |
| 更新状态读取错误目录，修复 Skill 改变账本位置 | 设置读取 Suite 状态，保留既有 Skill 修改和账本位置                  | `src/collaboration/host/settings.ts`                 |
| 官方 UI 适配散落、样式未随插件释放            | 必要适配集中 compat，移除导航文字匹配观察器，样式随生命周期释放     | `src/compat/client`、`build.mjs`                     |
| 运行时依赖、构建来源不清楚                    | 从构建元数据提取官方 peers，记录源码与发布文件摘要                  | `build.mjs`                                          |
| 仅构建和单测不足以覆盖官方桌面                | 添加隔离桌面资格脚本与 macOS/Windows 工作流                         | `scripts/qualify-official-runtime.mjs`               |

模块依赖、开发命令、数据位置和恢复方式见[开发与验证](development.md)。兼容资格的执行方式及证明范围见[官方桌面兼容验证](compatibility.md)。

## 明确保留的边界

- 主执行服务保留会话生命周期、授权和任务调度的统一所有权；不为了行数拆出多个状态负责人。
- 旧外部控制 API 作为兼容入口，内部转发到同一生成契约；新 Client 不再使用它。
- 旧会话文件保持原样，完成一次性迁移后只写新布局。回滚旧插件前需保留当前 profile，旧文件不包含迁移后新增变更。
- 稳定频道的 Latest 指向最新联合 Release；历史 Release 和 tag 默认保留，清理仅在用户明确要求时单独执行。已安装 profile 使用本地 Suite 的不可变 release 目录，不依赖 GitHub 历史资产。
- 官方桌面使用自身更新机制；OPL Host 检查正式 Release，通用设置管理检查与准备，套件启动入口只在退出后安装用户已确认的增强包。
- 本次本地交付不自动发布、推送或升级日常使用的 profile。Windows 与真实外部模型的结果按实际证据报告，不用本机模拟资格代替。
