# MiniMax Bash 候选版：构建与选择

当前候选基于官方 npm `@minimax-ai/code@0.7.4`。官方分发文件与账号实现保持原样，OPL 扩展单独存放在 `overlay/`；它使用原生 Git Bash 绑定，并提供 ACP Shell 回读、仅对话历史的编辑、官方登录取消与授权到期处理。M3.1 的实际广告名为 `MiniMax-M3.1-Flash`，不附加 Preview。

## 当前 0.7.4 候选

固定输入在 `scripts/mcode-candidate/distribution.json`，官方文件清单在 `official-0.7.4-files.json`。构建先核对 npm 归档 SHA-512、许可 SHA-256 与逐文件摘要，再安装依赖；依赖安装后重新核对原始文件，生成含便携 Node 的完整清单。清单的 `filesSha256` 是官方文件数组经 `JSON.stringify` 序列化的 SHA-256。

```powershell
node scripts/mcode-candidate/build-distribution.mjs --out "D:/mcode/0.7.4-opl-bash.20261102.2" --archive "D:/downloads/code-0.7.4.tgz" --node "C:/Program Files/nodejs/node.exe" --license "D:/downloads/MiniMax-LICENSE" --proxy http://127.0.0.1:7897
node scripts/mcode-candidate/verify-candidate.mjs --candidate "D:/mcode/0.7.4-opl-bash.20261102.2" --out "D:/mcode/verification"
```

当前构建支持 Windows 与 Node 24–26。许可文件取自固定的官方公开提交；npm 0.7.4 暂无同版本公开源码标签，因此此交付不声称从 0.7.4 源码重新编译。overlay 使用该 npm 包的固定导出；升级版本必须重新核验导出、协议和真实工具，不能只改版本字符串。

选择使用 `control.mjs minimax-candidate-select --version <版本> --source <目录>`，由 Host 核对全项目空闲并保存实际启动器。静态通过后仍需真实 ACP new/load、Git Bash、正式模型和 effort、仅对话编辑及登录流程验收。旧候选保留，可在全项目空闲时重新选择；历史日志不改名或重写。

## 旧 0.6.3 源码构建记录

以下固定输入和命令仅适用于旧源码候选，保留用于复现与回退。

## 固定事实

以下事实写在 `candidate.json`，所有脚本按它失败关闭。改动任何一项都要同时复核脚本检查与本文件。

| 项目                                     | 值                                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方仓库                                 | https://github.com/MiniMax-AI/minimax-code                                                                                                                                                |
| 官方 tag                                 | `v0.6.3`                                                                                                                                                                                  |
| 源码归档                                 | `https://codeload.github.com/MiniMax-AI/minimax-code/legacy.tar.gz/refs/tags/v0.6.3`                                                                                                      |
| 归档 SHA-256                             | `ced0ad86a13b9f6fdd378027b50026c6a80df6481cdf2d9884478d780c94cdae`（27 501 362 字节）                                                                                                     |
| 归档目录名里的 GitHub 修订               | `07a2390`                                                                                                                                                                                 |
| `release/extraction.json` 的内部源码修订 | `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee`                                                                                                                                                |
| 构建链依赖的 npm 包管理器                | `pnpm@9.12.0`（`pnpm install --frozen-lockfile`）                                                                                                                                         |
| Node 引擎                                | `>=22.19 <23 \|\| >=24.2 <27`                                                                                                                                                             |
| 构建链另会下载的归档                     | `https://registry.npmjs.org/@minimax-ai/code/-/code-0.3.11.tgz`，整包 sha512 完整性值与内嵌 `cli.mjs` 的 sha256 都取自官方 `scripts/lib/mcode-tools-artifact.mjs`，两者语义不同、不可互换 |

归档摘要是第一道闸门，解包后还会核对 `package.json` 版本与 `release/extraction.json` 的内部源码修订。**官方 tag 之外的新版本会被直接拒绝**，旧补丁不会被套用到未经复核的源码上。

## 补丁

补丁按职责分成五个，按顺序应用；五个都是必需项（`candidate.json` 里 `required: true`）。

