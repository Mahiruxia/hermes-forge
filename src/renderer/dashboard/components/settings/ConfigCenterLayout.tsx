import { cn } from "../../DashboardPrimitives";

export type ConfigSectionId = "general" | "providers" | "secrets" | "health";

type ConfigSection = {
  id: ConfigSectionId;
  label: string;
  icon: string;
  description: string;
};

const SECTIONS: ConfigSection[] = [
  {
    id: "general",
    icon: "🎛️",
    label: "常规设置",
    description: "Hermes 运行与权限",
  },
  {
    id: "providers",
    icon: "🤖",
    label: "模型提供商",
    description: "模型来源与连接测试",
  },
  {
    id: "secrets",
    icon: "🔑",
    label: "密钥管理",
    description: "保存和维护 API Key",
  },
  {
    id: "health",
    icon: "🩺",
    label: "系统状态",
    description: "检查环境与阻塞项",
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
    <section className="absolute inset-0 overflow-auto bg-[#f6f7f9] text-slate-900">
      <div className="mx-auto flex min-h-full w-full max-w-7xl gap-6 px-6 py-6">
        <aside className="sticky top-0 h-fit w-[260px] shrink-0 rounded-2xl border border-slate-200/60 bg-white/90 p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur">
          <div className="border-b border-slate-200/70 px-3 pb-4 pt-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              Config Center
            </p>
            <h1 className="mt-2 text-[18px] font-semibold tracking-tight text-slate-950">
              {props.title ?? "配置中心"}
            </h1>
            <p className="mt-1 text-[12px] leading-5 text-slate-500">
              {props.description ?? "集中管理 Hermes、模型、密钥和系统健康状态。"}
            </p>
          </div>

          <nav className="mt-3 space-y-1">
            {SECTIONS.map((section) => {
              const active = props.activeSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => props.onSectionChange(section.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-all",
                    active
                      ? "bg-slate-900 text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-100/80 hover:text-slate-900",
                  )}
                >
                  <span className="mt-0.5 text-[16px]">{section.icon}</span>
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
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50"
            >
              返回工作台
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-3xl">
            <div className="mb-4 flex min-h-[40px] items-center justify-end">
              {props.saveNotice ? (
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[12px] font-medium text-emerald-700">
                  {props.saveNotice}
                </span>
              ) : null}
            </div>

            <div className="rounded-2xl border border-slate-200/60 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              {props.children}
            </div>
          </div>
        </main>
      </div>
    </section>
  );
}
