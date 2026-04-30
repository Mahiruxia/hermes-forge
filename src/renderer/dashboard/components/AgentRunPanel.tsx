import {
  Bot,
  Brain,
  Calculator,
  Check,
  ChevronDown,
  Code2,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  PanelRightClose,
  Repeat2,
  Settings2,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { EngineEvent, ModelProfile, PermissionOverview, RuntimeConfig, SessionAgentInsightUsage, TaskEventEnvelope, TaskRunProjection } from "../../../shared/types";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";
import {
  capabilityProbeUserLabel,
  cliPermissionModeUserLabel,
  extractPermissionDiagnostics,
  enforcementMatrix,
  permissionPolicyUserLabel,
  sessionModeUserLabel,
  transportUserLabel,
} from "../permissionModel";

type FixTarget = "model" | "hermes" | "health" | "diagnostics" | "workspace";
type ProgressTone = "complete" | "waiting" | "failed";

export function AgentRunPanel(props: { open?: boolean; onClose?: () => void; onOpenFix?: (target: FixTarget) => void }) {
  const store = useAppStore();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  const [savingKey, setSavingKey] = useState<string | undefined>();
  const activeRun = useMemo(() => resolveActiveRun(store), [
    store.runningTaskRunId,
    store.activeSessionId,
    store.taskRunOrderBySession,
    store.taskRunProjectionsById,
  ]);
  const modelProfile = resolveModelProfile(store.runtimeConfig, activeRun);
  const insight = store.sessionAgentInsight;
  const modelLabel = activeRun?.modelId || insight?.latestRuntime?.modelId || modelProfile?.model || "未配置";
  const hasModel = Boolean(modelProfile?.model || activeRun?.modelId || insight?.latestRuntime?.modelId);
  const contextWindow = insight?.latestRuntime?.contextWindow ?? resolveContextWindow(store, modelProfile, modelLabel);
  const temperature = typeof insight?.latestRuntime?.temperature === "number"
    ? insight.latestRuntime.temperature
    : typeof modelProfile?.temperature === "number"
      ? modelProfile.temperature
      : 0.7;
  const activeEvents = useMemo(() => activeSessionEvents(store), [store.activeSessionId, store.events]);
  const permissionDiagnostics = useMemo(() => extractPermissionDiagnostics(activeEvents), [activeEvents]);
  const usage = activeEvents.some((event) => event.event.type === "usage")
    ? summarizeUsage(activeEvents, contextWindow)
    : usageFromInsight(insight?.usage, contextWindow);
  const toolEvents = activeRun?.toolEvents ?? [];
  const toolCapabilities = buildToolCapabilities(toolEvents, activeEvents, Boolean(store.contextBundle || insight?.memory));
  const enabledCapabilityCount = toolCapabilities.filter((item) => item.active).length;
  const contextUsed = store.contextBundle?.usedCharacters ?? insight?.memory?.usedCharacters ?? 0;
  const contextMax = store.contextBundle?.maxCharacters ?? insight?.memory?.maxCharacters ?? 0;
  const contextPercent = contextMax > 0 ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : 0;
  const settings = store.webUiOverview?.settings;
  const permissions = store.runtimeConfig?.enginePermissions?.hermes;
  const runStatus = activeRun ? runStatusLabel(activeRun.status) : runStatusLabel(insight?.latestRuntime?.status);

  async function updateWebUiSetting(key: "showUsage" | "showCliSessions", value: boolean) {
    setSavingKey(key);
    try {
      const nextSettings = await window.workbenchClient.saveWebUiSettings({ [key]: value });
      store.setWebUiOverview(store.webUiOverview ? { ...store.webUiOverview, settings: nextSettings } : undefined);
      store.success("设置已保存", key === "showUsage" ? "Token 用量显示已更新。" : "CLI 会话显示已更新。");
    } catch (error) {
      store.error("设置保存失败", error instanceof Error ? error.message : "无法保存 Web UI 设置。");
    } finally {
      setSavingKey(undefined);
    }
  }

  async function updateHermesPermission(key: "commandRun" | "fileWrite", value: boolean) {
    if (!store.runtimeConfig) {
      store.error("设置保存失败", "运行时配置尚未加载。");
      return;
    }
    setSavingKey(key);
    try {
      const nextConfig: RuntimeConfig = {
        ...store.runtimeConfig,
        enginePermissions: {
          ...store.runtimeConfig.enginePermissions,
          hermes: {
            ...store.runtimeConfig.enginePermissions?.hermes,
            [key]: value,
          },
        },
      };
      const saved = await window.workbenchClient.saveRuntimeConfig(nextConfig);
      store.setRuntimeConfig(saved);
      store.success("权限已保存", key === "commandRun" ? "命令执行权限已更新。" : "文件写入权限已更新。");
    } catch (error) {
      store.error("权限保存失败", error instanceof Error ? error.message : "无法保存 Hermes 权限配置。");
    } finally {
      setSavingKey(undefined);
    }
  }

  return (
    <aside
      className={cn(
        "hermes-agent-panel flex h-full w-[360px] flex-col overflow-hidden border-l border-slate-200/80 bg-[#f5f6fa] shadow-[-12px_0_32px_rgba(15,23,42,0.06)]",
        !props.open && "pointer-events-none",
      )}
      aria-hidden={!props.open}
      aria-label="Agent 面板"
    >
      <div className="hermes-agent-panel__header flex h-[58px] shrink-0 items-center justify-between border-b border-slate-200/80 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Repeat2 size={16} className="text-slate-500" />
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-semibold tracking-tight text-slate-900">Agent 运行面板</h2>
            <p className="truncate text-[11px] text-slate-400">{runStatus} · {modelLabel}</p>
          </div>
        </div>
        <button
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-white hover:text-slate-900"
          onClick={props.onClose}
          aria-label="关闭 Agent 面板"
          type="button"
        >
          <ChevronDown size={16} />
        </button>
      </div>

      <div className="hermes-agent-panel__content custom-scrollbar flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <PanelCard title="当前模型" action={hasModel ? <ReadyBadge /> : <StatusPill tone="amber">未配置</StatusPill>}>
          <div className="flex items-center gap-3">
            <span data-testid="agent-model-icon" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--hermes-primary-soft)] text-[var(--hermes-primary)] ring-1 ring-[var(--hermes-primary-border)]">
              <Bot size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[17px] font-semibold text-slate-900">{modelLabel}</p>
              <p className="mt-0.5 truncate text-[11px] text-slate-400">{modelProfile?.provider ?? activeRun?.providerId ?? insight?.latestRuntime?.providerId ?? "默认模型配置"}</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 divide-x divide-slate-100 border-t border-slate-100 pt-3">
            <ModelMetric label="上下文窗口" value={contextWindow ? formatCompactNumber(contextWindow) : "未知"} />
            <ModelMetric label="温度" value={temperature.toFixed(1)} />
          </div>
          <button
            className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--hermes-primary-border)] text-[12px] font-semibold text-[var(--hermes-primary)] transition hover:bg-[var(--hermes-primary-soft)]"
            onClick={() => props.onOpenFix?.("model")}
            type="button"
          >
            <Sparkles size={14} />
            更换模型
          </button>
        </PanelCard>

        <PanelCard title={usage.source === "actual" ? "Token 用量" : "Token 估算"} action={usage.hasUsage ? <StatusPill tone="green">{usage.source === "actual" ? "实测" : "约"} {formatCompactNumber(usage.totalTokens)}</StatusPill> : undefined}>
          {usage.hasUsage ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-[12px]">
                <TokenMetric label="估算输入" value={formatCompactNumber(usage.totalInput)} />
                <TokenMetric label="估算输出" value={formatCompactNumber(usage.totalOutput)} />
                <TokenMetric label="估算费用" value={formatCost(usage.totalCost)} />
              </div>
              <div className="mt-3 flex items-center justify-between text-[12px]">
                <span className="text-slate-500">本轮占用</span>
                <span className="font-semibold text-emerald-600">{usage.contextPercent}%</span>
              </div>
              <ProgressBar value={usage.contextPercent} data-testid="agent-token-progress" />
              <p className="mt-2 text-[11px] leading-5 text-slate-400">
                最近一次估算：{formatCompactNumber(usage.latestInput)} in / {formatCompactNumber(usage.latestOutput)} out
              </p>
            </>
          ) : (
            <EmptyInline text="暂无 Token 估算，运行任务后自动汇总。" />
          )}
          {settings?.showUsage === false ? (
            <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-500">
              <span>详细用量已隐藏</span>
              <button className="font-semibold text-[var(--hermes-primary)]" onClick={() => void updateWebUiSetting("showUsage", true)} type="button">
                显示
              </button>
            </div>
          ) : null}
        </PanelCard>

        <PanelCard title="工具状态" action={<StatusPill tone={enabledCapabilityCount ? "green" : "slate"}>{enabledCapabilityCount}/{toolCapabilities.length} 已触发</StatusPill>}>
          <div className="grid grid-cols-2 gap-2">
            {toolCapabilities.map((capability) => (
              <CapabilityChip key={capability.label} {...capability} />
            ))}
          </div>
          <button
            className="mt-3 inline-flex w-full items-center justify-center gap-2 text-[12px] font-semibold text-[var(--hermes-primary)] transition hover:text-[var(--hermes-primary-strong)]"
            onClick={() => setToolsOpen((value) => !value)}
            type="button"
          >
            查看全部工具
            <ChevronDown size={14} className={cn("transition-transform", toolsOpen && "rotate-180")} />
          </button>
          {toolsOpen ? <ToolDetailList events={toolEvents} rawEvents={activeEvents} /> : null}
        </PanelCard>

        <PanelCard title="会话记忆" action={<StatusPill tone="green">{contextPercent}%</StatusPill>}>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-slate-500">已用上下文</span>
            <span className="font-semibold text-slate-600">{formatCompactNumber(contextUsed)} / {contextMax ? formatCompactNumber(contextMax) : "未知"}</span>
          </div>
          <ProgressBar value={contextPercent} data-testid="agent-memory-progress" />
          <div className="mt-3 flex items-center justify-between text-[12px]">
            <span className="font-semibold text-slate-500">记忆摘要</span>
            <button
              className="text-slate-400 transition hover:text-[var(--hermes-primary)]"
              onClick={() => store.info("会话记忆会随任务自动刷新", "当前面板正在读取最新本地状态。")}
              type="button"
            >
              刷新
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-5 text-slate-500">
            {store.contextBundle?.summary || insight?.memory?.summary || "当前会话主要讨论内容会在任务运行后生成摘要。"}
          </p>
          <button className="mt-3 text-[12px] font-semibold text-[var(--hermes-primary)]" onClick={() => store.setActivePanel("memory")} type="button">
            管理记忆
          </button>
        </PanelCard>

        <PanelCard title="任务进度">
          {activeRun ? (
            <>
              <div className="space-y-2">
                {progressRows(activeRun).map((row) => <ProgressRow key={row.label} {...row} />)}
              </div>
              <button
                className="mt-3 inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--hermes-primary)]"
                onClick={() => setTaskDetailsOpen((value) => !value)}
                type="button"
              >
                查看详情
                <ChevronDown size={14} className={cn("transition-transform", taskDetailsOpen && "rotate-180")} />
              </button>
              {taskDetailsOpen ? <EventDetailList events={activeEvents.slice(0, 8)} /> : null}
            </>
          ) : (
            <EmptyInline text="暂无运行中的任务。" />
          )}
        </PanelCard>

        <PanelCard title="权限诊断">
          <PermissionDiagnosticsView diagnostics={permissionDiagnostics} runtimeConfig={store.runtimeConfig} overview={store.permissionOverview} />
        </PanelCard>

        <PanelCard title="快捷设置">
          <div className="space-y-3">
            <SettingToggle
              label="显示 Token 用量"
              active={settings?.showUsage !== false}
              saving={savingKey === "showUsage"}
              onToggle={(value) => void updateWebUiSetting("showUsage", value)}
            />
            <SettingToggle
              label="显示 CLI 会话"
              active={Boolean(settings?.showCliSessions)}
              saving={savingKey === "showCliSessions"}
              onToggle={(value) => void updateWebUiSetting("showCliSessions", value)}
            />
            <SettingToggle
              label="允许命令执行"
              active={permissions?.commandRun !== false}
              saving={savingKey === "commandRun"}
              onToggle={(value) => void updateHermesPermission("commandRun", value)}
            />
            <SettingToggle
              label="允许文件写入"
              active={permissions?.fileWrite !== false}
              saving={savingKey === "fileWrite"}
              onToggle={(value) => void updateHermesPermission("fileWrite", value)}
            />
          </div>
        </PanelCard>
      </div>
    </aside>
  );
}

