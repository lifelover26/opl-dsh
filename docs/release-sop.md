# OPL DSH 稳定发布 SOP

本手册是 OPL DSH 稳定发布的执行入口。它适用于官方 DeepSeek Harness 与 OPL 增强包的联合稳定 Release；不适用于只构建、不公开的本地验证，也不适用于 nightly 或临时预览版。

发布合同、命名和资产要求见[发布约定](release-policy.md)。兼容性检查的覆盖范围和证据字段见[官方桌面兼容验证](compatibility.md)。本手册描述顺序、完成条件和恢复方法；命令必须以当前仓库脚本和 GitHub CLI 的实际帮助为准。

## 1. 完成标准

### GitHub Actions 发布环境

`.github/workflows/stable-release.yml` 每日北京时间 02:37 自动检查主线，并为稳定发布提供临时 macOS arm64 打包环境（Node 24、Python、Apple 工具及 NSIS）、临时 Windows 桌面验收环境和 Ubuntu 公开发布环境。准备与发布 job 使用 GitHub 为本仓库签发的临时 `GITHUB_TOKEN`，仅这两个 job 具有 `contents: write`；不需要把个人访问令牌写入仓库或云环境。

日常增强改动只需让可接受实现进入 `main`；上游单独升级无需额外提交产品改动。每日准备 job 通过 `scripts/prepare-daily-release.mjs` 比较公开稳定 tag 与主线的真实产品路径，同时用 `scripts/official-desktop-feeds.mjs` 读取两平台官方清单，并与 Latest 中校验过摘要的联合清单比较。有未发布增强改动或官方版本变化，就自动准备递增版本、`docs/release-notes-<版本>.md` 和 canonical tag；两者都未变化则跳过。新 tag 注释固定目标官方版本，打包及发布再次核对实际 feed，随后沿原双平台隔离验收与公开回读执行。