| 补丁                                        | SHA-256                                                            | 涉及模块                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patches/mcode-shell-path-minimal.patch`    | `09a9f0aaf9bc328768596358bc8f84edc7cd26257cf5afa20ac1bcf546203e7e` | `third_party/pi-mono/packages/coding-agent/src/utils/shell.ts`、`packages/tui/src/acp/agent.ts`                                                                                                                                                                                                                       |
| `patches/mcode-shell-path-repo-gates.patch` | `2d800c1c297103f2e4164ffb487436050a4c084a2e3ddc0ccfbfdc3340c2d8a7` | `packages/local-runtime/test/unit/local-bash-shell-path.test.ts`、`test/vitest-suites.json`、`docs/tui-capabilities.md`、`release/public-source.json`、`third_party/pi-mono/MINIMAX_CHANGES.md`                                                                                                                       |
| `patches/mcode-opl-session-history.patch`   | `f1f4f1d148826474028baa4718b2948219cc976dc47aca31f109fca9fdd22b42` | `packages/tui/src/acp/session-history-extension.ts`、`packages/tui/src/acp/agent.ts`、`packages/tui/test/unit/acp-session-history-extension.test.ts`、`packages/tui/test/unit/acp-session-history-agent.test.ts`、`packages/tui/test/unit/acp-agent.test.ts`、`test/vitest-suites.json`、`release/public-source.json` |

- **运行时最小补丁**给官方共用的 Shell 解析函数增加 `MCODE_SHELL_PATH` 选择：必须是存在的绝对可执行文件，否则报错而不回退平台默认；同时在 ACP `initialize` 的 `_meta["minimax-code/shell"]` 里回报 version 1、解析出的可执行文件、参数与 Shell 类型。它只改命令解释器，不改权限模式、审批、沙箱或账号状态。
- **仓库门禁补丁**补齐官方仓库自身要求：新增回归测试、登记到 `test/vitest-suites.json` 的 `capability` 组、把新增文件写进 `release/public-source.json` 公开清单、更新 `docs/tui-capabilities.md`，并在 `third_party/pi-mono/MINIMAX_CHANGES.md` 的本地补丁台账里记录这次 vendored 修改。
- **会话历史补丁**（停止后编辑所需）新增 ACP 会话历史扩展 v1：`opl/session/history/list`、只回退对话上下文的 `opl/session/history/rewind`，以及把 `clientRequestId` 绑定到官方 Runtime 真正接纳的 turn/用户消息的 `opl/session/history/boundary` 通知；同时把两个新增 focused 测试登记进 `capability` 组、登记公开源码清单，并把官方 `initialize` 的严格整体断言更新为包含新增能力（其他断言保留）。它的 `agent.ts` 上下文依赖 minimal 补丁先应用；与 repo-gates 补丁的 `vitest-suites.json` hunk 不重叠，两者顺序无关。回退只回退对话，`rewindTurnDiff` 恒为 false，任何文件回退参数被显式拒绝——磁盘上已写的文件不还原。

许可方面：官方 `LICENSE-STATUS.md` 说明第一方代码默认 MIT，`third_party/pi-mono` 为 MIT（保留原有声明与 `MINIMAX_CHANGES.md`），`third_party/sandbox-runtime` 为 Apache-2.0，且分发物必须保留适用许可文本。构建脚本据此把 `LICENSE`、`NOTICE`、`LICENSE-STATUS.md`、`THIRD_PARTY_NOTICES.md`、`release/dependency-licenses.json` 与两个 `third_party` 的 `LICENSE` 一并放进候选目录的 `licenses/`。

## 用法

三个脚本都可以独立运行；只有构建入口会联网，且只下载两份固定摘要的官方归档。没有任何脚本会安装、覆盖官方安装或发布分发物。

```sh
# 1) 预检：核对摘要、解包、打补丁、写候选版本号、把 mcode-tools 归档放进官方构建读取的缓存、暂存许可文件
#    默认下载两份官方归档；加 --offline 时必须同时给 --source-archive 与 --tools-archive
node scripts/mcode-candidate/build-candidate.mjs --out "D:/opl build/candidate" --system-node

# 2) 预检（离线）：使用本地已校验的官方源码归档，不联网
node scripts/mcode-candidate/build-candidate.mjs --out "D:/opl build/candidate" \
  --node "C:/Program Files/nodejs/node.exe" --offline \
  --source-archive "D:/downloads/minimax-code-v0.6.3.tar.gz" \
  --tools-archive "D:/downloads/code-0.3.11.tgz"

# 3) 真正构建：安装依赖、打包、跑官方门禁，然后组装候选目录
node scripts/mcode-candidate/build-candidate.mjs --out "D:/opl build/candidate" \
  --node "C:/Program Files/nodejs/node.exe" --execute

