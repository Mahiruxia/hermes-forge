import { useState } from "react";
import { Plus, Save, Trash2, Wrench, Tag, Upload } from "lucide-react";
import type { HermesSkill } from "../../../../shared/types";
import { useAppStore } from "../../../store";
import { cn } from "../../DashboardPrimitives";
import { ConfirmCard } from "../ConfirmCard";
import { NoticeCard } from "../NoticeCard";

export function SkillsPanel() {
  const store = useAppStore();
  const skills = store.webUiOverview?.skills ?? [];
  const [editing, setEditing] = useState<{ id: string; content: string; isNew?: boolean } | undefined>();
  const [confirming, setConfirming] = useState<HermesSkill | undefined>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    store.setWebUiOverview(await window.workbenchClient.getWebUiOverview());
  }

  async function editSkill(skill: HermesSkill) {
    setError("");
    try {
      const file = await window.workbenchClient.readSkill(skill.id);
      setEditing({ id: skill.id, content: file.content });
    } catch (err) {
      setError(err instanceof Error ? `技能读取失败：${err.message}` : "技能读取失败。");
    }
  }

  async function saveSkill() {
    if (!editing?.id.trim()) return;
    setError("");
    try {
      await window.workbenchClient.saveSkill({ id: editing.id.trim(), content: editing.content });
      setEditing(undefined);
      setMessage("技能已保存。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? `技能保存失败：${err.message}` : "技能保存失败。");
    }
  }

  async function uploadSkill() {
    setError("");
    try {
      const skill = await window.workbenchClient.uploadSkill();
      setMessage(`技能“${skill.name}”已上传。`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? `技能上传失败：${err.message}` : "技能上传失败。");
    }
  }

  async function deleteSkill(skill: HermesSkill) {
    setError("");
    try {
      await window.workbenchClient.deleteSkill(skill.id);
      setConfirming(undefined);
      setMessage("技能已删除。");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? `技能删除失败：${err.message}` : "技能删除失败。");
    }
  }

  const validSkills = skills.filter((skill) => 
    skill.name && 
    skill.name.trim().length > 0 && 
    skill.size > 0 && 
    skill.path && 
    skill.summary && 
    skill.summary.trim().length > 0
  );
  const groupedSkills = validSkills.reduce<Record<string, HermesSkill[]>>((acc, skill) => {
    const category = skill.category || "other";
    acc[category] = [...(acc[category] || []), skill];
    return acc;
  }, {});

  const sortedCategories = Object.keys(groupedSkills).sort((a, b) => {
    if (a === "personal") return -1;
    if (b === "personal") return 1;
    const countA = groupedSkills[a].length;
    const countB = groupedSkills[b].length;
    if (countB !== countA) return countB - countA;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Wrench size={14} />
          <span>读取并编辑当前 Hermes Home 下 `skills/` 目录的 Markdown 技能文件。</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-all hover:bg-slate-50 hover:shadow-md active:scale-[0.98]"
            onClick={() => void uploadSkill()}
            type="button"
          >
            <Upload size={14} />
            上传技能
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-indigo-700 hover:shadow-md active:scale-[0.98]"
            onClick={() => setEditing({ id: "new-skill.md", content: "# New Skill\n\n描述这个技能的用途。\n", isNew: true })}
            type="button"
          >
            <Plus size={14} />
            新建技能
          </button>
        </div>
      </div>

      {message ? <NoticeCard text={message} onClose={() => setMessage("")} /> : null}
      {error ? <NoticeCard text={error} onClose={() => setError("")} /> : null}
      {confirming ? <ConfirmCard title={`删除技能：${confirming.name}`} body="技能文件会从当前 Hermes Home 的 skills 目录删除。请确认没有其他 Agent 依赖它。" tone="danger" onCancel={() => setConfirming(undefined)} onConfirm={() => void deleteSkill(confirming)} /> : null}

      {editing ? (
        <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
          {editing.id.includes("/SKILL.md") ? (
            <div className="mb-3 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
              目录技能支持编辑 SKILL.md 主文件，子资源（references、scripts 等）请在文件系统中管理。
            </div>
          ) : null}
          <div className="mb-3">
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">文件路径</label>
            <input
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-1 ring-transparent transition-all focus:border-indigo-400 focus:ring-indigo-100"
              value={editing.id}
              onChange={(event) => setEditing({ ...editing, id: event.target.value })}
              placeholder="skill-name.md"
            />
          </div>
          <textarea
            className="h-48 w-full rounded-lg border border-slate-200 bg-white p-3 text-sm font-mono outline-none ring-1 ring-transparent transition-all focus:border-indigo-400 focus:ring-indigo-100 resize-none"
            value={editing.content}
            onChange={(event) => setEditing({ ...editing, content: event.target.value })}
            placeholder="在此输入技能内容..."
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              className="rounded-lg px-4 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100"
              onClick={() => setEditing(undefined)}
              type="button"
            >
              取消
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-indigo-700"
              onClick={() => void saveSkill()}
              type="button"
            >
              <Save size={14} />
              保存
            </button>
          </div>
        </section>
      ) : null}

      {validSkills.length ? (
        <div className="space-y-5">
          {sortedCategories.map((category) => (
            <div key={category}>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium",
                    category === "personal" ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-600"
                  )}
                >
                  {category === "personal" ? "个人技能" : category}
                </span>
                <span className={cn(
                  "inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium",
                  groupedSkills[category].length >= 10 ? "bg-amber-100 text-amber-700" :
                  groupedSkills[category].length >= 5 ? "bg-green-100 text-green-700" :
                  "bg-slate-100 text-slate-500"
                )}>
                  {groupedSkills[category].length} 个
                </span>
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {groupedSkills[category].map((skill) => (
                  <section
                    key={skill.id}
                    className="group relative overflow-hidden rounded-xl border border-slate-100 bg-white p-4 shadow-[0_2px_8px_rgba(15,23,42,0.04)] transition-all duration-200 ease-out hover:border-slate-200 hover:shadow-[0_8px_25px_rgba(15,23,42,0.08)] hover:-translate-y-0.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold text-slate-900">{skill.name}</h3>
                        <div className="mt-1 flex items-center gap-1 text-xs text-slate-400">
                          <code>{skill.relativePath}</code>
                        </div>
                        {skill.summary && (
                          <p className="mt-2 line-clamp-2 text-sm text-slate-600">{skill.summary}</p>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <Tag size={10} className="text-slate-400" />
                          <span className="text-xs text-slate-400">{skill.category}</span>
                        </div>
                        {skill.format === "directory" ? (
                          <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-600">📦 目录包</span>
                        ) : null}
                      </div>
                      <div className="flex gap-1">
                        <button
                          className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                          title="编辑"
                          onClick={() => void editSkill(skill)}
                          type="button"
                        >
                          <Wrench size={13} />
                        </button>
                        <button
                          className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                          title="删除"
                          onClick={() => setConfirming(skill)}
                          type="button"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </section>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-slate-100">
            <Wrench size={28} className="text-slate-400" />
          </div>
          <p className="mt-4 text-sm text-slate-500">暂无技能</p>
          <p className="mt-1 text-xs text-slate-400">创建后会写入当前 Hermes Home 的 `skills/` 目录</p>
          <button
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-indigo-700"
            onClick={() => setEditing({ id: "new-skill.md", content: "# New Skill\n\n描述这个技能的用途。\n", isNew: true })}
            type="button"
          >
            <Plus size={14} />
            创建第一个技能
          </button>
        </div>
      )}
    </div>
  );
}
