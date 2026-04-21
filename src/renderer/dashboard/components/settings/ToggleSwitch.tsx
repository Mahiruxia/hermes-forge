import { cn } from "../../DashboardPrimitives";

export function ToggleSwitch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      className="flex w-full items-center justify-between gap-4 rounded-2xl border border-slate-200/70 bg-white px-4 py-4 text-left transition hover:border-slate-300/80 hover:bg-slate-50/80"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-slate-900">{props.label}</span>
        {props.description ? (
          <span className="mt-1 block text-[12px] leading-5 text-slate-500">{props.description}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "relative inline-flex h-7 w-12 shrink-0 rounded-full p-0.5 transition-all",
          props.checked ? "bg-slate-900" : "bg-slate-200",
        )}
      >
        <span
          className={cn(
            "h-6 w-6 rounded-full bg-white shadow-[0_1px_2px_rgba(15,23,42,0.18)] transition-all",
            props.checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}
