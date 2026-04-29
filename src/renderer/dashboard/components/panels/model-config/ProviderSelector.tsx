import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { ModelSourceType } from "../../../../../shared/types";
import { cn } from "../../../DashboardPrimitives";
import type { OverviewModels, ProviderPreset, SecretMeta } from "./types";

type TemplateGroupId = "coding_plan" | "model_api" | "custom";

const TEMPLATE_GROUPS: Array<{ id: TemplateGroupId; label: string }> = [
  { id: "coding_plan", label: "模型 Coding Plan" },
  { id: "model_api", label: "模型 API" },
  { id: "custom", label: "自定义模型" },
];

/**
 * Cascading model template picker.
 *
 * The first menu level stays intentionally tiny, matching common coding-tool
 * setup flows: choose Coding Plan, API provider, or a custom model, then pick
 * the exact backend-backed provider template only when needed.
 */
export function ProviderSelector(props: {
  sourceType: ModelSourceType;
  models: OverviewModels;
  secrets: SecretMeta[];
  providers: ProviderPreset[];
  onChange: (sourceType: ModelSourceType) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<TemplateGroupId>("custom");
  const selected = props.providers.find((item) => item.id === props.sourceType) ?? props.providers[0];
  const grouped = useMemo(() => ({
    coding_plan: props.providers.filter((item) => item.roleCapabilities.includes("coding_plan") || item.badge === "Coding Plan").sort((left, right) => codingPlanOrder(left.id) - codingPlanOrder(right.id)),
    model_api: props.providers.filter((item) => item.roleCapabilities.includes("chat") && item.group !== "local" && item.id !== "openai_compatible"),
    custom: props.providers.filter((item) => item.group === "local" || item.id === "openai_compatible"),
  }), [props.providers]);
  const activeItems = grouped[activeGroup].length ? grouped[activeGroup] : grouped.custom;

  function chooseGroup(groupId: TemplateGroupId) {
    setActiveGroup(groupId);
    if (groupId === "custom") {
      props.onChange("openai_compatible");
    }
  }

  function chooseProvider(sourceType: ModelSourceType) {
    props.onChange(sourceType);
    setOpen(false);
  }

  return (
    <section className="relative rounded-[24px] bg-white shadow-[0_18px_60px_rgba(15,23,42,0.045)] ring-1 ring-slate-200/60">
      <button
        className="flex h-14 w-full items-center justify-between rounded-[24px] px-5 text-left text-[15px] font-medium text-slate-950 transition hover:bg-slate-50/70 active:translate-y-px"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span>{selected?.badge === "Coding Plan" ? "模型 Coding Plan" : selected?.id === "openai_compatible" ? "自定义模型" : "模型 API"}</span>
        <ChevronDown size={18} className={cn("text-slate-500 transition", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+10px)] z-30 grid min-h-[184px] overflow-hidden rounded-[26px] bg-white/95 shadow-[0_30px_90px_rgba(15,23,42,0.16)] ring-1 ring-slate-200/70 backdrop-blur md:grid-cols-[minmax(260px,1fr)_minmax(260px,340px)]">
          <div className="space-y-1 bg-slate-50/70 p-2">
            {TEMPLATE_GROUPS.map((group) => {
              const active = activeGroup === group.id;
              return (
                <button
                  key={group.id}
                  className={cn(
                    "relative flex h-14 w-full items-center justify-between rounded-2xl px-4 text-left text-[15px] transition",
                    active ? "bg-white font-semibold text-slate-950 shadow-[0_12px_28px_rgba(15,23,42,0.07)]" : "text-slate-600 hover:bg-white/70 hover:text-slate-950",
                  )}
                  onMouseEnter={() => setActiveGroup(group.id)}
                  onClick={() => chooseGroup(group.id)}
                  type="button"
                >
                  <span className={cn("absolute left-0 top-3 bottom-3 w-[3px] rounded-full", active ? "bg-slate-700" : "bg-transparent")} />
                  <span>{group.label}</span>
                  {group.id !== "custom" ? <ChevronRight size={18} className="text-slate-400" /> : null}
                </button>
              );
            })}
          </div>

          {activeGroup === "custom" ? null : (
            <div className="max-h-[360px] overflow-auto p-2">
              {activeItems.map((provider) => (
                <button
                  key={provider.id}
                  className={cn(
                    "flex h-14 w-full items-center rounded-2xl px-4 text-left text-[15px] text-slate-700 transition hover:bg-slate-50 hover:text-slate-950",
                    provider.id === props.sourceType && "bg-slate-100/80 font-semibold text-slate-950",
                  )}
                  onClick={() => chooseProvider(provider.id)}
                  type="button"
                >
                  <span className="truncate">{providerMenuLabel(provider)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function providerMenuLabel(provider: ProviderPreset) {
  if (provider.id === "deepseek_api_key") return "深度求索（DeepSeek）";
  if (provider.id === "moonshot_api_key") return "Moonshot AI（Kimi 国内）";
  if (provider.id === "zhipu_api_key") return "智谱 AI（GLM 国内）";
  if (provider.id === "mimo_api_key") return "MiMo API（按量付费）";
  if (provider.id === "volcengine_ark_api_key") return "火山引擎（豆包）";
  if (provider.id === "baidu_wenxin_api_key") return "百度（文心一言）";
  if (provider.id === "volcengine_coding_api_key") return "火山引擎方舟 Coding Plan";
  if (provider.id === "dashscope_coding_api_key") return "通义千问 Coding Plan（国内）";
  if (provider.id === "zhipu_coding_api_key") return "智谱 Coding Plan（国内）";
  if (provider.id === "baidu_qianfan_coding_api_key") return "百度千帆 Coding Plan";
  if (provider.id === "tencent_token_plan_api_key") return "腾讯云通用 Token Plan";
  if (provider.id === "tencent_hunyuan_token_plan_api_key") return "腾讯云 Hy Token Plan";
  if (provider.id === "mimo_token_plan_api_key") return "MiMo Token Plan（中国区）";
  if (provider.id === "minimax_token_plan_api_key") return "MiniMax Token Plan（国内）";
  if (provider.id === "kimi_coding_api_key") return "Kimi Coding Plan";
  return provider.label;
}

function codingPlanOrder(sourceType: ModelSourceType) {
  const order: Partial<Record<ModelSourceType, number>> = {
    tencent_token_plan_api_key: 10,
    tencent_hunyuan_token_plan_api_key: 20,
    mimo_token_plan_api_key: 30,
    minimax_token_plan_api_key: 40,
    zhipu_coding_api_key: 50,
    kimi_coding_api_key: 60,
    dashscope_coding_api_key: 70,
    baidu_qianfan_coding_api_key: 80,
    volcengine_coding_api_key: 90,
  };
  return order[sourceType] ?? 999;
}