function resolveActiveRun(store: ReturnType<typeof useAppStore.getState>): TaskRunProjection | undefined {
  if (store.runningTaskRunId && store.taskRunProjectionsById[store.runningTaskRunId]) {
    return store.taskRunProjectionsById[store.runningTaskRunId];
  }
  const order = store.activeSessionId ? store.taskRunOrderBySession[store.activeSessionId] ?? [] : [];
  const latestId = order.at(-1);
  return latestId ? store.taskRunProjectionsById[latestId] : undefined;
}

function resolveModelProfile(runtimeConfig: RuntimeConfig | undefined, activeRun?: TaskRunProjection): ModelProfile | undefined {
  const profiles = runtimeConfig?.modelProfiles ?? [];
  return profiles.find((profile) => activeRun?.modelId && profile.model === activeRun.modelId)
    ?? profiles.find((profile) => profile.id === runtimeConfig?.defaultModelProfileId)
    ?? profiles[0];
}

function resolveContextWindow(store: ReturnType<typeof useAppStore.getState>, modelProfile: ModelProfile | undefined, modelLabel: string) {
  const providerProfiles = store.runtimeConfig?.providerProfiles ?? store.providerProfiles;
  const matchedModel = providerProfiles
    .flatMap((profile) => profile.models)
    .find((model) => model.id === modelLabel || model.label === modelLabel || model.id === modelProfile?.model || model.label === modelProfile?.model);
  return matchedModel?.contextWindow ?? modelProfile?.maxTokens;
}

