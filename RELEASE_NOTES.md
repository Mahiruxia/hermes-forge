# Release Notes

## Hermes Forge v0.2.26

发布日期：2026-05-20

这是一次面向模型切换与 MiniMax Token Plan 连接稳定性的修复版本。重点解决用户切换聊天模型后，已经连接的微信等第三方 Gateway 仍沿用旧模型运行时配置，以及 MiniMax-M2.7 在主聊天模型路径缺少 `minimax-cn` 规范 API Key 导致调用失败的问题。

### 核心修复

- **切换模型后自动同步并重启 Gateway**：保存或删除当前聊天模型配置时会同步 Hermes 运行时配置；如果 Gateway 已运行，会自动重启让微信等第三方连接器立即使用新模型。
- **模型切换结果在 UI 可见**：模型配置向导保存后会展示“已同步并重启 Gateway / Gateway 未运行无需重启 / 重启失败”等状态，避免后台行为不可确认。
- **MiniMax Token Plan 写入规范环境变量**：MiniMax CN 配置会写入 Hermes Agent 实际读取的 `MINIMAX_CN_API_KEY` 与 `MINIMAX_CN_BASE_URL`，并保留旧别名兼容，避免主聊天模型只拿到 Coding Plan Key。
- **MiniMax 连接检查对齐主聊天模型**：`minimax-cn` 的原生 Key 检查改为验证 `MINIMAX_CN_API_KEY`，减少配置页显示可用但聊天运行失败的错位。

### 验证

- `npm run check` 通过
- `npm test` 通过
- `npm run build` 通过
- `git diff --check` / secret-pattern scan 通过

## Hermes Forge v0.2.25

发布日期：2026-05-20

这是一次面向用户反馈的界面与设置可发现性修复版本。重点解决 AI 回复操作按钮遮挡状态、Enter / Ctrl+Enter 发送方式不够明显、设置入口分散，以及诊断页在 0/0 状态下仍显示红色“需处理”带来的误导感。

### 核心修复

- **AI 回复操作按钮不再遮挡状态**：复制、继续生成和更多操作从消息卡片右上角绝对定位改为消息头部布局内控件，状态、时间和操作按钮各占自己的空间。
- **发送快捷键选择会保存并自动隐藏**：首次进入输入框时以轻量工具栏胶囊展示 Enter / Ctrl+Enter 选择，用户选择后写入 Web UI 设置并隐藏提示。
- **局部设置保存不再重置其它偏好**：Web UI 设置服务保存部分字段时会保留现有 language、sendKey 等值，避免只改一个开关却意外恢复其它默认项。
- **诊断 0/0 状态不再显示红色**：一键诊断页在未发现阻塞项、尚未真正运行诊断时改为“待检查/待读取”中性色；只有真实失败时才进入红色提醒。

### 体验优化

- **工作台偏好进入设置中心**：Agent 设置页新增“工作台偏好”，集中管理发送快捷键、Token 用量显示和 CLI 会话显示，不再只藏在右侧运行面板。
- **发送方式控件更精巧**：输入框里的发送方式提示改为低噪声键盘分段胶囊，保留可发现性但不打断当前输入。
- **诊断提醒语气更克制**：诊断统计卡和结果摘要降低红色面积，将“需处理”调整为更温和的“需关注”，减少误报式紧张感。

### 验证

- `npm run check` 通过
- `npm test` 通过，52 个测试文件、392 个测试全部成功
- `npm run build` 通过
- `git diff --check` / secret-pattern scan 通过

## Hermes Forge v0.2.24

发布日期：2026-05-20

这是一次长对话稳定性、token 真实性与飞书多机器人二次修复版本。重点处理用户连续反馈的长时间对话结束后状态卡住、token 卡片把旧实测误当成本轮实测、以及飞书多实例在 Gateway 已运行时仍无法可靠启动/编辑的问题。

### 核心修复

- **长对话结束后不再卡在运行中**：任务收到 completed / failed / cancelled / interrupted 终态事件后会清理当前运行标记，重启恢复时也不再沿用旧的 running task，避免长对话报错后下一轮被旧状态挡住。
- **Token 计数不再拿旧实测冒充本轮实测**：同一任务内 actual 仍优先于 estimated，但不同任务之间按最新一轮展示；如果最新一轮只有估算，输入框与 Agent 面板会明确标为“估算”，不会继续显示上一轮“实测”。
- **Late estimate 不再覆盖 actual usage**：后端 usage meter 已收到 actual 后会忽略后到的 estimated usage，避免 provider/Hermes 已返回真实用量后又被 stdout 估算值抬高或污染。
- **飞书多实例启动判断修正**：只包含 `feishu:*` 的 Gateway 状态不再被误认为主连接器 Gateway；当一个飞书机器人已运行时，另一个停止中的飞书实例仍可从 UI 触发启动。
- **飞书旧配置迁移更稳**：从旧 `.env` 导入 `FEISHU_*` 时会进入 `default` 实例，不会覆盖或删除已有其它 Bot 实例；旧版未带 `feishu:default` 前缀的运行状态也会映射到默认实例。
- **飞书实例目录清理覆盖 Agent profile**：同步配置时会在默认 Hermes home 与各 Agent profile 的 `connector-instances/feishu` 下清理失效目录，避免旧 Bot home 残留影响状态判断。

### 体验优化

- **飞书编辑器保留高级字段**：已保存过值或密钥的飞书高级字段再次编辑时保持可见，并提示“已保存密钥，留空保存不会覆盖”，减少用户误以为配置丢失。
- **工作区文件入口更明确**：Header 与空会话页增加工作区文件入口，抽屉支持 Escape 和收起按钮关闭，切换工作区后自动收起。
- **长回复排版更稳**：聊天气泡、Markdown、代码块、链接和 inline code 增强换行与最大宽度约束，降低长代码/长 URL 撑破对话布局的概率。

### 验证

- `npm run check` 通过
- `npm test` 通过
- `npm run build` 通过
- `git diff --check` / secret-pattern scan 通过

## Hermes Forge v0.2.22

发布日期：2026-05-18

这是一次飞书多机器人隔离与 token 统计修复版本。重点解决两个飞书机器人绑定不同智能体时可能互相覆盖配置、配对失败，以及 Windows Native 模式下 token/上下文显示长期停留在估算值的问题。

### 核心修复

- **飞书多机器人不再互相覆盖**：飞书连接器升级为多实例模型，每个 Bot 使用独立实例 ID、secret ref、`.env`、Gateway 状态和运行目录，避免多个机器人共享一组 `FEISHU_*` 环境变量。
- **飞书 Bot 真实绑定 Agent profile**：每个飞书实例按 `agentId` 启动在对应 Hermes profile 下，并挂接该 profile 的技能、记忆、配置和认证文件；状态按 `feishu:<instanceId>` 聚合。
- **Token 用量 actual 优先**：Windows bridge 会透传 Hermes/provider 返回的 prompt、completion、total、cache、reasoning 与上下文窗口字段；前端收到 actual 后覆盖估算。
- **修复 token 小标签卡在旧估算**：聊天气泡和 Agent 运行面板统一按 actual 优先、当前任务优先展示，不再被早期 `约 55 token` 之类估算事件挡住。

### 新增功能

- **飞书实例 UI**：连接器面板支持新增、编辑、禁用多个飞书机器人，并在卡片上展示实例 ID 与绑定 Agent。
- **上下文窗口实测显示**：输入框上下文条和运行面板会展示实测上下文占用、剩余窗口、最近输入/输出，并在缺少 actual 时明确标注估算。
- **MiniMax Token Plan 兼容**：旧 MiniMax-M2 配置会迁移到 Token Plan 运行时入口，避免模型配置继续走旧 endpoint。

### 体验优化

- **会话 usage 聚合更稳**：同一任务同时存在 estimated 和 actual 时优先保留 actual，重启恢复后也不会退回旧估算。
- **运行面板更贴近本轮任务**：Token 卡优先展示当前 active run 的 usage，避免把同会话其它轮次混入“本轮占用”。
- **飞书兼容旧配置**：已有单飞书配置会自动迁移为 `default` 实例，原有 secret ref 不丢失。

### 验证

- `npm run check` 通过
- `npm test` 通过，51 个测试文件、375 个测试全部成功
- `npm run build` 通过
- 飞书多实例与 token 展示相关 targeted tests 通过