# 4) 校验已构建的候选目录：布局、清单完整性与摘要、启动器、许可、凭据扫描、
#    外部模块依赖、能力标记，并在隔离数据目录下跑一次入口 smoke
node scripts/mcode-candidate/verify-candidate.mjs --candidate "D:/opl build/candidate/0.6.3-opl-bash.20261010.2" \
  --manifest "D:/opl build/candidate/candidate-manifest.json" --out "D:/opl build/candidate/verification"

# 5) 有界的入口编排自检：用真实官方归档 + 工具链替身，把「构建入口 → 组装 → 验证入口」跑通一次
node scripts/mcode-candidate/self-test.mjs --out "D:/opl build/selftest" \
  --source-archive "D:/downloads/minimax-code-v0.6.3.tar.gz"

# 6) 生命周期（面向交付对象，不重造安装体系）：导入候选、列版本、记录显式选择、升级、切回官方
#    全部离线、不下载 latest、不读账号与用户配置、不执行候选代码；先看计划再执行
#    --active-tasks 必须来自调用方的公开活动状态；下面的 N 是占位符，不要照抄成 0
node scripts/mcode-candidate/lifecycle.mjs verify --source "D:/opl build/candidate/0.6.3-opl-bash.20261010.2" \
  --manifest "D:/opl build/candidate/candidate-manifest.json" --json
node scripts/mcode-candidate/lifecycle.mjs import --source "D:/opl build/candidate/0.6.3-opl-bash.20261010.2" \
  --manifest "D:/opl build/candidate/candidate-manifest.json" --select --active-tasks <N> --dry-run
node scripts/mcode-candidate/lifecycle.mjs list --json
node scripts/mcode-candidate/lifecycle.mjs select --version 0.6.3-opl-bash.20261010.2 --active-tasks <N>
node scripts/mcode-candidate/lifecycle.mjs official --active-tasks <N>
```

以上 `select` / `upgrade` / `official` 只写本目录自己的选择回执，**不会**改变 DSH 的真实运行时选择；真实生效使用下文的 Host 选择命令或 Harness 设置。

启动器使用的运行时来源必须显式，二选一：`--system-node`（用 PATH 上的 `node`）或 `--node <node.exe>`（写进启动器并记录版本与摘要）。两者都不给时入口在创建任何输出目录之前就拒绝。

`--toolchain-shim <脚本>` 用一个替身代替 pnpm 与 esbuild，只用于第 5 条的有界编排自检。替身产物会在计划、清单和验证报告里标记为 `toolchainStubbed`，验证器会拒绝把它当作可分发产物，因此它不能替代真实构建。

输出目录结构：

```
<out>/
  build-plan.json          固定事实、实际使用的补丁与摘要、工具链版本、边界声明
  build-trace.jsonl        每条外部命令的命令行、解析到的可执行文件、退出码、耗时与输出尾部
  downloads/               校验通过的官方归档与 mcode-tools 归档
  work/src/                打补丁后的源码（含官方构建读取的 .cache/artifacts 缓存）
  work/licenses/           暂存的许可与声明
  <candidateVersion>/      --execute 成功后组装的候选目录
  candidate-manifest.json  候选目录内每个文件的字节数与摘要（写在目录之外，不把自己算进去）
