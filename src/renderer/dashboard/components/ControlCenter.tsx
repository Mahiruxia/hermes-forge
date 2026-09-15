import { lazy, Suspense, useEffect } from "react";
import { BookOpen, CalendarClock, FolderOpen, PlugZap, UserCircle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store";

const WorkspacePanel = lazy(() => import("./panels/WorkspacePanel").then(module => ({ default: module.WorkspacePanel })));
const KnowledgePanel = lazy(() => import("./panels/KnowledgePanel").then(module => ({ default: module.KnowledgePanel })));
const TasksPanel = lazy(() => import("./panels/TasksPanel").then(module => ({ default: module.TasksPanel })));
const ConnectorsPanel = lazy(() => import("./panels/ConnectorsPanel").then(module => ({ default: module.ConnectorsPanel })));
const ProfilesPanel = lazy(() => import("./panels/ProfilesPanel").then(module => ({ default: module.ProfilesPanel })));

export function ControlCenter(props: {
  onRefresh: () => Promise<unknown>;
  onOpenSettings: () => void;
  onClearSession: () => void;
  onOpenSessionFolder: () => void;
  onPickWorkspace: () => void;
  onSelectWorkspace: (path: string) => void;
}) {
  const { activePanel, extensionSettings, setActivePanel } = useAppStore(useShallow(state => ({
    activePanel: state.activePanel,
    extensionSettings: state.runtimeConfig?.extensionSettings,
    setActivePanel: state.setActivePanel,
  })));
  const openSettings = props.onOpenSettings;
  useEffect(() => {
    if (activePanel === "settings") {
      setActivePanel("chat");
      openSettings();
    }
  }, [activePanel, setActivePanel, openSettings]);
  if (activePanel === "chat" || activePanel === "settings") return null;
  const disabled = (activePanel === "tasks" && !extensionSettings?.cronEnabled)
    || (activePanel === "connectors" && !extensionSettings?.connectorsEnabled);
  const panel = {
    workspace: { label: "工作区", icon: FolderOpen },
    files: { label: "工作区", icon: FolderOpen },
    knowledge: { label: "技能与记忆", icon: BookOpen },
    tasks: { label: "定时任务", icon: CalendarClock },
    connectors: { label: "消息连接器", icon: PlugZap },
    profiles: { label: "高级 Agent 配置", icon: UserCircle },
  }[activePanel];
  const Icon = panel.icon;
  return (
    <div className="hermes-panel-shell flex h-full flex-col">
      <header className="hermes-panel-header flex h-12 items-center gap-3 border-b border-slate-100 bg-white px-4">
        <Icon size={18} className="text-[var(--hermes-primary)]" />
        <h2 className="text-base font-semibold text-slate-900">{panel.label}</h2>
      </header>
      <div className="hermes-panel-content custom-scrollbar flex-1 overflow-y-auto p-4">
        {disabled ? <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">此扩展尚未启用。<button type="button" className="ml-2 text-[var(--hermes-primary)]" onClick={openSettings}>前往设置</button></div> : (
          <Suspense fallback={<p role="status" className="py-8 text-sm text-slate-500">正在读取…</p>}>
            {activePanel === "workspace" || activePanel === "files" ? <WorkspacePanel onPickWorkspace={props.onPickWorkspace} onSelectWorkspace={props.onSelectWorkspace} /> : null}
            {activePanel === "knowledge" ? <KnowledgePanel /> : null}
            {activePanel === "tasks" ? <TasksPanel /> : null}
            {activePanel === "connectors" ? <ConnectorsPanel /> : null}
            {activePanel === "profiles" ? <ProfilesPanel /> : null}
          </Suspense>
        )}
      </div>
    </div>
  );
}
