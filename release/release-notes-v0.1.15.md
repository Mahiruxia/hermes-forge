## Hermes Forge v0.1.15

发布日期：2026-04-24

这是 v0.1.14 之后的发布补丁版本，重点收口 WSL Hermes Agent 默认链路、模型接入体验、聊天流污染、启动更新检查和顶部/输入区视觉密度，目标是让用户打开后更快可用、聊天更干净、发布包更稳。

### 重点修复

- WSL / Hermes Agent：
  - 默认运行模式继续向 WSL Hermes Agent 收口，减少误回落 Windows 端的情况。
  - 修复 WSL 一键安装、修复和导出诊断的多个可用性问题。
  - Bridge 不可达不再误阻断 Hermes Agent 主链路。

- 模型接入：
  - OpenAI-compatible 入口前置，并支持 MiniMax、DeepSeek、Qwen、Kimi、Zhipu、SiliconFlow、Volcengine、Tencent Hunyuan 等常见 coding provider。
  - 支持手动填写模型名，模型列表不可用时不再阻断保存与测试。
  - 保存过的模型会进入历史列表，并支持一键切换默认模型。
  - 默认上下文长度收口为 256k，不再让用户在 UI 中手动选择。

- 聊天稳定性：
  - 修复 Hermes CLI 输出 `Resumed session ...` 等会话恢复状态时被误展示为回复正文的问题。
  - 在 adapter 和 renderer store 两层过滤 CLI 生命周期日志，覆盖 stdout、最终结果和流式文本。
  - 修复会话切换、任务完成回写和历史恢复相关的错乱风险。

- 启动与更新检查：
  - 启动阶段继续避免自动触发重型 RuntimeProbe、Gateway 启动、capabilities 深探测和 WebUI 大量扫描。
  - 客户端更新检查改为启动后单次后台检查；后续只在用户手动点击时执行。
  - 更新检查增加超时兜底，避免状态一直停在“检查中”。

- UI 收口：
  - 顶部状态栏瘦身，降低首屏高度占用。
  - 输入框默认高度和最大高度下调，聊天区域显示更紧凑。
  - “当前会话正在处理中”改为等待态提示，不再用红色错误样式误导用户。

### 验证

- `npm test`：45 个测试文件 / 238 个测试通过
- `npm run check`
- `npm run build`
- `npm run package:win`
- `npm run package:portable`
