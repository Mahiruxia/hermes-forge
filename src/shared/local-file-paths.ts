const INLINE_LOCAL_FILE_PATH_PATTERN =
  /(?:"([^"\r\n]+?\.[A-Za-z0-9]{1,12})"|'([^'\r\n]+?\.[A-Za-z0-9]{1,12})'|([a-zA-Z]:\\[^\r\n"'<>|]+?\.[A-Za-z0-9]{1,12})|(\\\\wsl\$\\[^\r\n"'<>|]+?\.[A-Za-z0-9]{1,12})|(\/mnt\/[a-zA-Z]\/[^\r\n"'<>|]+?\.[A-Za-z0-9]{1,12}))/g;

export function extractInlineLocalFilePaths(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_LOCAL_FILE_PATH_PATTERN)) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "").trim();
    if (!candidate || !looksLikeAbsoluteLocalFilePath(candidate)) continue;
    const key = normalizeLocalFilePathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(candidate);
  }
  return paths;
}

export function hasInlineLocalFilePath(text: string) {
  return extractInlineLocalFilePaths(text).length > 0;
}

export function looksLikeAbsoluteLocalFilePath(value: string) {
  return /^[a-zA-Z]:\\/.test(value) || /^\\\\wsl\\\$\\/.test(value) || /^\/mnt\/[a-zA-Z]\//.test(value);
}

export function normalizeLocalFilePathKey(value: string) {
  return /^[a-zA-Z]:\\/.test(value) || /^\\\\wsl\\\$\\/.test(value)
    ? value.toLowerCase()
    : value;
}

export const testOnly = {
  INLINE_LOCAL_FILE_PATH_PATTERN,
};
