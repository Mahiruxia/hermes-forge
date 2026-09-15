import { MessageSquare, FolderOpen, BookOpen, Settings, Moon, Sun } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";

type PanelId = ReturnType<typeof useAppStore.getState>["activePanel"];

export function IconRail() {
  const store = useAppStore(useShallow((state) => ({
    activePanel: state.activePanel,
    webUiOverview: state.webUiOverview,
    setActivePanel: state.setActivePanel,
    setView: state.setView,
    setWebUiOverview: state.setWebUiOverview,
  })));
  const dark = store.webUiOverview?.settings.theme === "slate" || store.webUiOverview?.settings.theme === "oled";
  const items: Array<{ id: PanelId; label: string; icon: typeof MessageSquare }> = [
    { id: "chat", label: "聊天", icon: MessageSquare },
    { id: "workspace", label: "工作区", icon: FolderOpen },
    { id: "knowledge", label: "技能与记忆", icon: BookOpen },
  ];

  async function toggleTheme() {
    const current = store.webUiOverview?.settings ?? {
      theme: "green-light" as const,
      language: "zh" as const,
      sendKey: "enter" as const,
      sendKeyHintDismissed: true,
      showUsage: false,
      showCliSessions: true,
    };
    const settings = await window.workbenchClient.saveWebUiSettings({
      theme: dark ? "green-light" : "slate",
    });
    store.setWebUiOverview(store.webUiOverview
      ? { ...store.webUiOverview, settings }
      : { settings: { ...current, ...settings }, projects: [], spaces: [], skills: [], memory: [], crons: [], profiles: [], slashCommands: [] });
  }

  return (
    <nav className="hermes-icon-rail flex h-full w-[68px] shrink-0 flex-col items-center gap-2.5 border-r border-slate-200/70 bg-[#f8f9fb] px-2 py-4">
      {items.map((item) => {
        const Icon = item.icon;
        const active = store.activePanel === item.id;
        return (
          <button
            key={item.id}
            className={cn(
              "hermes-rail-item flex w-full flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2.5 text-slate-500 transition-all duration-200",
              "hover:bg-[var(--hermes-primary-soft)] hover:text-[var(--hermes-primary)]",
              active && "is-active bg-[var(--hermes-primary)] text-white shadow-[0_12px_28px_rgba(91,77,255,0.28)] ring-1 ring-[var(--hermes-primary-border)]"
            )}
            title={item.label}
            type="button"
            onClick={() => store.setActivePanel(item.id)}
          >
            <Icon size={18} strokeWidth={1.5} />
            <span className={cn("text-[11px] font-medium", active && "text-white")}>{item.label}</span>
          </button>
        );
      })}
      
      <div className="my-1 h-px w-8 bg-slate-200" />

      <button
        className="hermes-theme-toggle mt-auto"
        aria-label={dark ? "切换到亮色主题" : "切换到深色主题"}
        title={dark ? "切换到亮色主题" : "切换到深色主题"}
        type="button"
        onClick={() => void toggleTheme()}
      >
        <span className="hermes-theme-toggle__halo" />
        <span className="hermes-theme-toggle__track">
          <span className="hermes-theme-toggle__thumb">
            {dark ? <Moon size={14} strokeWidth={2} /> : <Sun size={14} strokeWidth={2} />}
          </span>
        </span>
      </button>
      
      <button
        className="hermes-rail-item flex w-full flex-col items-center justify-center gap-1 rounded-2xl px-1 py-2.5 text-slate-500 transition-all duration-200 hover:bg-[var(--hermes-primary-soft)] hover:text-[var(--hermes-primary)]"
        aria-label="设置中心"
        title="设置中心"
        type="button"
        onClick={() => store.setView("settings")}
      >
        <Settings size={18} strokeWidth={1.5} />
        <span className="text-[11px] font-medium">设置</span>
      </button>
    </nav>
  );
}