```

## 写入与失败边界

- **只写 `--out`**：所有写入都要落在声明的独占目录内；已存在的符号链接/junction 祖先按真实路径逐段规范化，不因为目标路径尚不存在就当作安全路径。
- **受保护目录双向不重叠**：判定为受保护的是下面这些具体位置，`--out` 落在其中、被它包含、或包含它们，都拒绝，没有覆盖开关。
  - 官方数据目录：`~/.minimax`、`~/.minimax-code-data`、`~/.config/mcode`，以及 `MINIMAX_CODE_HOME` / `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` 指向的位置（这些目录只判断路径，不读取内容）。
  - 官方启动器：`~/.minimax-code`，以及**按 PATH/PATHEXT 能解析到的官方 `mcode` 启动器所在目录**。解析只做存在性判断，不读文件内容、不遍历目录、不读任何登录凭据。
  - OPL profile：`OPL_DSH_HOME` 或 `~/.dsh`；套件 Harness 根目录：`%APPDATA%/OPL DSH Suite`、`%LOCALAPPDATA%/OPL DSH Suite`。
  - 用户声明的额外根目录：命令行 `--protect <路径>`（可重复）或环境变量 `OPL_MCODE_PROTECTED_ROOTS`（逗号分隔）。
  - **边界说明**：官方 mcode 可以装在任意自定义位置。脚本不扫描磁盘、不猜测 npm 全局前缀或任意 PATH 目录；**不在 PATH 上、也不在上述默认位置的自定义安装目录，必须由用户用 `--protect` 显式声明**，否则不在这份保护范围内。
- **失败不覆盖**：解包目标非空时拒绝；输出目录已存在时要求显式 `--replace`；`--replace` 把旧目录改名为 `<目录>.previous-<时间戳>` 保留，不做删除。失败时不发布候选目录。
- **入口守卫先于写入**：缺少运行时来源、`--node` 与 `--system-node` 同时给出、`--offline` 缺任一本地归档、替身脚本不存在，都在创建任何目录之前拒绝。
- **路径含空格可用**：所有外部命令都用 argv 数组调用，不拼接命令字符串；Windows 上 `.cmd`/`.bat` shim（例如 `pnpm.cmd`）按 PATH 与 PATHEXT 解析后经 cmd.exe 逐字传参，含空格的参数不会被重新解释。
- **摘要不符即失败**：归档与补丁都按固定 SHA-256 校验，mcode-tools 整包按固定 sha512 完整性值校验，不匹配不做修补或降级。
- **无凭据**：脚本不读取、不复制官方登录目录；组装候选目录后扫描 `auth`、`tokens.json`、`.npmrc` 等凭据文件名，发现即失败。
- **不写系统 PATH**：脚本从不修改环境变量，只打印切换方式。
- **先验失败即零执行**：验证器先跑完布局、清单 schema 与逐文件摘要、启动器、许可、凭据、外部模块闭包、能力标记与工具链替身检查；任一失败都不执行候选启动器，只在报告里记录跳过原因（`executionGate.candidateCodeExecuted=false`）。缺清单、坏清单、篡改启动器、摘要失败、替身产物都属先验失败。
- **拒绝时不留目录**：报告目录与 smoke 隔离数据目录都先验证真实目标再创建；被拒绝时不会留下任何目录。解析路径时若现存祖先无法取真实路径（坏 symlink/junction），直接报错而不是按未验证路径放行。

`lifecycle.mjs` 的边界略有不同，因为它要写的就是套件自有的 Harness 根目录：

- **候选 Store 根目录**允许落在 `%APPDATA%/OPL DSH Suite` 或 `%LOCALAPPDATA%/OPL DSH Suite` 之内（默认 `harnesses/MiniMax Code`），套件根之外的位置必须用 `--allow-root` 显式声明。
- 官方数据目录、`~/.minimax-code`、按 PATH 解析到的官方启动器目录与 OPL profile **一律仍然拒写**，没有覆盖开关；来源候选目录落在这些位置时同样拒绝导入。
- 旧候选目录只改名保留（`<版本>.previous-<时间戳>` / `<版本>.failed-<时间戳>`），从不删除；选择回执原子替换，失败保持逐字节不变。

### Windows 上 tar 的两个坑

构建脚本按 `tar --version` 区分实现：GNU tar 需要 `--force-local`，否则会把 `C:/...` 当成 `host:path` 远程归档；tar 的路径参数一律用正斜杠，因为 Node 的 `path.join` 产生的反斜杠路径会被 GNU tar 当成相对路径并报 `Cannot open`。这两点已在自检中用真实归档复现并修正。

## 选择性使用（不覆盖官方安装）

候选版不写系统 PATH、不改官方安装、不复制官方账号数据。

**先读清楚这条边界**：`lifecycle.mjs` 只维护它自己的**审计回执** `selection.json` 与候选**版本目录**；它**不改变 DSH 的真实运行时选择**——写入回执不会让任何 MiniMax 组合改用候选启动器。DSH 的真实选择使用 Host 的 `oplExecution/select-minimax-candidate`，不读取此回执。离线脚本的 `select` / `upgrade` / `official` 始终只算准备；不能用其结果宣称运行时已经切换。

交付对象按下面的顺序操作：

1. 用官方安装器安装 `mcode` 并完成官方登录（`mcode login` 或 `mcode login --region global`）。
2. **导入候选**（可校验、可 dry-run）：`lifecycle.mjs import` 会先只读校验版本、逐文件摘要、能力标记与许可，全部通过才把候选复制进**版本目录** `%APPDATA%/OPL DSH Suite/harnesses/MiniMax Code/<candidateVersion>/`；同一位置的旧候选目录从不删除。可与 `--select` 组合，一次完成导入 + 记录选择。
3. **记录显式选择**：`lifecycle.mjs select --version <candidateVersion> --active-tasks <调用方注入的活动数>` 写入选择回执 `selection.json`（套件自有位置），并在输出里给出要填进“可执行文件路径”的绝对路径。这一步只写回执。
4. **让选择真正生效**：人工在设置 → 执行与组合 → 执行引擎与网络代理 的 MiniMax Code 卡片里展开“可执行文件路径”，填入该绝对路径（该输入框接受绝对路径或 PATH 中的命令，失焦即保存；绝对路径按“来自执行组合”识别，含空格可用）。也可使用下面的 Host 选择命令，导入校验和执行组合发布在同一维护操作中完成。
5. 候选与官方共用官方登录状态：不要设置 `MINIMAX_DATA_DIR`/`MAVIS_DATA_DIR` 指向副本，也不要复制 `~/.minimax`。

### 由 DSH Host 导入并选择

使用已安装的协作 Skill：

```sh
ELECTRON_RUN_AS_NODE=1 '<配置中的 executable>' '<Skill>/control.mjs' minimax-candidate-select --version 0.6.3-opl-bash.20261010.2 --source 'C:/absolute/verified-candidate'
```

省略 `--source` 会重新校验并选择已导入的版本。Host 固定使用套件 Store；它不下载、不覆盖已有版本、不执行候选代码，校验成功才原子发布 MiniMax 的实际 command 和空 prefix。返回值包含上一个 command/prefix 与当前清单和启动器摘要；`validation: static` 只说明文件检查通过，真实 ACP、模型和 Bash 需要另验。

Host 检查同一运行实例所有项目的运行 Agent、组合轮次和公开 Session 活动；启动、连接、停止后编辑和异步发送的接纳也占用维护互斥。维护期间新的外部启动、发送和原生模型请求明确拒绝，用户稍后重试。MiniMax 的空闲旧连接在下一轮按新的启动参数重新恢复同一原生会话；运行中的任务不会被切换或取消。其他 Harness、代理、权限、模型及历史记录保留。

失败的导入或配置落盘不改变当前 command；新导入版本保留供排查。切回已导入版本使用同一命令。切回官方时在 Harness 设置中恢复原 command/prefix，且必须已安装兼容的官方版本；缺少 Bash ACP 回读的官方 mcode 会在发送模型任务前拒绝，不能把回切配置成功称作官方 Bash 已可用。

### 导入契约（面向他人）

- **先校验后复制**：来源目录先做一次只读校验，复制到版本目录后再对**目标目录**重跑同一份校验。任一失败不出候选、不写选择；复制后被发现的失败目录会改名成 `<版本>.failed-<时间戳>` 保留，不会被选择。
- **五条硬闸门**：① 版本必须是 `<官方版本>-opl-bash.<YYYYMMDD>.<序号>` 且官方基线等于 `candidate.json` 的 `official.version`；② 目录里的 `package.json` 身份必须自洽——包名等于 `candidate.json` 的 `official.packageName`（官方构建链写出的分发名 `@minimax-ai/code`）、包版本等于本次候选版本。只核对清单里的版本字符串，会让「改写 `package.json`、重算全部摘要、保留 `manifest.version`」的候选通过；③ 清单必须覆盖版本目录里的每个文件，路径**不重复**，且每个文件的 SHA-256 **与声明的字节数**都一致（`toolchainStubbed` 的替身产物直接拒绝）；④ 能力标记必须在 bundle 里真实出现——既检查 `minimax-code/shell`、`MCODE_SHELL_PATH`，也检查会话历史的 `opl/session-history`、`opl/clientRequestId`、`opl/session/history/list|rewind`、`opl/session/history/boundary`；⑤ 许可文件必须存在、非空且被清单摘要覆盖。此外还拒绝凭据/账号文件名、目录内符号链接与逃出候选目录的外部原生模块闭包。
  **能力标记只是静态证据**：它证明补丁进了 bundle，**不等于**运行时通过。真实 ACP `initialize` 回读、会话历史接口与真实 Bash 执行不在这些离线检查范围内（`verify --json` 的 `runtimeValidation.verifiedByThisScript` 恒为 false）。
- **摘要完整性不是发行来源认证**：清单与目录内容一致，只证明「这组字节没有被改动过」，**不证明**它来自 MiniMax 官方，也不是签名或可信来源。改写内容后重算摘要同样能得到一份自洽清单。来源认证只能来自官方归档摘要、官方构建链证据与人工复核；本目录不提供、也不声称提供这种认证。
- **启动器是完整模板，不是「包含合法子串」**：逐行比对 `launcherContent()` 的已知模板，只允许运行时那一行变化，且该行必须是 `node`、`"<绝对路径>"` 或 `"%~dp0<候选内相对路径>"` 三者之一，行尾必须是 ` "%~dp0cli.js" %*`。额外插入一行命令、追加重定向或用 `&` 串命令都会被 `launcher-grammar` 拒绝。
- **启动器运行时两种合法形态**：与清单 `nodeRuntime.path` 完全一致（绝对路径或 `system-node`），或引用**候选目录内**的相对运行时（例如自包含布局的 `"%~dp0node.exe"`）。第二种形态要求该文件真实存在、不上跳出候选目录、并且被清单摘要覆盖；声明 `system-node` 却在启动器里写死外部绝对路径同样拒绝。装了一份没有摘要的运行时会被拒绝，不会放过。
- **派生输出路径逐个判定**：`assertStoreRoot` 只证明 Store **根目录**在套件自有位置；版本目录、`verification/` 报告目录、回执文件与暂存/改名目录都是派生路径，它们的**现存祖先**可能是符号链接/junction。每个派生目标在**任何写入之前**都按真实路径重新判定：必须仍在同一个 Store 内，且不与官方安装、官方登录数据或 OPL profile 重叠。把 `<store>/verification` 或某个版本目录预建成指向 Store 之外的 junction 会被拒绝，旧状态保持不变；来源目录别名到 Store 内部也拒绝自我导入。
- **报告与回执原子发布**：先创建独占临时文件，再替换目标目录项；现存报告即使是指向 Store 外文件的硬链接，也不会改写它所引用的文件。最终报告文件和临时文件均先检查真实路径。

- **清单必须描述最终分发形态**。`build-candidate.mjs` 写出的 `candidate-manifest.json` 描述的是**构建产物**：如果之后又把 `node.exe` 打进目录、把启动器改成 `"%~dp0node.exe"`，就必须为这个自包含形态重新生成清单（`nodeRuntime.path` 用候选内的相对路径，`node.exe` 与改写后的 `mcode.cmd` 都进 `files[]`）。否则导入闸门会如实报出 `launcher-grammar`、`launcher-runtime-resolvable`、`manifest-covers-all-files`、`manifest-digests` 失败——这是「没有人对这份字节负责」，不能靠放宽校验绕过。
- **`--replace` 不能替换当前已选择的版本**：替换会把回执里的启动器绝对路径指向被改名的旧目录，因此直接拒绝。替换其他版本时先在 Store 内复制并校验**暂存目录**，通过后才改名发布；发布、写报告或写回执任何一步失败都会把原版本目录改回原位，被拒产物保留成 `<版本>.failed-<时间戳>`，**不会删除原目录**，也不会在同一份结果里既报 `applied:false` 又把原目录留在改名之后。
- **不自动更新、不联网**：`lifecycle.mjs` 没有任何下载参数，`networkUsed` 恒为 false；官方发新版本时它不会自己去取，只有人工复核后重跑构建并导入新版本。
- **不读凭据与用户配置**：脚本不读官方登录目录、不读 Desktop 的 `execution-catalog.json` 或任何 `*.control.json`。当前选择只在它自己的 `selection.json` 里记录；“活动任务数”必须由调用方通过 `--active-tasks <非负整数>` 或 `--activity <公开 JSON>` 注入，脚本不自行探活。

导入后的 Store 布局（`<store>` 默认 `%APPDATA%/OPL DSH Suite/harnesses/MiniMax Code`）：

```
<store>/
  selection.json                      本次选择的审计回执（原子替换；含 preserved 与 history）
  <candidateVersion>/                 版本目录：候选内容 + 复制进来的 manifest.json
  verification/<candidateVersion>/    导入校验报告 import-verification.json
  <candidateVersion>.previous-<ts>/   被 --replace 保留的旧目录（不删除）
  <candidateVersion>.failed-<ts>/     复制后校验失败时保留的目录（不会被选择）