function activeSessionEvents(store: ReturnType<typeof useAppStore.getState>) {
  if (!store.activeSessionId) return store.events;
  return store.events.filter((event) => event.workSessionId === store.activeSessionId);
}

function summarizeUsage(events: TaskEventEnvelope[], contextWindow?: number) {
  const usageEvents = events.filter((event): event is TaskEventEnvelope & { event: Extract<EngineEvent, { type: "usage" }> } => event.event.type === "usage");
  const latestByTaskRun = new Map<string, Extract<EngineEvent, { type: "usage" }>>();
  for (const usageEvent of usageEvents) {
    const existing = latestByTaskRun.get(usageEvent.taskRunId);
    if (!existing || usageEvent.event.at >= existing.at) {
      latestByTaskRun.set(usageEvent.taskRunId, usageEvent.event);
    }
  }
  const latestEvents = [...latestByTaskRun.values()];
  const totalInput = latestEvents.reduce((sum, event) => sum + event.inputTokens, 0);
  const totalOutput = latestEvents.reduce((sum, event) => sum + event.outputTokens, 0);
  const totalCost = latestEvents.reduce((sum, event) => sum + event.estimatedCostUsd, 0);
  const latest = latestEvents.sort((left, right) => right.at.localeCompare(left.at))[0];
  const latestTotal = (latest?.inputTokens ?? 0) + (latest?.outputTokens ?? 0);
  const latestSource = latest?.source ?? "estimated";
  return {
    hasUsage: usageEvents.length > 0,
    totalInput,
    totalOutput,
    totalTokens: totalInput + totalOutput,
    totalCost,
    latestInput: latest?.inputTokens ?? 0,
    latestOutput: latest?.outputTokens ?? 0,
    source: latestSource,
    contextPercent: contextWindow ? Math.min(100, Math.round((latestTotal / contextWindow) * 100)) : 0,
  };
}