## Hermes Forge v0.2.21

发布日期：2026-05-18

这是一次安装落地、长会话稳定性与上下文可视化版本。重点解决 Windows 用户安装 Hermes Agent 的可用性问题、长对话恢复错乱、模型切换不生效，以及上下文窗口看不准的问题。

### 核心修复

- **Hermes Agent 安装源明确可选**：欢迎页与设置页安装前都会让用户选择官方 GitHub 或国内社区镜像，不再静默自动切换来源；官方失败后提供“改用国内社区镜像重试”的明确动作。
- **修复 Windows 子进程编码崩溃**：安装、自检、维护、Gateway 与 Python 相关路径统一注入 `PYTHONIOENCODING=utf-8:replace`，并在 Windows 打包中包含 `python-sitecustomize`，降低 `_readerthread UnicodeDecodeError` 风险。
- **修复重启后聊天记录缺失和回复错乱**：会话恢复改为读取完整的近期任务运行片段，重放流式消息前清理旧投影，避免只剩一条记录、重复拼接或顺序混乱。
- **修复模型切换后仍像旧模型**：切换模型会同步更新默认模型与聊天角色分配，运行时按模型隔离 Hermes 会话，避免复用旧模型上下文。

### 新增功能

- **更真实的 token 与上下文占用显示**：优先使用 Hermes/模型返回的 usage 数据，结合当前输入草稿估算剩余上下文窗口；无 usage 时使用共享本地估算器兜底。
- **安装日志可追踪来源**：下载安装脚本后记录脚本 URL、内容长度和 SHA256，方便用户与开发者定位官方源、镜像源或网络环境问题。
- **长回复处理提示**：对超长回复提供文件化/导出方向的提示，减少长消息把聊天界面撑乱的概率。

### 体验优化

- **聊天页长时间使用更轻**：消息列表增加窗口化渲染，长会话默认只渲染近段消息，向上滚动再加载历史，同时保留回到底部与流式跟随体验。
- **顶部状态与输入区更收敛**：API、Hermes、Gateway、更新状态合并为一个环境状态入口；底部 composer 减少大白块背景，和对话区更好融合。
- **安装依赖预检更稳**：Windows Native 安装路径继续保留动态参数探测，仅在脚本支持时传入 `-WithSystemPackages` 与 `-SkipGatewayStartup`，减少不同安装脚本版本的兼容风险。

### 验证

- `npm run check` 通过
- `npm test -- --run` 通过，51 个测试文件、363 个测试全部成功
- `npm run build` 通过

## Hermes Forge v0.2.20

发布日期：2026-05-18

这是一次连接器对齐、消息恢复与品牌图标修复版本。重点解决用户反馈的飞书配置与 Hermes CLI 行为不一致、一键修复失败后无法继续发消息，以及 Windows 图标边缘不透明的问题。

### 核心修复

- **修复一键修复后无法继续发消息**：Hermes 安装、更新、一键诊断、依赖修复、模型与密钥配置变更后会立即清理任务预检缓存，避免旧的 Hermes 不可用状态继续阻塞发送。
- **启动失败不再吞掉用户输入**：任务启动前检查失败时会释放运行锁、刷新 Hermes 状态，并恢复用户刚输入的内容，用户可以直接调整后重试。
- **修复空结果覆盖已流式输出**：当 Hermes 已有流式回复但最终结果为空时，不再用“已运行但没有返回可显示内容”覆盖真实输出。
- **增强 Windows Agent 结果解析**：兼容 `final_response`、`response`、`content`、`message`、`output`、`text` 以及消息数组中的最终文本，减少误判空内容。

### 新增功能

- **飞书连接器对齐 Hermes CLI**：补齐 `FEISHU_ALLOW_ALL_USERS`，默认 WebSocket、私聊配对审批、群聊 open 且需要 @ 机器人。
- **QQ Bot 连接器对齐 Hermes CLI**：补齐 `QQ_APP_ID`、`QQ_CLIENT_SECRET`、`QQ_ALLOW_ALL_USERS`，并改用 Gateway 推荐的 `QQBOT_HOME_CHANNEL`。
- **飞书身份与 Agent 映射字段**：新增 Bot Open ID、Bot User ID、Bot 名称、Webhook 加密字段和 `FEISHU_AGENT_MAPPING` 写入能力，为后续多实例路由预留。

### 体验调整

- **连接器配置提示更准确**：微信、QQ、飞书的最小必填项、默认策略和高级字段说明与 Hermes Gateway 实际读取逻辑保持一致。
- **程序图标重绘**：替换 PNG、ICO、ICNS 图标资源，修复旧图标未抠透明背景导致的视觉粗糙问题。
- **修复失败后刷新状态**：设置页和欢迎页的修复/安装失败路径也会刷新 setup 检查，避免页面停留在旧状态。

### 验证

- `npm run check` 通过
- `npm test` 通过，46 个测试文件、332 个测试全部成功
- `npm run build` 通过
- `npm run package:portable` 通过
- 微信、QQ、飞书最小环境变量已通过本机 Hermes Gateway 配置加载验证

## Hermes Forge v0.2.18

发布日期：2026-05-13

这是一次根治安装卡死与自动更新体验的重构版本。重点解决 Windows 用户反馈的 Hermes Agent 安装长期卡在 55% 的问题，并重构自动更新流程，让用户对更新节奏有完全掌控。

### 核心修复

- **根治安装卡在 55%**：修复心跳进度硬编码 55% 的显示 bug，进度改为只增不减；新增安装日志实时透传与深色终端面板，用户可实时看到脚本在做什么。
- **PowerShell 执行策略预检**：运行脚本前检测 `-ExecutionPolicy Bypass`，受限时直接报错而非干等。
- **国内镜像自动切换**：后端自动探测 PyPI/清华/阿里/中科大速度，自动注入 pip/uv 镜像环境变量；安装开始时前端给出中文网络提示。
- **Git/Python 缺失预修复**：进入 PowerShell 脚本前，先用 winget 主动安装 Git.Git 和 Python.Python.3.12，避免脚本在后台从 GitHub 慢速下载。
- **GitHub 慢速前置检测**：ping + HTTP 延迟检测，慢速时 emit 中文提示建议切换国内社区镜像。

### 体验调整

- **自动更新 UI 重构**：关闭强制自动下载，改为用户可控弹窗；新增「跳过本次」与「稍后提醒」；更新弹窗展示 release notes；状态流转为 `available → downloading → downloaded`。

### 验证

- `npm run check` 通过
- `npm test` 通过，45 个测试文件、326 个测试全部成功

## Hermes Forge v0.2.17

发布日期：2026-05-11

这是一次桌面端启动回归修复版本，重点解决 v0.2.16 用户反馈的“打开直接白屏”问题，并收紧打包产物与外部链接处理。

### 核心修复

- **修复打包后白屏风险**：渲染进程不再直接导入 Electron `webUtils`，拖拽附件获取文件路径改为通过 preload 暴露的 `workbenchClient.getPathForFile()`，避免 Electron/Node 模块进入 Vite renderer bundle。
- **清理旧构建资源**：Vite 构建恢复清理 `dist/renderer`，避免旧 hash JS/CSS 被 `electron-builder` 一起打进安装包。
- **外部链接安全处理**：Electron 主窗口统一拦截新窗口打开，HTTP/HTTPS/mailto 链接交给系统浏览器，其他不可信新窗口直接阻止。
- **版本元数据校准**：同步更新 package 与 lockfile 版本，确保安装包、release 与自动更新元数据一致。

### 验证

- `npm run check` 通过
- `npm run build` 通过
- `npm test` 通过，45 个测试文件、314 个测试全部成功
- 构建版 Electron 启动烟测通过，`#root` 正常渲染且 `workbenchClient` 正常注入

## Hermes Forge v0.2.16

发布日期：2026-05-11

这是一次安装稳定性、性能优化与 Gateway 兼容性修复版本，重点解决 Windows exe 安装场景下的 PYTHONPATH 冲突导致的启动失败问题，以及每次消息触发多次 Python 探测的性能瓶颈。同时统一默认安装源为官方 Hermes Agent 仓库，并为 Gateway 状态检测与启动增加 editable install 感知能力。

### 核心修复