```

### 集成状态（回执 ≠ 真实选择）

**`selection.json` 只是本目录自己的回执。** 它不写 DSH 的运行时配置、不碰用户配置，因此在主审接线之前，它不改变任何 MiniMax 组合实际启动哪个 `mcode`。命令输出里的 `integration` 块与 `注意` 行会明确写出这一点；`list --json` 也会带同样的声明。

之前脚本的回执-only 说明仍适用于 `lifecycle.mjs`；当前 DSH Host 已提供更强的选择入口：`minimax-candidate-select --version <版本> [--source <目录>]` 调用公开 `oplExecution/select-minimax-candidate`，先校验再把实际 `minimax-code` command 原子写入运行目录，并在同一 Host 的所有公开项目上执行活动检查。选择结果返回旧 command/prefix，便于安全回切；设置页的“可执行文件路径”仍显示同一实际字段。`selection.json` 不能替代这个 Host 操作。

### 升级

`lifecycle.mjs upgrade --source <新候选目录> --manifest <清单> --active-tasks <注入值>`：

- 新版本必须**高于**当前选择；不高于时拒绝，除非显式 `--allow-same-or-older`。
- 旧候选目录、旧校验报告一律保留；旧选择追加进 `history`。
- `preserved` 是不透明状态，原样搬运：**代理、模型、权限等调用方设置不会因为一次导入/升级/切回被改写**。
- 当前没有已选候选时 `upgrade` 拒绝，提示先用 `import --select` 完成首次导入。
- 该离线命令只改回执。让版本生效需再使用 Host 选择命令；Host 不覆盖原版本，并在导入、校验或配置写入失败时保留原 command。

### 切回官方

`lifecycle.mjs official --active-tasks <注入值>` 只把选择回执改成官方（`selection.kind = "official"`），候选目录、`preserved`、历史全部保留，官方安装与账号数据自始至终未被修改；真实切回要把“可执行文件路径”改回官方 `mcode.cmd` 或官方安装目录里的绝对路径（通过 `save-catalog` 保存实际执行组合）。

需要预先知道的是：当前适配器在 Windows 上要求 ACP 回读 `_meta["minimax-code/shell"]` 与会话历史接口，官方 0.6.3 不提供这些接口，所以切回官方后 MiniMax 组合会在发送前按设计被拒绝，不会悄悄退回 PowerShell、CMD 或 WSL。命令的输出里也会带这条提醒。只有官方提供等价接口并通过真实回读与真实工具执行验证后，才适合切回或换用新候选。

### 活动任务与失败语义

- **活动任务闸门是调用方断言，不是全局锁**：`select`、`official`、`upgrade` 与 `import --select` 都要求注入活动任务数；缺失即拒绝，不为 0 时同样拒绝（闸门在**复制之前**判定，被拒的切换不会留下用不上的版本目录）。但脚本无法验证注入值是否与真实运行中的会话/任务一致——注入 `--active-tasks 0` **只说明调用方在这一次调用里声称空闲**，它既不是全局活动检查，也不构成「可以安全切换」的证据；在并行活动期间尤其不能当作放行依据。真实活动状态必须由接线方从公开来源提供。
- **失败保留旧选择**：选择回执只在全部检查通过后用临时文件 + `rename` 原子替换；任何一步失败时旧回执逐字节不变。回执损坏、schemaVersion 不受支持或其真实路径逃出 Store 时拒绝覆盖，而不是当成空回执重建。
- **导入是事务性的**：先在 Store 内复制暂存目录、对暂存目录重跑全部校验，通过后才改名发布；发布、写报告、写回执任一失败都会恢复原版本目录，并把被拒产物保留成 `<版本>.failed-<时间戳>`。返回值里 `restored`/`originalRestored`/`rollbackProblems` 如实描述恢复结果，恢复不完整时不会给出干净的 `applied:false`。
- **dry-run**：`--dry-run` 会真实跑完只读校验与闸门判定，列出计划写入（`writes`），但一个文件都不写（`applied: false`）；活动任务数在 dry-run 里也要注入，这样计划与实际执行走的是同一套判定。

### 离线预检的保证范围

`--offline` 需要同时给出 `--source-archive` 与 `--tools-archive`，两份都按固定摘要复核后才使用（`--tools-archive` 摘要不符会在写入官方缓存**之前**被拒）。它保证的是：解包、打补丁、写版本号、放置官方构建读取的 mcode-tools 缓存、暂存许可文件这一段**不发生网络调用**。

它**不包含依赖安装**：`--execute` 的 `pnpm install --frozen-lockfile` 仍需要 pnpm 与包仓库，没有离线保证。

## 验收要求

静态检查（`self-test.mjs`、`verify-candidate.mjs`、`lifecycle.mjs verify`）与离线聚焦测试只能证明补丁进了产物、摘要一致、边界按预期拒绝、回执按预期写入。它们是**本机离线检查，不是 ACP/Bash smoke，也不是真实安装或选择验收**。下列项必须由主审接公开接口后实机验收，静态或离线通过不能替代：

- 候选目录 artifact 与 `candidate-manifest.json` 逐文件摘要一致，清单覆盖目录里每个文件（不漏也不多），`build-trace.jsonl` 记录了真实执行的每条命令。
- 外部原生模块的传递依赖闭包从**各实际依赖方所在目录**解析，全部必须落在候选目录内；落在构建树或仓库 `node_modules` 的包会被判失败。包内容复制时排除原 `node_modules`，同名依赖的不同来源复制到实际依赖方的私有 `node_modules`，相同来源复用可解析的祖先目录；没有指向构建树的链接。当前平台未安装的可选依赖允许缺失。清单的 `placements` 登记每份复制的版本及相对位置；`closureVerified` 保持 false，真实模块加载单独验收。
- 真实 ACP `initialize` 回读 `_meta["minimax-code/shell"]`：version=1、type=bash、同一可执行路径、`args=["-c"]`；新建、跨进程恢复与每次发送前都核对。
- 真实工具执行：真实 Bash 身份与中文/emoji/含空格路径参数、非零退出码、stdout/stderr、取消后清理所属后代进程、超时输出。
- 两个固定模型各自独立进程的 new/load 固定模型参数与 Shell。
- 未改动的官方 Desktop 在隔离数据目录下的安装、五设置插槽加载与重启恢复。
- 生命周期交付还须验证：权威构建到便携目录的精确转换、真实 Host 导入与执行组合、活动任务拒绝、失败保留与显式回切、代理和模型权限保留。单独写回执或注入活动数不能替代这些检查。
- 切回官方的兼容性必须按实际版本验证；当前官方 0.6.3 不满足此适配器所需的 ACP 扩展。
  未做过的检查照实写"未做"，不用固定值或离线结果冒充实机结果。

## 实机验证状态

候选基线为官方 v0.6.3，候选版本为 `0.6.3-opl-bash.20261010.2`。WSL2 Ubuntu 的官方完整 capability 组有 214 个文件、5368 项通过，20 项按原规则跳过；Windows 的完整组仍有 54 项失败，不能称为 Windows 全套通过。Windows 组装使用同一已验收源码和产物；已有本机安装与停止后编辑的真实 ACP 验证记录保留。

便携目录按原构建清单逐文件比对后转换：把已核验的 Node 放进目录、改写启动器并为最终 2041 个文件生成分发清单。没有用重算未知安装目录的摘要替代原构建来源。离线生命周期的 27 项检查覆盖包版本、启动器额外命令、junction 写出 Store、报告硬链接、失败保留与原子发布。

隔离数据目录中的未修改官方 Desktop 已通过 Host 真实导入、执行组合发布、另一项目的原生任务活动拒绝以及无效升级后原选择保留。选择便携目录后，M3.1/max 和 M3/on 各完成一次真实 Bash 新建验收；关闭该隔离 Desktop 后，两者恢复同一 ACP Session，并再次完成内置 Bash 的 sort、Bash 版本和 uname 命令，退出码均为 0。权限为 full-access，项目路径含中文和空格。该验证没有修改官方安装、登录文件或生产 profile。

当前 Host 接线已构建并完成隔离验证，尚未安装到生产 Desktop。不同候选版本的真实模型升级仍需要另一份经过验收的候选；合成版本的行为检查不能替代这一项。现有候选不自动更新，Shell 验收不替代实时界面或通知验收。

## 账号授权取消修正

独立候选 0.6.3-opl-bash.20261024.1 增加 mcode-account-cancel.patch，保留既有 Shell 和会话历史补丁。官方 OAuth 核心发布授权时将本地租约缩短至服务端有效期，避免五分钟授权码在十分钟租约内被继续复用。OPL_MCODE_AUTH_CONTROL=1 启用固定的 stdin 取消消息，CLI 调用官方 cancelLogin 清理自己持有的租约，不执行 logout。stdout 仅向 OPL 发送就绪与剩余秒数，授权 URL 和代码仍在被丢弃的 stderr，不进入界面或日志。未启用该协议的正常 CLI 命令保持原样。

`mcode-monotonic-test.patch` 仅将真实 Bash 等待测试的耗时观察改为单调时钟，保留 60 秒断言和持久时间戳检查，不修改运行时。它避免 WSL 校时使实际 60 秒被测成不足 60 秒。
