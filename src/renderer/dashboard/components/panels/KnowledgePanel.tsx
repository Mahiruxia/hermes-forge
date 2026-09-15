import { lazy, Suspense } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../../store";
import { cn } from "../../DashboardPrimitives";

const SkillsPanel = lazy(() => import("./SkillsPanel").then(module => ({ default: module.SkillsPanel })));
const MemoryPanel = lazy(() => import("./MemoryPanel").then(module => ({ default: module.MemoryPanel })));

export function KnowledgePanel() {
  const { knowledgeTab, setKnowledgeTab } = useAppStore(useShallow(state => ({
    knowledgeTab: state.knowledgeTab,
    setKnowledgeTab: state.setKnowledgeTab,
  })));
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="技能与记忆" className="flex gap-2 border-b border-slate-200 pb-3">
        {(["skills", "memory"] as const).map(tab => (
          <button key={tab} id={`knowledge-tab-${tab}`} type="button" role="tab" aria-selected={knowledgeTab === tab} aria-controls="knowledge-content"
            onClick={() => setKnowledgeTab(tab)}
            className={cn("rounded-lg px-4 py-2 text-sm font-medium", knowledgeTab === tab ? "bg-[var(--hermes-primary)] text-white" : "text-slate-500 hover:bg-slate-100")}>
            {tab === "skills" ? "技能" : "记忆"}
          </button>
        ))}
      </div>
      <div id="knowledge-content" role="tabpanel" aria-labelledby={`knowledge-tab-${knowledgeTab}`}>
        <Suspense fallback={<p role="status" className="py-8 text-sm text-slate-500">正在读取…</p>}>
          {knowledgeTab === "skills" ? <SkillsPanel /> : <MemoryPanel />}
        </Suspense>
      </div>
    </div>
  );
}
