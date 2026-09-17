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
- GitHub 标签触发 Windows / macOS 的类型检查、单元测试、Python 回归、打包及离线启动检查；发布结果随后追加。

## 功能边界

- 桌面命令包括 `/help`、`/clear`、`/model`、`/workspace`、`/new`、`/skills`、`/memory`、`/usage`、`/theme` 和已安装技能调用。`/compact`、`/goal` 暂未接入，明确提示并保留草稿；自动压缩由 Hermes 负责。
- 图片处理仍取决于配置的模型视觉能力和官方辅助视觉策略。
- 本地没有 macOS 实机；发布 CI 的客户端打包与离线启动不能替代完整 Hermes 安装、真实模型或账号连接器验收。
- 备用模型、服务商路由和推理设置有配置传递回归，不代表每个云服务商都完成实际请求验收。
- 未宣称复刻官方终端的全部交互功能。安装器仍未配置代码签名。

本地测试报告、截图和包文件保存在 `release/agent-parity-0.2.33/`，不提交运行环境、模型凭据或用户数据。
