# Codex Git Bash 运行时

Windows 可以为 Codex CLI 显式选择套件拥有的 Git Bash 构建。默认仍使用已配置的官方 Codex CLI；选择候选不会修改官方程序、日常 Codex 配置或会话权限。

当前候选为 `0.169.0-opl-gitbash.20261116.1`，由 `rust-v0.169.0` 加公开补丁构建，仅支持 Windows x64 与完全访问任务。它是未签名的自建开发版本，不是 OpenAI 发布包。Git for Windows 必须已安装；每次建立或恢复会话都检查实际 Bash，失败拒绝发送模型请求，不回退 PowerShell、不提升权限。

## 打包、导入与回切

下载 [Windows x64 便携候选包](https://github.com/lifelover26/opl-dsh-1/releases/download/codex-gitbash-0.169.0-opl.20261116.1/codex169-win-x64.zip)。ZIP 的 SHA-256 为 `bd1264600718253b187a0bfa42e2f06a49403d15c3d17b426dae55b6debd6f97`。解压后选择内含 `manifest.json` 的目录。无需自行编译，也不要以官方 npm 包替代自建候选。已有 0.160.1 用户可继续使用原版本。

`node scripts/codex-candidate/package-candidate.mjs <已验收 codex.exe 的绝对路径> <新的包目录>` 生成便携目录。目录包含可执行文件、固定构建清单、许可证和完整补丁。清单固定二进制 SHA-256，不接受导入方自行重算的清单。额外文件、错误版本、符号链接和 junction 均拒绝导入。

通过安装后的协作 Skill 执行 `control.mjs codex-runtime-select --mode git-bash --version 0.169.0-opl-gitbash.20261116.1 --source <便携目录绝对路径>`。该命令把候选复制到 profile 自有版本目录，校验后原子保存选择。已有同版本文件只能重新核验，不能覆盖。省略 `--source` 可以重新选择已导入版本。

`control.mjs codex-runtime-select --mode official` 恢复选择前的官方命令及前缀。全项目有活动任务、人工等待或在途启动时拒绝切换。导入或保存失败保留原选择；切换不迁移或删除既有会话。命令需要按 Skill 的 Electron Node 启动方式运行。

静态哈希校验只证明文件与已验收包相同；正式验收还须检查真实启动、Bash 外部工具、模型身份、新建与恢复、失败保留和回切。Auto Review 继续由实际 Codex app-server 回读决定是否可用，不能由 Git Bash 构建身份推定。
