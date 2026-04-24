# Hermes Forge v0.1.16

这是一个面向 WSL 安装链路的稳定性补丁，重点修复新机器上无法顺利安装 WSL 版 Hermes Agent 的问题。

## 更新内容

- 新增独立的“安装 WSL 版 Hermes Agent”入口，不再把 WSL/Ubuntu/Hermes Agent 安装混在“一键修复”里。
- 安装器会自动尝试安装或连接 Ubuntu WSL 环境，然后修复 Python、Git、Pip、Venv，并安装 Hermes Agent。
- 当 `wsl.exe` 初始不可用时，安装器会尝试执行 `wsl.exe --install -d Ubuntu`，并在需要重启或首次初始化 Ubuntu 时给出可恢复提示。
- 一键修复如果识别到缺少 WSL 下 Hermes Agent，会提示用户确认；确认后会自动触发独立安装器。
- 安装器报告会保存完整状态，方便查看安装失败阶段和下一步恢复动作。

## 验证

- `npm run check`
- `npm test`
- `npm audit --audit-level=high`
- `npm run build`

## 注意

首次安装 WSL/Ubuntu 时，Windows 可能要求管理员权限、启用虚拟化、重启系统，或打开 Ubuntu 完成用户名和密码初始化。完成后再次点击“安装 WSL 版 Hermes Agent”即可继续。