function usageFromInsight(usage: SessionAgentInsightUsage | undefined, contextWindow?: number) {
  return {
    hasUsage: Boolean(usage),
    totalInput: usage?.totalInputTokens ?? 0,
    totalOutput: usage?.totalOutputTokens ?? 0,
    totalTokens: (usage?.totalInputTokens ?? 0) + (usage?.totalOutputTokens ?? 0),
    totalCost: usage?.totalEstimatedCostUsd ?? 0,
    latestInput: usage?.latestInputTokens ?? 0,
    latestOutput: usage?.latestOutputTokens ?? 0,
    source: usage?.source ?? "estimated",
    contextPercent: contextWindow ? Math.min(100, Math.round((((usage?.latestInputTokens ?? 0) + (usage?.latestOutputTokens ?? 0)) / contextWindow) * 100)) : 0,
  };
}

function PermissionDiagnosticsView(props: { diagnostics: ReturnType<typeof extractPermissionDiagnostics>; runtimeConfig?: RuntimeConfig; overview?: PermissionOverview }) {
  if (props.overview) {
    const hard = overviewRows(props.overview.enforcement.hardEnforceable);
    const soft = overviewRows(props.overview.enforcement.softGuarded);
    const missing = overviewRows(props.overview.enforcement.notEnforceableYet);
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <TokenMetric label="运行保护" value={permissionPolicyUserLabel(props.overview.permissionPolicy)} />
          <TokenMetric label="命令确认" value={cliPermissionModeUserLabel(props.overview.cliPermissionMode)} />
          <TokenMetric label="启动方式" value={transportUserLabel(props.overview.transport ?? props.diagnostics.transport ?? "none")} />
          <TokenMetric label="会话状态" value={sessionModeUserLabel(props.overview.sessionMode ?? props.diagnostics.sessionMode ?? "fresh/resume")} />
        </div>
        {props.overview.blockReason ? (
          <PermissionBlockCard block={props.overview.blockReason} />
        ) : null}
        {props.overview.capabilityProbe ? (
          <TechnicalDetails title={`Hermes 能力检测：${capabilityProbeUserLabel(props.overview.capabilityProbe)}`} payload={props.overview.capabilityProbe} />
        ) : null}
        <BoundaryGroup title="桌面端已强制保护" rows={hard} tone="green" />
        <BoundaryGroup title="由 Hermes 确认或提示保护" rows={soft} tone="amber" />
        <BoundaryGroup title="目前只是提醒，未硬限制" rows={missing} tone="rose" />
      </div>
    );
  }
  const runtime = props.runtimeConfig?.hermesRuntime;
  const fallbackRows = enforcementMatrix(runtime);
  const hard = props.diagnostics.hardEnforceable ?? Object.fromEntries(fallbackRows.filter((row) => row.category === "hard-enforceable").map((row) => [row.label, row.detail]));
  const soft = props.diagnostics.softGuarded ?? Object.fromEntries(fallbackRows.filter((row) => row.category === "soft-guarded").map((row) => [row.label, row.detail]));
  const missing = props.diagnostics.notEnforceableYet ?? Object.fromEntries(fallbackRows.filter((row) => row.category === "not-enforceable-yet").map((row) => [row.label, row.detail]));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-[12px]">
        <TokenMetric label="运行保护" value={permissionPolicyUserLabel(props.diagnostics.permissionPolicy ?? runtime?.permissionPolicy ?? "bridge_guarded")} />
        <TokenMetric label="命令确认" value={cliPermissionModeUserLabel(props.diagnostics.cliPermissionMode ?? runtime?.cliPermissionMode ?? "guarded")} />
        <TokenMetric label="启动方式" value={transportUserLabel(props.diagnostics.transport ?? (runtime?.mode === "wsl" ? "native-arg-env" : "windows-headless"))} />
        <TokenMetric label="会话状态" value={sessionModeUserLabel(props.diagnostics.sessionMode ?? "fresh/resume")} />
      </div>
      {props.diagnostics.policyBlock ? (
        <PermissionBlockCard block={props.diagnostics.policyBlock} />
      ) : null}
      {props.diagnostics.capabilityProbe ? (
        <TechnicalDetails title={`Hermes 能力检测：${capabilityProbeUserLabel(props.diagnostics.capabilityProbe)}`} payload={props.diagnostics.capabilityProbe} />
      ) : null}
      {props.diagnostics.wslWorkerDetail ? (
        <TechnicalDetails title={`WSL Worker：${wslWorkerStatusLabel(props.diagnostics.wslWorkerStatus)}`} payload={{ message: props.diagnostics.wslWorkerDetail }} />
      ) : null}
      <BoundaryGroup title="桌面端已强制保护" rows={hard} tone="green" />
      <BoundaryGroup title="由 Hermes 确认或提示保护" rows={soft} tone="amber" />
      <BoundaryGroup title="目前只是提醒，未硬限制" rows={missing} tone="rose" />
    </div>
  );
}

