import { CheckCircle2, XCircle, AlertCircle, Info, X } from "lucide-react";
import { useEffect, useRef, useCallback } from "react";
import { cn } from "./DashboardPrimitives";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  onClose?: () => void;
}

interface ToastProps {
  toast: Toast;
  onClose: (id: string) => void;
}

export function ToastNotification(props: ToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const remainingRef = useRef(props.toast.duration ?? (props.toast.type === "error" ? 8000 : 4500));
  const startRef = useRef(Date.now());

  const startTimer = useCallback(() => {
    startRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      props.onClose(props.toast.id);
    }, remainingRef.current);
  }, [props.onClose, props.toast.id]);

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      remainingRef.current -= Date.now() - startRef.current;
    }
  }, []);

  useEffect(() => {
    startTimer();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [startTimer]);

  const icon = {
    success: <CheckCircle2 size={18} />,
    error: <XCircle size={18} />,
    warning: <AlertCircle size={18} />,
    info: <Info size={18} />,
  };

  const colors = {
    success: "bg-green-50 border-green-200 text-green-800",
    error: "bg-red-50 border-red-200 text-red-800",
    warning: "bg-yellow-50 border-yellow-200 text-yellow-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
  };

  const iconColors = {
    success: "text-green-500",
    error: "text-red-500",
    warning: "text-yellow-500",
    info: "text-blue-500",
  };

  return (
    <div
      role={props.toast.type === "error" ? "alert" : "status"}
      className={cn(
        "group flex items-start gap-3 rounded-xl border px-4 py-3 shadow-[0_16px_42px_rgba(15,23,42,0.13)] transition-all duration-300 animate-slide-in",
        colors[props.toast.type]
      )}
      onMouseEnter={pauseTimer}
      onMouseLeave={startTimer}
    >
      <span className={cn("shrink-0", iconColors[props.toast.type])}>
        {icon[props.toast.type]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{props.toast.title}</p>
        {props.toast.message && <p className="mt-0.5 text-sm opacity-80">{props.toast.message}</p>}
      </div>
      <button
        className="shrink-0 rounded-md opacity-60 transition-opacity hover:opacity-100"
        onClick={() => props.onClose(props.toast.id)}
        type="button"
        aria-label="关闭通知"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export interface ToastContainerProps {
  toasts: Toast[];
  onClose: (id: string) => void;
}

export function ToastContainer(props: ToastContainerProps) {
  if (props.toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex max-w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2" aria-atomic="false" aria-live="polite">
      {props.toasts.map((toast) => (
        <ToastNotification key={toast.id} toast={toast} onClose={props.onClose} />
      ))}
    </div>
  );
}
