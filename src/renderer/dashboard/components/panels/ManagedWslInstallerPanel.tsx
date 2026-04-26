import { useMemo, useState } from "react";
import { AlertCircle, BookOpen, CheckCircle2, ClipboardList, Hammer, Loader2, PlayCircle, RefreshCw, Wrench } from "lucide-react";
import type {
  ManagedWslInstallerDependencyResult,
  ManagedWslInstallerIpcResult,
  ManagedWslInstallerReport,
  ManagedWslInstallerStatus,
} from "../../../../shared/types";
import { useManagedWslInstaller } from "../../../hooks/useManagedWslInstaller";

export function ManagedWslInstallerPanel(props: {
  title?: string;
  onAfterAction?: () => Promise<unknown> | unknown;
  onNotice?: (message: string, detail?: string, tone?: "success" | "warning" | "error") => void;
}) {
  const { result, report, loadingAction, refreshLastReport, planInstall, dryRunRepair, executeRepair, install } = useManagedWslInstaller();
  const [showRaw, setShowRaw] = useState(false);
  const blockingIssues = useMemo(() => readDoctorItems(report?.lastDoctor, "blockingIssues"), [report?.lastDoctor]);
  const recommendedActions = useMemo(() => readStringList(report?.lastDoctor, "recommendedActions"), [report?.lastDoctor]);
  const dryRunActions = useMemo(() => readRepairActions(report?.lastDryRunRepair), [report?.lastDryRunRepair]);
  const executeDisabled = loadingAction !== undefined || !report?.lastDryRunRepair;
  const installDisabled = loadingAction !== undefined;

  async function runAction(action: () => Promise<ManagedWslInstallerIpcResult>) {
    const next = await action();
    await props.onAfterAction?.();
    if (!next.ok) {
      props.onNotice?.(next.summary, next.fixHint ?? next.detail, "error");
      return next;
    }
    props.onNotice?.(next.summary, next.detail, next.code === "manual_action_required" || next.code === "unsupported" ? "warning" : "success");
    return next;
  }

  return (
    <section className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardList size={16} className="text-slate-500" />
            <h3 className="text-sm font-semibold text-slate-900">{props.title ?? "WSL Hermes Agent 安装器"}</h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            这是独立的 WSL 安装入口，不属于一键修复。用于安装或恢复 Ubuntu 下的 Hermes Agent。
          </p>
        </div>
        <StatusPill
          label={report?.finalInstallerState ?? result?.status ?? "unknown"}
          tone={toneForStatus(report?.status ?? result?.status)}
        />
      </div>

      <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">安装 WSL 版 Hermes Agent</p>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">
              自动检查 WSL，安装或连接 Ubuntu，修复 Python/Git/Pip/Venv，安装 Hermes Agent，并完成可用性验证。
            </p>
          </div>
          <ActionButton
            icon={PlayCircle}
            label="安装 WSL 版 Hermes Agent"
            busy={loadingAction === "install"}
            disabled={installDisabled}
            variant="primary"
            onClick={() => void runAction(install)}
          />
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          首次安装 Ubuntu 时，Windows 可能要求重启或打开 Ubuntu 完成用户名初始化。完成后再次点击本按钮会从可恢复阶段继续。
          如果自动安装反复失败，可
          <a
            href="https://hermesagent.org.cn/docs/getting-started/windows-installation"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-indigo-600 underline hover:text-indigo-700"
          >
            查看手动安装教程
          </a>
          。
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton icon={ClipboardList} label="检查安装条件" busy={loadingAction === "plan"} disabled={loadingAction !== undefined} onClick={() => void runAction(planInstall)} />
        <ActionButton icon={Wrench} label="预演修复" busy={loadingAction === "dry_run_repair"} disabled={loadingAction !== undefined} onClick={() => void runAction(dryRunRepair)} />
        <ActionButton icon={Hammer} label="仅执行修复" busy={loadingAction === "execute_repair"} disabled={executeDisabled} onClick={() => void runAction(executeRepair)} />
        <ActionButton icon={RefreshCw} label="读取上次结果" busy={loadingAction === "get_last_report"} disabled={loadingAction !== undefined} onClick={() => void runAction(refreshLastReport)} />
      </div>

      {result ? (
        <div className={`mt-4 rounded-xl border px-4 py-3 ${panelToneClass(result)}`}>
          <div className="flex items-start gap-2">
            {result.ok ? <CheckCircle2 size={16} className="mt-0.5 text-emerald-600" /> : <AlertCircle size={16} className="mt-0.5 text-amber-600" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">{result.summary}</p>
              <p className="mt-1 text-xs text-slate-600">
                {`状态 ${result.status} · 阶段 ${result.phase} · 代码 ${result.code}`}
              </p>
              {result.detail ? <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-600">{result.detail}</p> : null}
              {result.fixHint ? <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 text-xs leading-5 text-slate-600">建议：{result.fixHint}</p> : null}
            </div>
          </div>
        </div>
      ) : null}

      {report ? (
        <div className="mt-4 space-y-4">
          <MetricGrid report={report} />

          <InfoCard title="安装前检查">
            <InfoRow label="当前状态" value={report.finalInstallerState} />
            <InfoRow label="Code" value={report.code} />
            <InfoRow label="结论" value={report.summary} />
            {report.detail ? <InfoRow label="说明" value={report.detail} multiline /> : null}
            {report.fixHint ? <InfoRow label="建议" value={report.fixHint} multiline /> : null}
            {blockingIssues.length ? (
              <div className="mt-3 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">当前阻塞项</p>
                {blockingIssues.map((issue, index) => (
                  <div key={`${issue.code}-${index}`} className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <p className="font-semibold">{issue.summary}</p>
                    <p className="mt-1">代码：{issue.code}</p>
                    {issue.fixHint ? <p className="mt-1">建议：{issue.fixHint}</p> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {recommendedActions.length ? (
              <div className="mt-3 space-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">建议操作</p>
                {recommendedActions.map((item) => <p key={item} className="text-xs text-slate-600">{item}</p>)}
              </div>
            ) : null}
          </InfoCard>

          <InfoCard title="修复预演">
            <DependencyStatusRow label="Python" value={report.pythonStatus} />
            <DependencyStatusRow label="Git" value={report.gitStatus} />
            <DependencyStatusRow label="Pip" value={report.pipStatus} />
            <DependencyStatusRow label="Venv" value={report.venvStatus} />
            {dryRunActions.length ? (
              <div className="mt-3 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">计划执行项</p>
                {dryRunActions.map((action, index) => (
                  <div key={`${action.actionId}-${index}`} className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    <p className="font-semibold">{action.description}</p>
                    <p className="mt-1">会变更：{String(action.wouldChange)} · 需要手动处理：{String(Boolean(action.manualActionRequired))}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words">{action.expectedOutcome}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">当前还没有修复预演结果，先点击上方按钮生成。</p>
            )}
          </InfoCard>

          <InfoCard title="安装结果">
            {report.hermesSource ? <InfoRow label="Hermes 来源" value={`${report.hermesSource.sourceLabel} · ${report.hermesSource.repoUrl}`} multiline /> : null}
            {report.hermesSource?.branch ? <InfoRow label="跟踪分支" value={report.hermesSource.branch} /> : null}
            {report.hermesSource?.commit ? <InfoRow label="固定 Commit" value={report.hermesSource.commit} /> : null}
            {report.hermesCommit ? <InfoRow label="实际安装 Commit" value={report.hermesCommit} /> : null}
            {report.hermesVersion ? <InfoRow label="Hermes 版本" value={report.hermesVersion} /> : null}
            {report.hermesCapabilityProbe ? <InfoRow label="能力门槛" value={report.hermesCapabilityProbe.minimumSatisfied ? "通过" : `未通过 · 缺失 ${(report.hermesCapabilityProbe.missing ?? []).join(", ") || "unknown"}`} multiline /> : null}
            <InfoRow label="代码仓库" value={`${report.repoStatus.status} · ${report.repoStatus.code} · ${report.repoStatus.summary}`} multiline />
            <InfoRow label="依赖安装" value={`${report.installStatus.status} · ${report.installStatus.code} · ${report.installStatus.summary}`} multiline />
            <InfoRow label="健康检查" value={`${report.healthStatus.status} · ${report.healthStatus.code} · ${report.healthStatus.summary}`} multiline />
            {report.reprobeStatus ? <InfoRow label="安装后 Reprobe" value={report.reprobeStatus} /> : null}
            {report.reDoctorStatus ? <InfoRow label="安装后 Re-doctor" value={report.reDoctorStatus} /> : null}
          </InfoCard>

          <InfoCard title="报告详情">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => setShowRaw((value) => !value)}
              >
                {showRaw ? "隐藏详情" : "查看详情"}
              </button>
              {report.reportPath ? <span className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] text-slate-500">{report.reportPath}</span> : null}
            </div>
            {showRaw ? (
              <div className="mt-3 space-y-3">
                <RawBlock title="lastDoctor" value={report.lastDoctor} />
                <RawBlock title="lastDryRunRepair" value={report.lastDryRunRepair} />
                <RawBlock title="lastRepairExecution" value={report.lastRepairExecution} />
                <RawBlock title="lastCreateDistro" value={report.lastCreateDistro} />
                <RawBlock title="lastHermesInstall" value={report.lastHermesInstall} />
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">这里可以查看完整的 doctor、repair、创建 distro 和 Hermes 安装结果，方便定位问题或导出排查。</p>
            )}
          </InfoCard>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
          还没有受管安装报告。可以先读取上次结果，或者从“获取 Plan”开始。
        </div>
      )}
    </section>
  );
}

function MetricGrid(props: { report: ManagedWslInstallerReport }) {
  const installedVenvStatus = props.report.lastHermesInstall?.venvStatus as
    | { state?: string; path?: string; detail?: string }
    | undefined;
  const installedVenv = installedVenvStatus
    ? `${installedVenvStatus.state ?? "unknown"} · ${installedVenvStatus.path ?? installedVenvStatus.detail ?? "unknown"}`
    : `${props.report.venvStatus.status} · ${props.report.venvStatus.code}`;
  const items = [
    { label: "WSL 发行版", value: props.report.distroName ?? "unknown" },
    { label: "安装目录", value: props.report.managedRoot ?? "unknown" },
    { label: "Hermes 来源", value: props.report.hermesSource ? `${props.report.hermesSource.sourceLabel} · ${props.report.hermesSource.repoUrl}` : "unknown" },
    { label: "Hermes Commit", value: props.report.hermesCommit ?? props.report.hermesSource?.commit ?? "unknown" },
    { label: "Hermes 版本", value: props.report.hermesVersion ?? props.report.hermesCapabilityProbe?.cliVersion ?? "unknown" },
    { label: "Python", value: `${props.report.pythonStatus.status} · ${props.report.pythonStatus.code}` },
    { label: "Git", value: `${props.report.gitStatus.status} · ${props.report.gitStatus.code}` },
    { label: "Pip", value: `${props.report.pipStatus.status} · ${props.report.pipStatus.code}` },
    { label: "Venv", value: installedVenv },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{item.label}</p>
          <p className="mt-1 break-words text-sm font-medium text-slate-800 [overflow-wrap:anywhere]">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

function DependencyStatusRow(props: { label: string; value: ManagedWslInstallerDependencyResult }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-800">{props.label}</p>
          <p className="mt-1 text-xs text-slate-600">{props.value.summary}</p>
        </div>
        <StatusPill label={`${props.value.status} · ${props.value.code}`} tone={toneForCode(props.value.code)} />
      </div>
      {props.value.fixHint ? <p className="mt-2 text-xs text-slate-500">建议：{props.value.fixHint}</p> : null}
    </div>
  );
}

function InfoCard(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4">
      <h4 className="text-sm font-semibold text-slate-900">{props.title}</h4>
      <div className="mt-3 space-y-2">{props.children}</div>
    </div>
  );
}

function InfoRow(props: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="grid gap-1 md:grid-cols-[120px_1fr] md:items-start">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{props.label}</span>
      <span className={`text-xs text-slate-700 ${props.multiline ? "whitespace-pre-wrap break-words" : "break-words"}`}>{props.value}</span>
    </div>
  );
}

function RawBlock(props: { title: string; value: unknown }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{props.title}</p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
        {JSON.stringify(props.value ?? null, null, 2)}
      </pre>
    </div>
  );
}

function ActionButton(props: {
  icon: typeof ClipboardList;
  label: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "default" | "primary";
}) {
  const Icon = props.icon;
  const className = props.variant === "primary"
    ? "inline-flex items-center gap-2 rounded-lg border border-indigo-600 bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
    : "inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={className}
    >
      {props.busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
      {props.label}
    </button>
  );
}

function StatusPill(props: { label: string; tone: "ok" | "warning" | "danger" | "neutral" }) {
  const className =
    props.tone === "ok"
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : props.tone === "warning"
        ? "bg-amber-50 text-amber-700 border-amber-100"
        : props.tone === "danger"
          ? "bg-rose-50 text-rose-700 border-rose-100"
          : "bg-slate-100 text-slate-600 border-slate-200";
  return <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${className}`}>{props.label}</span>;
}

function panelToneClass(result: ManagedWslInstallerIpcResult) {
  if (result.code === "unsupported" || result.code === "manual_action_required") return "border-amber-100 bg-amber-50";
  if (!result.ok) return "border-rose-100 bg-rose-50";
  return "border-emerald-100 bg-emerald-50";
}

function toneForStatus(status?: ManagedWslInstallerStatus) {
  if (status === "completed" || status === "ready") return "ok";
  if (status === "blocked" || status === "failed") return "danger";
  if (status === "running") return "warning";
  return "neutral";
}

function toneForCode(code: ManagedWslInstallerIpcResult["code"]) {
  if (code === "ok") return "ok";
  if (code === "manual_action_required" || code === "unsupported") return "warning";
  return "danger";
}

function readDoctorItems(source: unknown, key: string) {
  if (!source || typeof source !== "object") return [] as Array<{ code: string; summary: string; fixHint?: string }>;
  const value = (source as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      code: typeof (item as Record<string, unknown>).code === "string" ? String((item as Record<string, unknown>).code) : "unknown",
      summary: typeof (item as Record<string, unknown>).summary === "string" ? String((item as Record<string, unknown>).summary) : "unknown",
      fixHint: typeof (item as Record<string, unknown>).fixHint === "string" ? String((item as Record<string, unknown>).fixHint) : undefined,
    }));
}

function readStringList(source: unknown, key: string) {
  if (!source || typeof source !== "object") return [] as string[];
  const value = (source as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readRepairActions(source: unknown) {
  if (!source || typeof source !== "object") return [] as Array<{ actionId: string; description: string; wouldChange: boolean; manualActionRequired?: boolean; expectedOutcome: string }>;
  const value = (source as Record<string, unknown>).actions;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      actionId: typeof (item as Record<string, unknown>).actionId === "string" ? String((item as Record<string, unknown>).actionId) : "unknown",
      description: typeof (item as Record<string, unknown>).description === "string" ? String((item as Record<string, unknown>).description) : "unknown",
      wouldChange: Boolean((item as Record<string, unknown>).wouldChange),
      manualActionRequired: Boolean((item as Record<string, unknown>).manualActionRequired),
      expectedOutcome: typeof (item as Record<string, unknown>).expectedOutcome === "string" ? String((item as Record<string, unknown>).expectedOutcome) : "",
    }));
}
