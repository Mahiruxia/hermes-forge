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
    label: "Agent 环境",
    description: "安装、路径、状态",
  },
  {
    id: "providers",
    icon: Bot,
    label: "模型",
    description: "来源、测试、默认模型",
  },
  {
    id: "integrations",
    icon: PlugZap,
    label: "扩展",
    description: "技能与连接器入口",
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
  const activeConfig = SECTIONS.find((section) => section.id === props.activeSection) ?? SECTIONS[0];
  return (
    <section className="absolute inset-0 overflow-y-auto bg-[#f4f5f7] text-slate-900 lg:overflow-hidden">
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-5 lg:h-full lg:flex-row lg:gap-5">
        <aside className="h-fit w-full shrink-0 rounded-2xl bg-white p-2.5 shadow-[0_20px_70px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/55 lg:w-[232px]">
          <div className="flex items-start justify-between gap-3 px-3 pb-3 pt-2">
            <div>
              <h1 className="text-[16px] font-semibold tracking-[-0.02em] text-slate-950">
                {props.title ?? "配置中心"}
              </h1>
              <p className="mt-1 max-w-[34ch] text-[11px] leading-4 text-slate-500">
                {props.description ?? "集中管理 Agent、模型、扩展、密钥和诊断。"}
              </p>
            </div>
            <button
              type="button"
              onClick={props.onBack}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 lg:hidden"
              aria-label="返回工作台"
            >
              <ArrowLeft size={14} />
            </button>
          </div>

          <nav className="mt-1 grid grid-cols-2 gap-1 sm:grid-cols-5 lg:block lg:space-y-1" aria-label="设置分区">
            {SECTIONS.map((section) => {
              const active = props.activeSection === section.id;
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => props.onSectionChange(section.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all duration-200 lg:px-3",
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
                        "hidden text-[10px] leading-3 lg:block",
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

          <div className="mt-3 hidden px-2 pb-1 pt-2 lg:block">
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

        <main id="main-content" tabIndex={-1} className="flex min-h-[540px] min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mb-3 flex min-h-[40px] shrink-0 items-end justify-between gap-4 px-1">
            <div>
              <p className="text-[13px] font-semibold text-slate-900">{activeConfig.label}</p>
              <p className="mt-0.5 text-[11px] text-slate-500">{activeConfig.description}</p>
            </div>
            {props.saveNotice ? (
              <span className="max-w-[55%] rounded-lg bg-emerald-50 px-3 py-1.5 text-right text-[11px] font-medium text-emerald-700 shadow-[0_8px_24px_rgba(16,185,129,0.08)] ring-1 ring-emerald-200/60" role="status">
                {props.saveNotice}
              </span>
            ) : null}
          </div>

          <div className="custom-scrollbar flex-1 overflow-y-auto rounded-2xl bg-white p-4 shadow-[0_24px_80px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/45 sm:p-5">
            {props.children}
          </div>
        </main>
      </div>
    </section>
  );
}
