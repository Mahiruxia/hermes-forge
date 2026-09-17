# Hermes Forge v0.2.32 验收记录

日期：2026-09-17。主要验收环境：Windows x64。

## 本轮范围

首次启动、缓存恢复、安装与取消、模型配置交接、工具路径发现，以及 GitHub Release 构建。继续固定官方 Hermes 0.21.3（`345cd2b057a452236de401d3534b8502a7465e8d`），使用官方锁文件同步受管环境。

默认依赖为核心、MCP 和两种聊天协议需要的 SDK；其他扩展按启用状态选择。Windows 已有 Git / uv 时不再下载引导脚本。macOS 缺少 uv 时使用固定版本 0.12.15 的官方安装器，并在执行前校验 SHA256：`716a1d6844740756c68770fcec2f79c2013fb9b03869a113f61e15f6f482a6a1`。

## 已完成的自动验证

- `npm ci`：成功。
- `npm run check`：成功。
- `npm test -- --maxWorkers=2`：74 个文件，548 项测试全部通过。
- 随后补充 macOS 非 Hermes 仓库保护与空闲状态提示两项回归；对应的 11 项定向测试全部通过，测试总数为 550。发布 CI 会再次运行完整测试集。
- `npm run build`：成功。
- `npm audit --omit=dev`：0 项。自动更新相关锁定依赖已更新到 `electron-updater 6.8.9`、`builder-util-runtime 9.7.0` 与 `js-yaml 4.3.2`。
- Electron 更新至同一大版本的 41.10.7；重新完成类型检查与生产构建，并在最终安装包中验证。
- 新增回归覆盖：IPC 提前注册、窗口重建、缓存损坏和配额限制、偏好恢复、安装取消竞争、失败日志保留、首次模型检查等待、模型保存后刷新失败、macOS uv 安装器校验、核心模型 SDK 安装及日志事件。

全依赖审计还包含开发和打包工具链告警，不等同于上述生产 npm 依赖范围；本轮没有执行跨大版本的批量依赖升级。

## 实际 Hermes 安装

通过编译后的 `NativeInstallStrategy` 在全新的隔离目录运行官方安装流程，不修改现有 Hermes 配置或模型密钥。

- 从官方 GitHub 下载并验证固定提交。
- 使用 uv 创建独立 Python 3.11.15 环境。
- `uv sync --locked --no-dev --extra anthropic --extra mcp`：安装 84 个包。
- `uv pip check`：全部依赖兼容。
- Hermes CLI 返回 0.21.3；`AIAgent`、`SessionDB`、MCP、OpenAI 与 Anthropic 导入检查通过。
- 首次完成耗时 115.445 秒；虚拟环境文件总大小 166,785,454 字节。
- 同目录重复安装成功；再次同步检查 84 个包，没有依赖增删。

此验证复用了开发机已有 Git / uv 与 uv 缓存，不能视为没有任何开发工具的 Windows 虚拟机验收。缺少工具时的引导、取消与重试分支有自动测试覆盖。

## 安装包验证

- 最终 Windows NSIS 安装器：`Hermes-Forge-0.2.32-x64.exe`，94,207,309 字节（约 89.8 MiB）。
- 本地构建 SHA256：`ba3c38dc8f03e6ca122b0381ffce20f772d641bba83b8a365da1bdf15d0b6efe`。CI 重新构建的包会有自己的校验值，不能混用。
- 对最终包执行 `--smoke-test`，使用全新隔离用户目录、真实 preload / IPC 和 SQL WASM：11 项检查全部通过。
- 首次引导 DOM 就绪 1,291 ms，聊天 DOM 就绪 3,455 ms（包含前一页截图的等待时间）。已查看两张实际界面截图，确认首次设置与聊天布局、版本号和“待检查”状态。
- 15 秒空闲期间外部子进程启动为 0，没有 HTTP / WebSocket 请求、后台环境扫描或 Renderer / preload 错误；测试结束后没有本安装包的残留进程。
- 检查打包后的 ASAR，确认实际包含 `electron-updater 6.8.9` 与 `builder-util-runtime 9.7.0`。

## 平台与网络限制

- 首次安装 Hermes 仍需联网。社区选项只替换 Windows 工具引导脚本，源码仍需访问官方 GitHub；依赖还需要其下载服务。
- macOS 安装入口和 uv 引导经过模拟回归；本地没有 macOS 实机。发布流水线对 macOS 执行类型检查、单元测试、打包与真实应用离线启动，以本标签对应 CI 结果为准。
- Windows 和 macOS 当前都未配置代码签名；首次启动的系统来源提示仍可能出现。
- 本轮隔离安装没有配置真实云端模型密钥；SDK 导入与模型向导回归不能替代真实模型服务的端到端请求。

本地机器生成的安装报告、重复安装日志、测试报告和截图位于 `release/onboarding-0.2.32/`，不提交用户数据、密钥或运行环境到源码仓库。
