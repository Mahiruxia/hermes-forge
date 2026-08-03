import { Globe2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../DashboardPrimitives";

export type InstallSourceChoice = "official" | "mirror";

export function InstallSourceDialog(props: {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onSelect: (kind: InstallSourceChoice) => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.open) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLButtonElement>("[data-install-source]")?.focus(), 0);
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !props.busy) props.onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [props.busy, props.onClose, props.open]);

  if (!props.open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        aria-describedby="install-source-description"
        aria-labelledby="install-source-title"
        aria-modal="true"
        className="w-full max-w-2xl rounded-[22px] border border-slate-200 bg-white shadow-[0_32px_100px_rgba(15,23,42,0.28)]"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 id="install-source-title" className="text-base font-semibold text-slate-950">选择 Hermes Agent 安装来源</h2>
            <p id="install-source-description" className="mt-1 max-w-[58ch] text-sm leading-5 text-slate-500">
              官方源可信优先，国内社区镜像可用性优先。镜像为非官方来源，请按网络情况主动选择。
            </p>
          </div>
          <button
            aria-label="关闭安装来源选择"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
            disabled={props.busy}
            onClick={props.onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-3 px-5 py-4 md:grid-cols-2">
          <InstallSourceOption
            badge="推荐"
            busy={props.busy}
            detail="安装脚本来自 GitHub Raw，仓库为 NousResearch/hermes-agent。适合可以稳定访问 GitHub 的环境。"
            icon={ShieldCheck}
            label="官方 GitHub"
            onClick={() => props.onSelect("official")}
            tone="official"
          />
          <InstallSourceOption
            badge="备用 · 非官方"
            busy={props.busy}
            detail="安装脚本来自中文社区镜像，适合 GitHub、uv 或 Python 依赖下载慢、失败时使用。"
            icon={Globe2}
            label="国内社区镜像"
            onClick={() => props.onSelect("mirror")}
            tone="mirror"
          />
        </div>

        <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-xs leading-5 text-slate-500">
          安装前会记录脚本 URL、大小和 SHA256 到安装日志，便于诊断和追溯。
        </div>
      </div>
    </div>
  );
}

function InstallSourceOption(props: {
  badge: string;
  busy?: boolean;
  detail: string;
  icon: typeof ShieldCheck;
  label: string;
  onClick: () => void;
  tone: "official" | "mirror";
}) {
  const Icon = props.icon;
  return (
    <button
      data-install-source
      className={cn(
        "group flex min-h-40 flex-col items-start rounded-xl border bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60",
        props.tone === "official"
          ? "border-emerald-200 hover:border-emerald-300 hover:shadow-emerald-950/10"
          : "border-amber-200 hover:border-amber-300 hover:shadow-amber-950/10",
      )}
      disabled={props.busy}
      onClick={props.onClick}
      type="button"
    >
      <div className="flex w-full items-start justify-between gap-3">
        <span
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
            props.tone === "official" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700",
          )}
        >
          <Icon size={19} />
        </span>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-[11px] font-semibold",
            props.tone === "official" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700",
          )}
        >
          {props.badge}
        </span>
      </div>
      <span className="mt-3 text-sm font-semibold text-slate-950">{props.label}</span>
      <span className="mt-1 text-xs leading-5 text-slate-500">{props.detail}</span>
      <span className="mt-auto pt-3 text-xs font-semibold text-slate-700 group-hover:text-slate-950">
        使用此来源安装
      </span>
    </button>
  );
}
