import { CalendarClock, Wrench, BookOpen, UserCircle, FolderOpen, FolderKanban, Settings, RefreshCw, ExternalLink } from "lucide-react";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";
import { TasksPanel } from "./panels/TasksPanel";
import { SkillsPanel } from "./panels/SkillsPanel";
import { MemoryPanel } from "./panels/MemoryPanel";
import { ConnectorsPanel } from "./panels/ConnectorsPanel";
import { ProfilesPanel } from "./panels/ProfilesPanel";
import { SpacesPanel } from "./panels/SpacesPanel";
import { ProjectsPanel } from "./panels/ProjectsPanel";
import { SettingsPanel } from "./panels/SettingsPanel";

type PanelId = ReturnType<typeof useAppStore.getState>["activePanel"];

interface PanelConfig {
  id: PanelId;
  label: string;
  icon: typeof CalendarClock;
}

const panels: PanelConfig[] = [
  { id: "tasks", label: "定时任务", icon: CalendarClock },
  { id: "skills", label: "技能", icon: Wrench },
  { id: "memory", label: "记忆", icon: BookOpen },
  { id: "connectors", label: "连接器", icon: ExternalLink },
  { id: "profiles", label: "Agent", icon: UserCircle },
  { id: "spaces", label: "工作区", icon: FolderOpen },
  { id: "projects", label: "项目", icon: FolderKanban },
  { id: "settings", label: "设置", icon: Settings },
];

export function ControlCenter(props: {
  onRefresh: () => Promise<unknown>;
  onOpenSettings: () => void;
  onClearSession: () => void;
  onOpenSessionFolder: () => void;
  onExportDiagnostics: () => void;
}) {
  const store = useAppStore();
  const active = store.activePanel;

  if (active === "chat") return null;

  const activeConfig = panels.find((p) => p.id === active);

  return (
    <div className="hermes-panel-shell flex h-full flex-col">
      <header className="hermes-panel-header flex h-14 items-center justify-between border-b border-slate-100 bg-white px-5 shadow-sm">
        <div className="flex items-center gap-3">
          {activeConfig && (
            <>
              <div className={cn("grid h-9 w-9 place-items-center rounded-xl", active === "settings" ? "bg-slate-100" : "bg-indigo-100")}>
                {activeConfig.icon && <activeConfig.icon size={18} className={active === "settings" ? "text-slate-600" : "text-indigo-600"} />}
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900">{activeConfig.label}</h2>
                <p className="text-xs text-slate-400">{panelDescription(active)}</p>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-slate-500 transition-all hover:bg-slate-100 hover:text-slate-700 active:scale-[0.98]"
            onClick={() => void props.onRefresh()}
            type="button"
          >
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </header>

      <div className="hermes-panel-content custom-scrollbar flex-1 overflow-y-auto p-5">
        <div className="transition-opacity duration-200">
          {active === "tasks" ? <TasksPanel key="tasks" /> : null}
          {active === "skills" ? <SkillsPanel key="skills" /> : null}
          {active === "memory" ? <MemoryPanel key="memory" /> : null}
          {active === "connectors" ? <ConnectorsPanel key="connectors" /> : null}
          {active === "profiles" ? <ProfilesPanel key="profiles" /> : null}
          {active === "spaces" ? <SpacesPanel key="spaces" onSelect={(path) => useAppStore.getState().setWorkspacePath(path)} /> : null}
          {active === "projects" ? <ProjectsPanel key="projects" /> : null}
          {active === "settings" ? <SettingsPanel key="settings" {...props} /> : null}
        </div>
      </div>
    </div>
  );
}

function panelDescription(panel: PanelId): string {
  return {
    chat: "",
    tasks: "管理和配置定时任务",
    skills: "查看和编辑技能文件",
    memory: "管理记忆和用户偏好",
    connectors: "管理第三方服务接入",
    files: "浏览当前工作区文件",
    profiles: "管理多个配置文件",
    spaces: "管理工作区路径",
    projects: "按项目组织会话",
    settings: "应用设置和诊断",
  }[panel] || "";
}
