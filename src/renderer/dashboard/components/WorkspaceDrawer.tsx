import { useState } from "react";
import { Check, ChevronRight, Eye, File, Folder, FolderPlus, Plus, Search, X } from "lucide-react";
import type { FileTreeEntry } from "../../../shared/types";
import { useAppStore } from "../../store";
import { cn } from "../DashboardPrimitives";

export function WorkspaceDrawer(props: {
  onPickWorkspace: () => void;
  onSelectWorkspace: (workspacePath: string) => void;
  onRefreshFileTree: () => void;
}) {
  const store = useAppStore();
  const [query, setQuery] = useState("");
  const [previewPath, setPreviewPath] = useState<string | undefined>();
  const [previewContent, setPreviewContent] = useState<string | undefined>();

  const tree = store.fileTree;
  const visibleFiles = tree?.entries?.filter((entry) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return entry.name.toLowerCase().includes(q);
  });

  async function handlePreview(path: string) {
    if (previewPath === path) {
      setPreviewPath(undefined);
      setPreviewContent(undefined);
      return;
    }
    setPreviewPath(path);
    setPreviewContent("加载中...");
    try {
      const preview = await window.workbenchClient.previewFile(path);
      setPreviewContent(preview.content || (preview.kind === "directory" ? "目录无法预览。" : "没有可预览内容。"));
    } catch (error) {
      setPreviewContent(error instanceof Error ? error.message : "预览失败。");
    }
  }

  return (
    <aside className={cn("absolute left-0 top-0 z-30 flex h-full w-72 flex-col border-r border-slate-200 bg-white transition-transform", store.workspaceDrawerOpen ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex h-12 items-center justify-between border-b border-slate-200 px-3">
        <div className="flex items-center gap-2">
          <Folder size={16} className="text-slate-500" />
          <span className="text-sm font-medium text-slate-700">工作区文件</span>
        </div>
        <button className="grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100" onClick={() => store.setWorkspaceDrawerOpen(false)} type="button">
          <X size={14} />
        </button>
      </div>

      <div className="border-b border-slate-200 p-3">
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-2">
          <Search size={13} className="text-slate-400" />
          <input className="flex-1 bg-transparent text-[12px] outline-none placeholder:text-slate-400" placeholder="搜索文件..." value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="mt-2 flex gap-2">
          <button className={primaryActionClass} onClick={props.onPickWorkspace} type="button">
            <FolderPlus size={12} /> 选择工作区
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-slate-400">
          单击文件可加入本轮上下文，点击“预览”只查看内容，不会自动发送给 Hermes。
        </p>
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto overflow-x-hidden">
        {store.workspacePath ? (
          <div className="overflow-hidden p-2">
            {store.selectedFiles.length ? (
              <div className="mb-2 rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-[11px] text-indigo-700">
                已选 {store.selectedFiles.length} 个文件，将随本轮任务一起提供给 Hermes。
              </div>
            ) : null}
            <FileTree
              entries={visibleFiles ?? []}
              onPreview={handlePreview}
              previewPath={previewPath}
              selectedFiles={store.selectedFiles}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12">
            <Folder size={32} className="text-slate-300" />
            <p className="mt-2 text-sm text-slate-400">未选择工作区</p>
            <button className="mt-2 rounded-md px-3 py-1.5 text-[12px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50" onClick={props.onPickWorkspace} type="button">
              选择工作区
            </button>
          </div>
        )}
      </div>

      {previewPath && (
        <div className="border-t border-slate-200 p-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-slate-500">预览</p>
            <button className="text-[11px] text-slate-400" onClick={() => setPreviewPath(undefined)} type="button">关闭</button>
          </div>
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] font-mono text-slate-600">
            {previewContent || "加载中..."}
          </pre>
        </div>
      )}
    </aside>
  );
}

const primaryActionClass = "inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-indigo-700";

function FileTree(props: { entries: FileTreeEntry[]; onPreview: (path: string) => void; previewPath?: string; selectedFiles: string[] }) {
  const store = useAppStore();
  return (
    <div className="space-y-0.5 overflow-hidden">
      {props.entries.map((entry) => (
        <div key={entry.path}>
          <div
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] transition-colors",
              props.previewPath === entry.path && "bg-indigo-50 text-indigo-700",
              props.selectedFiles.includes(entry.path) && "bg-emerald-50 text-emerald-700",
            )}
            onClick={() => {
              if (entry.type === "file") {
                store.toggleSelectedFile(entry.path);
              }
            }}
          >
            {entry.type === "directory" ? (
              <ChevronRight size={12} className="text-slate-400" />
            ) : (
              <File size={12} className="text-slate-400" />
            )}
            {entry.type === "directory" ? (
              <Folder size={12} className="text-amber-500" />
            ) : (
              <File size={12} className="text-slate-400" />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {props.selectedFiles.includes(entry.path) ? (
              <Check size={10} className="ml-auto text-emerald-600" />
            ) : null}
            {entry.type === "file" ? (
              <button
                className="ml-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white hover:text-slate-600"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onPreview(entry.path);
                }}
                type="button"
              >
                <span className="inline-flex items-center gap-1">
                  <Eye size={10} />
                  预览
                </span>
              </button>
            ) : null}
          </div>
          {entry.children?.length ? (
            <div className="ml-3 pl-1">
              <FileTree entries={entry.children} onPreview={props.onPreview} previewPath={props.previewPath} selectedFiles={props.selectedFiles} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
