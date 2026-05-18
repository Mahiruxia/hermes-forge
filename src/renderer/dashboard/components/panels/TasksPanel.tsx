import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Bot, CalendarClock, Clock3, FileCode2, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { HermesCronJob, HermesGatewayStatus } from "../../../../shared/types";
import { useAppStore } from "../../../store";
import { cn } from "../../DashboardPrimitives";
import { ConfirmCard } from "../ConfirmCard";
import { CronEditor } from "../CronEditor";
import { NoticeCard } from "../NoticeCard";

type JobAction = "delete" | "pause" | "resume" | "run";

export function TasksPanel() {
  const store = useAppStore();
  const jobs = store.webUiOverview?.crons ?? [];
  const [editing, setEditing] = useState<Partial<HermesCronJob> | undefined>();
  const [confirmingDelete, setConfirmingDelete] = useState<HermesCronJob | undefined>();
  const [message, setMessage] = useState("");
  const [gateway, setGateway] = useState<HermesGatewayStatus | undefined>();
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const summary = useMemo(() => {
    const active = jobs.filter((job) => job.status === "active").length;
    const nextJob = jobs
      .filter((job) => job.nextRunAt)
      .sort((left, right) => String(left.nextRunAt).localeCompare(String(right.nextRunAt)))[0];
    return { active, total: jobs.length, nextRun: nextJob?.nextRunAt };
  }, [jobs]);

  useEffect(() => {
    void Promise.all([refresh(), refreshGateway()]).finally(() => setLoading(false));
  }, []);

  async function refresh() {
    try {
      store.setWebUiOverview(await window.workbenchClient.getWebUiOverview());
    } catch {
      setMessage("刷新任务列表失败，请重试。");
    }
  }

  async function refreshGateway() {
    setGateway(await window.workbenchClient.getGatewayStatus().catch(() => undefined));
  }

  async function startGateway() {
    const result = await window.workbenchClient.startGateway();
    setGateway(result.status);
    setMessage(result.message);
  }

  async function runAction(action: JobAction, job: HermesCronJob) {
    setBusyJobId(job.id);
    try {
      const result =
        action === "delete" ? await window.workbenchClient.deleteCronJob(job.id) :
        action === "pause" ? await window.workbenchClient.pauseCronJob(job.id) :
        action === "resume" ? await window.workbenchClient.resumeCronJob(job.id) :
        await window.workbenchClient.runCronJob(job.id);
      setMessage(result.message || `${job.name} 已${actionLabel(action)}`);
      setConfirmingDelete(undefined);
      await refresh();
      await refreshGateway();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${job.name} ${actionLabel(action)}失败。`);
      setConfirmingDelete(undefined);
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_12px_32px_rgba(15,23,42,0.045)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-950 text-white">
                <CalendarClock size={17} />
              </span>
              <GatewayPill running={Boolean(gateway?.running)} loading={loading} />
            </div>
            <h3 className="mt-3 text-xl font-semibold tracking-normal text-slate-950">定时任务</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>{summary.total} 个任务</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>{summary.active} 个启用</span>
              <span className="h-1 w-1 rounded-full bg-slate-300" />
              <span>{summary.nextRun ? `下次 ${formatCronTime(summary.nextRun)}` : "暂无下次运行"}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {!loading && gateway && !gateway.running ? (
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
                onClick={() => void startGateway()}
                type="button"
              >
                <AlertCircle size={14} />
                启动 Gateway
              </button>
            ) : null}
            <button
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
              onClick={() => setEditing({ name: "", schedule: "0 9 * * *", prompt: "", status: "active" })}
              type="button"
            >
              <Plus size={14} />
              新建任务
            </button>
          </div>
        </div>
      </section>

      {message ? <NoticeCard text={message} onClose={() => setMessage("")} /> : null}
      {confirmingDelete ? (
        <ConfirmCard
          title={`删除：${confirmingDelete.name}`}
          body="删除后会从 Hermes cron 中移除该任务。"
          tone="danger"
          onCancel={() => setConfirmingDelete(undefined)}
          onConfirm={() => void runAction("delete", confirmingDelete)}
        />
      ) : null}
      {editing ? <CronEditor value={editing} onChange={setEditing} onCancel={() => setEditing(undefined)} onSave={() => void saveJob()} /> : null}

      {loading ? (
        <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-16">
          <Loader2 size={24} className="animate-spin text-slate-400" />
        </div>
      ) : jobs.length ? (
        <div className="grid gap-2">
          {jobs.map((job) => (
            <CronJobRow
              key={job.id}
              job={job}
              busy={busyJobId === job.id}
              onDelete={() => setConfirmingDelete(job)}
              onEdit={() => setEditing({ ...job })}
              onRun={() => void runAction("run", job)}
              onToggle={() => void runAction(job.status === "active" ? "pause" : "resume", job)}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white py-16">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-50 ring-1 ring-slate-200">
            <CalendarClock size={24} className="text-slate-400" />
          </div>
          <p className="mt-4 text-sm font-medium text-slate-700">暂无定时任务</p>
          <button
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
            onClick={() => setEditing({ name: "", schedule: "0 9 * * *", prompt: "", status: "active" })}
            type="button"
          >
            <Plus size={14} />
            创建第一个任务
          </button>
        </div>
      )}
    </div>
  );

  async function saveJob() {
    const hasScript = Boolean(editing?.script?.trim() || editing?.scriptContent?.trim());
    if (!editing?.name?.trim()) { setMessage("请填写任务名称。"); return; }
    if (!editing.schedule?.trim()) { setMessage("请设置触发时间。"); return; }
    if (editing.noAgent ? !hasScript : !editing.prompt?.trim()) {
      setMessage(editing.noAgent ? "脚本任务需要脚本文件名或脚本内容。" : "请填写提示词。");
      return;
    }
    const job: Partial<HermesCronJob> = {
      id: editing.id,
      name: editing.name.trim(),
      schedule: editing.schedule || "0 9 * * *",
      prompt: editing.prompt || "",
      status: editing.status || "active",
      script: editing.script?.trim(),
      scriptContent: editing.scriptContent,
      noAgent: Boolean(editing.noAgent),
      deliver: editing.deliver?.trim(),
      workdir: editing.workdir?.trim(),
      skills: editing.skills,
    };
    try {
      await window.workbenchClient.saveCronJob(job);
      setEditing(undefined);
      setMessage("任务已保存。");
      await refresh();
      await refreshGateway();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存定时任务失败。");
    }
  }
}

function GatewayPill(props: { running: boolean; loading: boolean }) {
  if (props.loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
        <Loader2 size={12} className="animate-spin" /> 检测中
      </span>
    );
  }
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1",
      props.running ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : "bg-amber-50 text-amber-700 ring-amber-200",
    )}>
      <span className={cn("h-1.5 w-1.5 rounded-full", props.running ? "bg-emerald-500" : "bg-amber-400")} />
      {props.running ? "Gateway 运行中" : "Gateway 未运行"}
    </span>
  );
}

function CronJobRow(props: {
  job: HermesCronJob;
  busy: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onRun: () => void;
  onToggle: () => void;
}) {
  const job = props.job;
  const active = job.status === "active";

  return (
    <section className="group rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.035)] transition hover:border-slate-300">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className={cn(
            "mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1",
            active ? "bg-emerald-50 text-emerald-600 ring-emerald-100" : "bg-slate-50 text-slate-400 ring-slate-200",
          )}>
            {job.noAgent ? <FileCode2 size={18} /> : <Bot size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-slate-950">{job.name}</h3>
              <StatusPill active={active} />
              <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
                {job.noAgent ? "脚本" : "Agent"}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1">
                <Clock3 size={12} />
                {formatSchedule(job.schedule)}
              </span>
              {job.nextRunAt ? <span>下次 {formatCronTime(job.nextRunAt)}</span> : null}
              {job.lastRunAt ? <span>上次 {formatCronTime(job.lastRunAt)}</span> : null}
            </div>
            <p className="mt-2 line-clamp-1 text-[13px] leading-5 text-slate-500">{job.prompt || job.script || "无描述"}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className={cn(
              "relative h-6 w-11 rounded-full transition disabled:opacity-40",
              active ? "bg-slate-950" : "bg-slate-200",
            )}
            disabled={props.busy}
            onClick={props.onToggle}
            title={active ? "暂停" : "启用"}
            type="button"
          >
            <span className={cn("absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition", active ? "left-6" : "left-1")} />
          </button>
          <IconButton icon={Play} label="立即运行" disabled={props.busy} onClick={props.onRun} />
          <IconButton icon={Pencil} label="编辑" disabled={props.busy} onClick={props.onEdit} />
          <IconButton icon={Trash2} label="删除" disabled={props.busy} onClick={props.onDelete} tone="danger" />
        </div>
      </div>
    </section>
  );
}

function StatusPill(props: { active: boolean }) {
  return (
    <span className={cn(
      "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
      props.active ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : "bg-slate-100 text-slate-500 ring-slate-200",
    )}>
      {props.active ? "启用" : "暂停"}
    </span>
  );
}

function IconButton(props: { icon: typeof Play; label: string; disabled?: boolean; onClick: () => void; tone?: "danger" }) {
  const Icon = props.icon;
  return (
    <button
      className={cn(
        "grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40",
        props.tone === "danger" && "text-rose-500 hover:bg-rose-50 hover:text-rose-600",
      )}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      <Icon size={14} />
    </button>
  );
}

function actionLabel(action: JobAction) {
  return ({ delete: "删除", pause: "暂停", resume: "恢复", run: "运行" } as const)[action];
}

function formatCronTime(value: string | undefined) {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatSchedule(value: string | undefined) {
  if (!value) return "未设置";
  const interval = value.match(/^(?:every\s+)?(\d+)\s*([mhd])$/i);
  if (interval) {
    const unit = interval[2].toLowerCase() === "m" ? "分钟" : interval[2].toLowerCase() === "h" ? "小时" : "天";
    return `每 ${interval[1]} ${unit}触发`;
  }
  const daily = value.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
  if (daily) return `每天 ${formatHourMinute(daily[2], daily[1])}`;
  const weekly = value.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\d{1,2})$/);
  if (weekly) return `每${weekdayLabel(weekly[3])} ${formatHourMinute(weekly[2], weekly[1])}`;
  const monthly = value.match(/^(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+\*\s+\*$/);
  if (monthly) return `每月 ${monthly[3]} 号 ${formatHourMinute(monthly[2], monthly[1])}`;
  const once = value.match(/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})/);
  if (once) return `${value.replace("T", " ").slice(0, 16)} 触发一次`;
  return value;
}

function formatHourMinute(hour: string, minute: string) {
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function weekdayLabel(value: string) {
  return ({ "0": "周日", "1": "周一", "2": "周二", "3": "周三", "4": "周四", "5": "周五", "6": "周六" } as Record<string, string>)[value] ?? `周${value}`;
}
