import { Download, FolderOpen, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import { useAppStore } from "../store";
import { cn, formatShortDate } from "./DashboardPrimitives";

export function ContextInspector(props: {
  open: boolean;
  onClose: () => void;
  onRefreshFileTree: () => void;
  onRestoreSnapshot: () => void;
  onExportDiagnostics: () => void;
  onOpenSessionFolder: () => void;
}) {
  const store = useAppStore();
  const memory = store.hermesStatus?.memory;
  const health = store.hermesStatus?.engine;
  const permissions = store.runtimeConfig?.enginePermissions?.hermes;

  return (
    <aside className={cn("absolute right-0 top-0 z-50 flex h-full w-[380px] max-w-[92vw] flex-col bg-[#f9f9fa]/95 shadow-[-20px_0_60px_rgba(0,0,0,0.08)] backdrop-blur-2xl transition-transform duration-300", props.open ? "translate-x-0" : "translate-x-full")}>
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <div>
          <p className="text-[13px] font-semibold text-slate-900">Hermes 工具区</p>
          <p className="text-[11px] text-slate-400">快照恢复、诊断导出、记忆状态与运行过程</p>
        </div>
        <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" onClick={props.onClose} type="button">
          <X size={16} />
        </button>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <Panel title="常用工具">
          <p className="text-[12px] leading-5 text-slate-500">这里放恢复、诊断和文件类操作，不再打扰主聊天流程。</p>
          <div className="grid grid-cols-2 gap-2">
            <button className="inline-flex h-9 items-center justify-center gap-2 rounded-lg text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800" onClick={props.onOpenSessionFolder} type="button">
              <FolderOpen size={14} />
              会话文件
            </button>
            <button className="inline-flex h-9 items-center justify-center gap-2 rounded-lg text-[12px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40" onClick={props.onRestoreSnapshot} type="button" disabled={!store.snapshots.length || Boolean(store.locks.length)}>
              <RotateCcw size={14} />
              恢复快照
            </button>
            <button className="col-span-2 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-indigo-600 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-indigo-700" onClick={props.onExportDiagnostics} type="button">
              <Download size={14} />
              导出 Hermes 诊断
            </button>
          </div>
        </Panel>

        <Panel title="Hermes 状态">
          <Metric label="CLI" value={health?.available ? "可用" : "待配置"} tone={health?.available ? "green" : "amber"} />
          <Metric label="路径" value={health?.path ?? "未检测"} />
          <Metric label="MEMORY.md" value={memory?.maxCharacters ? `${memory.usedCharacters}/${memory.maxCharacters} 字符` : `${memory?.usedCharacters ?? 0} 字符`} tone="green" />
          <Metric label="记忆文件" value={memory?.filePath ?? "未检测"} />
        </Panel>

        <Panel title="权限状态">
          <Permission label="读取项目" enabled={permissions?.workspaceRead !== false} />
          <Permission label="写入文件" enabled={permissions?.fileWrite !== false} />
          <Permission label="运行命令" enabled={permissions?.commandRun !== false} />
          <Permission label="读取记忆" enabled={permissions?.memoryRead !== false} />
          <Permission label="快照回滚" enabled />
        </Panel>

        <Panel title="恢复与安全">
          <Metric label="文件锁" value={store.locks[0] ? store.locks[0].message : "空闲"} tone={store.locks[0] ? "amber" : "green"} />
          <Metric label="选中文件" value={`${store.selectedFiles.length} 个`} />
          <p className="text-[12px] leading-5 text-slate-500">如果 Hermes 改坏了文件，优先回这里看最近快照；恢复不会删除快照之后新增的文件。</p>
          <div className="space-y-2">
            {store.snapshots.slice(0, 4).map((snapshot) => (
              <div key={snapshot.snapshotId} className="rounded-xl bg-[#f9f9fa] px-3 py-2 text-[12px] text-slate-500">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-slate-700">{formatShortDate(snapshot.createdAt)}</p>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-500">{snapshot.mode ?? "full"}</span>
                </div>
                <p className="mt-1">复制 {snapshot.copiedFiles} 个文件 · 跳过 {snapshot.skippedFiles} 个</p>
                {snapshot.scopedPaths?.length ? <p className="mt-1 text-slate-400">恢复范围：{snapshot.scopedPaths.slice(0, 2).join("、")}{snapshot.scopedPaths.length > 2 ? " …" : ""}</p> : null}
              </div>
            ))}
            {!store.snapshots.length && <p className="text-[12px] text-slate-400">暂无可恢复快照。</p>}
          </div>
        </Panel>

        <Panel title="最近过程">
          <p className="text-[12px] leading-5 text-slate-500">这里只看最近的关键运行痕迹；更完整的过程应通过聊天区的“查看过程”理解。</p>
          <div className="space-y-2">
            {store.events.slice(-8).reverse().map((event, index) => (
              <div key={`${event.taskRunId}-${index}`} className="rounded-xl bg-white px-3 py-2 text-[12px] shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <p className="font-medium text-slate-700">{eventTitle(event.event)}</p>
                <p className="mt-0.5 break-words text-slate-400 [overflow-wrap:anywhere]">{eventMessage(event.event)}</p>
              </div>
            ))}
            {!store.events.length && <p className="text-[12px] text-slate-400">暂无运行事件。</p>}
          </div>
        </Panel>
      </div>

      <div className="shrink-0 px-4 py-3 text-[11px] text-slate-400">
        工具区负责快照、诊断、记忆与过程查看；主工作台只保留任务输入与结果展示。
      </div>
    </aside>
  );
}

function Panel(props: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-400">{props.title}</h3>
      <div className="space-y-2 rounded-2xl bg-white p-4 shadow-[0_8px_30px_rgba(0,0,0,0.04)] ring-1 ring-slate-100/60">{props.children}</div>
    </section>
  );
}

function Metric(props: { label: string; value: string; tone?: "green" | "amber" | "slate" }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-slate-400">{props.label}</span>
      <span className={cn("break-words text-right font-medium [overflow-wrap:anywhere]", props.tone === "green" ? "text-indigo-700" : props.tone === "amber" ? "text-amber-700" : "text-slate-700")}>{props.value}</span>
    </div>
  );
}

function Permission(props: { label: string; enabled: boolean }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="inline-flex items-center gap-2 text-slate-600"><ShieldCheck size={13} />{props.label}</span>
      <span className={props.enabled ? "text-indigo-700" : "text-rose-700"}>{props.enabled ? "开启" : "关闭"}</span>
    </div>
  );
}

function eventTitle(event: import("../../shared/types").EngineEvent) {
  if (event.type === "lifecycle") return `生命周期 · ${event.stage}`;
  if (event.type === "progress") return event.step;
  if (event.type === "tool_call" || event.type === "tool_result") return event.toolName;
  if (event.type === "result") return event.title;
  return event.type;
}

function eventMessage(event: import("../../shared/types").EngineEvent) {
  if (event.type === "stdout") return event.line;
  if (event.type === "stderr") return event.line;
  if (event.type === "result") return event.detail;
  if ("message" in event) return event.message;
  if (event.type === "file_change") return event.path;
  return "事件已记录。";
}
