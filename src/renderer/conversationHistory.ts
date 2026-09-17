import type { ConversationHistoryEntry, TaskRunProjection } from "../shared/types";

const MAX_HISTORY_ENTRIES = 24;
const MAX_HISTORY_ENTRY_CHARS = 11_500;
const MAX_HISTORY_TOTAL_CHARS = 56_000;
const LONG_CONTENT_HEAD_CHARS = 3_600;
const LONG_CONTENT_TAIL_CHARS = 7_400;

export function buildConversationHistory(input: {
  workSessionId: string;
  taskRunOrderBySession: Record<string, string[]>;
  taskRunProjectionsById: Record<string, TaskRunProjection>;
}): ConversationHistoryEntry[] {
  const order = input.taskRunOrderBySession[input.workSessionId] ?? [];
  const turns = order
    .map((taskRunId) => input.taskRunProjectionsById[taskRunId])
    .filter((run): run is NonNullable<typeof run> => Boolean(run) && run.workSessionId === input.workSessionId)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .map((run) => {
      const entries: ConversationHistoryEntry[] = [];
      if (run.userMessage?.content.trim()) {
        entries.push({
          role: "user",
          content: compactHistoryContent(run.userMessage.content.trim()),
          createdAt: run.userMessage.createdAt,
          taskRunId: run.taskRunId,
        });
      }
      if (entries.length && run.assistantMessage.content.trim() && run.status === "complete") {
        entries.push({
          role: "assistant",
          content: compactHistoryContent(run.assistantMessage.content.trim()),
          createdAt: run.assistantMessage.createdAt,
          taskRunId: run.taskRunId,
        });
      }
      return entries;
    })
    .filter((entries) => entries.length);

  const kept: ConversationHistoryEntry[][] = [];
  let totalChars = 0;
  let totalEntries = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const characters = turn.reduce((sum, entry) => sum + entry.content.length, 0);
    // Keep a contiguous suffix of whole turns. Skipping individual messages
    // invents gaps and can retain an answer after discarding its question.
    if (totalEntries + turn.length > MAX_HISTORY_ENTRIES || totalChars + characters > MAX_HISTORY_TOTAL_CHARS) break;
    kept.push(turn);
    totalChars += characters;
    totalEntries += turn.length;
  }
  return kept.reverse().flat();
}

export function compactHistoryContent(content: string) {
  if (content.length <= MAX_HISTORY_ENTRY_CHARS) return content;
  const head = content.slice(0, LONG_CONTENT_HEAD_CHARS).trimEnd();
  const tail = content.slice(-LONG_CONTENT_TAIL_CHARS).trimStart();
  const omitted = content.length - head.length - tail.length;
  return [
    head,
    "",
    `[中间 ${omitted.toLocaleString("en-US")} 个字符已省略，以便当前会话可以继续发送。]`,
    "",
    tail,
  ].join("\n");
}