function PermissionBlockCard(props: { block: NonNullable<PermissionOverview["blockReason"]> }) {
  return (
    <div className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
      <p className="font-semibold">{props.block.summary}</p>
      <p className="mt-1 leading-5">{props.block.detail}</p>
      {props.block.fixHint ? <p className="mt-1 font-medium">{props.block.fixHint}</p> : null}
      <details className="mt-1">
        <summary className="cursor-pointer font-semibold">技术详情</summary>
        <p className="mt-1 font-mono text-[11px]">{props.block.code}</p>
      </details>
    </div>
  );
}

function TechnicalDetails(props: { title: string; payload: unknown }) {
  return (
    <details className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
      <summary className="cursor-pointer font-semibold">{props.title}</summary>
      <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-950/90 p-2 text-[11px] leading-4 text-slate-100">
        {JSON.stringify(props.payload, null, 2)}
      </pre>
    </details>
  );
}

function wslWorkerStatusLabel(status?: string) {
  if (status === "ready") return "已复用或启动";
  if (status === "enabled") return "已启用";
  if (status === "fallback") return "已回退";
  if (status === "crashed") return "已崩溃";
  return status || "关闭";
}

function overviewRows(items: string[]) {
  return Object.fromEntries(items.map((item) => {
    const [key, ...rest] = item.split(":");
    return [key.trim() || item.slice(0, 24), rest.join(":").trim() || item];
  }));
}