- **PYTHONPATH 冲突导致安装检测失败**：Windows Native exe 安装模式下， unconditionally 注入 `PYTHONPATH` 会导致 `hermes.exe` 运行时触发 Python 模块导入冲突，进而使版本检测返回非零退出码。已在 `hermesEnv()`、`detectLaunch()`、`buildGatewayEnv()` 等所有相关位置改为 **仅在 editable install 时注入 PYTHONPATH**，exe 安装不再受影响。
- **Gateway 启动与状态检测同样受 PYTHONPATH 影响**：`preflightGatewayRuntime()`、`gatewayCliStatus()`、`gatewayLaunchFromRuntime()`、`legacyGatewayLaunch()` 以及微信扫码/依赖安装路径均已同步改为条件注入，确保有连接器的 exe 用户也能正常启动 Gateway。
- **TypeScript 编译错误修复**：`detectWindowsPython` 返回的 union type 中 success/failure 分支结构不一致，导致 `spec.lastError` 访问报错。已通过统一返回类型签名修复。

### 性能优化

- **Python 探测缓存**：`windowsPythonSpec()` 新增 per-rootPath 缓存，首次成功探测后复用结果，避免每次用户消息触发最多 4 次 Python 子进程探测（每次 20s 超时），显著降低回复延迟。

### 体验调整

- **默认安装源改为官方仓库**：`DEFAULT_PINNED_HERMES_SOURCE` 从 `Mahiruxia/hermes-agent` fork 切换为 `NousResearch/hermes-agent` 官方 main 分支，确保用户安装的是上游官方版本。
- **默认 CLI 权限模式收紧**：`cliPermissionMode` 默认值从 `"yolo"` 改为 `"guarded"`，`permissionPolicy` 默认改为 `"bridge_guarded"`，提升开箱即用的安全性。
- **Windows Python 路径增强**：`platform-resolver.ts` 新增 Anaconda / Miniconda 安装路径检测，覆盖更多用户的 Python 环境。

### 验证

- `npm run check` 通过
- `npm run build` 通过
- `npm test -- --run`：45 个文件，314 个测试全部通过

## Hermes Forge v0.2.15

发布日期：2026-05-10

这是一次看板中文化、会话体验增强与进程生命周期修复版本，重点补齐 Kanban 前端的中文界面与小白友好引导，同时修复用户长期反馈的 Forge 退出后 Hermes 残留、Gateway 断连后重连过慢、会话标题无法编辑等痛点。

### 新增功能

- **看板 (Kanban) 中文化**：完整的中文看板界面，六列状态（待分类/待处理/就绪/执行中/已阻塞/已完成）均附带小白友好的说明文字；任务卡片、搜索、筛选、负责人分配、诊断告警等全部中文化。
- **默认大字体主题**：新增 `default-large` 主题，18px 基础字号，对大屏和高分辨率显示器更友好。
- **顶部重启 Hermes Agent 按钮**：Header 菜单新增"重启 Hermes Agent"入口，支持显式预热 Hermes，加载新技能后无需重启 Forge。

### 核心修复

- **Forge 退出后 Hermes 进程残留**：`HermesCliAdapter.stop()` 之前为空实现，导致关闭 Forge 时 Windows Native Agent 子进程不会被终止。现已通过 `activeProcesses` Set 追踪所有 `spawn` 出的进程，在 `stop()` 时统一发送 `SIGTERM` 清理。
- **Gateway 自动断连重连过慢**：首次重连等待从 5s 降至 3s，后续退避阶梯从 15s/60s/300s 收紧为 10s/30s/60s，减少"调度器未运行"的感知时间。
- **会话标题不可编辑**：侧边栏和 Header 均支持双击/点击编辑会话标题，Enter 保存、Escape 取消、失焦自动保存；同步修复 `main.tsx` 中 `updateSessionMeta` / `updateActiveSessionMeta` 的类型签名与 `SessionMetaPatch` 不一致的问题。
- **依赖修复 `hermes_python_dotenv` 被 IPC 拦截**：`repairSetupDependency` 的 Zod schema 漏了 `"hermes_python_dotenv"`，导致前端点击修复 python-dotenv 时直接报校验错误，无法到达修复逻辑。

### 体验优化

- **会话侧边栏交互增强**：hover 显示操作按钮（重命名/收藏/复制/导出/删除），收藏状态用琥珀色圆点标识，标签页切换更明确。
- **Cron 编辑器优化**：支持 Agent 任务与脚本看门狗两种模式切换，UI 更直观。
- **关闭 Forge 时 Hermes 停止超时**：从 5s 提升到 10s，给 Hermes 更充裕的清理时间。

### 验证

- `npx tsc --noEmit` 通过。
- `npm test` 通过，314 个测试全部成功。

发布日期：2026-05-05

这是一次会话安全与聊天界面体验修复版本，重点解决历史聊天栏里“归档/收藏”造成会话看起来消失的问题，并收紧顶部与输入区的常驻信息密度。

### 核心修复

- 取消历史聊天栏里的“归档”入口，避免会话被一键隐藏后误以为聊天丢失。
- 会话列表会重新显示既有 archived 会话，帮助已被归档的历史聊天回到可见列表。
- 收藏现在只作为标记和筛选条件，不会再把会话从“最近”列表移走。
- “最近”列表恢复按更新时间排序，不再被收藏状态打乱。

### 体验优化

- 顶部更多菜单新增“删除当前会话”，带明确二次确认，并复用原删除会话数据流。
- 左侧历史会话栏和右侧 Agent 面板支持拖拽调宽，并作为本机 UI 偏好持久化。
- 输入区改为更轻的单体胶囊样式，placeholder 缩短，模型、附件、上下文与发送按钮更紧凑。
- 运行保护提示降级到底部小字，黄色状态只保留轻提示和可展开说明。
- 顶部品牌和当前会话信息改为更紧凑的 logo + 会话胶囊，减少主界面占位。

### 验证

- `npm run check` 通过。
- `npm test` 通过，295 个测试全部成功。
- GitHub CI `verify` 通过。

## Hermes Forge v0.2.11

发布日期：2026-05-02

这是一次 Windows Native 聊天热修版本，针对新版本用户反馈的 `No module named 'dotenv'` 启动失败做收口。

### 核心修复

- 修复 Windows Agent 对话启动时只尝试系统 `python` / `py -3`，导致已安装 Hermes venv 仍可能报缺少 `python-dotenv` 的问题。
- Windows Agent 启动前现在会优先使用 Hermes `.venv` / `venv` 中的 Python，并真实导入 `run_agent.AIAgent` 做探测，避免 `hermes --version` 通过但任务运行期失败。
- 修复用户点击依赖修复后，同一进程仍可能沿用旧 Python 选择的情况：Windows Agent 每次启动都会重新按当前 Hermes 环境探测。
- Hermes 设置页的 `PyYAML` / `python-dotenv` 依赖检查也改为 venv 优先，减少系统 Python 与真实任务环境不一致造成的误报或漏报。

### 验证

- `npm run check` 通过。
- `npm test` 通过，291 个测试全部成功。
- `npm run build` 通过。
- `npm run package:win` 通过，生成 Windows x64 安装包与自动更新元数据。

## Hermes Forge v0.2.10

发布日期：2026-05-01

这是一次面向聊天稳定性、Gateway 可信状态、上下文显示和回复体感的修复版本。

### 核心修复

- 修复 Hermes 回复偶尔停在“让我再仔细查一下：”这类半截句后就标记完成的问题：Windows Native runner 现在会识别明显未完成的最终回复，并自动续写补全。
- 修复 Gateway 顶部显示运行中、但实际微信连接不可用时的冲突状态：旧的无 PID 状态文件超过 120 秒后不再被当作可信运行状态，CLI 状态也必须成功退出才会点亮运行。
- 修复连接器 `.env` 与 Gateway 实际使用 Hermes profile 不一致的问题：微信连接器配置会同步到当前 active Hermes home，并在 Gateway 启动/状态检查时显式传入 `HERMES_HOME`。
- 兼容 macOS Native Hermes CLI 路径解析，不再沿用 Windows-only 的 CLI 路径逻辑。

### 聊天体验

- 新增 Hermes 思考/工具/回复阶段状态，但不会显示原始推理内容。
- 状态文案改为更轻松的短句，并会随等待时长变化，减少一直卡在“准备上下文”的观感。
- 上下文胶囊改为优先显示真实/估算“已用上下文”，模型窗口上限放到详情里说明，避免把 `256k` 误解成当前会话长度。
- 长回复的流式输出改为小批量合并，减少高频磁盘写入、IPC 和 UI 更新带来的抖动。

