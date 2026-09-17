# 缓存与上下文验收记录（2026-09-17）

本次改动基于 Hermes Forge 0.2.32，使用锁定的官方 Hermes 0.21.3 / `345cd2b057a452236de401d3534b8502a7465e8d` 验证。没有新增运行依赖，也没有修改已安装的 Hermes 源码。

## 已修复的问题

1. 会话恢复原先使用 `include_ancestors=True`，把供界面展示的压缩前历史也送回模型。现在沿官方恢复链定位当前会话，只加载当前摘要和有效消息；工具调用配对、`api_content`、推理内容和多模态结构保持原样。官方空会话保持为空，仅在官方会话不存在时使用桌面历史作为后备。
2. `HERMES_FORGE_CONTEXT_WINDOW` 原先没有被 Python 桥接读取。现在通过官方压缩器的 `context_length` setter 应用窗口上限，更新派生阈值，并保留压缩失败后的冷却状态。模型元数据按模型来源和服务地址匹配，窗口设置修改后也会使运行环境缓存失效。
3. 桌面后备历史按连续的完整问答轮次保留，遵守 24 条消息、56,000 字符预算；适配器不再进行第二次 16 条截断。正常恢复仍以官方数据库为准。
4. 用量优先使用覆盖整个工具循环的官方累计计数。完整输入包含未缓存输入、缓存读取和写入；后备解析支持 OpenAI / Responses、Anthropic、DeepSeek、Kimi 风格及 Gemini 的缓存字段。
5. 当前窗口占用与累计费用用量分开。窗口按最近一次 Prompt 与回复计算，输入框再叠加草稿估算；压缩后等待新的实测值，切换模型后不沿用旧模型的窗口上限和命中率。
6. 输入框及运行侧栏展示缓存读取、写入和命中率，会话日志保留新增字段。汇总按输入 Token 数加权，旧事件缺少缓存字段时不加入命中率分母。

缓存标记、工具顺序和请求参数仍由官方 Hermes 按协议处理。未向通用兼容端点添加专属缓存参数，也未强制延长缓存保留时间。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test -- --maxWorkers=2` | 565 项通过，无失败或跳过 |
| `python -B -m unittest discover -s resources/tests -p "test_*.py"` | 21 项通过 |
| `npm run build` | 通过 |
| Windows x64 unpacked 打包 | 通过 |
| 打包应用 `--smoke-test` | 11 项通过；15 秒空闲观察，无外部命令、联网请求或渲染错误 |

回归覆盖：多服务地址下同名模型的窗口解析、配置缓存失效、完整问答保留、压缩会话恢复、缓存字段归一化、零命中值、按 Token 加权、累计用量与当前窗口分离、模型切换、会话日志持久化和 UI 展示。Python 桥接测试已加入发布工作流。

本地报告位于 `release/cache-context/tests.json` 和 `release/cache-context/smoke.json`，截图位于 `release/cache-context/screenshots/`；这些构建产物不纳入 Git。启动检查的欢迎页就绪时间为 1,234 ms，聊天页为 3,437 ms；后者包含欢迎页截图与页面切换，不能作为独立启动性能基准。

## 官方核心集成验证

脚本 `resources/tests/probe_prompt_cache.py` 使用独立临时目录、真实的锁定版 Hermes 与本地 OpenAI / Anthropic 协议模拟服务。外部网络在测试子进程中被阻断，不读取用户凭证。

```powershell
python -B resources/tests/probe_prompt_cache.py --root <Hermes安装目录> --python <受管Python路径>
```

三个阶段均通过：

- 构造真实 SessionDB 的压缩父子链，确认恢复父会话时只读取当前子会话。测试数据中旧方法得到 104,591 字符，修复后为 399 字符；这是人工构造的恢复测试，不是模型压缩率测量。64,000 Token 窗口生效，派生压缩阈值为 51,000，冷却状态保留。
- OpenAI 兼容协议启动两个独立进程续接同一会话，系统及工具定义保持相同，第二次请求延续原消息前缀，通用端点未收到不支持的缓存字段。
- Anthropic 协议同样跨两个进程验证系统、工具和消息前缀，并确认官方缓存标记存在。比较时仅统一协议中等价的文本简写格式，并移除用于选择缓存位置的标记。

模拟服务在第二次请求返回 1,000 输入 Token、900 缓存读取 Token、12 输出 Token，验证桥接计数与上下文统计一致。这些数值是测试输入，**不是实际云端命中率**。

## 验证边界与参考

本次未执行各服务商真实云端的命中率或成本基准，未在 macOS 上运行新增改动。实际收益需使用同一模型、同一配置和连续请求观察服务商返回的用量；不同模型、前缀变化或缓存过期后的请求不能保证命中。

请求前缀与协议处理参考 [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) 和 [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)，集成行为以本次锁定的官方 Hermes 源码和本地验证为准。
