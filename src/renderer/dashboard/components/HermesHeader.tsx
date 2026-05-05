import { useEffect, useRef, useState } from "react";
import { ExternalLink, FolderOpen, HeartHandshake, MoreHorizontal, PanelRightOpen, PencilLine, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import type { ClientUpdateEvent, SessionMetaPatch } from "../../../shared/types";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";
import { StatusBar } from "./StatusBar";

export function HermesHeader(props: {
  onRenameSession: (title: string) => void;
  onClearSession: () => void;
  onDeleteActiveSession: () => void;
  onToggleInspector: () => void;
  onToggleWorkspace: () => void;
  onToggleAgentPanel: () => void;
  onUpdateActiveSessionMeta: (patch: SessionMetaPatch) => void;
  onOpenSessionFolder: () => void;
  onOpenSupport: () => void;
  inspectorOpen?: boolean;
  agentPanelOpen?: boolean;
}) {
  const store = useAppStore();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [clientUpdate, setClientUpdate] = useState<ClientUpdateEvent | undefined>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeSession = store.sessions.find((session) => session.id === store.activeSessionId);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
        setConfirmingDelete(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!window.workbenchClient || typeof window.workbenchClient.onClientUpdateEvent !== "function") return;
    return window.workbenchClient.onClientUpdateEvent((event) => {
      setClientUpdate(event);
      setCheckingUpdate(event.status === "checking" || event.status === "downloading");
      const feedback = useAppStore.getState();
      if (event.status === "downloaded") {
        feedback.success("更新已下载", event.message);
      } else if (event.status === "not-available" && event.manual) {
        feedback.success("已是最新版本", event.message);
      } else if (event.status === "error") {
        feedback.error("检查更新失败", event.message);
      }
    });
  }, []);

  function startEditing() {
    if (!activeSession) return;
    setTitleValue(activeSession.title);
    setEditingTitle(true);
  }

  function saveTitle() {
    const nextTitle = titleValue.trim();
    if (nextTitle) props.onRenameSession(nextTitle);
    setEditingTitle(false);
    setTitleValue("");
  }

  function cancelEditing() {
    setEditingTitle(false);
    setTitleValue("");
  }

  async function checkClientUpdate() {
    if (checkingUpdate || !window.workbenchClient || typeof window.workbenchClient.checkClientUpdate !== "function") return;
    setCheckingUpdate(true);
    try {
      const event = await window.workbenchClient.checkClientUpdate();
      setClientUpdate(event);
      const feedback = useAppStore.getState();
      if (event.status === "not-available") {
        feedback.success("已是最新版本", event.message);
      } else if (event.status === "available" || event.status === "downloading") {
        feedback.info("发现更新", event.message);
      } else if (event.status === "downloaded") {
        feedback.success("更新已下载", event.message);
      } else if (event.status === "error") {
        feedback.error("检查更新失败", event.message);
      }
    } catch (error) {
      useAppStore.getState().error("检查更新失败", error instanceof Error ? error.message : "未知错误");
    } finally {
      setCheckingUpdate(false);
    }
  }

  const updateBusy = checkingUpdate || clientUpdate?.status === "checking" || clientUpdate?.status === "downloading";
  const updatePercent = clientUpdate?.status === "downloading" && typeof clientUpdate.percent === "number"
    ? Math.max(0, Math.min(100, Math.round(clientUpdate.percent)))
    : undefined;

  const menuItems: Array<
    | { divider: true }
    | { icon: typeof ExternalLink; label: string; active?: boolean; danger?: boolean; action: () => void }
  > = [
    {
      icon: PanelRightOpen,
      label: props.agentPanelOpen ? "收起 Agent 面板" : "打开 Agent 面板",
      active: props.agentPanelOpen,
      action: () => {
        props.onToggleAgentPanel();
        setShowMenu(false);
        setConfirmingDelete(false);
      },
    },
    {
      icon: Search,
      label: props.inspectorOpen ? "收起搜索与检查器" : "打开搜索与检查器",
      active: props.inspectorOpen,
      action: () => {
        props.onToggleInspector();
        setShowMenu(false);
        setConfirmingDelete(false);
      },
    },
    { divider: true },
    {
      icon: FolderOpen,
      label: "打开会话文件夹",
      action: () => {
        props.onOpenSessionFolder();
        setShowMenu(false);
        setConfirmingDelete(false);
      },
    },
    {
      icon: ExternalLink,
      label: "官网",
      action: () => {
        if (window.workbenchClient && typeof window.workbenchClient.openHelp === "function") {
          window.workbenchClient.openHelp();
        }
        setShowMenu(false);
        setConfirmingDelete(false);
      },
    },
    { divider: true },
    {
      icon: HeartHandshake,
      label: "赞助与反馈",
      action: () => {
        props.onOpenSupport();
        setShowMenu(false);
        setConfirmingDelete(false);
      },
    },
    { divider: true },
    {
      icon: Trash2,
      label: "删除当前会话",
      danger: true,
      action: () => {
        setConfirmingDelete(true);
      },
    },
    {
      icon: Trash2,
      label: "清空会话",
      danger: true,
      action: () => {
        props.onClearSession();
        setShowMenu(false);
        setConfirmingDelete(false);
      },
    },
  ];

  return (
    <header className="hermes-header relative z-40 flex h-12 items-center justify-between border-b border-slate-200/70 bg-white/95 px-3 backdrop-blur-md" role="banner">
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-slate-200/80 bg-slate-950 text-white shadow-[0_6px_16px_rgba(15,23,42,0.10)]"
          title="Hermes Forge"
          aria-label="Hermes Forge"
        >
          <Sparkles size={14} />
        </div>

        {activeSession ? (
          editingTitle ? (
            <div className="flex items-center gap-1.5 rounded-full border border-slate-200/75 bg-white/80 px-1.5 py-1 shadow-[0_8px_22px_rgba(15,23,42,0.05)]">
              <input
                className={inputClass}
                value={titleValue}
                onChange={(event) => setTitleValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveTitle();
                  if (event.key === "Escape") cancelEditing();
                }}
                autoFocus
              />
              <button className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700" onClick={saveTitle} type="button">
                <CheckIcon />
              </button>
              <button className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700" onClick={cancelEditing} type="button">
                <XIcon />
              </button>
            </div>
          ) : (
            <button
              className="group flex h-8 min-w-0 max-w-[280px] items-center gap-2 rounded-full border border-slate-200/75 bg-white/70 px-2.5 text-left shadow-[0_8px_22px_rgba(15,23,42,0.04)] transition hover:border-slate-300 hover:bg-white hover:shadow-[0_10px_26px_rgba(15,23,42,0.07)]"
              onClick={startEditing}
              title={`会话 ID：${activeSession.id}`}
              type="button"
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", sessionStatusDotClass(activeSession.status))} />
              <span className="min-w-0 truncate text-[13px] font-semibold text-slate-900">{activeSession.title}</span>
              <span className="hidden shrink-0 text-[10px] font-medium text-slate-400 sm:inline">{sessionMetaLabel(activeSession.status)}</span>
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-300 opacity-0 transition group-hover:bg-slate-50 group-hover:text-slate-500 group-hover:opacity-100">
                <PencilLine size={11} />
              </span>
            </button>
          )
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        <StatusBar />

        <button
          className={cn(headerActionClass(updateBusy), "relative")}
          onClick={() => void checkClientUpdate()}
          title={updatePercent !== undefined ? `正在下载更新：${updatePercent}%` : "检查更新"}
          aria-label="检查更新"
          disabled={updateBusy}
          type="button"
        >
          <RefreshCw size={15} className={updateBusy ? "animate-spin" : undefined} />
          {updatePercent !== undefined ? (
            <span className="absolute -bottom-1 -right-1 rounded-full bg-slate-950 px-1 text-[9px] font-semibold leading-4 text-white">
              {updatePercent}
            </span>
          ) : null}
        </button>

        <button
          className={headerActionClass(props.inspectorOpen)}
          onClick={props.onToggleInspector}
          title="搜索与检查器"
          aria-label="搜索"
          type="button"
        >
          <Search size={15} />
        </button>

        <button
          className={headerActionClass(props.agentPanelOpen)}
          onClick={props.onToggleAgentPanel}
          title={props.agentPanelOpen ? "收起 Agent 面板" : "打开 Agent 面板"}
          aria-label="Agent 面板"
          type="button"
        >
          <PanelRightOpen size={15} />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            className={headerActionClass(showMenu)}
            onClick={() => {
              setShowMenu((value) => !value);
              setConfirmingDelete(false);
            }}
            aria-label="更多选项"
            title="更多选项"
            type="button"
          >
            <MoreHorizontal size={15} />
          </button>

          {showMenu ? (
            <div className="hermes-popover absolute right-0 top-[calc(100%+10px)] z-[45] w-52 overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 p-1.5 shadow-[0_18px_45px_rgba(15,23,42,0.12)] backdrop-blur-xl">
              {confirmingDelete ? (
                <div className="p-2">
                  <p className="text-[13px] font-semibold text-rose-700">删除当前会话？</p>
                  <p className="mt-1 text-[12px] leading-5 text-slate-500">会删除该会话记录和会话文件夹。项目目录不会被修改。</p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                      onClick={() => setConfirmingDelete(false)}
                      type="button"
                    >
                      取消
                    </button>
                    <button
                      className="rounded-lg bg-rose-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-rose-700"
                      onClick={() => {
                        props.onDeleteActiveSession();
                        setShowMenu(false);
                        setConfirmingDelete(false);
                      }}
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                </div>
              ) : menuItems.map((item, index) => (
                "divider" in item ? (
                  <div key={`divider-${index}`} className="my-1 h-px bg-slate-100" />
                ) : (
                  <button
                    key={item.label}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition",
                      item.danger && "text-rose-600 hover:bg-rose-50",
                      !item.danger && item.active && "bg-slate-100 text-slate-900",
                      !item.danger && !item.active && "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                    )}
                    onClick={item.action}
                    type="button"
                  >
                    <item.icon size={15} />
                    <span>{item.label}</span>
                  </button>
                )
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

const inputClass = "h-7 w-48 rounded-full border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-800 outline-none transition focus:border-slate-300 focus:bg-white";

function headerActionClass(active?: boolean) {
  return cn(
    "hermes-header-action grid h-8 w-8 place-items-center rounded-xl border border-transparent text-slate-500 transition hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900",
    active && "border-slate-200 bg-slate-100 text-slate-900",
  );
}

function sessionMetaLabel(status?: string) {
  if (status === "running") return "运行中";
  if (status === "failed") return "未完成";
  if (status === "completed") return "已完成";
  return "当前";
}

function sessionStatusDotClass(status?: string) {
  if (status === "running") return "bg-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,0.12)]";
  if (status === "failed") return "bg-rose-400 shadow-[0_0_0_3px_rgba(251,113,133,0.12)]";
  if (status === "completed") return "bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.12)]";
  return "bg-slate-300 shadow-[0_0_0_3px_rgba(148,163,184,0.10)]";
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
