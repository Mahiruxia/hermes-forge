export function isHermesCliLifecycleLine(line: string) {
  const text = normalizeCliStatusLine(line);
  return /^(?:created|started|resumed|continued|loaded)\s+session\s+[A-Za-z0-9_-]+(?:\s*\([^)]*\))?$/i.test(text);
}

export function extractHermesCliLifecycleSessionId(line: string) {
  const match = normalizeCliStatusLine(line).match(/^(?:created|started|resumed|continued|loaded)\s+session\s+([A-Za-z0-9_-]+)(?:\s*\([^)]*\))?$/i);
  return match?.[1];
}

export function stripHermesCliLifecycleLines(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => !isHermesCliLifecycleLine(line))
    .join("\n")
    .trim();
}

function normalizeCliStatusLine(line: string) {
  return line.trim().replace(/^[\s\u2022\u00b7\u21bb\u27f3\u231b-]+/u, "").trim();
}
