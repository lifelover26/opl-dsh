# SuperAgent 测试按平台能力执行

Windows 运行 SuperAgent 的共享逻辑、文档与 Git 配置语义检查。依赖 POSIX 信号、权限位、服务脚本或可执行 Shell wrapper 的用例仅在 Linux/macOS 执行；目录别名用 Windows junction 验证。配置解析测试独立于 POSIX 启动准备，路径和 Git 配置断言遵循本机解析结果。

Windows 官方兼容与发布资格任务运行共享测试，Linux/macOS 保留完整测试。此范围不新增 Windows SuperAgent 启动入口。Claude 推理档位测试在同一会话验证 high/max 两轮及其持久化记录，读取记录时直接使用会话存储，避免额外探测整个执行组合目录。