`scripts/daily-release-notes.mjs` 依次尝试 Copilot CLI 自动选模型、Gateway `deepseek-flash`、Gateway `gpt-6-luna`、机械说明。调用策略与实现统一归 [Framework 发布说明入口](https://github.com/gaofeng21cn/one-person-lab/tree/main/scripts/release-note-writer)；模型顺序、Gateway 地址、超时、Copilot 版本和预算仅修改其中的 `policy.json`。每次准备先解析中央主线 SHA 并下载同提交的配置和代码到 runner 临时目录，记录策略提交及配置摘要；加载失败直接机械兜底，CLI 安装失败继续 Gateway。凭据仍由本仓 Secret 和 `GITHUB_TOKEN` 提供，job 保留 `copilot-requests: write`。写作输入排除锁文件、生成 RPC 和历史发布说明的 diff；大 diff 按文件提供有界摘录并明确省略，读取失败时仍提供提交正文，模型只能总结证据支持的变化。模型按本次公开 Git 证据和官方版本变化撰写中文用户说明；机械说明保留原始提交与链接，不把提交标题加工成已验证的功能承诺。生成方式保留在 Markdown 标记中，工作流记录调用顺序，维护者已准备的说明保持原样。准备后的源码提交作为后续所有 job 的 checkout ref，各阶段重新核对 tag 与实际源码。

GitHub 的临时 token 推送 tag 不会触发另一轮 push 工作流，因此本轮准备 job 直接将 tag 与源码提交传给既有打包、验收和发布 job，不依赖第二次事件或本机调度。人工推送 canonical tag 仍可启动同一流程。Release Note 中的 `{{VERSION}}`、`{{OFFICIAL_VERSION}}`、`{{SOURCE_COMMIT}}` 由已核验清单替换。手动选择 `main` 立即执行一次每日检查；恢复已冻结候选时选择同一个 canonical tag。

说明写作链可通过 `.github/workflows/release-notes-check.yml` 单独运行云端检查。它使用已发布功能的真实 Git 证据生成预览，同时验证 Copilot 实际调用、Copilot 失败后的真实 `deepseek-flash` 调用、前两层失败后的真实 `gpt-6-luna` 调用和三层均失败后的机械说明；只提供预览与结果 artifact，不准备或发布产品版本。

打包 job 执行源码门禁，生成 macOS DMG、Windows EXE、增强 ZIP 和联合清单；两个验收 job 解压同一 ZIP，用其实际 payload 验收官方桌面，不用各自重建的字节代替。发布 job 检查清洁源码、清单与两平台证据的源提交、套件摘要和官方版本，重新读取官方 feed，然后生成联合资格 JSON 和 `SHA256SUMS`。只有全部通过才创建并公开稳定 Release。

冻结产品源码与资格运行器分别记录。打包、产品源码检查和公开校验仍使用候选 tag 的提交；资格运行器从触发本轮工作流的精确提交独立检出到忽略目录，显式读取同一交付 payload，不改产品 checkout 或安装包。证据的 `sourceCommit`、源树摘要和套件摘要对应产品，`qualificationRunner.sourceCommit` 对应执行验收的脚本，`sourceDirty` 要求构建来源与运行器均清洁。仅修正验收脚本时，主线手动触发可用修正后的运行器继续验收已冻结候选，保留同一个版本与 tag；这不能用于替换产品代码或绕过既有门禁。

若验收发现产品实现需要修正，旧候选不能沿用。保留其 tag 和失败证据，把产品修正、递增的版本与发布说明一起提交主线，建立新的 canonical tag 后走同一完整发布流程；未公开的旧候选不创建 Release，也不改写其源码身份。

公开后逐一下载核验资产、确认 Latest，再更新 Homebrew Cask。主线若已移动，Cask 跟随停止并报告，不覆盖新提交；已经公开的 Release 保留。历史 Release/tag 默认保留，发布流程不自动删除；元数据及操作记录保存为 `release-audit` 工作流 artifact。失败后先读取对应 job、证据和 audit，再按本文恢复；已公开版本的资产不被重建字节覆盖。

以下步骤同时是手动发布和故障恢复的事实检查合同。

一次发布只有在以下事实都成立时才算完成：

1. 主线候选已冻结，工作区和源提交可追溯。
2. macOS 与 Windows 官方 feed 返回同一个官方 DSH 版本；该版本与构建产物、联合清单和验收证据一致。
3. Host/Client、RPC、模块边界、格式、构建和测试全部通过。
4. 未修改的官方桌面在隔离 profile 中完成安装、Client/RPC、模型流、官方工具、重启恢复和官方文件未改变的验收。
5. GitHub Release、tag、五类交付资产、SHA-256 清单和验收记录已公开，且公开下载摘要与本地摘要一致。
6. `releases/latest` 指向本次 Release；安装器和更新器能从该 Release 读取稳定清单。
7. Homebrew Cask（如果本次维护）已指向公开增强包摘要并完成回读。
8. 历史 Release/tag 默认保留；若另行执行用户要求的清理，已记录范围与结果。已安装 profile 的本地不可变 release 目录仍保留。

构建成功、测试通过、tag 已推送、Release 已创建或资产已上传，都只证明对应的一层，不单独构成发布完成。

## 2. 版本与权威来源

### 2.1 官方 DSH 版本

官方桌面的当前版本以两个更新 feed 为准，不以 npm `latest`、网页文案、已安装应用显示或第三方镜像为准：

| 平台        | Feed                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| macOS arm64 | `https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml` |
| Windows x64 | `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`       |

两份 feed 的 `version`、下载路径和摘要必须都可解析，并且版本完全相同。官方 GitHub 仓库的 tag/release 用于核对上游阶段；它可以是 RC，而 OPL Release 仍可使用稳定的 OPL 版本号，但 Release Note 必须明确写出官方版本及其候选状态。不能把 `0.2.0-rc.2` 改写成 `0.2.0`。

使用下面的只读检查确认当前事实；不要把检查结果手写进源码：

```sh
node - <<'NODE'
const feeds = {
  mac: 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml',
  win: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
}
for (const [platform, url] of Object.entries(feeds)) {
  const text = await (await fetch(url)).text()
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim()
  const path = text.match(/^path:\s*>-\s*\n\s+(.+)$/m)?.[1]?.trim()
  const sha512 = text.match(/^sha512:\s*>-\s*\n\s+(.+)$/m)?.[1]?.trim()
  console.log(JSON.stringify({ platform, version, path, sha512 }))
}
NODE
gh api 'repos/deepseek-ai/deepseek-harness/releases?per_page=3' \
  --jq '.[] | [.tag_name, .prerelease, .draft, .published_at] | @tsv'
```

### 2.2 OPL 版本

- 稳定版本使用三段式 SemVer，例如 `0.2.19`；不使用 `-rc`、`-beta` 或 nightly 作为 OPL 稳定版本。
- 版本只递增，不复用，不因为官方 DSH 版本号相同而重复发布相同 OPL 字节。
- `package.json`、`package-lock.json`、Homebrew Cask、Release Note 和联合清单中的 OPL 版本必须一致。
- 官方 DSH 版本与 OPL 增强版本是两个字段，不能把官方版本直接当作 OPL 版本。

### 2.3 联合清单

`dist/release-manifest.json` 是联合版本配对的唯一机器可读权威。它必须绑定：

- `channel=stable`；
- `releaseVersion`、`enhancement.version` 和 `tagName`；
- 两个平台官方 feed 的实际版本、路径和 SHA-512；
- 增强包名称、大小和 SHA-256；
- 构建源提交、源树摘要和验收证据文件名。

`scripts/create-release-manifest.mjs` 会重新读取两个官方 feed；只要平台版本不一致、feed 字段无效或构建基线不同，就必须停止发布。

## 3. 发布前准备

### 3.1 收敛主线

发布操作只从 `main` 的干净工作区开始：

```sh
git fetch origin --prune --tags
git switch main
git pull --ff-only origin main
git status --short --branch
```

若存在其他任务留下的改动，不要覆盖、清理或把它们混入候选。先确认当前发布的源提交、官方版本和 OPL 版本，再决定是否继续。

### 3.2 更新官方依赖

当官方 feed 产生新版本时，先把所有 `@deepseek-ai/dsh-*` 开发依赖更新到同一官方版本，再重新生成 lockfile。不要只更新顶层 `dsh-agent`，也不要保留依赖树中一部分旧 RC。

更新后检查：

```sh
rg -n '"@deepseek-ai/dsh-|0\.2\.0' package.json package-lock.json
npm ci --ignore-scripts
```

如果官方版本没有变化，只能因为 OPL 代码确有用户可见变更而递增 OPL 版本；不要为“重新发布”制造重复版本。

### 3.3 先完成文档和源代码，再冻结

README、兼容说明、Release Note 草稿、安装器、测试和 Homebrew 以外的源代码都必须在构建前完成。`build.mjs` 会把源提交、源树摘要和每个发布文件摘要写入 `artifact.json`；构建后修改这些文件会使候选与当前主线脱节，必须重新构建。

`Casks/opl-dsh.rb` 的公开摘要依赖最终 Release 资产，因此允许在公开 Release 回读后单独更新；它被排除在源树摘要之外，不能反过来作为修改产品字节的理由。

## 4. 构建与资格验收

### 4.1 源码门禁

按以下顺序执行，构建先于 artifact 测试：

```sh
npm run generate:rpc
npm run check:rpc
npm run typecheck
npm run check:boundaries
npm run format:check
npm run package
npm test
npm run release:manifest
```

`npm run package` 会生成：

- `dist/OPL-DSH-Enhancements.zip`
- `dist/OPL-DSH-Installer-mac-arm64.dmg`
- `dist/OPL-DSH-Installer-windows-x64.exe`
- `dist/OPL DSH 一键安装/artifact.json`

`npm run release:manifest` 必须在 `npm run package` 之后执行。检查联合清单中的版本、tag、源提交和官方版本配对，不接受未提交源构建。

### 4.2 官方桌面隔离验收

本机 macOS 使用已安装的未修改官方应用和一次性隔离 profile：

```sh
node scripts/qualify-official-runtime.mjs \
  --app "$HOME/Applications/DeepSeek Harness.app" \
  --payload "dist/OPL DSH 一键安装" \
  --evidence "dist/official-qualification.json"
```

隔离根目录必须由脚本使用 Node 的真实 `os.tmpdir()` 创建，并以 `opl-dsh-accept-` 开头；macOS 的 `/tmp` 可能解析到 `/private/var/...`，不能手写一个路径绕过 runner 的隔离检查。

插件安装使用所选官方桌面 `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`，兼容旧发行包 `runtime/pnpm/bin` 下的 `pnpm.mjs` 或 `pnpm.cjs`，不借用系统 pnpm。失败证据保留隔离 profile 中最多四份包管理器日志的末尾，便于区分官方运行时入口变化与依赖下载错误。

Host 内部 Remote 调用通过统一兼容入口携带官方 Peer：转发时保留调用者身份，后台调用使用官方 connection 创建、随所属 Context 释放的 owner Peer；旧桌面没有该工厂时沿用其内部调用方式。双平台隔离验收覆盖安装后的会话创建、模型请求和工具执行，开发依赖上的类型检查不能替代最新桌面验收。

导入外部 Harness 历史后，使用官方 Workspace 的 `attachSession` 登记原会话；`session.create` 负责创建或复用空会话，不用于接管已有历史。

Windows 的 `--download` 会安装官方程序并写入系统注册信息，只能在临时 GitHub Actions runner 使用；开发机使用 `--app`。发布工作流的 `--download` 会同时验证官方安装包 SHA-512、签名和实际版本。

验收 JSON 必须满足：

- `status=passed`；
- `officialVersion` 与两个 feed、`artifact.json` 和联合清单一致；
- `sourceDirty=false`；
- `isolatedInstallation`、Client、runtime、restart 和 `officialUnmodified` 均通过；
- 官方 Bundle ID、Developer ID/Windows 发布者签名和 `app.asar` 摘要未改变。

本地模拟模型只证明协议、工具和持久化链路，不证明真实 Gateway、凭据、外部模型质量或所有 Harness 组合。API/RPC 通过不能代替 Client 页面可见性和交互验收；两者必须分别记录。macOS 通过不能替代 Windows 结果；Windows 未进入桌面运行验收时，Release Note 必须明确记录。

## 5. 组装发布资产

验收完成后，把证据复制为清单约定的稳定文件名，并从同一 `dist` 目录生成摘要：

```sh
cp dist/official-qualification.json \
  dist/official-qualification-<OPL_VERSION>.json
cd dist
shasum -a 256 \
  OPL-DSH-Enhancements.zip \
  OPL-DSH-Installer-mac-arm64.dmg \
  OPL-DSH-Installer-windows-x64.exe \
  release-manifest.json \
  official-qualification-<OPL_VERSION>.json \
  > SHA256SUMS
cd ..
```

发布目录只能包含五类交付资产和一份摘要清单：

| 文件                                        | 用途                       |
| ------------------------------------------- | -------------------------- |
| `OPL-DSH-Enhancements.zip`                  | OPL 增强包和安装器 payload |
| `OPL-DSH-Installer-mac-arm64.dmg`           | macOS 一键安装器           |
| `OPL-DSH-Installer-windows-x64.exe`         | Windows 一键安装器         |
| `release-manifest.json`                     | DSH 与 OPL 的联合版本清单  |
| `official-qualification-<OPL_VERSION>.json` | 官方桌面隔离验收证据       |
| `SHA256SUMS`                                | 上述文件的摘要清单         |

`SHA256SUMS` 只记录最终上传的文件名和摘要。不要上传临时 tarball、旧版本 artifact、含凭据的 profile 或完整隔离目录；截图只有在能解释验收结论时才作为额外资产上传。

## 6. 创建并公开 Release

### 6.1 先固定 tag 和正文

Release tag、名称和正文必须完全遵守[Release Note 模板](release-notes-template.md)。以下命令中的尖括号是占位符，执行前必须替换为本次候选的实际值：

```sh
VERSION=<OPL_VERSION>
TAG="opl-dsh-v$VERSION"
git tag -a "$TAG" -m "OPL DSH v$VERSION"
git push origin main "$TAG"
```

发布正文写入临时文件后回读，确认官方版本、OPL 版本、验证结果和限制没有套用上一版。GitHub 页面已展示 Release 名称，正文从联合版本说明开始，不重复 Release 标题。不要使用自动生成的 GitHub Release Notes 代替联合说明。

已发布正文的重复标题可用 `Normalize release notes` 工作流修正。它只删除 Latest 正文开头与 Release 名称相同的标题，保存修改前后的审计记录，并回读确认 tag、Latest 和资产标识及摘要未改变；不会重新打包或发布新版本。

### 6.2 创建稳定 Release

必须显式设置稳定和 Latest 标志，并使用已存在的 tag：

```sh
gh release create "$TAG" \
  dist/OPL-DSH-Enhancements.zip \
  dist/OPL-DSH-Installer-mac-arm64.dmg \
  dist/OPL-DSH-Installer-windows-x64.exe \
  dist/release-manifest.json \
  dist/official-qualification-"$VERSION".json \
  dist/SHA256SUMS \
  --verify-tag \
  --title "OPL DSH v$VERSION" \
  --notes-file <release-notes.md> \
  --latest
```

上传或发布结果未知时，先只读读取 Release、tag 和资产列表；确认没有创建成功前不得重新执行创建命令。若已创建 draft，沿用同一个 tag 补齐资产并发布，不新建第二个 tag。

## 7. 公开回读与跟随渠道

### 7.1 Release 回读

公开后必须从 GitHub 下载每个资产，而不是只检查本地文件：

```sh
gh release view "$TAG" --json tagName,name,isDraft,isPrerelease,publishedAt,assets
curl -fsSL "https://github.com/gaofeng21cn/opl-dsh/releases/latest" \
  -o /dev/null -w '%{url_effective}\n'
mkdir -p /tmp/opl-dsh-release-"$VERSION"
cd /tmp/opl-dsh-release-"$VERSION"
for file in SHA256SUMS release-manifest.json \
  OPL-DSH-Enhancements.zip \
  OPL-DSH-Installer-mac-arm64.dmg \
  OPL-DSH-Installer-windows-x64.exe \
  official-qualification-"$VERSION".json; do
  curl -fsSLO "https://github.com/gaofeng21cn/opl-dsh/releases/download/$TAG/$file"
done
shasum -a 256 -c SHA256SUMS
```

回读必须确认：`isDraft=false`、`isPrerelease=false`、tag 是 canonical tag、`latest` URL 指向本次 tag、所有资产名称/大小/摘要与清单一致。联合清单的 `tagName`、`releaseVersion`、官方 feed 和增强包摘要还要重新解析。

### 7.2 Homebrew Cask

公开 Release 的增强包摘要回读后，才更新 `Casks/opl-dsh.rb` 的 `version` 和 `sha256`。Cask 只能指向已公开的 `OPL-DSH-Enhancements.zip`，提交并推送后执行本地语法和 URL/摘要检查：

```sh
ruby -c Casks/opl-dsh.rb
curl -fsSL "https://github.com/gaofeng21cn/opl-dsh/releases/download/opl-dsh-v<VERSION>/OPL-DSH-Enhancements.zip" \
  | shasum -a 256
```

Cask 失败不回滚已经公开的 Release；修复 Cask 后重新回读即可。

### 7.3 安装器和自动更新

稳定发布必须实际验证两个用户入口：

- 首次安装：`install.sh`/DMG/EXE 能读取 `releases/latest`，校验 `SHA256SUMS`、联合清单、canonical tag 和 payload 文件后再安装。
- 已安装用户：Host 在启动后及每六小时读取 GitHub latest；通用设置可手动检查和关闭自动检查。检查只下载元数据与清单，显式准备后才下载增强包。维护入口只在所有 profile 已退出时安装待更新包；取消、活动 profile、版本不匹配及摘要失败不得替换当前安装。原安装和目标包的安全更新协议必须均为版本 1，否则使用完整安装包。

OPL 插件加载后即可发现新版本，套件入口负责退出后的安装。官方桌面继续由 DeepSeek feed、SHA-512、签名和版本检查负责升级；这两个更新责任必须在 Release Note 和用户文档中分开说明。

## 8. 可选的历史版本清理

历史 Release 与 tag 默认保留，本节不是发布门禁。仅在用户明确要求清理并指定范围时，先确认新 Release 已完成公开回读，再列出当前公开版本：

```sh
gh release list --limit 20
git ls-remote --tags origin
```

确认 Latest 指向新 Release 且待删版本属于用户指定的范围后，再删除对应旧 Release 和关联 tag：

```sh
gh release delete opl-dsh-v<OLD_VERSION> --cleanup-tag --yes
```

删除前保存必要的 Release/tag 元数据和资产摘要到临时目录，供本次操作恢复和审计；不把临时目录上传为新的公开历史。不要删除当前 tag、源码提交、已安装 Suite 的本地 `releases/<suiteSha256>`，也不要为了清理旧版本删除用户 profile、凭据、会话或自定义 Skill。

## 9. 失败恢复

| 断点                                      | 处理方式                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 官方两个 feed 版本不一致                  | 停止发布，记录两端版本和路径；等待官方 feed 收敛或明确选择可验收的共同版本，不能手填清单。                                  |
| `npm ci`、类型、RPC、边界、格式或测试失败 | 修复源代码/依赖后重新从源码门禁开始；不要复用旧 artifact。                                                                  |
| package 后发现源代码或文档改变            | 重新构建、重新生成清单、重新验收；不能只替换 `artifact.json`。                                                              |
| 官方隔离验收失败                          | 定位最深失败检查；macOS/Windows 分开记录。未通过的平台不能写成通过。                                                        |
| 上传/发布结果未知                         | 只读回查 Release、tag、资产和 latest 指针；明确已有对象前不重试公开 mutation。                                              |
| 资产摘要不一致                            | 保留当前公开 Release，先确认是否下载损坏、资产混入旧候选或清单错配；修复候选后按同 tag 修复流程处理。                       |
| Homebrew 摘要更新失败                     | Release 仍可保持已公开状态；只恢复 Cask，回读公开资产后再提交。                                                             |
| 用户更新失败                              | 保留当前本地 release 和 profile，读取 `enhancement-update.json`；网络、运行中 profile、版本未变和校验失败不能触发强制覆盖。 |
| 清理旧 Release 结果未知                   | 先查询旧 tag、Release 和 latest；确认删除状态后再继续，不能盲目重复删除或创建新 Release。                                   |

## 10. 发布记录

每次发布在最终回复或关联记录中保留以下最小事实：

- OPL 版本、官方 DSH 版本、canonical tag、源提交；
- 源码门禁和官方资格证据文件名；
- Release URL、Latest 回读结果、资产摘要校验结果；
- macOS/Windows 各自的验收状态和明确缺口；
- Homebrew 状态；
- 历史版本保留状态；如用户另行要求清理，记录范围与结果；
- 未完成项、解除条件和是否需要下一次发布恢复。

不要用“已构建”“CI 通过”“已上传”“已排队”代替公开可用；也不要把本机模拟模型、单个平台通过或 GitHub 页面可见误写成全平台稳定验收。

## 11. 发布前后快速清单

### 发布前

- [ ] 官方两个 feed 版本一致，官方阶段已核对。
- [ ] OPL 版本递增，`package.json` 与 lockfile 一致。
- [ ] 主线干净，文档和源代码已冻结。
- [ ] RPC、类型、边界、格式、构建和测试通过。
- [ ] package、联合清单和官方隔离验收通过。
- [ ] 五类交付资产、验收记录和 `SHA256SUMS` 已由同一候选生成。

### 发布后

- [ ] tag、Release 名称、正文和清单一致。
- [ ] Release 非 draft、非 prerelease，Latest 指向正确。
- [ ] 公开下载资产逐一通过 `SHA256SUMS`。
- [ ] 安装器和已安装更新路径的校验边界保持不变。
- [ ] Homebrew Cask 已跟随公开摘要，或明确记录未完成。
- [ ] 历史 Release/tag 已保留；如另行执行用户要求的清理，范围与审计记录齐全。
- [ ] 最终记录包含各平台证据、限制和真实缺口。
