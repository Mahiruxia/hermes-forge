import type { EngineEvent } from "../shared/types";

const now = () => new Date().toISOString();

export function deriveTaskEvents(line: string): EngineEvent[] {
  return [
    deriveToolCall(line),
    ...deriveFileChanges(line),
  ].filter((item): item is EngineEvent => Boolean(item));
}

export function deriveToolCall(line: string): EngineEvent | undefined {
  const text = line.trim();
  const toolMatch =
    text.match(/^(?:tool|工具)(?:\s*call)?[:：]\s*(.+)$/i) ??
    text.match(/^\$\s*([a-zA-Z0-9._-]+)(.*)$/) ??
    text.match(/^(git|npm|pnpm|yarn|node|python|pip|cargo|go|uv|bash|pwsh|powershell)\b(.*)$/i);
  if (!toolMatch) return undefined;
  const toolName = (toolMatch[1] ?? "").trim();
  const argsPreview = toolMatch[2]?.trim() || text;
  if (!toolName) return undefined;
  return { type: "tool_call", toolName, argsPreview, at: now() };
}

export function deriveFileChanges(line: string): EngineEvent[] {
  const text = line.trim();
  const matches: EngineEvent[] = [];
  const normalized = text.replace(/^[-*]\s*/, "");
  const createMatch = normalized.match(/(?:创建|新建|新增|created?|wrote)\s+(.+\.[^\s]+)$/i);
  const updateMatch = normalized.match(/(?:修改|更新|覆盖|updated?|modified?)\s+(.+\.[^\s]+)$/i);
  const deleteMatch = normalized.match(/(?:删除|移除|deleted?|removed?)\s+(.+\.[^\s]+)$/i);
  if (createMatch?.[1]) matches.push({ type: "file_change", changeType: "create", path: createMatch[1], at: now() });
  if (updateMatch?.[1]) matches.push({ type: "file_change", changeType: "update", path: updateMatch[1], at: now() });
  if (deleteMatch?.[1]) matches.push({ type: "file_change", changeType: "delete", path: deleteMatch[1], at: now() });
  return matches;
}
