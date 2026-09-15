import { FolderOpen, Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../store";

export function WorkspacePanel(props: { onPickWorkspace: () => void; onSelectWorkspace: (path: string) => void }) {
  const { recentWorkspaces, workspacePath, projects, spaces, sessions, setSelectedProject, setActivePanel } = useAppStore(useShallow(state => ({
    recentWorkspaces: state.recentWorkspaces,
    workspacePath: state.workspacePath,
    projects: state.webUiOverview?.projects,
    spaces: state.webUiOverview?.spaces,
    sessions: state.sessions,
    setSelectedProject: state.setSelectedProject,
    setActivePanel: state.setActivePanel,
  })));
  const directories = new Map<string, { path: string; name: string }>();
  for (const entry of [
    ...(workspacePath ? [{ path: workspacePath, name: "当前工作区" }] : []),
    ...recentWorkspaces,
    ...(spaces ?? []),
    ...sessions.filter(session => session.workspacePath).map(session => ({ path: session.workspacePath!, name: session.workspacePath!.split(/[\\/]/).filter(Boolean).at(-1) ?? session.workspacePath! })),
  ]) {
    const key = entry.path.replace(/\\/g, "/").replace(/\/$/, "");
    if (!directories.has(key)) directories.set(key, { path: entry.path, name: entry.name || entry.path });
  }
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">打开常用目录，继续处理其中的文件。</p>
        <button type="button" onClick={props.onPickWorkspace} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[var(--hermes-primary)] px-4 py-2 text-sm font-medium text-white"><Plus size={15} />选择目录</button>
      </div>
      <div className="grid gap-3">
        {[...directories.values()].map(entry => (
          <button type="button" key={entry.path} onClick={() => props.onSelectWorkspace(entry.path)} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-[var(--hermes-primary-border)] hover:bg-slate-50">
            <FolderOpen size={22} className="shrink-0 text-[var(--hermes-primary)]" />
            <span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-800">{entry.name}</span><span className="mt-1 block break-all text-xs text-slate-500">{entry.path}</span></span>
          </button>
        ))}
        {!directories.size ? <p className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">还没有最近目录，选择一个工作区开始。</p> : null}
      </div>
      {(projects?.length ?? 0) > 0 ? (
        <details className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm text-slate-600">按已有项目查找会话</summary>
          <div className="mt-3 flex flex-wrap gap-2">
            {projects!.map(project => <button type="button" key={project.id} onClick={() => { setSelectedProject(project.id); setActivePanel("chat"); }} className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{project.name} · {project.sessionCount}</button>)}
          </div>
        </details>
      ) : null}
    </div>
  );
}