function BoundaryGroup(props: { title: string; rows: Record<string, string>; tone: "green" | "amber" | "rose" }) {
  const tone = props.tone === "green" ? "text-emerald-600" : props.tone === "amber" ? "text-amber-600" : "text-rose-600";
  const entries = Object.entries(props.rows);
  return (
    <div>
      <p className={cn("mb-1 text-[12px] font-semibold", tone)}>{props.title}</p>
      <div className="space-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-[12px] font-semibold text-slate-700">{key}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-500">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildToolCapabilities(toolEvents: TaskRunProjection["toolEvents"], activeEvents: TaskEventEnvelope[], hasContext: boolean) {
  const labels = [
    ...toolEvents.map((tool) => tool.label),
    ...activeEvents.map((event) => {
      if (event.event.type === "tool_call" || event.event.type === "tool_result") return event.event.toolName;
      if (event.event.type === "file_change") return `file ${event.event.path}`;
      if (event.event.type === "memory_access") return `memory ${event.event.action}`;
      if (event.event.type === "diagnostic") return event.event.category;
      return event.event.type;
    }),
  ].join(" ");
  return [
    { label: "图像理解", icon: ImageIcon, tone: "green" as const, active: /image|vision|analyze|图像/i.test(labels) },
    { label: "代码执行", icon: Code2, tone: "teal" as const, active: /shell|powershell|code|command|execute|代码/i.test(labels) },
    { label: "网页检索", icon: Globe, tone: "blue" as const, active: /web|search|browser|网页|检索/i.test(labels) },
    { label: "文件解析", icon: FileText, tone: "sky" as const, active: /file|write|read|文件/i.test(labels) },
    { label: "计算器", icon: Calculator, tone: "purple" as const, active: /calc|math|计算/i.test(labels) },
    { label: "思维链", icon: Brain, tone: "orange" as const, active: hasContext || /memory|lifecycle|progress|thinking/i.test(labels) },
  ];
}

function PanelCard(props: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="hermes-agent-card rounded-xl border border-slate-200/70 bg-white px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-[var(--hermes-primary)]">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function ReadyBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-emerald-600">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      已就绪
    </span>
  );
}

function StatusPill(props: { children: ReactNode; tone: "green" | "amber" | "slate" }) {
  return (
    <span className={cn(
      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
      props.tone === "green" && "bg-emerald-50 text-emerald-600",
      props.tone === "amber" && "bg-amber-50 text-amber-600",
      props.tone === "slate" && "bg-slate-100 text-slate-500",
    )}>
      {props.children}
    </span>
  );
}

