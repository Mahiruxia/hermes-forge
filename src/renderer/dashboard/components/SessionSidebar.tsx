import { Copy, Download, FolderPlus, PanelLeftClose, Pin, Plus, Search, Trash2, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import type { SessionMetaPatch, WorkSession } from "../../../shared/types";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";

export function SessionSidebar(props: {
  onCreateSession: () => void;
  onSelectSession: (session: WorkSession | string) => void;
  onDeleteSession: (session: WorkSession) => void;
  onDuplicateSession: (session: WorkSession) => void;
  onExportSession: (session: WorkSession, format: "json" | "markdown") => void;
  onImportSession: () => void;
  onUpdateSessionMeta: (sessionId: string, patch: SessionMetaPatch) => void;
  onCollapse: () => void;
}) {
  const store = useAppStore();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"recent" | "favorite">("recent");
  const activeId = store.activeSessionId;
  const activeSession = store.sessions.find((session) => session.id === activeId);
  const defaultModel = store.runtimeConfig?.modelProfiles.find((profile) => profile.id === store.runtimeConfig?.defaultModelProfileId)
    ?? store.runtimeConfig?.modelProfiles[0];
  const modelLabel = defaultModel?.model || defaultModel?.name || defaultModel?.id || "gpt-5.4";
  const visibleSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return store.sessions
      .filter((session) => !q || session.title.toLowerCase().includes(q) || session.id.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [query, store.sessions]);
  const sections = tab === "favorite"
    ? [{ title: "收藏", sessions: visibleSessions.filter((session) => session.pinned) }]
    : groupSessions(visibleSessions);
  const shownSessionCount = sections.reduce((count, section) => count + section.sessions.length, 0);

  function togglePin(session: WorkSession) {
    props.onUpdateSessionMeta(session.id, { pinned: !session.pinned });
  }

  return (
    <aside className="hermes-session-sidebar flex h-full min-h-0 w-full shrink-0 flex-col border-r border-slate-200/80 bg-[#fbfbfd] p-2">
      <div className="space-y-2 border-b border-slate-200/70 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <button className="flex h-[34px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[var(--hermes-primary)] px-2.5 text-[12px] font-medium text-white shadow-[0_10px_24px_rgba(91,77,255,0.24)] transition hover:bg-[var(--hermes-primary-strong)]" onClick={props.onCreateSession} type="button">
            <Plus size={14} />
            新建
          </button>
          <button className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-[var(--hermes-primary-soft)] hover:text-[var(--hermes-primary)]" aria-label="隐藏历史会话栏" onClick={props.onCollapse} title="隐藏历史会话栏" type="button">
            <PanelLeftClose size={15} />
          </button>
        </div>
        <div className="hermes-session-search flex h-8 items-center gap-2 rounded-xl border border-[var(--hermes-card-border)] bg-white px-2.5 focus-within:hermes-purple-focus">
          <Search size={13} className="text-slate-400" />
          <input className="hermes-session-search__input min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="flex items-center justify-between px-0.5">
          <button className={tabClass(tab === "recent")} onClick={() => setTab("recent")} type="button">最近</button>
          <button className={tabClass(tab === "favorite")} onClick={() => setTab("favorite")} type="button">收藏</button>
        </div>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-0.5 pt-2">
        {sections.map((section) => (
          <SessionListSection
            key={section.title}
            title={section.title}
            sessions={section.sessions}
            activeId={activeId}
            onSelect={props.onSelectSession}
            onPin={togglePin}
            onDuplicate={props.onDuplicateSession}
            onExport={(session) => props.onExportSession(session, "json")}
            onDelete={props.onDeleteSession}
            modelLabel={modelLabel}
          />
        ))}

        {shownSessionCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-10">
            <FolderPlus size={24} className="text-slate-300" />
            <p className="mt-2 text-[12px] text-slate-400">暂无会话</p>
            <button className="mt-2 rounded-lg px-3 py-1.5 text-[12px] font-medium text-indigo-600 transition-colors hover:bg-white" onClick={props.onCreateSession} type="button">
              新建会话
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-auto shrink-0 border-t border-slate-200/70 px-1 pt-2" data-testid="session-sidebar-footer">
        <div className="flex gap-1">
          <button className={actionButtonClass} onClick={props.onImportSession} title="导入会话" type="button">
            <Upload size={13} />
          </button>
          <button className={actionButtonClass} disabled={!activeSession} onClick={() => activeSession && props.onExportSession(activeSession, "json")} title="导出会话" type="button">
            <Download size={13} />
          </button>
        </div>
      </div>
    </aside>
  );
}

function SessionListSection(props: {
  title: string;
  sessions: WorkSession[];
  activeId?: string;
  onSelect: (session: WorkSession | string) => void;
  onPin: (session: WorkSession) => void;
  onDuplicate: (session: WorkSession) => void;
  onExport: (session: WorkSession) => void;
  onDelete: (session: WorkSession) => void;
  modelLabel: string;
}) {
  if (!props.sessions.length) return null;
  return (
    <section className="mb-2.5 last:mb-0">
      <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">{props.title}</p>
      <div className="grid gap-0.5">
        {props.sessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            active={session.id === props.activeId}
            onSelect={() => props.onSelect(session)}
            onPin={() => props.onPin(session)}
            onDuplicate={() => props.onDuplicate(session)}
            onExport={() => props.onExport(session)}
            onDelete={() => props.onDelete(session)}
            modelLabel={props.modelLabel}
          />
        ))}
      </div>
    </section>
  );
}

const actionButtonClass = "grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white hover:text-slate-700 disabled:opacity-40";

function SessionItem(props: {
  session: WorkSession;
  active: boolean;
  onSelect: () => void;
  onPin: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  modelLabel: string;
}) {
  return (
    <div className={cn("hermes-session-item group rounded-xl px-2.5 py-2 text-[12px] transition-all focus-within:bg-white", props.active ? "is-active bg-[var(--hermes-primary-soft)] text-[var(--hermes-primary)] shadow-sm ring-1 ring-[var(--hermes-primary-border)]" : "text-slate-600 hover:bg-white hover:shadow-sm hover:ring-1 hover:ring-slate-200/70")}>
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", props.active ? "bg-[var(--hermes-primary)] shadow-[0_0_10px_rgba(91,77,255,0.4)]" : props.session.pinned ? "bg-amber-400" : "bg-slate-300/70")} />
        <button className="min-w-0 flex-1 overflow-hidden text-left" onClick={props.onSelect} type="button">
          <span className={cn("block truncate text-[12px] leading-5 text-slate-700", props.active && "font-semibold text-[var(--hermes-primary)]")}>{props.session.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-4 text-slate-400">
            <span className="min-w-0 flex-1 truncate">{sessionSubtitle(props.session, props.modelLabel)}</span>
            <span className="shrink-0">{formatSessionTime(props.session.updatedAt)}</span>
          </span>
        </button>
      </div>
      <div className="mt-1 flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button className={miniButtonClass} onClick={props.onPin} title={props.session.pinned ? "取消收藏" : "收藏"} type="button"><Pin size={10} /></button>
        <button className={miniButtonClass} onClick={props.onDuplicate} title="复制会话" type="button"><Copy size={11} /></button>
        <button className={miniButtonClass} onClick={props.onExport} title="导出" type="button"><Download size={11} /></button>
        <button className="grid h-6 w-6 place-items-center rounded text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600" onClick={props.onDelete} title="删除" type="button"><Trash2 size={11} /></button>
      </div>
    </div>
  );
}

const miniButtonClass = "grid h-6 w-6 place-items-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700";

function tabClass(active: boolean) {
  return cn(
    "relative rounded-lg px-2 py-1 text-[11px] font-medium transition after:absolute after:inset-x-2 after:-bottom-0.5 after:h-0.5 after:rounded-full after:transition",
    active ? "text-[var(--hermes-primary)] after:bg-[var(--hermes-primary)]" : "text-slate-400 after:bg-transparent hover:text-slate-600",
  );
}

function groupSessions(sessions: WorkSession[]) {
  const now = new Date();
  const todayKey = dateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = dateKey(yesterday);
  return [
    { title: "最近", sessions: sessions.filter((session) => dateKey(new Date(session.updatedAt)) === todayKey) },
    { title: "昨天", sessions: sessions.filter((session) => dateKey(new Date(session.updatedAt)) === yesterdayKey) },
    { title: "更早", sessions: sessions.filter((session) => ![todayKey, yesterdayKey].includes(dateKey(new Date(session.updatedAt)))) },
  ];
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function sessionSubtitle(session: WorkSession, modelLabel: string) {
  if (session.status === "running") return "运行中";
  if (session.status === "failed") return "未完成";
  return `Hermes · ${modelLabel}`;
}
