import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CalendarClock, MonitorCog, PlugZap } from "lucide-react";
import type { RuntimeConfig } from "../../shared/types";
import { useAppStore } from "../store";

type ExtensionSettings = NonNullable<RuntimeConfig["extensionSettings"]>;
const DEFAULT_EXTENSIONS: ExtensionSettings = { connectorsEnabled: false, cronEnabled: false, desktopAutomationEnabled: false };

export function ExtensionsPanel(props: { onRefresh: () => Promise<void>; onOpenEnvironment: () => void }) {
  const { extensionSettings, setRuntimeConfig, setActivePanel, setView } = useAppStore(useShallow(state => ({
    extensionSettings: state.runtimeConfig?.extensionSettings,
    setRuntimeConfig: state.setRuntimeConfig,
    setActivePanel: state.setActivePanel,
    setView: state.setView,
  })));
  const [saving, setSaving] = useState<keyof ExtensionSettings>();
  const [error, setError] = useState("");
  const settings = extensionSettings ?? DEFAULT_EXTENSIONS;
  async function toggle(key: keyof ExtensionSettings, enabled: boolean) {
    if (saving) return;
    setSaving(key);
    setError("");
    try {
      const config = await window.workbenchClient.getRuntimeConfig();
      const saved = await window.workbenchClient.saveRuntimeConfig({ ...config, extensionSettings: { ...DEFAULT_EXTENSIONS, ...config.extensionSettings, [key]: enabled } });
      setRuntimeConfig(saved);
      await props.onRefresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "扩展设置保存失败，请重试。");
    } finally {
      setSaving(undefined);
    }
  }
  const extensions: Array<{ key: keyof ExtensionSettings; label: string; detail: string; icon: typeof PlugZap; open: () => void }> = [
    { key: "connectorsEnabled", label: "消息连接器", detail: "通过微信、飞书等渠道收发消息。", icon: PlugZap, open: () => { setActivePanel("connectors"); setView("home"); } },
    { key: "cronEnabled", label: "定时任务", detail: "按时间安排 Agent 任务或本地脚本。", icon: CalendarClock, open: () => { setActivePanel("tasks"); setView("home"); } },
    { key: "desktopAutomationEnabled", label: "桌面自动化", detail: "使用本机窗口、剪贴板等桌面能力。", icon: MonitorCog, open: props.onOpenEnvironment },
  ];
  return (
    <section className="space-y-4">
      <p className="text-sm leading-6 text-slate-500">启用需要的扩展，再配置具体用途。聊天、文件、技能和记忆可直接使用。</p>
      {error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}
      {extensions.map(extension => {
        const Icon = extension.icon;
        const enabled = settings[extension.key];
        return (
          <section key={extension.key} className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-start gap-3">
              <Icon size={20} className="mt-1 shrink-0 text-[var(--hermes-primary)]" />
              <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold text-slate-900">{extension.label}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{extension.detail}</p></div>
              <button type="button" role="switch" aria-checked={enabled} aria-label={`启用${extension.label}`} disabled={Boolean(saving)} onClick={() => void toggle(extension.key, !enabled)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${enabled ? "bg-[var(--hermes-primary)]" : "bg-slate-200"}`}>
                <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${enabled ? "left-6" : "left-1"}`} />
              </button>
            </div>
            {enabled ? <button type="button" onClick={extension.open} className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700">配置{extension.label}</button> : null}
          </section>
        );
      })}
    </section>
  );
}
