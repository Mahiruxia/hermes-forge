# Hermes Forge Capability Matrix

当前基线：Forge 0.2.31 / Hermes 0.21.3，Electron + React + TypeScript。

| 能力 | 当前形态 | 边界 |
| --- | --- | --- |
| 聊天、附件、恢复和搜索 | 主入口 | 成功、失败、取消各有明确终态；保留官方工具历史。 |
| 工作区 | 项目与空间合并 | 旧项目分组仍可用于会话筛选。 |
| 技能与记忆 | 合并入口、按需加载 | 官方文件和数据保留。 |
| 模型与设置 | 设置中心 | 安装、健康、诊断集中；高级设置包含 Profile。 |
| 工具审批 | 官方回调 + 主进程审批 | 按官方允许范围展示 once/session/always/deny，取消与超时拒绝；官方永久策略由 Hermes 管理。 |
| 澄清问题 | 双向 JSONL + 单总线 | 请求 ID 与 taskRunId 路由，支持单选、多选、多题和自由回答。 |
| 会话数据 | 官方 SessionDB | 查询只读，数据库错误明确返回；清空换新映射，导出真实消息。 |
| 消息连接器 | 可选扩展 | 默认关闭；微信、QQ、飞书等按配置启用，飞书可独立实例。 |
| 定时任务 | 可选扩展 | 可独立调度；关闭时暂停 Forge Gateway 的自动调度，保留任务文件。 |
| 桌面自动化 | 可选扩展 | Windows 自动化入口按需展示，命令遵循权限配置。 |
| Gateway 状态 | 进程事件、状态文件与缓存 | 被动读取不启动 CLI；完整检查由显式刷新触发。 |
| 安装与升级 | 官方固定 SHA、原地同步 | 同一受管 Python；不自动备份或 stash；失败可重试。 |
| 客户端更新 | electron-updater | 本轮只生成本地安装包，不发布 GitHub Release。 |
| Windows | 主要验收平台 | 本机结果见验收记录。 |
| macOS | 原生策略和 CI | 本轮未提供 macOS 真机，不能据此宣称实际包已验收。 |
| WSL | 迁移入口 | 不作为新任务运行路径。 |
| Kanban | 移除客户端页面及专属 IPC | 不删除已有官方任务数据。 |
| 离线包冒烟 | --smoke-test | 隔离 userData，真实 Renderer/preload/IPC/SQL WASM，不依赖模型或 Hermes 安装。 |

Hermes 是唯一执行引擎，task:event 是唯一任务事件总线。具体测试、实测指标和未覆盖项见 [验收记录](VALIDATION_0.2.31.md)。