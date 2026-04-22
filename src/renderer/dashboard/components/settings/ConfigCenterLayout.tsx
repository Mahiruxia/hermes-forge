import type { LucideIcon } from "lucide-react";
import { ArrowLeft, Bot, KeyRound, MonitorCog, ShieldCheck } from "lucide-react";
import { cn } from "../../DashboardPrimitives";

export type ConfigSectionId = "general" | "providers" | "secrets" | "health";

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
    label: "Hermes",
    description: "路径、预热、权限",
  },
  {
    id: "providers",
    icon: Bot,
    label: "模型",
    description: "来源、测试、默认模型",
  },
  {
    id: "secrets",
    icon: KeyRound,
    label: "密钥",
    description: "本地保存状态",
  },
  {
    id: "health",
    icon: ShieldCheck,
    label: "诊断",
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
    <section className="absolute inset-0 overflow-auto bg-[#f7f8fa] text-slate-900">
      <div className="mx-auto flex min-h-full w-full max-w-6xl gap-5 px-6 py-6">
        <aside className="sticky top-0 h-fit w-[232px] shrink-0 rounded-2xl border border-slate-200/70 bg-white p-3 shadow-[0_18px_60px_rgba(15,23,42,0.06)]">
          <div className="px-3 pb-3 pt-2">
            <h1 className="text-[18px] font-semibold tracking-tight text-slate-950">
              {props.title ?? "配置中心"}
            </h1>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              {props.description ?? "集中管理 Hermes、模型、密钥和系统健康状态。"}
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
                    "flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-all",
                    active
                      ? "bg-slate-950 text-white shadow-[0_10px_24px_rgba(15,23,42,0.12)]"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
                  )}
                >
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", active ? "bg-white/12 text-white" : "bg-slate-100 text-slate-500")}>
                    <Icon size={16} strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      {section.label}
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 block text-[11px]",
                        active ? "text-white/70" : "text-slate-400",
                      )}
                    >
                      {section.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="mt-4 border-t border-slate-200/70 px-3 pt-4">
            <button
              type="button"
              onClick={props.onBack}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50"
            >
              <ArrowLeft size={14} />
              返回工作台
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-4xl">
            <div className="mb-4 flex min-h-[40px] items-center justify-end">
              {props.saveNotice ? (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] font-medium text-emerald-700">
                  {props.saveNotice}
                </span>
              ) : null}
            </div>

            <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
              {props.children}
            </div>
          </div>
        </main>
      </div>
    </section>
  );
}
