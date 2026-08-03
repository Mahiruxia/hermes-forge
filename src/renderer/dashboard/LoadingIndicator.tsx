import { Loader2, Sparkles } from "lucide-react";
import { cn } from "./DashboardPrimitives";

interface LoadingProps {
  size?: "sm" | "md" | "lg";
  text?: string;
  inline?: boolean;
}

export function LoadingIndicator(props: LoadingProps) {
  const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
  };

  const textSizeClasses = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-base",
  };

  if (props.inline) {
    return (
      <span className="inline-flex items-center gap-2">
        <Loader2 className={cn(sizeClasses[props.size || "sm"], "animate-spin")} strokeWidth={1.5} />
        {props.text && <span className={textSizeClasses[props.size || "sm"]}>{props.text}</span>}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3">
      <Loader2 className={cn(sizeClasses[props.size || "lg"], "animate-spin text-indigo-600")} strokeWidth={1.5} />
      {props.text && <p className={cn("text-slate-500", textSizeClasses[props.size || "lg"])}>{props.text}</p>}
    </div>
  );
}

export function PageLoader() {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#f4f5f7]/95 px-5 backdrop-blur-sm" role="status" aria-live="polite">
      <div className="w-full max-w-sm rounded-[24px] bg-white p-6 shadow-[0_28px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-200/70">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-[13px] bg-slate-950 text-white">
            <Sparkles size={17} />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">正在恢复工作台</p>
            <p className="mt-0.5 text-xs text-slate-500">载入会话、工作区和运行状态</p>
          </div>
        </div>
        <div className="mt-6 space-y-2.5" aria-hidden="true">
          <div className="h-10 w-full animate-pulse rounded-xl bg-slate-100" />
          <div className="h-10 w-[86%] animate-pulse rounded-xl bg-slate-100" />
          <div className="h-10 w-[68%] animate-pulse rounded-xl bg-slate-100" />
        </div>
        <p className="sr-only">正在加载应用数据</p>
      </div>
    </div>
  );
}

export function PulseLoader() {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <div className="h-2 w-2 animate-bounce rounded-full bg-indigo-500" style={{ animationDelay: "0ms" }} />
      <div className="h-2 w-2 animate-bounce rounded-full bg-indigo-400" style={{ animationDelay: "150ms" }} />
      <div className="h-2 w-2 animate-bounce rounded-full bg-indigo-300" style={{ animationDelay: "300ms" }} />
    </div>
  );
}
