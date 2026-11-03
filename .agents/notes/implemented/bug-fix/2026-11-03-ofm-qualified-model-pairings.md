---
title: OFM 精确车道配对与 DSH 推荐
kind: bug-fix
status: implemented
---

OFM 的带前缀 ID 与同名裸 ID 是独立车道。新增 EAC OpenCode 配对保留完整模型 ID，通过来源的公开连接解析转发地址和凭据，不加入 OpenCode 直连免费模型表。Pi 的 Inkling 和 Gemma 使用各自的模型及配置入口，模型是否仍在目录中由 OFM 实时状态决定。

新模型发现对精确登记的 EAC DeepSeek V4.1 Flash 推荐 DSH。通用 DSH 适配器可以接受未知模型，但这种能力不构成已登记推荐；其他未知条目继续显示手动尝试。新增推荐不自动启用组合，不改变用户已保存的停用选择，也不替换历史会话的模型或来源。
