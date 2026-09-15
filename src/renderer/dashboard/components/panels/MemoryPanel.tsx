import { useEffect, useState } from "react";
import { Save, Upload, BookOpen, User } from "lucide-react";
import type { HermesMemoryFile } from "../../../../shared/types";
import { useAppStore } from "../../../store";
import { NoticeCard } from "../NoticeCard";
import { refreshOverviewSection } from "../../../overview-data";

const EMPTY_MEMORY: HermesMemoryFile[] = [];

export function MemoryPanel() {
  const [editing, setEditing] = useState<{ id: "USER.md" | "MEMORY.md"; content: string } | undefined>();
  const [message, setMessage] = useState("");
  const files = useAppStore(state => state.webUiOverview?.memory ?? EMPTY_MEMORY);

  useEffect(() => { void refresh().catch(error => setMessage(error instanceof Error ? error.message : "记忆读取失败，请重试。")); }, []);

  async function refresh() {
    await refreshOverviewSection("memory");
  }

  async function importMemory(targetId: "USER.md" | "MEMORY.md") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.txt";
    input.style.display = "none";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await window.workbenchClient.saveMemoryFile({ id: targetId, content: await file.text() });
        setMessage(`已从 ${file.name} 导入到 ${targetId}`);
        await refresh();
      } catch (error) {
        setMessage(`导入失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    };
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <BookOpen size={14} />
        <span>编辑当前 Agent 的长期记忆和用户偏好。</span>
      </div>

      {message ? <NoticeCard text={message} onClose={() => setMessage("")} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {files.map((file) => (
          <section
            key={file.id}
            className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm transition-all hover:border-slate-200"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className={cn("grid h-8 w-8 place-items-center rounded-lg", file.id === "USER.md" ? "bg-rose-100" : "bg-indigo-100")}>
                  {file.id === "USER.md" ? <User size={16} className="text-rose-600" /> : <BookOpen size={16} className="text-indigo-600" />}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{file.label}</h3>
                  <p className="text-xs text-slate-400">{file.id}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
                  onClick={() => importMemory(file.id)}
                  type="button"
                >
                  <Upload size={12} />
                  导入
                </button>
                <button
                  className="flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-50"
                  onClick={() => setEditing({ id: file.id, content: file.content })}
                  type="button"
                >
                  <Save size={12} />
                  编辑
                </button>
              </div>
            </div>

            <div className="mt-3">
              <pre className="max-h-40 overflow-auto rounded-lg bg-slate-50 p-3 text-xs font-mono text-slate-600 whitespace-pre-wrap">
                {file.content || "点击编辑添加内容"}
              </pre>
            </div>
          </section>
        ))}
      </div>

      {editing ? (
        <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">编辑 {editing.id}</h3>
            <button
              className="text-xs text-slate-400 transition-colors hover:text-slate-600"
              onClick={() => setEditing(undefined)}
              type="button"
            >
              取消
            </button>
          </div>
          <textarea
            className="h-48 w-full rounded-lg border border-slate-200 bg-white p-3 text-sm font-mono outline-none ring-1 ring-transparent transition-all focus:border-indigo-400 focus:ring-indigo-100 resize-none"
            value={editing.content}
            onChange={(event) => setEditing({ ...editing, content: event.target.value })}
            placeholder="在此输入记忆内容..."
          />
          <div className="mt-3 flex justify-end">
            <button
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-indigo-700"
              onClick={() =>
                window.workbenchClient.saveMemoryFile(editing).then(async () => {
                  await refresh();
                  setEditing(undefined);
                }).catch(error => setMessage(error instanceof Error ? error.message : "记忆保存失败，请重试。"))
              }
              type="button"
            >
              <Save size={14} />
              保存
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function cn(...classNames: Array<string | false | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}
