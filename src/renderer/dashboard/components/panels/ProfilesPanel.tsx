import { useEffect, useState } from "react";
import { BookOpen, Check, Plus, RefreshCw, Trash2, UserCircle, Wrench } from "lucide-react";
import type { HermesProfile } from "../../../../shared/types";
import { useAppStore } from "../../../store";
import { ConfirmCard } from "../ConfirmCard";
import { NoticeCard } from "../NoticeCard";
import { refreshOverviewSection } from "../../../overview-data";

export function ProfilesPanel() {
  const store = useAppStore();
  const profiles = store.webUiOverview?.profiles ?? [];
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState<HermesProfile | undefined>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const nameError = profileNameError(name);
  const activeProfile = profiles.find((profile) => profile.active);

  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : "Agent 读取失败，请重试。")); }, []);

  async function refresh() {
    await refreshOverviewSection("profiles");
  }

  async function createProfile() {
    const nextName = name.trim();
    const error = profileNameError(nextName);
    if (error) {
      setMessage(error);
      return;
    }
    setBusy("create");
    try {
      const created = await window.workbenchClient.createProfile(nextName);
      if (created) {
        await window.workbenchClient.switchProfile(created.name);
      }
      setName("");
      setMessage(created ? `Agent 已创建并切换到：${created.name}。` : "Agent 已创建。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent 创建失败。");
    } finally {
      setBusy(undefined);
    }
  }

  async function switchProfile(profile: HermesProfile) {
    setBusy(`switch:${profile.id}`);
    try {
      await window.workbenchClient.switchProfile(profile.name);
      setMessage(`已切换到 Agent: ${profile.name}。技能、记忆和定时任务已切换到该 Agent。`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent 切换失败。");
    } finally {
      setBusy(undefined);
    }
  }

  async function deleteProfile(profile: HermesProfile) {
    setBusy(`delete:${profile.id}`);
    try {
      await window.workbenchClient.deleteProfile(profile.name);
      setConfirming(undefined);
      setMessage(profile.active ? "Agent 已删除，并已切回 default。" : "Agent 已删除。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent 删除失败。");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <UserCircle size={14} />
        <span>管理多个 Agent，每个拥有独立的技能、记忆和配置。</span>
      </div>

      {activeProfile ? (
        <section className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wider text-indigo-400">当前 Agent</p>
              <h3 className="mt-1 text-sm font-semibold text-indigo-950">{activeProfile.name}</h3>
              <p className="mt-0.5 break-all font-mono text-xs text-indigo-500">{activeProfile.path}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100 transition hover:bg-indigo-50" onClick={() => { store.setKnowledgeTab("skills"); store.setActivePanel("knowledge"); store.setView("home"); }} type="button">
                <Wrench size={13} /> 技能
              </button>
              <button className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100 transition hover:bg-indigo-50" onClick={() => { store.setKnowledgeTab("memory"); store.setActivePanel("knowledge"); store.setView("home"); }} type="button">
                <BookOpen size={13} /> 记忆
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">新建并切换 Agent</label>
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-1 ring-transparent transition-all focus:border-indigo-400 focus:ring-indigo-100"
            placeholder="wechat-assistant"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && !nameError && createProfile()}
          />
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={Boolean(nameError) || busy === "create"}
            onClick={() => void createProfile()}
            type="button"
          >
            {busy === "create" ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
            创建并切换
          </button>
        </div>
        <p className={cn("mt-2 text-xs", nameError && name.trim() ? "text-rose-500" : "text-slate-400")}>
          {name.trim() ? nameError || "名称可用；将创建独立 skills、memories 和 cron 目录。" : "仅支持字母、数字、下划线和连字符，最多 64 个字符。"}
        </p>
      </section>

      {message ? <NoticeCard text={message} onClose={() => setMessage("")} /> : null}
      {confirming ? <ConfirmCard title={`删除 Agent：${confirming.name}`} body={confirming.active ? "会删除该 Agent 目录下的 skills、memories 和 cron 数据，并切回 default Agent。" : "会删除该 Agent 目录下的 skills、memories 和 cron 数据；default Agent 不能删除。"} tone="danger" onCancel={() => setConfirming(undefined)} onConfirm={() => void deleteProfile(confirming)} /> : null}

      {profiles.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.map((profile) => (
            <section
              key={profile.id}
              className={cn(
                "relative overflow-hidden rounded-xl border bg-white p-4 shadow-sm transition-all",
                profile.active
                  ? "border-indigo-200 bg-indigo-50/50"
                  : "border-slate-100 hover:border-slate-200 hover:shadow-md"
              )}
            >
              {profile.active && (
                <div className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-indigo-500 px-2 py-0.5">
                  <Check size={10} className="text-white" />
                  <span className="text-xs font-medium text-white">当前</span>
                </div>
              )}

              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-100 to-indigo-200">
                  <UserCircle size={20} className="text-indigo-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-slate-900">{profile.name}</h3>
                  <p className="mt-0.5 break-all font-mono text-xs text-slate-400">{profile.path}</p>
                  <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                    <span>技能 {profile.skillCount}</span>
                    <span>·</span>
                    <span>记忆 {profile.memoryFiles}</span>
                    <span>·</span>
                    <span>{profile.hasConfig ? "有配置" : "无配置"}</span>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <button
                  className={cn(
                    "rounded-lg px-4 py-1.5 text-xs font-medium transition-colors",
                    profile.active
                      ? "bg-white/80 text-indigo-600"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  )}
                  disabled={profile.active}
                  onClick={() => !profile.active && switchProfile(profile)}
                  type="button"
                >
                  {busy === `switch:${profile.id}` ? "切换中" : profile.active ? "当前 Agent" : "切换"}
                </button>
                <button
                  className={cn(
                    "grid h-7 w-7 place-items-center rounded-md transition-colors",
                    profile.name === "default"
                      ? "text-slate-300 cursor-not-allowed"
                      : "text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  )}
                  title="删除"
                  disabled={profile.name === "default" || busy === `delete:${profile.id}`}
                  onClick={() => profile.name !== "default" && setConfirming(profile)}
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-slate-100">
            <UserCircle size={28} className="text-slate-400" />
          </div>
          <p className="mt-4 text-sm text-slate-500">暂无 Agent</p>
          <p className="mt-1 text-xs text-slate-400">创建后会写入 ~/.hermes/profiles</p>
        </div>
      )}
    </div>
  );
}

function cn(...classNames: Array<string | false | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}

function profileNameError(name: string) {
  const value = name.trim();
  if (!value) return "请输入 Agent 名称。";
  if (value.length > 64) return "Agent 名称不能超过 64 个字符。";
  if (/[^a-zA-Z0-9_-]/.test(value)) return "Agent 名称只能包含字母、数字、下划线和连字符。";
  if (value.startsWith("-")) return "Agent 名称不能以连字符开头。";
  if (value.toLowerCase() === "default") return "default Agent 已存在。";
  return "";
}
