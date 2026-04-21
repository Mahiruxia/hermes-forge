# Hermes Forge Capability Matrix

本表用于冻结当前单引擎基线，避免 roadmap 与代码再次错位。

| Area | Current State | Notes |
| --- | --- | --- |
| 引擎架构 | Hermes-only | 不保留 OpenClaw / 多引擎扩展位。 |
| 任务事件 IPC | `task:event` 单总线 | 生命周期、stdout、tool、usage、result、approval 全走同一路径。 |
| 任务编排 | 已拆分主职责 | `task-runner` 使用独立 usage meter 与 derived event parser。 |
| 用量统计 | 已支持模型定价 | 优先读取 `ModelOption.inputCostPer1kUsd/outputCostPer1kUsd`。 |
| 审批治理 | 主进程统一审批 | 支持 `once/session/always/deny/timeout`，永久策略写入 `approval-policy.json`。 |
| Windows 高风险动作 | 已接审批 | 文件写入、PowerShell、键鼠、窗口控制等经过 `ApprovalService`。 |
| Native fast path | 已接审批 | 桌面侧宿主管理写文件会触发审批。 |
| 首启/诊断 | 配置中心可恢复 | Hermes 路径、模型、Secret、健康检查统一在 UI 内处理。 |
| 模型配置 | 已支持定价与上下文窗口 | 连接测试与 provider/profile 保持兼容。 |
| 连接器配置 | 主进程存储 | 配置状态与运行状态分离展示。 |
| Gateway runtime | 已有健康/退避/退出记录 | 包含 `healthStatus`、`lastExitCode`、`restartCount`、`backoffUntil`。 |
| 微信扫码 | 已闭环到 timeout/retry | 主进程状态机覆盖 `idle -> success|timeout|failed|cancelled`。 |
| Renderer 审批卡 | 已联通 | `approval` 事件驱动卡片创建与关闭。 |
| Renderer 连接器面板 | 已联通 runtime 状态 | UI 区分配置状态、运行状态、二维码超时态。 |
| 客户端自动更新 | 已接 GitHub Releases | `electron-updater` 支持启动检查、后台下载、进度 IPC 与重启提示；仍需真实 Release 包验证。 |
| 测试 | 已覆盖关键主链路 | 包含 approval service、usage meter、Windows tool executor、connector helper、renderer/store。 |
| Smoke / Electron E2E | 未引入 | 当前仍以 Vitest 单元/集成为主，后续再接桌面冒烟。 |

## 单引擎边界

- Hermes 是唯一执行引擎。
- 不新增第二条任务推送总线。
- 不在配置中引入 `defaultEngineId`、`openclawRuntime` 或任何多引擎字段。

## 下一阶段优先级

1. 继续补首启诊断文案与失败恢复体验。
2. 深化连接器 runtime 的非微信适配器闭环。
3. 追加 Electron smoke 测试与 CI 门槛。
