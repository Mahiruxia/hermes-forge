import { Code2, MessageSquare, Pencil, Plus, Star, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ModelSourceType } from "../../../../../shared/types";
import { providerForCatalog } from "./providerCatalog";
import { getSourceStatus, inferSourceType, roleLabel } from "./modelConfigUtils";
import { StatusBadge } from "./StatusBadge";
import type { OverviewModels, ProviderPreset, SecretMeta } from "./types";

/**
 * Card list for saved model profiles.
 *
 * Each card surfaces provider, model ID, health status, and compact icon
 * actions so users can switch default models without leaving the configuration
 * flow.
 */
export function SavedModelList(props: {
  models: OverviewModels;
  secrets: SecretMeta[];
  providers: ProviderPreset[];
  editingProfileId?: string;
  onCreate: () => void;
  onEdit: (profileId: string) => void;
  onDelete: (profileId: string) => void;
  onSetDefault: (profileId: string) => void;
  onSetRole: (role: "chat" | "coding_plan", profileId: string) => void;
}) {
  return (
    <section className="bg-white">
      <div className="flex items-center justify-between gap-3 px-4 py-4">
        <div>
          <p className="text-[13px] font-semibold text-slate-950">当前使用模型</p>
          <p className="mt-1 text-[11px] text-slate-400">已保存模型、健康状态和默认切换</p>
        </div>
        <button
          aria-label="添加模型"
          className="inline-flex h-9 items-center gap-2 rounded-xl bg-slate-900 px-3 text-[12px] font-semibold text-white shadow-[0_12px_28px_rgba(15,23,42,0.16)] transition hover:bg-slate-800 active:translate-y-px"
          onClick={props.onCreate}
          type="button"
        >
          <Plus size={14} />
          添加模型
        </button>
      </div>

      {props.models.modelProfiles.length ? (
        <div className="grid gap-3 p-4 lg:grid-cols-2">
          {props.models.modelProfiles.map((profile) => {
            const sourceType = (profile.sourceType ?? inferSourceType(profile.provider, profile.baseUrl)) as ModelSourceType;
            const provider = providerForCatalog(sourceType, props.providers);
            const status = getSourceStatus(props.models, props.secrets, sourceType, props.providers);
            const isDefault = profile.id === props.models.defaultProfileId;
            const isChat = (props.models.roleAssignments?.chat ?? props.models.defaultProfileId) === profile.id;
            const isCodingPlan = props.models.roleAssignments?.coding_plan === profile.id;
            const isEditing = profile.id === props.editingProfileId;
            const canChat = provider.roleCapabilities.includes("chat") && provider.runtimeCompatibility !== "connection_only";
            const canCodingPlan = provider.roleCapabilities.includes("coding_plan") && provider.runtimeCompatibility !== "connection_only";
            return (
              <article key={profile.id} className="rounded-[20px] bg-slate-50/75 p-3.5 shadow-[0_10px_26px_rgba(15,23,42,0.035)] ring-1 ring-slate-200/65">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-[13px] font-semibold text-slate-950">{profile.name ?? `${provider.label} · ${profile.model}`}</p>
                      {isChat ? <StatusBadge label="主模型" tone="success" /> : null}
                      {isCodingPlan ? <StatusBadge label="Coding Plan" tone="default" /> : null}
                      {isEditing ? <StatusBadge label="编辑中" tone="default" /> : null}
                    </div>
                    <p className="mt-1 truncate font-mono text-[12px] text-slate-500">{profile.model}</p>
                  </div>
                  <StatusBadge label={profile.lastHealthStatus ? healthLabel(profile.lastHealthStatus) : status.label} tone={healthTone(profile.lastHealthStatus, status.tone)} />
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusBadge label={provider.label} tone="muted" />
                  {provider.runtimeCompatibility === "connection_only" ? <StatusBadge label="仅测试" tone="warning" /> : null}
                  {provider.runtimeCompatibility === "proxy" ? <StatusBadge label="proxy" tone="default" /> : null}
                  {profile.agentRole ? <StatusBadge label={roleLabel(profile.agentRole)} tone={profile.agentRole === "primary_agent" ? "success" : "warning"} /> : null}
                  {typeof profile.supportsTools === "boolean" ? <StatusBadge label={profile.supportsTools ? "tools" : "tools 待验"} tone={profile.supportsTools ? "success" : "warning"} /> : null}
                </div>

                {profile.baseUrl ? <p className="mt-3 truncate font-mono text-[11px] text-slate-400">{profile.baseUrl}</p> : null}
                {profile.lastHealthSummary ? <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-slate-500">{profile.lastHealthSummary}</p> : null}

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-200/70 pt-2">
                  {!isChat && canChat ? (
                    <button
                      className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-slate-900 px-3 text-[12px] font-semibold text-white shadow-[0_8px_18px_rgba(15,23,42,0.12)] transition hover:bg-slate-800 active:translate-y-px"
                      onClick={() => props.onSetRole("chat", profile.id)}
                      type="button"
                    >
                      <MessageSquare size={13} />
                      切换使用
                    </button>
                  ) : (
                    <span />
                  )}
                  <div className="flex gap-1">
                    <IconButton label={isChat ? "当前主模型" : "设为主模型"} disabled={isChat || !canChat} onClick={() => props.onSetRole("chat", profile.id)}>
                      <MessageSquare size={14} />
                    </IconButton>
                    <IconButton label={isCodingPlan ? "当前 Coding Plan" : "设为 Coding Plan"} disabled={isCodingPlan || !canCodingPlan} onClick={() => props.onSetRole("coding_plan", profile.id)}>
                      <Code2 size={14} />
                    </IconButton>
                    <IconButton label={isDefault ? "当前默认" : "设为默认"} disabled={isDefault} onClick={() => props.onSetDefault(profile.id)}>
                      <Star size={14} className={isDefault ? "fill-current" : undefined} />
                    </IconButton>
                    <IconButton label="编辑" onClick={() => props.onEdit(profile.id)}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton label="删除" onClick={() => props.onDelete(profile.id)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="p-6 text-center text-[13px] text-slate-500">还没有保存模型。先选择 Provider，填入模型 ID 后保存。</div>
      )}
    </section>
  );
}

function IconButton(props: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={props.label}
      className="grid h-8 w-8 place-items-center rounded-xl text-slate-500 transition hover:bg-white hover:text-slate-950 hover:shadow-[0_8px_18px_rgba(15,23,42,0.06)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.label}
      type="button"
    >
      {props.children}
    </button>
  );
}

function healthLabel(status: NonNullable<OverviewModels["modelProfiles"][number]["lastHealthStatus"]>) {
  if (status === "ready") return "ready";
  if (status === "warning") return "warning";
  return "error";
}

function healthTone(status: OverviewModels["modelProfiles"][number]["lastHealthStatus"] | undefined, fallback: "success" | "warning" | "error" | "muted" | "default" | "selected") {
  if (status === "ready") return "success";
  if (status === "warning") return "warning";
  if (status === "failed") return "error";
  return fallback;
}
