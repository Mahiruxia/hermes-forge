export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProfileName(name: string): ValidationResult {
  const errors: string[] = [];
  
  if (!name || name.trim() === "") {
    errors.push("Profile 名称不能为空");
  }
  
  if (name.length > 64) {
    errors.push("Profile 名称不能超过 64 个字符");
  }
  
  const invalidChars = /[^a-zA-Z0-9_-]/;
  if (invalidChars.test(name)) {
    errors.push("Profile 名称只能包含字母、数字、下划线和连字符");
  }
  
  if (name.startsWith("-")) {
    errors.push("Profile 名称不能以连字符开头");
  }
  
  return { valid: errors.length === 0, errors };
}

export function validateSkillId(id: string): ValidationResult {
  const errors: string[] = [];
  
  if (!id || id.trim() === "") {
    errors.push("技能 ID 不能为空");
  }
  
  if (id.length > 255) {
    errors.push("技能 ID 不能超过 255 个字符");
  }
  
  if (!id.endsWith(".md")) {
    errors.push("技能文件必须以 .md 结尾");
  }
  
  const invalidChars = /[<>:"/\\|?*\x00-\x1F]/;
  if (invalidChars.test(id)) {
    errors.push("技能 ID 包含非法字符");
  }
  
  return { valid: errors.length === 0, errors };
}

export function validateSkillDirectoryName(name: string): ValidationResult {
  const errors: string[] = [];

  if (!name || name.trim() === "") {
    errors.push("技能名称不能为空");
  }

  if (name.length > 64) {
    errors.push("技能名称不能超过 64 个字符");
  }

  const invalidChars = /[^a-zA-Z0-9_\-/]/;
  if (invalidChars.test(name)) {
    errors.push("技能名称只能包含字母、数字、下划线、连字符和正斜杠");
  }

  return { valid: errors.length === 0, errors };
}

export function validateSkillUploadPath(sourcePath: string): ValidationResult {
  const errors: string[] = [];

  if (!sourcePath || sourcePath.trim() === "") {
    errors.push("上传路径不能为空");
  }

  return { valid: errors.length === 0, errors };
}

export function validateMemoryContent(content: string): ValidationResult {
  const errors: string[] = [];
  
  if (content.length > 1024 * 1024) {
    errors.push("记忆内容不能超过 1MB");
  }
  
  return { valid: errors.length === 0, errors };
}

export function validateCronSchedule(schedule: string): ValidationResult {
  const errors: string[] = [];
  const trimmed = schedule.trim();
  
  if (!trimmed) {
    errors.push("定时计划不能为空");
  }

  const duration = "\\d+\\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)";
  
  const patterns = [
    new RegExp(`^${duration}$`, "i"),
    new RegExp(`^every\\s+${duration}$`, "i"),
    /^(\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2})$/,
    /^(\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}) (\*|\d{4}|\d{4}-\d{4})$/,
    /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:\d{2})?$/,
  ];
  
  const isValid = patterns.some((pattern) => pattern.test(trimmed));
  if (!isValid) {
    errors.push("定时计划格式无效，支持: 30m、every 2h、2026-04-24T09:00、0 9 * * *");
  }
  
  return { valid: isValid, errors };
}

export function validateWorkspacePath(path: string): ValidationResult {
  const errors: string[] = [];
  
  if (!path || path.trim() === "") {
    errors.push("工作区路径不能为空");
  }
  
  const maxLength = process.platform === "win32" ? 260 : 4096;
  if (path.length > maxLength) {
    errors.push(`路径长度超过限制（最大 ${maxLength} 字符）`);
  }
  
  return { valid: errors.length === 0, errors };
}

export function validateUserInput(input: string): ValidationResult {
  const errors: string[] = [];
  
  if (input.length > 1024 * 10) {
    errors.push("输入内容不能超过 10KB");
  }
  
  return { valid: errors.length === 0, errors };
}