### 性能优化

- Windows Native runner 兜底历史从最近 48 条收窄到最近 16 条，并改为紧凑 JSON；Hermes 自己的 state.db 历史不受影响。
- 首输出耗时统计现在会把 `message_chunk` 计入，诊断中的首字速度更准确。

### 验证

- `npm run check` 通过。
- `npx vitest run src/adapters/hermes/hermes-cli-adapter.test.ts src/renderer/dashboard/DashboardView.test.tsx src/renderer/dashboard/components/AgentRunPanel.test.tsx src/main/hermes-connector-service.test.ts` 通过，70 个测试全部成功。
- `python -m py_compile resources/hermes-windows-agent.py` 通过。

## Hermes Forge v0.2.9

发布日期：2026-05-01

这是一次 Hermes 更新链路与 macOS Native 兼容性的修复版本。该版本包含当前工作区内 Claude Code 和 Codex 共同完成的最新改动。

### 发布资产

- Windows: `Hermes-Forge-0.2.9-x64.exe`
- macOS Apple Silicon: `Hermes-Forge-0.2.9-arm64.dmg` / `Hermes-Forge-0.2.9-arm64.zip`
- 自动更新元数据：`latest.yml`、`latest-mac.yml` 和对应 `*.blockmap`

### 核心修复

- 修复 Hermes 一键更新只提示成功但本地代码没有真正前进的问题：更新流程现在直接接管 Git fetch / fast-forward pull，并在完成后再次校验本地是否仍落后远端。
- 修复更新后继续提示“还有 commits 可更新”的冲突体验：更新检测会读取远端 Hermes 版本号，只有远端稳定版本更高时才提示用户更新。
- 强化更新失败反馈：detached HEAD、fetch 失败、pull 冲突、更新后仍落后等情况会明确返回失败，不再被静默吞掉。
- 更新成功后会刷新设置页的当前版本、最新版本和更新状态，避免 UI 继续显示旧结果。

### 桌面体验

- 顶部 Hermes 状态增加醒目的“更新”状态，存在可用稳定版本时不再只是一个很弱的灰点。
- 聊天输入区上方新增 Hermes 更新提醒条，让用户在主要工作流里也能看到可更新状态。
- 设置页会同时展示当前版本与远端最新版本，减少“已经更新了为什么还提示”的误解。

### macOS Native

- 运行时探测、Hermes CLI 路径解析、权限概览和设置页现在会正确识别 `macOS Native`。
- macOS 用户可以选择已安装的 Hermes CLI 路径并保存配置，不再被界面固定显示为 `Windows Native`。
- macOS 自动一键安装仍未开放；当前版本支持“已安装 Hermes 后选择路径使用”的路径。

### 验证

- `npm run check` 通过。
- `npm test` 通过，288 个测试全部成功。
- `npm run build` 通过。

## Hermes Forge v0.2.8

发布日期：2026-04-30

这是一次面向 Windows Native 主线、配置迁移和桌面输入体验的版本更新。该版本包含 Claude Code 协作完成的大批运行时收口改动，也包含今天对聊天输入区的细节修复。

### 核心变化

- 收口 Windows Native 运行链路，移除旧 Managed WSL 安装器、WSL doctor、WSL runtime adapter 等遗留路径。
- 新增 Hermes Core bridge、Hermes home 链接与 legacy WSL 配置迁移服务，让旧配置可以迁入当前 Forge 管理目录。
- 强化 Hermes 兼容性检测、诊断编排、模型运行时同步和连接测试，减少配置看似可用但运行时失败的情况。
- 优化 Windows agent 的文件、窗口、剪贴板和命令能力处理，并补充 token usage 解析与展示。

### 桌面体验

- 修复聊天输入区右下角上下文用量详情被 composer 裁切、覆盖发送区域的问题，改为轻量浮层展示。
- 修复语音输入状态机：避免监听状态卡死、临时识别结果重复追加，并让监听中的左下角按钮直接停止语音输入。
- 改进 Agent 面板、欢迎页、设置页和模型配置页的文案与布局，让 Windows Native 状态更清楚。
- `.claude/` 本地工作树缓存已加入忽略列表，避免误提交本地辅助环境。

### 验证

- `npm run check` 通过。
- `npm test` 通过，285 个测试全部成功。
- `npm run build` 通过。
- GitHub CI `verify` 通过。

## Hermes Forge v0.2.7

发布日期：2026-04-29

这是一次模型接入热修版本，重点修复 MiMo V2.5 Pro / Token Plan 以及多类 Coding Plan 在 Hermes CLI 下的 provider、模型名和运行环境兼容问题。

### 修复内容

- 新增 MiMo API 与 MiMo Token Plan（中国区）独立接入：
  - MiMo Token Plan 默认使用 `https://token-plan-cn.xiaomimimo.com/v1`。
  - 模型名统一规范化为 `mimo-v2.5-pro`，避免 `MiMo-V2.5-Pro` 被服务端判定为不支持模型。
  - Hermes CLI 运行时映射为已支持的 `xiaomi` provider。
- 修复部分 Coding Plan 被错误映射成 Hermes CLI 不支持的 `--provider`：
  - DashScope、智谱、百度千帆、腾讯、火山等 OpenAI-compatible Coding Plan 不再强行传入自造 provider 名。
  - Kimi、MiniMax、MiMo 保留 Hermes 内置 provider 路径。
- 修复 MiniMax Token Plan 的 Anthropic / OpenAI 双协议环境变量覆盖问题。
- 模型配置页新增更准确的 Coding Plan 提醒：
  - 区分 Hermes 内置 provider 与 OpenAI-compatible/custom 路由。
  - 避免用户把所有 Coding Plan 都理解为同一种运行方式。

### 性能优化

- Hermes CLI 已经输出正文时，不再额外等待 session 文件读取，减少回复结束阶段的尾部等待。
- WSL `/models` 可达性探测增加短期缓存，降低连续聊天前的重复探测开销。

### 验证

- `npm test -- --run src/shared/model-config.test.ts src/main/runtime-env-resolver.test.ts src/main/hermes-model-sync.test.ts src/adapters/hermes/hermes-cli-adapter.test.ts src/main/model-connection-service.test.ts src/main/model-runtime-proxy.test.ts` 通过。
- `npm run check` 通过。
- `npm run build` 通过。
- `npm run package:win` 通过。
- WSL 端实测 `hermes chat --provider xiaomi --model mimo-v2.5-pro` 返回 `OK`。

## Hermes Forge v0.2.1

发布日期：2026-04-26

这是 v0.2.0 Shell 架构重构之后的一次稳定性 + 接入面拓展版本，重点补齐 Kimi 等 Coding Plan / Token Plan 套餐的接入路径，修复 WSL 与 Windows 两种 runtime 下模型请求构建链路上的若干兼容性问题，并把 Chat 与 Coding Plan 角色配置在写入 Hermes Agent 时的链路彻底分开。

### 修复内容

- 修复 Kimi Coding Plan 套餐 `KIMI_BASE_URL` 拼接出 `/v1/v1/messages` 导致 HTTP 404 的问题：
  - Forge 在写入 Hermes 托管 `.env` 时会去掉 `kimi_coding_api_key` 类型 base URL 末尾的 `/v1`。
  - Hermes Agent 内置的 `_detect_api_mode_for_url()` 会把 `api.kimi.com/coding` 识别为 Anthropic Messages 协议，由 Anthropic SDK 自行追加 `/v1/messages`。
  - 用户在配置面板里仍然按官方文档填写 `https://api.kimi.com/coding/v1`，运行时由 Forge 自动归一。
  - 已在 WSL 端 `hermes chat -q 'Say only OK' --provider kimi-coding` 端到端验证返回 `OK`。
- 修复 Hermes Forge 调用 Hermes CLI 时 `--provider` 参数与套餐 sourceType 不匹配的问题：
  - 新增 `mapSourceTypeToHermesProvider` / `resolveHermesProvider`，按 `kimi_coding_api_key → kimi-coding`、`volcengine_coding_api_key → volcengine-coding`、`zhipu_coding_api_key → zhipu-coding`、`dashscope_coding_api_key → dashscope-coding`、`baidu_qianfan_coding_api_key → baidu-qianfan-coding`、`tencent_token_plan_api_key → tencent-token-plan`、`tencent_hunyuan_token_plan_api_key → tencent-hy-token-plan`、`minimax_token_plan_api_key`/`minimax_api_key`/`minimax_cn_token_plan_api_key`/`stepfun_coding_api_key` 等映射输出 Hermes 端能识别的 provider 名。
  - Forge profile 仍保留 `provider: "custom"`，不影响其他 OpenAI-compatible 接入路径。
