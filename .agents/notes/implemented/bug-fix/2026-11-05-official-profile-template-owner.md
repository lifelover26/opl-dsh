# 官方 profile 模板来源

安装器使用实际安装的官方应用所带的 profile 模板。DSH 0.2.1 从 `@deepseek-ai/dsh-app-boot` 导出 `PROFILE_TEMPLATES`，0.2.2 从 `@deepseek-ai/dsh-official-bundles` 导出。安装器按公开导出选择来源，再调用同一官方 `initProfile`；不复制模板、不覆盖已有 profile，也不捕获并跳过模块加载失败。

隔离子进程回归覆盖两种模板来源、真实安装参数和已有 manifest 保留。双平台官方资格仍从官方更新源取得桌面应用，不能通过固定旧下载版本掩盖接口变化。
