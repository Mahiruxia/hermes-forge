# Hermes Forge Roadmap

Hermes Forge 当前以 Hermes 单引擎为核心，目标是把已经可运行的本地桌面工作台继续收口成稳定、可审计、可维护的社区客户端。

## 当前基线

- Hermes 是唯一执行引擎。
- `task:event` 是唯一任务事件总线。
- 高风险 Windows 动作已接入主进程审批。
- 微信扫码、Gateway runtime、模型定价和配置恢复入口已有可用闭环。

详细现状见 [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)。

## 近期重点

- 打磨首启修复体验：让 Hermes 路径、CLI 健康、模型配置、Secret 缺失和 WSL/Windows bridge 异常都能在 UI 中自助恢复。
- 扩展连接器 runtime：在微信之外补齐至少一个非微信平台的真实 `start/stop/healthCheck` 生命周期。
- 增加 Electron smoke 测试：覆盖启动应用、发起任务、收到 `task:event`、触发审批卡、轮询扫码状态。
- 继续拆分高复杂度文件：`hermes-connector-service.ts`、`hermes-cli-adapter.ts`、`task-runner.ts`。

## Connector Runtime

- 继续完善 Gateway 的崩溃诊断、退避、stdout/stderr 截断日志与恢复提示。
- 为更多平台补充凭据校验、运行状态探测和健康检查。
- 保持所有凭据和 token 严格停留在主进程，不把敏感值暴露到 Renderer。

## Security and Consent

- 补强审批测试与审计记录展示。
- 继续完善路径校验、IPC schema、命令执行边界与日志脱敏。
- 为触发审批的命令、文件路径和风险等级提供更清晰的 UI 文案。

## Platform and Packaging

- 在干净 Windows 机器验证 installer / portable 安装、升级和回滚。
- 增加签名、release provenance 和安装包加固。
- 补充 WSL 假设、常见错误和恢复路径文档。
- macOS / Linux 继续保持延后，等维护者具备稳定验证条件后再推进。

## Documentation

- 增加架构图、故障排查与真实工作流示例。
- 让 README、ROADMAP 与 capability matrix 始终跟随代码现状更新。
- 逐步补齐中英文核心文档。