- 修复 WSL runtime 下模型 base URL 包含 `127.0.0.1 / localhost / ::1` 时 Hermes Agent 实际访问失败的问题：
  - hermes-cli-adapter 在拼装环境变量时，会把 `OPENAI_BASE_URL`、`AI_BASE_URL`、`ANTHROPIC_BASE_URL` 中的 localhost 改写为 WSL 可见的 Windows 桥接 host。
  - hermes-model-sync 写入托管 `.env` / `config.yaml` 时同样会经过 `toRuntimeReachableBaseUrl` 重写，避免一份配置在 Forge 看得到但在 WSL 内打不通。
- 修复 Hermes Agent 兼容性检查在 WSL CLI 较旧时静默回退、导致界面里看到“可以聊天但实际不会启动”的问题：
  - `negotiateCliCapabilities` 在 WSL 模式下会强制要求 CLI 同时支持 `capabilities --json`、`--launch-metadata`（参数 + 环境变量两种形式）以及 `--resume`，不满足直接报错。
  - 新增的 `cli-adapter` 测试覆盖能力协商失败分支，避免回归。
- 修复 Windows 原生模式下 `testHermesWindowsBridge` 永远返回 `false`、看起来 Windows 桥接没接入的问题：
  - 改为真实调用 `hermes.healthCheck()`，并把错误信息透传到设置页。
- 修复 Coding Plan 套餐被 Forge 自有 chat/tool probe 误判为不可用的问题：
  - `BaseProvider.shouldDelegateToHermesRuntime()` 会按 `definition.badge === "Coding Plan"` 跳过 Forge 自己的 chat 与 tool calling 探测。
  - 改为只跑 WSL 可达性探测 + Hermes CLI capability 协商，把套餐侧 `access_terminated_error` / stainless-headers 拒绝第三方客户端的情况收敛到“委托运行时验证”路径。

### 接入面拓展

- 模型配置中心新增 / 完善 7 类 Coding Plan / Token Plan 套餐：
  - Kimi Coding、Volcengine Coding、DashScope Coding、Zhipu Coding、Baidu Qianfan Coding、Tencent lkeap、Tencent TokenHub、MiniMax Token Plan。
  - 自动按 base URL 推断 sourceType（`coding-intl.dashscope`、`api.z.ai/api/coding/paas/v4`、`api.kimi.com/coding/v1`、`qianfan.baidubce.com/v2/coding`、`api.minimaxi.com/anthropic`、`api.lkeap.cloud.tencent.com/coding/v3`、`tokenhub.tencentmaas.com` 等）。
  - 套餐保存即按 CC Switch 直通模板写入 `.env`，并由 Forge 自动选择对应 Hermes provider 名。
- 新增 Chat 与 Coding Plan 模型角色解析 (`modelRoleAssignments`)：
  - `RuntimeEnvResolver.resolveRoleFromConfig` 区分 chat / coding_plan，缺少角色分配时直接报错而不是回退到 chat 主模型。
  - `hermes-model-sync` 同步时会同时写入 `HERMES_FORGE_CHAT_MODEL_PROFILE_ID`、`HERMES_CODING_PLAN_BASE_URL`、`HERMES_CODING_PLAN_API_KEY` 等环境变量；`HERMES_CODING_PLAN_*` 已写入但当前 Hermes Agent 尚未读取，会显式标注 `consumedByHermes: false` 与等待原生支持的提示。
- 新增 `model-runtime-snapshot` 模块：
  - 把 `defaultModelProfileId / modelRoleAssignments / modelProfiles / providerProfiles` 一并打包进比较快照。
  - 角色分配变化（包括只切 Coding Plan 不动 chat）会触发 Hermes 同步与 runtime 重建。
- 新增 / 增强 `ModelRuntimeProxyService`：
  - 短 API key、本地 endpoint 在送到 Hermes 之前由本地 HTTP 代理重写为可签发的形式。
  - 启动主进程时自动 warmup，关闭时统一进入 shutdown pipeline。

### 用户体验

- 模型配置面板的连接测试结果（`ConnectionTestResult`）增加 `fixSteps`：
  - WSL 不可达时给出中文修复提示（区分 “模型只监听 127.0.0.1” 与 “Windows 防火墙 / WSL 网络问题”）。
- 模型配置向导和设置页对 Coding Plan 套餐显示专属 badge 与说明文案，避免用户误把套餐当作通用 OpenAI-compatible endpoint。
- 新增 `exportMessage` 与 `writeClipboard` IPC，用于在面板里直接导出消息或拷到剪贴板。
- 修复多个面板的 React state / useEffect 闪烁、滚动跳动等小问题。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- `npm run build` 通过，`dist/main/main/index.js` 与 `dist/renderer/index.html` 均产出。
- `package.json` `extraResources` 中所有 ico/icns/bmp/wasm/py/nsh 文件均存在。

### 已知限制

- Hermes Agent 当前仍未读取 `HERMES_CODING_PLAN_*`，Coding Plan 角色被分配的模型不会自动接管 Hermes 的 Coding Plan 任务，目前仅作为 Forge 侧记录，后续随 Hermes Agent 升级一并启用。
- WSL 桥接 host 的发现依赖 `wsl.exe` 输出的 IPv4 地址，在 mirrored networking 模式下若没有 `127.0.0.1` 重定向，需要把模型 endpoint 显式绑定到 `0.0.0.0`。

## Hermes Forge v0.1.19

发布日期：2026-04-24

这是一次面向模型接入和 WSL 既有 Hermes 用户的紧急体验修复版本。重点解决“模型能聊天但 tool calling 检测过不了”“自定义 endpoint 无法保存/测试反馈不清楚”“已有 WSL Hermes 被误判为无效安装”等问题。

### 修复内容

- 模型接入检测更兼容：
  - OpenAI-compatible / OpenRouter / 自定义 endpoint 不再只依赖单一 tool calling 探测方式。
  - 兼容 `tools + tool_choice`、`tool_choice: required/auto`、旧版 `functions/function_call` 等常见实现差异。
  - `/models` 返回空、400、或没有列出手填模型时，不再直接判失败，会以实际 chat/tool probe 结果为准。
- 模型配置保存体验修复：
  - “测试失败但模型可聊天”的配置可以保存为辅助/待确认模型，不再把用户卡死。
  - 主模型能力通过时会自动保存并设为默认模型。
  - 保存/测试异常会在界面上明确显示，而不是看起来点了没反应。
- 模型配置前端交互优化：
  - 点击“立即测试 / 保存并测试 / 自动探测”后，操作区附近会立即显示进行中反馈。
  - 完成后直接显示测试结论、下一步建议、tool calling、context、WSL 可达性等关键信息。
  - 操作后会自动把反馈区滚入视野，避免用户还要手动下滑查找结果。
- WSL 既有 Hermes 接入修复：
  - Managed WSL 安装器会优先发现并接入用户 WSL 里已有的 Hermes CLI。
  - 现有 Hermes 目录只要能运行版本检查和 capability 检查，就会复用，不再轻易提示“无效安装”。
  - 对非标准安装位置增加候选发现和轻量 wrapper 兼容，尽量避免覆盖用户已有环境。

### 已知限制

- 某些模型服务虽然兼容 Chat Completions，但如果服务端确实没有实现工具调用，只能保存为辅助模型，不能直接作为 Hermes 主 Agent 模型。
- 自托管模型的 WSL 可达性仍取决于 Windows localhost、WSL 网络和模型服务绑定地址是否正确。

### 验证

- `npm run check` 通过。
- `npm test` 通过，47 个测试文件、255 个测试。
- `npm run build` 通过。

## Hermes Forge v0.1.18

发布日期：2026-04-24

这是一次紧急补丁版本，重点修复定时任务在 Forge 前端“看起来保存了，但没有真正接入 Hermes Agent 原生 cron 调度”的问题。现在定时任务会走 Hermes 原生 CLI，WSL runtime 下会通过原生 WSL Hermes Agent 写入和触发 cron。