function ModelMetric(props: { label: string; value: string }) {
  return (
    <div className="px-1 first:pl-0 last:pr-0">
      <p className="text-[11px] font-medium text-slate-400">{props.label}</p>
      <p className="mt-1 text-[14px] font-semibold text-slate-700">{props.value}</p>
    </div>
  );
}

function TokenMetric(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-2">
      <p className="text-[10px] font-medium text-slate-400">{props.label}</p>
      <p className="mt-1 truncate text-[13px] font-semibold text-slate-700">{props.value}</p>
    </div>
  );
}

function ProgressBar(props: { value: number; ["data-testid"]?: string }) {
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200/70">
      <div data-testid={props["data-testid"]} className="h-full rounded-full bg-[var(--hermes-primary)] transition-all" style={{ width: `${Math.max(0, Math.min(100, props.value))}%` }} />
    </div>
  );
}

function EmptyInline(props: { text: string }) {
  return <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-3 py-4 text-center text-[12px] leading-5 text-slate-400">{props.text}</div>;
}

function CapabilityChip(props: { label: string; active: boolean; icon: typeof Bot; tone: "green" | "teal" | "blue" | "sky" | "purple" | "orange" }) {
  const Icon = props.icon;
  return (
    <span className={cn(
      "inline-flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] font-semibold transition",
      props.active ? capabilityToneClass(props.tone) : "bg-slate-50 text-slate-400",
    )}>
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{props.label}</span>
    </span>
  );
}

