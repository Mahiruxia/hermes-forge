# Hermes Forge v0.2.33 验收记录

日期：2026-09-17。主要验收环境：Windows x64。

## 本轮范围

桌面通用 Agent 与官方 Hermes 配置、工具、技能和结果语义对齐；同时发布模型缓存与上下文优化。继续固定 Hermes 0.21.3，提交 `345cd2b057a452236de401d3534b8502a7465e8d`，不修改官方源码和锁文件。

聊天继承 Profile 的人格、推理偏好、工具集、回合与时间预算、备用模型、检查点、预置消息和服务商路由。MCP 在创建 Agent 前按配置发现；技能命令使用官方加载器。多图全部传入，工具失败按官方检测器报告，最终回复与中间过程分开处理。

移除过时的 Windows `_wait_for_process` 替换：该替换不接受官方新增的 `bounded_capture` 等参数，会导致文件工具报错，并绕开官方的输出限制及协作中断。保留必要的 Windows / Git Bash 路径转换。

缓存和上下文修复包括压缩历史恢复、模型窗口解析和传递、缓存统计与当前上下文分离，详情见 [缓存与上下文记录](CACHE_CONTEXT_VALIDATION_2026-09-17.md)。

## 自动回归

- `npm ci`、`npm run check`、`npm run build`：成功。
- `npm test -- --maxWorkers=2`：76 个文件、572 项全部通过。
- `python -B -m unittest discover -s resources/tests -p test_*.py`：27 项全部通过。
- `npm audit --omit=dev`：生产 npm 依赖 0 项告警。完整依赖审计仍有开发和打包工具链告警，未执行跨大版本批量升级。
- 固定版本受管 Python 的 `uv pip check`：84 个包全部兼容。
- `git diff --check`：通过。

## 真实 Hermes 内核集成

以下探针使用实际固定版本 Hermes、独立临时 Home / 会话库、本地模型协议服务；不使用云端密钥，并阻止外网连接。

| 探针 | 结果 |
| --- | --- |
| `probe_native_agent.py` | 7 次模型请求完成原生技能加载、人格与预置消息、项目规则与记忆注入；2 张图片到达模型请求；搜索并调用真实 stdio MCP；缺失文件报告失败、随后成功读取已有文件；写入记忆、完成 todo、返回官方最终回复。 |
| `probe_prompt_cache.py` | 压缩后只恢复当前摘要及尾部；64k 窗口传给官方压缩器并保留冷却状态；独立进程恢复时 OpenAI 兼容与 Anthropic 请求的语义前缀稳定，保留 Anthropic 缓存标记。 |
| `probe_pinned_hermes.py` | 审批拒绝、多题澄清、工具事件与最终结果通过；Gateway 回调契约通过，外网请求为 0。 |

压缩历史探针使用真实 SessionDB 写入确定性摘要和尾部；本地服务返回的缓存 Token 是验证统计字段的固定值。它们不证明实际云端压缩质量或缓存命中提升比例。MCP 探针使用锁定环境的 MCP 2.0 SDK。

## 安装包与发布

- 本地 Windows NSIS 包：`Hermes-Forge-0.2.33-x64.exe`，94,212,638 字节；SHA256 为 `4ab691c3332fbccb0e3eef85cb6d5457cb6d13282982803a0ea6c585bea40419`。CI 构建产物会有自己的校验值。
- 打包后的真实应用执行 `--smoke-test`：11 项检查全部通过，包括全新临时用户目录、首次引导、聊天、preload、IPC、SQL WASM 和主进程依赖。
- 首次引导 DOM 就绪 1,452 ms；聊天 DOM 就绪 3,585 ms，后者包含前一页截图等待。已查看实际界面截图，版本号和布局正确。
- 15 秒空闲期间外部子进程启动、HTTP / WebSocket 请求、后台扫描、Renderer / preload 错误均为 0。总工作集从 450,836 KB 到 447,284 KB；没有同条件旧版基准，不据此声称性能提升比例。
- 包冒烟与模型审计完成后没有本安装包的残留进程。受管 Python 环境文件共 167,038,448 字节；本地 `release` 目录含旧包和测试环境共 3,528,952,298 字节。

## 正式发布结果

- 标签 `v0.2.33` 对应提交 `6d029f09b19f745aa2cb5be481cf20181c183b33`，代码已推送到 `main`。
- [发布流水线](https://github.com/Mahiruxia/hermes-forge/actions/runs/35196527391)的 Windows、macOS 和发布任务全部成功。
- Windows CI：572 项 TypeScript 测试、27 项 Python 测试通过；macOS CI：560 项 TypeScript 测试通过、12 项平台专用测试跳过，27 项 Python 测试通过。两平台均完成真实打包应用的离线启动检查。
- [GitHub Release](https://github.com/Mahiruxia/hermes-forge/releases/tag/v0.2.33) 已公开发布并标记为最新正式版，包含 Windows x64 安装器、macOS Apple Silicon DMG / ZIP 及自动更新清单和 blockmap，共 8 个附件。
- 已下载核对 `latest.yml` 与 `latest-mac.yml`，版本均为 `0.2.33`，文件名和大小与发布附件一致。未把清单校验表述为客户端完成更新安装。

GitHub 发布资产提供的 SHA256：

| 安装包 | 字节数 | SHA256 |
| --- | ---: | --- |
| `Hermes-Forge-0.2.33-x64.exe` | 94,212,574 | `9173b2c055051f5cdf0c341dc47ee397bd36b7754ea0d62f8019553e4a0cd5ec` |
| `Hermes-Forge-0.2.33-arm64.dmg` | 101,870,508 | `7327cc60fa27be396f6eb983332c9bf6faa3d965c65fe1e4f91018bbfbb3e11f` |
| `Hermes-Forge-0.2.33-arm64.zip` | 98,352,114 | `857aaf76677945c486e477086ea19d2d8f95d9c34f0fc2bbd8110c96c1f4a2ab` |

## 真实模型验证

最终本地安装包执行 `--system-audit`，并设置 `HERMES_FORGE_RELEASE_AUDIT=1`，使用现有模型凭据。默认模型 `kimi-for-coding` 的模型请求、跨独立进程恢复官方会话、特殊路径附件读取、约 9 MB 日志处理和原生命令执行共 5 项通过。

另一个已保存的模型配置仍返回 `HTTP 401: Invalid API Key`，切换模型项未通过，因此完整审计按设计返回非零退出码。该配置需有效凭据后重新验收，未把它报告为模型切换成功。默认跳过跨工作区写入，没有开启深度审计。

## 功能边界

- 桌面命令包括 `/help`、`/clear`、`/model`、`/workspace`、`/new`、`/skills`、`/memory`、`/usage`、`/theme` 和已安装技能调用。`/compact`、`/goal` 暂未接入，明确提示并保留草稿；自动压缩由 Hermes 负责。
- 图片处理仍取决于配置的模型视觉能力和官方辅助视觉策略。
- 本地没有 macOS 实机；发布 CI 的客户端打包与离线启动不能替代完整 Hermes 安装、真实模型或账号连接器验收。
- 备用模型、服务商路由和推理设置有配置传递回归，不代表每个云服务商都完成实际请求验收。
- 未宣称复刻官方终端的全部交互功能。安装器仍未配置代码签名。

本地测试报告、截图和包文件保存在 `release/agent-parity-0.2.33/`，不提交运行环境、模型凭据或用户数据。

新包验收后尝试清理旧构建产物，删除操作被自动审批策略拒绝，未提供更具体原因；原文件已保留，新包和官方环境不受影响。