### 修复内容

- 修复 Forge 调用 Hermes cron CLI 参数错误的问题：
  - 新建任务改为 `hermes cron create --name <name> <schedule> <prompt>`。
  - 编辑任务改为 `hermes cron edit <job_id> --name ... --schedule ... --prompt ...`。
  - 删除、暂停、恢复继续走 Hermes 原生命令。
- 修复保存失败后静默写入 fallback JSON，导致任务不会真正被 Hermes scheduler 执行的问题。
- 修复前端读取原生 `jobs.json` 结构错误的问题：
  - 兼容 Hermes 原生 `{ "jobs": [...] }` 结构。
  - 正确展示 `schedule_display`、任务状态、下次运行时间、最后运行状态。
- 修复“立即运行”只标记任务、不实际执行的问题：
  - 现在会先 `hermes cron run <job_id>`。
  - 随后执行 `hermes cron tick`，立即触发 Hermes scheduler。
- 修复定时任务表单不符合 Hermes 规范的问题：
  - 移除 `manual / RRULE` 这类 Hermes 当前不支持的输入提示。
  - 改为间隔、Cron 表达式、指定时间三种规范入口。
  - 默认使用 `every 1h`，任务 prompt 改为必填。
- 新增 Gateway 状态提示：
  - Hermes 原生 cron 自动触发依赖 Gateway。
  - Gateway 未运行时，任务页会提示并提供“启动 Gateway”按钮。

### 已知限制

- Hermes cron 的自动执行仍依赖 Hermes Gateway 运行；Gateway 未运行时，任务会保存但不会按计划自动触发。
- “立即运行”会触发一次 `cron tick`，真实执行仍取决于模型、密钥和当前 Hermes runtime 配置是否可用。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- WSL 原生 Hermes cron smoke 通过：在临时 `HERMES_HOME` 下创建任务并生成原生 `{ jobs: [...] }` 结构。

## Hermes Forge v0.1.17

发布日期：2026-04-24

这是一次面向 Windows + WSL 用户的稳定性和速度打磨版本。重点是降低连续回复的启动等待、修复实验性 WSL Worker 设置无法保存的问题，并改善新电脑首次安装 WSL / Ubuntu / Hermes Agent 时的可恢复体验。

### 新增内容

- 新增实验性“常驻 WSL Worker”灰度开关：
  - 默认关闭，只在 WSL runtime 下生效。
  - 开启后会复用一个常驻 WSL worker，减少连续任务中的 `wsl.exe` 冷启动等待。
  - worker 异常、崩溃或协议失败时会自动回退到普通 WSL CLI 启动链路。
- Agent 技术详情新增 WSL Worker 状态诊断：
  - enabled
  - ready
  - fallback
  - crashed
- Managed WSL 安装链路优化新电脑首次安装：
  - 自动安装 Ubuntu 时优先使用 `wsl.exe --install -d Ubuntu --no-launch`，避免后台卡在 Ubuntu 首次交互初始化。
  - 若 Windows 需要重启或 Ubuntu 需要首次打开初始化，现在会给出明确下一步，而不是显示成模糊失败。

### 修复内容

- 修复“常驻 WSL Worker”在设置页点击开启并保存后又恢复关闭的问题。
- 修复主进程配置保存 schema 未允许 `workerMode`，导致新字段被过滤的问题。
- 优化 WSL Hermes 启动链路的 warmup / preflight / capability / path 缓存，减少重复检测开销。
- 优化首启、聊天输入区、Agent 面板和权限诊断文案，减少普通用户看到内部字段名的机会。
- 修复新电脑 WSL/Ubuntu 尚未初始化时，自动安装流程缺少明确恢复提示的问题。

### 已知限制

- 实验性 WSL Worker 当前只减少 `wsl.exe` / WSL shell 冷启动；每个请求内部仍会启动 Hermes CLI 子进程。
- Windows 首次启用 WSL/虚拟化有时仍需要系统重启。
- Ubuntu 首次初始化仍需要用户打开一次 Ubuntu 并完成用户名/密码设置。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `npm run package:win` 通过。

## Hermes Forge v0.1.13

发布日期：2026-04-23

这是一次把“设置、WSL 主链路、记忆/技能目录、连接器状态和自动更新发布流程”一起收口的可交付版本。重点是让用户只面对一套主设置中心，而且默认更贴近真实开发使用方式：优先 WSL、默认自动放行命令，并把难懂的技术选项改成更容易理解的说明。

### 新增内容

- 主设置中心整合更多运行时能力：
  - 现在可直接在主设置页控制 `Windows / WSL`、Windows 联动方式、文件访问保护、命令审批方式、WSL 发行版和 Python 命令。
  - 工作台里的次级设置入口已改为统一跳转主设置中心，减少双入口混淆。
- 主设置中心新增更直观的状态与诊断信息：
  - 显示“当前正在使用：WSL / Windows”。
  - 新增运行时概览、Windows 联动检查结果和一键诊断入口。

### 修复内容

- 修复知识库里的 `USER.md / MEMORY.md`、SkillsPanel 和 WSL Hermes 实际读取目录不一致的问题，统一到当前 active Hermes home。
- 修复 diagnostics / memory status / permission overview 显示路径与 WSL Hermes 实际运行目录不一致的问题。
- 修复 QQ Bot 因为没有 required 字段而被误判为“已配置”的问题；未填写任何配置时现在会正确显示为“快速配置”。
- 修复 SkillsPanel 出错时没有反馈的问题，读取 / 保存 / 删除失败现在会明确提示原因。
- 将设置页文案改成用户更容易理解的表达，不再直接暴露一堆难懂的技术术语。
- 默认运行取向调整为：优先 WSL，默认 `yolo` 命令审批模式。
- 延续自动更新发布链路修复：Windows 正式更新包仍只使用 NSIS，portable 独立文件名输出，避免覆盖 `latest.yml` 对应产物。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- WSL 记忆 / skills 路径一致性回归测试通过。
- 微信 / QQ 连接器状态与交互回归测试通过。
- 自动更新元数据与 NSIS 安装包一致性验证通过。

## Hermes Forge v0.1.12

发布日期：2026-04-23

这是一次面向自动更新发布链路的修复版本。重点是修复 Windows 安装版与 portable 包在同一文件名下互相覆盖的问题，确保 GitHub release 中的 `latest.yml`、安装包和 blockmap 始终对应同一份 NSIS 更新包，使旧版本可以稳定通过“检测更新”升级到最新版本。

### 修复内容

- 修复 `package:win` 同时构建 NSIS 与 portable 时使用同名 exe、导致自动更新元数据与实际上传文件不一致的问题。
- 将官方 Windows 更新发布链路收口为仅产出 NSIS 安装包，避免 `latest.yml` 指向被 portable 覆盖后的错误文件。
- 将 `package:portable` 调整为独立文件名输出，避免与自动更新安装包互相覆盖。
- 更新发布检查清单，明确 `package:win` 是自动更新正式发布入口，portable 仅作为单独的手动分发包。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `npm run package:win` 通过。
- 重新检查 `release/latest.yml` 与 `Hermes-Forge-0.1.12-x64.exe` 的文件名、大小和哈希来源保持一致。

## Hermes Forge v0.1.11

发布日期：2026-04-23

这是一次面向 Managed WSL 安装稳定性的修复版本。重点是彻底解决 WSL 里 `pip install` 意外落到系统 Python、从而触发 `externally-managed-environment` 的问题，并让安装器界面对虚拟环境状态给出更可信的反馈。

### 修复内容

- 修复 Managed WSL 安装器在 `.venv` 创建失败后仍继续使用系统 Python 执行 `pip install -e .` 的问题。
- 将 `.venv` 创建失败从“跳过继续”改为“立即阻断并提示修复”，避免再次触发 Debian/Ubuntu 的 PEP 668 保护。
- 修复 WSL repair 对 `venv` 的预检过于宽松的问题，改为真实创建临时虚拟环境，而不是只检测 `python3 -m venv --help`。
- 优化安装器面板中的 Venv 状态展示，优先反映实际安装阶段的虚拟环境结果，减少“顶部显示 ok、实际安装失败”的误导。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `npm run package:portable` 通过。
- 新增 `venv` 创建失败回归测试，确认安装流程会在 `pip install` 前阻断。

## Hermes Forge v0.1.10