function ToolDetailList(props: { events: TaskRunProjection["toolEvents"]; rawEvents: TaskEventEnvelope[] }) {
  const rawToolEvents = props.rawEvents.filter((event) => event.event.type === "tool_call" || event.event.type === "tool_result").slice(0, 6);
  if (!props.events.length && !rawToolEvents.length) {
    return <p className="mt-3 text-center text-[12px] text-slate-400">暂无工具调用记录。</p>;
  }
  return (
    <div className="mt-3 space-y-1.5">
      {props.events.slice(0, 6).map((event) => (
        <div key={event.id} className="rounded-lg bg-slate-50 px-3 py-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-semibold text-slate-600">{event.label}</span>
            <span className={cn("shrink-0 text-[11px]", event.status === "failed" ? "text-rose-500" : event.status === "running" ? "text-amber-500" : "text-emerald-500")}>{toolStatusLabel(event.status)}</span>
          </div>
          {event.summary ? <p className="mt-1 truncate text-slate-400">{event.summary}</p> : null}
        </div>
      ))}
      {rawToolEvents.map((event, index) => (
        <div key={`${event.taskRunId}-${event.event.at}-${index}`} className="rounded-lg bg-slate-50 px-3 py-2 text-[12px]">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-semibold text-slate-600">{event.event.type === "tool_call" || event.event.type === "tool_result" ? event.event.toolName : "工具事件"}</span>
            <span className="shrink-0 text-[11px] text-slate-400">{event.event.type}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProgressRow(props: { label: string; value: string; tone: ProgressTone }) {
  const complete = props.tone === "complete";
  const failed = props.tone === "failed";
  return (
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded",
          complete && "bg-emerald-500 text-white",
          failed && "bg-rose-500 text-white",
          props.tone === "waiting" && "bg-slate-200 text-white",
        )}>
          {complete ? <Check size={11} /> : failed ? <Check size={11} /> : null}
        </span>
        <span className={cn("truncate font-semibold", complete ? "text-slate-700" : "text-slate-400")}>{props.label}</span>
      </span>
      <span className={cn("shrink-0", complete ? "text-emerald-600" : failed ? "text-rose-500" : "text-slate-400")}>{props.value}</span>
    </div>
  );
}

function EventDetailList(props: { events: TaskEventEnvelope[] }) {
  if (!props.events.length) return <p className="mt-3 text-center text-[12px] text-slate-400">暂无任务事件。</p>;
  return (
    <div className="mt-3 space-y-1.5">
      {props.events.map((event, index) => (
        <div key={`${event.taskRunId}-${event.event.at}-${index}`} className="rounded-lg bg-slate-50 px-3 py-2 text-[12px]">
          <p className="truncate font-semibold text-slate-600">{eventTitle(event.event)}</p>
          <p className="mt-1 truncate text-slate-400">{eventMessage(event.event)}</p>
        </div>
      ))}
    </div>
  );
}

function SettingToggle(props: { label: string; active: boolean; saving: boolean; onToggle: (active: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span className="inline-flex min-w-0 items-center gap-2 font-semibold text-slate-600">
        <Settings2 size={14} className="shrink-0 text-slate-400" />
        <span className="truncate">{props.label}</span>
      </span>
      <button
        className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition", props.active ? "bg-[var(--hermes-primary)]" : "bg-slate-200")}
        onClick={() => props.onToggle(!props.active)}
        disabled={props.saving}
        aria-label={props.label}
        type="button"
      >
        <span className={cn("grid h-5 w-5 place-items-center rounded-full bg-white shadow-sm transition", props.active && "translate-x-5")}>
          {props.saving ? <Loader2 size={11} className="animate-spin text-slate-400" /> : null}
        </span>
      </button>
    </div>
  );
}

function capabilityToneClass(tone: "green" | "teal" | "blue" | "sky" | "purple" | "orange") {
  return cn(
    tone === "green" && "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100",
    tone === "teal" && "bg-teal-50 text-teal-700 ring-1 ring-teal-100",
    tone === "blue" && "bg-blue-50 text-blue-700 ring-1 ring-blue-100",
    tone === "sky" && "bg-sky-50 text-sky-700 ring-1 ring-sky-100",
    tone === "purple" && "bg-[var(--hermes-primary-soft)] text-[var(--hermes-primary)] ring-1 ring-[var(--hermes-primary-border)]",
    tone === "orange" && "bg-orange-50 text-orange-700 ring-1 ring-orange-100",
  );
}

function runStatusLabel(status?: TaskRunProjection["status"]) {
  if (!status) return "空闲";
  if (status === "complete") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "interrupted") return "已中断";
  return "运行中";
}

function progressRows(run: TaskRunProjection): Array<{ label: string; value: string; tone: ProgressTone }> {
  const failed = run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
  const finalStatus = run.status === "cancelled" ? "已取消" : run.status === "interrupted" ? "已中断" : "已失败";
  return [
    { label: "准备运行环境", value: "完成", tone: "complete" },
    { label: "等待模型回复", value: run.status === "routing" ? "等待中" : failed ? finalStatus : "完成", tone: run.status === "routing" ? "waiting" : failed ? "failed" : "complete" },
    { label: "执行工具/文件操作", value: run.toolEvents.length ? `${run.toolEvents.length} 步` : failed ? finalStatus : "等待中", tone: run.toolEvents.length ? "complete" : failed ? "failed" : "waiting" },
    { label: "整理最终回复", value: run.status === "complete" ? "完成" : failed ? finalStatus : "等待中", tone: run.status === "complete" ? "complete" : failed ? "failed" : "waiting" },
  ];
}

function toolStatusLabel(status: TaskRunProjection["toolEvents"][number]["status"]) {
  if (status === "complete") return "完成";
  if (status === "failed") return "失败";
  return "运行中";
}

function eventTitle(event: EngineEvent) {
  if (event.type === "lifecycle") return `生命周期 · ${event.stage}`;
  if (event.type === "progress") return event.step;
  if (event.type === "tool_call" || event.type === "tool_result") return event.toolName;
  if (event.type === "result") return event.title;
  if (event.type === "usage") return "Token 用量";
  return event.type;
}

function eventMessage(event: EngineEvent) {
  if (event.type === "stdout" || event.type === "stderr") return event.line;
  if (event.type === "result") return event.detail;
  if (event.type === "usage") return `${event.source === "actual" ? "实测" : "约"} ${event.inputTokens}+${event.outputTokens} token`;
  if ("message" in event) return event.message;
  if (event.type === "file_change") return event.path;
  return "事件已记录。";
}

function formatCompactNumber(value: number) {
  if (value >= 10000) return `${Math.round(value / 1000)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(value);
}

function formatCost(value: number) {
  if (!value) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
