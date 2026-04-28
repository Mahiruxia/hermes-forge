import { AlertCircle, CheckCircle2, ChevronDown, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { ModelConnectionTestResult } from "../../../../../shared/types";
import { cn } from "../../../DashboardPrimitives";
import { healthStepLabel, isCodingPlanSourceType, MIN_AGENT_CONTEXT, roleLabel } from "./modelConfigUtils";
import { StatusBadge } from "./StatusBadge";
import type { BusyAction, OperationNotice } from "./types";

/**
 * Collapsible connection-test summary.
 *
 * The default view is one short success/failure line. Health-check details are
 * hidden until the user expands them, keeping the form calm during normal use.
 */
export function ConnectionTestResult(props: {
  busyAction?: BusyAction;
  notice?: OperationNotice;
  testResult?: ModelConnectionTestResult;
  formBlockingHint?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const tone = props.notice?.tone ?? resultTone(props.testResult) ?? (props.formBlockingHint ? "warning" : "info");
  const title = props.notice?.title ?? resultTitle(props.testResult) ?? (props.formBlockingHint ? "还差一步" : "准备测试");
  const message = props.notice?.message ?? props.testResult?.message ?? props.formBlockingHint ?? "填写必要字段后，可以直接测试或保存并测试。";

  return (
    <section aria-live="polite" className={cn("rounded-[22px] px-4 py-3 text-[12px] shadow-[0_16px_46px_rgba(15,23,42,0.04)] ring-1", toneClass(tone))}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold">
            {props.busyAction ? <Loader2 size={15} className="animate-spin" /> : tone === "success" ? <CheckCircle2 size={15} /> : tone === "error" ? <AlertCircle size={15} /> : <ShieldCheck size={15} />}
            <span>{title}</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap leading-6">{message}</p>
        </div>
        {props.testResult?.healthChecks?.length ? (
          <button className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-white/70 px-2.5 py-1.5 font-semibold shadow-[0_8px_18px_rgba(15,23,42,0.04)] transition hover:bg-white active:translate-y-px" onClick={() => setExpanded((value) => !value)} type="button">
            详情
            <ChevronDown size={13} className={cn("transition", expanded && "rotate-180")} />
          </button>
        ) : null}
      </div>

      {props.testResult ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {props.testResult.agentRole ? <StatusBadge label={roleLabel(props.testResult.agentRole, props.testResult.sourceType)} tone={props.testResult.agentRole === "primary_agent" ? "success" : "warning"} /> : null}
          {typeof props.testResult.supportsTools === "boolean" ? <StatusBadge label={props.testResult.supportsTools ? "支持工具调用" : "不支持工具调用"} tone={props.testResult.supportsTools ? "success" : "warning"} /> : null}
          {typeof props.testResult.contextWindow === "number" ? <StatusBadge label={`上下文 ${props.testResult.contextWindow}`} tone={props.testResult.contextWindow >= MIN_AGENT_CONTEXT ? "success" : "warning"} /> : null}
          {props.testResult.runtimeCompatibility ? <StatusBadge label={runtimeLabel(props.testResult.runtimeCompatibility)} tone={props.testResult.runtimeCompatibility === "connection_only" ? "warning" : "success"} /> : null}
          {props.testResult.roleCompatibility?.coding_plan?.ok ? <StatusBadge label="可作 Coding Plan" tone="success" /> : null}
          {typeof props.testResult.wslReachable === "boolean" ? <StatusBadge label={props.testResult.wslReachable ? "WSL 可连通" : "WSL 连不上"} tone={props.testResult.wslReachable ? "success" : "warning"} /> : null}
        </div>
      ) : null}

      {expanded && props.testResult?.healthChecks?.length ? (
        <div className="mt-3 grid gap-2">
          {props.testResult.healthChecks.map((item, index) => (
            <div key={`${item.id}-${index}`} className={cn("rounded-2xl bg-white/75 px-3 py-2.5 shadow-[0_8px_18px_rgba(15,23,42,0.03)]", item.ok ? "text-slate-700" : "text-rose-700")}>
              <p className="font-semibold">{item.ok ? "✓" : "✕"} {healthStepLabel(item.id)} · {item.message}</p>
              {item.detail ? <p className="mt-1 whitespace-pre-wrap text-slate-500">{item.detail}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {props.testResult?.recommendedFix ? (
        <div className="mt-3 rounded-2xl bg-white/75 px-3 py-2.5 font-medium shadow-[0_8px_18px_rgba(15,23,42,0.03)]">
          建议动作：{props.testResult.recommendedFix}
        </div>
      ) : null}

      {<WslLocalhostHelp testResult={props.testResult} />}
    </section>
  );
}

function WslLocalhostHelp(props: { testResult?: ModelConnectionTestResult }) {
  if (!props.testResult) return null;
  if (props.testResult.failureCategory !== "wsl_unreachable") return null;
  const url = props.testResult.wslProbeUrl ?? props.testResult.normalizedBaseUrl ?? "";
  if (!/127\.0\.0\.1|localhost/.test(url)) return null;
  const steps = props.testResult.fixSteps;
  if (!steps || steps.length === 0) return null;

  return (
    <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/60 px-3 py-2.5 shadow-[0_8px_18px_rgba(15,23,42,0.03)]">
      <p className="font-semibold text-amber-800">为什么 WSL 访问不到 Windows 上的模型服务？</p>
      <ol className="mt-2 list-decimal pl-5 text-amber-700">
        {steps.map((step, index) => (
          <li key={index} className="mt-1 leading-5">{step}</li>
        ))}
      </ol>
    </div>
  );
}

export function noticeForTestResult(result: ModelConnectionTestResult): OperationNotice {
  if (result.ok && isCodingPlanSourceType(result.sourceType)) {
    return { tone: "success", title: "配置已保存（由 Hermes 运行时验证）", message: result.message || "Coding Plan 配置已同步到 Hermes，实际可用性请在会话中确认。" };
  }
  if (result.ok) return { tone: "success", title: "测试通过", message: result.message || "这个模型已通过连接检查。" };
  const canStillSave = result.agentRole === "auxiliary_model" || result.agentRole === "provider_only";
  return {
    tone: canStillSave ? "warning" : "error",
    title: canStillSave ? "可保存，但暂不适合作主模型" : "测试失败",
    message: result.message || result.recommendedFix || "请按建议动作修复后再试。",
  };
}

function resultTone(result?: ModelConnectionTestResult): OperationNotice["tone"] | undefined {
  if (!result) return undefined;
  if (result.ok) return "success";
  return result.agentRole === "auxiliary_model" || result.agentRole === "provider_only" ? "warning" : "error";
}

function resultTitle(result?: ModelConnectionTestResult) {
  if (!result) return undefined;
  if (result.ok && isCodingPlanSourceType(result.sourceType)) return "配置已保存（由 Hermes 运行时验证）";
  return result.ok ? "测试通过" : "测试失败";
}

function runtimeLabel(value: NonNullable<ModelConnectionTestResult["runtimeCompatibility"]>) {
  if (value === "proxy") return "runtime proxy";
  if (value === "connection_only") return "仅连接测试";
  return "runtime";
}

function toneClass(tone: OperationNotice["tone"]) {
  if (tone === "success") return "bg-emerald-50/75 text-emerald-700 ring-emerald-200/70";
  if (tone === "warning") return "bg-amber-50/75 text-amber-800 ring-amber-200/70";
  if (tone === "error") return "bg-rose-50/75 text-rose-700 ring-rose-200/70";
  return "bg-slate-50/85 text-slate-600 ring-slate-200/75";
}