发布日期：2026-04-23

这是一次面向 WSL 主链路和发布可控性的收口版本。重点是让桌面端回到“壳与控制层”，由 WSL 内的 Hermes CLI 负责会话延续、运行上下文和能力协商；同时，Forge 现在可以绑定并发布固定的 Hermes fork / commit，不再依赖官方上游版本线。

### 新增内容

- WSL Hermes CLI 主链路收口：
  - Forge session 与 Hermes CLI session 建立持久映射，并优先使用 `--resume`。
  - 新增原生 Launch Metadata sidecar，WSL `--query` 回到用户自然输入。
  - Hermes CLI 新增 `capabilities --json` 和 `--launch-metadata` 能力协商。
- 固定 Hermes 受管依赖：
  - Managed WSL installer 支持配置 Hermes 安装源：`repo url / branch / commit / source label`。
  - 当前版本默认使用 pinned fork source，并优先按 commit 安装，而不是仅跟随 branch。
  - 安装完成后会记录实际安装的 Hermes source、commit、version 和 capability gate 结果。
- 权限模型收口：
  - 新增 `permissionPolicy`：`passthrough` / `bridge_guarded` / `restricted_workspace`。
  - `restricted_workspace` 当前无法真实 WSL 隔离时会直接阻断，不再伪装可用。
  - 新增后端权威 Permission Overview，并统一设置页、聊天输入预检条和 Agent 面板的展示口径。
- Managed WSL 链路增强：
  - WSL ready 时新配置默认优先 WSL；不可用时仍回退 Windows。
  - 设置页 WSL 模式下提供 Managed WSL Plan / Repair / Install / Last Report 入口。
- 模型接入整改：
  - 接入流程改为先选 provider family，再选或填写模型。
  - 区分 API Key、OAuth/本地凭据、Custom Endpoint 三类。
  - 保存前后执行 health check：auth、模型发现、最小 chat、agent 能力、WSL 可达性。
  - 模型能力分层为 provider-only、辅助模型、主 agent 模型，避免弱工具模型误设为主模型。

### 修复内容

- 修复 WSL 普通任务默认硬塞 `--yolo` 的问题，默认改为 guarded。
- 移除 WSL 路径下 memory / history / USER / MEMORY / 附件正文 / context bundle 的桌面端 prompt 注入。
- 修复桌面端通过解析 `chat --help` 判断 CLI 能力的不稳定做法，改为正式 capability negotiation。
- 修复 Forge 发布依赖 Hermes 官方后续版本的问题，改为支持固定 Hermes fork / commit 作为受管依赖。
- 修复 custom endpoint 在 WSL 中无法访问 Windows localhost 时缺少明确诊断的问题。
- 修复 provider/key/model 容易错配时反馈过于模糊的问题。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `npm run package:portable` 通过。
- 当前受管 Hermes 源已固定为 pinned fork / commit，并纳入 installer report 与 diagnostics。
- RC Smoke Matrix 覆盖：
  - WSL + bridge_guarded + guarded
  - WSL + passthrough + guarded
  - WSL + bridge_guarded + yolo
  - WSL + restricted_workspace blocked
  - CLI capability gate blocked
  - Bridge capability 未报告
  - sessionMode fresh / resumed / degraded

## Hermes Forge v0.1.9

发布日期：2026-04-23

这是一次聚焦桌面客户端视觉完成度的深色模式打磨版。重点是清理暗色模式下残留的亮色内背景和突兀高亮，让聊天区、会话栏、Agent 面板、支持页与通用控制台模块进入统一的 Surface Levels 深色设计系统。

### 新增内容

- 新增左侧导航栏底部的主题切换按钮：
  - 替代原设置页里的主题下拉。
  - 使用更紧凑的滑块式按钮，带有过渡动画、光晕和图标切换反馈。

### 修复内容

- 深色模式下重新设计左侧导航与会话栏：
  - 主导航选中态不再使用大面积廉价发紫高亮。
  - 会话列表栏彻底深色化，搜索框、会话项和激活态统一进入深灰层级。
- 优化主聊天区与输入区：
  - AI 回复卡片、等待态卡片、输入区、菜单和底部工具区都改为更统一的暗色层级。
  - 搜索会话输入框不再出现刺眼的白色背景。
- 适配 Agent 面板深色模式：
  - 面板容器、Header、卡片和内部浅色小块统一进入深色 Surface。
- 适配支持与反馈页面深色模式：
  - 页面背景、Header、外层卡片、表单、badge、说明卡片和反馈列表都改为暗色系统。
- 适配通用控制台模块深色模式：
  - `Skills / Connectors / Spaces / Tasks` 等面板通过统一的 `panel` 作用域接管内部白卡、表单和按钮背景。

### 验证

- `npm run check` 通过。
- `npm run build` 通过。
- `npm test` 通过。
- 相关 UI 回归：
  - `IconRail`
  - `SessionSidebar`
  - `StatusBar`
  - `DashboardView`
  - `AgentRunPanel`

## Hermes Forge v0.1.8

发布日期：2026-04-23

这是一次面向 Windows 原生能力、桌面核心体验和发布前诊断可靠性的稳定版。重点是让 Windows 原生 Hermes 真正拿到当前有效的 Windows Control Bridge，并把模型、附件、主题和诊断体验补到可交付状态。

### 新增内容

- 模型配置改为多 profile 管理：
  - 同一来源可以保存多个模型，不再互相覆盖。
  - 设置页可查看、编辑、删除非默认模型，并显式设为默认。
  - 聊天输入区的模型按钮可以直接切换默认模型，下一轮任务即时生效。
- 聊天输入区增强：
  - 附件按钮常驻显示，不再只藏在 `+` 菜单。
  - 支持从系统剪贴板粘贴图片作为图片附件。
  - 保留拖拽文件和图片上传能力。
- 主题体验增强：
  - 设置中心新增可见主题切换。
  - 接入高级深灰暗色主题，并保留 OLED 主题枚举。
- 诊断与系统审计增强：
  - 系统能力审计增加模型连通预检，模型服务不可用时快速失败。
  - 诊断导出改为容错导出，子检查失败也会生成报告并记录 `diagnosticErrors`。

### 修复内容

- 修复 Windows Bridge 端口过期导致 Hermes 无法检修 Windows 的问题：
  - 启动、配置刷新和任务前都会同步当前有效 bridge URL/token。
  - Bridge 测试会主动确保 bridge 已启动。
  - MCP server 不再固定使用 `py -3`，Windows 模式会优先使用配置里的 Python。
- 统一 Hermes HOME：
  - 模型同步、连接器 `.env`、Gateway 和 Windows bridge MCP 配置都写入 Forge profile 的 Hermes HOME。
  - 避免一部分链路写 `~/.hermes`，另一部分链路读 Forge profile 的配置。
- 修复 `No module named 'yaml'` 这类 Hermes 依赖问题的体检体验：
  - 识别为 `PyYAML` 缺失。
  - 提供“修复 Hermes 依赖”入口。

### 验证

- `npm run check` 通过。
- `npm run build` 通过。
- `npm test` 通过，34 个测试文件、161 个测试。
- `npx electron . --system-audit` 真实审计通过：
  - 模型连通预检通过。
  - 极限路径读取通过。
  - 工作区外文件写入/回读通过。
  - 大文件读取通过。
  - 宿主 PowerShell 命令执行通过。

## Hermes Forge v0.1.7

发布日期：2026-04-22

这是 v0.1.6 之后的一组稳定性、配置迁移和连接器体验改进，重点是降低真实 Windows 环境中的卡死概率，并让已有 Hermes 用户更容易把本机配置导入 Hermes Forge。

### 新增内容

- 新增 Hermes 既有配置导入：
  - 可从当前 Hermes home 与 active profile 中读取模型和连接器环境变量。
  - 导入时会把敏感值写入本机密钥库，只保存引用到运行配置。
- 新增 Hermes 系统能力审计：
  - 覆盖极限路径读取、工作区外文件写入、大文件读取和宿主命令执行等关键能力。
  - 支持在设置页触发审计，也支持命令行审计模式，便于已有 UI 运行时复测。
- 连接器配置面板增强：
  - 非微信连接器提供更清晰的快速配置模式。
  - 邮箱连接器支持常见服务商预设与自动填充。
  - 微信扫码登录状态机更稳，避免旧进程事件覆盖新一轮登录状态。

