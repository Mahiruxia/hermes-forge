import type { LucideIcon } from "lucide-react";
import { ArrowLeft, Bot, KeyRound, MonitorCog, PlugZap, ShieldCheck } from "lucide-react";
import { cn } from "../../DashboardPrimitives";

export type ConfigSectionId = "general" | "providers" | "integrations" | "secrets" | "health";

type ConfigSection = {
  id: ConfigSectionId;
  label: string;
  icon: LucideIcon;
  description: string;
};

const SECTIONS: ConfigSection[] = [
  {
    id: "general",
    icon: MonitorCog,
    label: "Agent",
    description: "安装、路径、状态",
  },
  {
    id: "providers",
    icon: Bot,
    label: "Models",
    description: "来源、测试、默认模型",
  },
  {
    id: "integrations",
    icon: PlugZap,
    label: "Skills & Connectors",
    description: "技能与连接器入口",
  },
  {
    id: "secrets",
    icon: KeyRound,
    label: "Keys",
    description: "本地保存状态",
  },
  {
    id: "health",
    icon: ShieldCheck,
    label: "Diagnostics",
    description: "阻塞项与修复",
  },
];

export function ConfigCenterLayout(props: {
  activeSection: ConfigSectionId;
  onSectionChange: (section: ConfigSectionId) => void;
  title?: string;
  description?: string;
  saveNotice?: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="absolute inset-0 overflow-hidden bg-[#FAFAFA] text-slate-900">
      <div className="mx-auto flex h-full w-full max-w-6xl gap-5 px-5 py-4">
        <aside className="h-fit w-[220px] shrink-0 rounded-2xl bg-white/95 p-2.5 shadow-[0_24px_90px_rgba(15,23,42,0.065)] ring-1 ring-slate-200/55 backdrop-blur">
          <div className="px-3 pb-3 pt-2">
            <h1 className="text-[16px] font-semibold tracking-[-0.01em] text-slate-950">
              {props.title ?? "配置中心"}
            </h1>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">
              {props.description ?? "集中管理 Agent、模型、Skills、连接器、密钥和诊断。"}
            </p>
          </div>

          <nav className="mt-1 space-y-1">
            {SECTIONS.map((section) => {
              const active = props.activeSection === section.id;
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => props.onSectionChange(section.id)}
                  className={cn(
                    "relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-all duration-200",
                    active
                      ? "bg-slate-100/80 text-slate-950"
                      : "text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                  )}
                >
                  <span className={cn("absolute left-0 top-2 bottom-2 w-[3px] rounded-full transition", active ? "bg-slate-700" : "bg-transparent")} />
                  <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg transition", active ? "bg-white text-slate-800 shadow-[0_8px_20px_rgba(15,23,42,0.06)]" : "bg-slate-50 text-slate-400")}>
                    <Icon size={15} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0">
                    <span className={cn("block text-[12px]", active ? "font-semibold" : "font-medium")}>
                      {section.label}
                    </span>
                    <span
                      className={cn(
                        "block text-[10px] leading-3",
                        active ? "text-slate-500" : "text-slate-400",
                      )}
                    >
                      {section.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="mt-3 px-2 pb-1 pt-2">
            <button
              type="button"
              onClick={props.onBack}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950 active:translate-y-px"
            >
              <ArrowLeft size={13} />
              返回工作台
            </button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mb-3 flex min-h-[28px] shrink-0 items-center justify-end">
            {props.saveNotice ? (
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-700 shadow-[0_8px_24px_rgba(16,185,129,0.08)] ring-1 ring-emerald-200/60">
                {props.saveNotice}
              </span>
            ) : null}
          </div>

          <div className="custom-scrollbar flex-1 overflow-y-auto rounded-2xl bg-white p-5 shadow-[0_28px_100px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/45">
            {props.children}
          </div>
        </main>
      </div>
    </section>
  );
}
