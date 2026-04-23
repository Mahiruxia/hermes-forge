import { z } from "zod";

export const engineIdSchema = z.literal("hermes");
export const taskTypeSchema = z.enum([
  "fix_error",
  "generate_web",
  "analyze_project",
  "organize_files",
  "custom",
]);

export const sessionAttachmentSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(260),
  path: z.string().trim().min(1).max(1000),
  originalPath: z.string().trim().min(1).max(1000),
  kind: z.enum(["image", "file"]),
  mimeType: z.string().trim().max(120).optional(),
  size: z.number().int().nonnegative().max(200 * 1024 * 1024),
  createdAt: z.string().trim().min(1).max(80),
});

export const startTaskInputSchema = z.object({
  userInput: z.string().trim().min(1).max(12000),
  taskType: taskTypeSchema,
  workspacePath: z.string().trim().max(1000).optional(),
  clientTaskId: z.string().trim().min(1).max(120).optional(),
  sessionId: z.string().trim().max(120).optional(),
  conversationHistory: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(12000),
    createdAt: z.string().trim().max(80).optional(),
    taskRunId: z.string().trim().max(120).optional(),
  })).max(24).default([]),
  sessionFilesPath: z.string().trim().min(1).max(1000),
  selectedFiles: z.array(z.string().max(1000)).default([]),
  attachments: z.array(sessionAttachmentSchema).default([]),
  modelProfileId: z.string().max(120).optional(),
});

export const sessionIdSchema = z.string().trim().min(1).max(120);
export const sessionUpdateSchema = z.object({
  id: sessionIdSchema,
  title: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["idle", "running", "failed", "completed", "archived"]).optional(),
  lastMessagePreview: z.string().trim().max(500).optional(),
  workspacePath: z.string().trim().max(1000).optional(),
  workspaceStatus: z.enum(["ready", "missing", "unselected"]).optional(),
  pinned: z.boolean().optional(),
  projectId: z.string().trim().max(120).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
});

export const workspacePathInputSchema = z.string().trim().min(1).max(1000);
export const secretRefSchema = z.string().trim().min(1).max(200);

export const secretSaveInputSchema = z.object({
  ref: secretRefSchema,
  plainText: z.string().min(1).max(20000),
});

export const providerIdSchema = z.enum(["openai", "anthropic", "openrouter", "local", "custom"]);

export const modelProfileSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().max(200).optional(),
  provider: providerIdSchema,
  baseUrl: z.string().trim().max(1000).optional(),
  model: z.string().trim().min(1).max(200),
  secretRef: z.string().trim().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(1000000).optional(),
});

export const modelOptionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().positive().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  inputCostPer1kUsd: z.number().nonnegative().max(1000).optional(),
  outputCostPer1kUsd: z.number().nonnegative().max(1000).optional(),
});

export const modelProviderProfileSchema = z.object({
  id: z.string().trim().min(1).max(120),
  provider: providerIdSchema,
  label: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().max(1000).optional(),
  apiKeySecretRef: z.string().trim().max(200).optional(),
  models: z.array(modelOptionSchema).default([]),
  status: z.enum(["unknown", "checking", "ready", "failed"]).default("unknown"),
  lastCheckedAt: z.string().optional(),
  lastError: z.string().optional(),
});

export const enginePermissionPolicySchema = z.object({
  enabled: z.boolean().default(true),
  workspaceRead: z.boolean().default(true),
  fileWrite: z.boolean().default(true),
  commandRun: z.boolean().default(true),
  memoryRead: z.boolean().default(true),
  contextBridge: z.boolean().default(true),
});

export const hermesRuntimeSchema = z.object({
  mode: z.enum(["windows", "wsl"]).default("windows"),
  distro: z.string().trim().max(120).optional(),
  pythonCommand: z.string().trim().min(1).max(120).default("python3"),
  windowsAgentMode: z.enum(["hermes_native", "host_tool_loop", "disabled"]).default("hermes_native"),
});

export const runtimeConfigSchema = z.object({
  defaultModelProfileId: z.string().max(120).optional(),
  modelProfiles: z.array(modelProfileSchema),
  providerProfiles: z.array(modelProviderProfileSchema).optional(),
  updateSources: z.record(z.string(), z.string().url()).default({}),
  enginePaths: z.record(z.string(), z.string().trim().min(1).max(1000)).optional(),
  startupWarmupMode: z.enum(["off", "cheap", "real_probe"]).default("cheap"),
  enginePermissions: z.record(z.string(), enginePermissionPolicySchema.partial()).optional(),
  hermesRuntime: hermesRuntimeSchema.default({ mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" }),
}).transform((config) => ({
  ...config,
  updateSources: pickHermesRecord(config.updateSources),
  enginePaths: config.enginePaths ? pickHermesRecord(config.enginePaths) : undefined,
  enginePermissions: config.enginePermissions ? pickHermesRecord(config.enginePermissions) : undefined,
}));

function pickHermesRecord<T>(record: Record<string, T>) {
  const next: Partial<Record<"hermes" | "client", T>> = {};
  if ("hermes" in record) next.hermes = record.hermes;
  if ("client" in record) next.client = record.client;
  return next;
}