### 修复内容

- 修复 Windows headless worker 单轮任务缺少超时的问题：
  - 默认 10 分钟超时并重启 worker，避免单次模型或网络卡住拖死后续回复。
  - 修复旧 worker 关闭事件可能误伤新请求的竞态。
- 修复前端任务事件重复写入的问题：
  - `task:event` 实时消费统一走单入口，减少重复状态更新和渲染压力。
  - 单个 taskRun 的前端事件缓存限制为 800 条，完整历史仍保存在本地 jsonl。
- 优化启动前快照：
  - 全量快照默认最多复制 1200 个文件或约 64MB。
  - 达到预算后写入截断信息并停止继续复制，避免大工作区让发送阶段显得卡住。
- 修复 Hermes Windows MCP 配置写入位置不一致的问题：
  - MCP 配置会写入当前实际运行的 Hermes home，而不是固定写入默认目录。
- 优化附件和本地路径处理：
  - 支持从用户输入中的本地文件路径自动形成附件。
  - 小型文本文件会作为只读内容注入上下文，提升本地资料分析稳定性。

### 验证

- `npm run check` 通过。
- `npm test` 通过，32 个测试文件、156 个测试。
- 新增覆盖：
  - worker 超时后队列恢复。
  - 快照预算截断。
  - 单任务事件缓存上限。
  - Hermes 既有配置导入。
  - 连接器快速配置与邮箱预设。

## Hermes Forge v0.1.6

发布日期：2026-04-22

这是一次面向发布资产和 Windows 图标的修复版。

### 修复内容

- 修复 GitHub 自动更新元数据与 Release 资产文件名不一致的问题：
  - 后续发布统一使用稳定的 `Hermes-Forge-${version}-${arch}` 资产命名。
  - 避免 `latest.yml` 指向不存在的安装包导致旧版本更新失败。
- 修复 Windows 应用程序图标可能未写入 exe 资源的问题：
  - 打包后使用轻量 `rcedit` 钩子写入应用图标，避免依赖 winCodeSign 解压符号链接权限。
  - 保留 `assets/icons/hermes-workbench.ico` 作为安装包和应用图标来源。

### 验证

- 已确认 v0.1.5 的缺失更新资产已补传，旧版客户端可继续下载更新包。
- 建议使用 v0.1.6 安装包验证 Windows 开始菜单、任务栏和窗口图标。

## Hermes Forge v0.1.5

发布日期：2026-04-22

这是一次面向“反馈闭环、更新入口和安装体验”的小版本。重点是让用户可以在客户端提交反馈，小夏可以在个人仪表盘集中查看、回复和删除反馈，同时继续补齐客户端更新检测与 Hermes 安装路径体验。

### 新增内容

- 新增反馈页面：
  - 支持提交意见反馈、问题和建议。
  - 反馈墙默认折叠，用户手动展开后才同步展示。
- 接入小夏个人仪表盘反馈闭环：
  - 客户端提交反馈会先保存在本机，再同步到服务器仪表盘。
  - 仪表盘支持查看反馈、写回复、标记状态和永久删除。
  - 客户端反馈墙会展示服务器侧回复。
- 右上角新增“检查更新”按钮：
  - 支持手动触发客户端更新检查。
  - 下载更新时显示进度状态。

### 优化内容

- Hermes 安装体验增强：
  - 支持从 UI 选择 Hermes 安装目录。
  - 支持打开当前 Hermes 路径。
  - 设置页和运行环境面板显示 Hermes 安装进度。
- 自动安装 Hermes 支持传入自定义安装路径，不再只能依赖环境变量。
- 设置面板补齐“安装到此路径”入口，降低首次部署门槛。

### 验证

- `npm run check` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- `npm run package:portable` 通过。
- 服务器仪表盘 `/hermes-feedback`、反馈提交 API、回复 API 和删除 API 均已验证。

### 已知限制

- 反馈同步依赖默认服务器接口；离线或接口不可用时仍会保存在本机。
- Windows/macOS 安装包仍未商业代码签名。

## Hermes Forge v0.1.4

发布日期：2026-04-22

这是一次面向新电脑首次安装体验的修复版。重点解决“没有预装 Hermes Agent 时，欢迎/安装界面看起来卡住，无法真正傻瓜式部署”的问题。

### 修复内容

- 首启自动安装 Hermes 前会主动检查 Git 和 Python。
- 如果缺少 Git，会尝试通过 winget 自动安装 `Git.Git`，安装后重新检测并继续部署 Hermes。
- 如果缺少 Python，会尝试通过 winget 自动安装 `Python.Python.3.12`，安装后重新检测。
- Python 启动器兼容 `python` 和 `py -3`：
  - pip 依赖安装会复用检测到的 Python launcher。
  - Hermes 自检也会优先使用同一个 launcher。
- `git clone` 和 `pip install` 增加安装心跳事件：
  - 慢网下载或首次安装依赖时，UI 会持续提示仍在运行。
  - 避免用户误以为安装界面卡死。
- 如果安装依赖后当前进程仍检测不到 PATH，会给出明确提示：重启 Hermes Forge 或手动确认 PATH，而不是静默停住。

### 验证

- `npm run check` 通过。
- `npx vitest run src/setup/setup-service.test.ts` 通过，10 个测试。
- `npm test` 通过，29 个测试文件，143 个测试。
- `npm run build` 通过。

## Hermes Forge v0.1.3

发布日期：2026-04-22

这是一次以“真实可用、连续会话、界面收口”为核心的稳定性与体验更新。重点修复了桌面聊天每轮像独立会话的问题，并把工作台主界面、Agent 面板、安装器和发布资源继续打磨到更接近可分发版本的状态。

### 重点修复

- 修复工作台会话上下文失忆：
  - Windows headless worker 和 WSL headless runner 都使用工作台会话 ID 作为 Hermes session id。
  - Renderer 会把当前左侧历史会话最近问答随任务一起传给主进程，作为下一轮上下文兜底。
  - 即使底层 Hermes session 暂时没有恢复，桌面端也能显式承接最近对话。
- 修复第二轮发送被旧健康检查误拦截：
  - 发送按钮不再因为后台 `setupSummary` 中的旧阻塞项一刀切禁用。
  - 仅对模型/密钥缺失、Hermes 真实不可用、写入类任务工作区不可用等关键问题阻断发送。
- 修复左侧会话栏显示不完整：
  - 侧栏改为真正的全高 flex 布局。
  - 会话列表独立滚动，底部导入/导出按钮固定到底部。
  - 会话卡片和长标题不再挤压或溢出。

### 界面体验

- 完成聊天区像素级 polish：
  - 输入框左下角提示改为柔和灰阶，减少警告感。
  - 用户和助手消息正文使用更舒展的中文阅读行高。
  - 精简消息元数据：状态与时间合并，模型/用量标签去边框并弱化视觉比重。
- 优化左侧历史会话栏：
  - 更稳定的最近/收藏视图。
  - 新增折叠入口和更紧凑的会话操作区。
- 优化右侧 Agent 控制面板：
  - 展示当前模型、Token 监控、工具状态、任务过程和会话记忆。
  - 修正 usage 统计，避免同一任务多次 usage 被重复累计。
- 优化顶部 Header 和更多菜单：
  - 帮助入口改为官网入口。
  - 移除重复的文件树入口，减少菜单噪音。

### 运行与发布

- Windows headless worker 持久化接入，降低 Electron GUI 进程中直接拉起交互式 CLI 的控制台兼容风险。
- Release 打包资源补齐：
  - installer 侧边图和 NSIS 自定义脚本迁移到可提交目录。
  - `hermes-headless-worker.py` 加入打包资源。
- 安装器继续使用可选择目录的 NSIS 模式，保留 portable 构建。
- 图标资源更新，Windows/macOS/PNG 图标统一使用新版品牌视觉。

### 验证

- `npm run check` 通过。
- `npm test` 通过，29 个测试文件，141 个测试。
- `npm run build` 通过。
- `npm run package:win` 已在本轮迭代中通过验证，确认安装器资源和 headless worker 资源可进入产物。

### 已知限制

- macOS 包仍未签名，首次打开可能触发系统安全提示。
- Windows 安装包仍未商业代码签名，SmartScreen 提示仍可能出现。
- 微信真实账号、非微信连接器 runtime adapter、安装后首次启动完整人工 smoke 仍建议继续验证。
