# Hermes Forge Release Checklist

## 源码与构建

执行 npm ci、npm run check、npm test、npm run build，再运行 npx electron-builder --win nsis --publish never。macOS 在本机使用 npx electron-builder --mac dmg zip --publish never。

只在明确需要公开发布时创建 Release；本地打包不会构成发布验收。

## 离线安装包冒烟

Windows 对 release/win-unpacked/Hermes Forge.exe 传入 --smoke-test，使用 PowerShell Start-Process -PassThru -WindowStyle Hidden -Wait，并检查返回进程的 ExitCode。不能直接启动 GUI 后读取旧的 LASTEXITCODE。

macOS 运行打包 .app/Contents/MacOS/Hermes Forge --smoke-test。该模式使用临时数据目录，验证 Renderer、preload、真实 IPC、主进程依赖和 SQL WASM；不调用模型、Hermes 或 Gateway。CI 对两个平台执行同一验收语义。

HERMES_FORGE_SMOKE_TEST_OUTPUT 可指定 JSON 报告路径。设置 HERMES_FORGE_SMOKE_TEST_IDLE_MS=300000 可记录实际五分钟空闲、进程启动次数与工作集内存；默认不延长 CI。

## 真实 Hermes 与模型验收

- 核实仓库来源、固定 SHA、包版本和实际 AIAgent/SessionDB/回调契约。
- uv pip check --python <managed-python> 通过；重复锁文件同步无变更。
- 覆盖旧 main、旧标签、detached HEAD；断网失败和中断恢复保留可诊断状态；不 stash、不向系统 Python 安装包。
- 运行 --system-audit；它使用已有模型配置，失败必须非零退出。工具和附件测试需要真实结果，不能只匹配提示词内的标记。
- 发布验收时加 HERMES_FORGE_RELEASE_AUDIT=1：额外验证独立进程从官方 SessionDB 恢复随机口令，以及另一已配置模型的真实请求；使用临时会话库，不改默认模型。
- 聊天、附件、模型切换、重启恢复、会话清空、审批拒绝、追问答复和五秒内取消按 [RC 矩阵](RC_SMOKE_MATRIX.md) 核对。
- 尚无真机、账号或凭据的项目明确记为未验收。

## 清理与交付

- 先验收受管环境，再清理确认未被引用的重复 .venv。
- 先验收新包，再清理旧安装包、解包目录和本轮临时文件，本地 release 最终只保留一个新 Windows 安装包。
- 保留源码、官方数据、用户配置、密钥、Profile 和任务记录。
- 记录安装包大小、环境与发布目录磁盘占用、冷启动和空闲内存；缺少同条件旧版数据时不虚构前后变化。
