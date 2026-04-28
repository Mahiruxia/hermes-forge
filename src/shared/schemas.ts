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

export const providerIdSchema = z.enum(["openai", "anthropic", "openrouter", "gemini", "deepseek", "huggingface", "copilot", "copilot_acp", "local", "custom"]);

export const modelSourceTypeSchema = z.enum([
  "openrouter_api_key",
  "anthropic_api_key",
  "gemini_api_key",
  "deepseek_api_key",
  "huggingface_api_key",
  "dashscope_api_key",
  "baidu_wenxin_api_key",
  "zhipu_api_key",
  "spark_api_key",
  "moonshot_api_key",
  "baichuan_api_key",
  "minimax_api_key",
  "yi_api_key",
  "hunyuan_api_key",
  "siliconflow_api_key",
  "volcengine_ark_api_key",
  "volcengine_coding_api_key",
  "dashscope_coding_api_key",
  "zhipu_coding_api_key",
  "baidu_qianfan_coding_api_key",
  "tencent_token_plan_api_key",
  "tencent_hunyuan_token_plan_api_key",
  "minimax_token_plan_api_key",
  "kimi_coding_api_key",
  "gemini_oauth",
  "anthropic_local_credentials",
  "github_copilot",
  "github_copilot_acp",
  "ollama",
  "vllm",
  "sglang",
  "lm_studio",
  "openai_compatible",
  "legacy",
]);

export const modelRoleSchema = z.enum(["chat", "coding_plan", "apply", "autocomplete"]);

export const modelProfileSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().max(200).optional(),
  provider: providerIdSchema,
  baseUrl: z.string().trim().max(1000).optional(),
  model: z.string().trim().min(1).max(200),
  secretRef: z.string().trim().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(1000000).optional(),
  sourceType: modelSourceTypeSchema.optional(),
  authMode: z.enum(["api_key", "oauth", "local_credentials", "external_process", "optional_api_key"]).optional(),
  agentRole: z.enum(["provider_only", "auxiliary_model", "primary_agent"]).optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  lastHealthCheckAt: z.string().trim().max(80).optional(),
  lastHealthStatus: z.enum(["ready", "warning", "failed"]).optional(),
  lastHealthSummary: z.string().trim().max(1000).optional(),
  settingsConfig: z.object({
    env: z.record(z.string().trim().min(1).max(200), z.string().trim().max(2000)),
  }).optional(),
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
  mode: z.enum(["windows", "wsl"]).default("wsl"),
  distro: z.string().trim().max(120).optional(),
  pythonCommand: z.string().trim().min(1).max(120).default("python3"),
  managedRoot: z.string().trim().max(1000).optional(),
  windowsAgentMode: z.enum(["hermes_native", "host_tool_loop", "disabled"]).default("hermes_native"),
  cliPermissionMode: z.enum(["yolo", "safe", "guarded"]).default("yolo"),
  permissionPolicy: z.enum(["passthrough", "bridge_guarded", "restricted_workspace"]).default("bridge_guarded"),
  workerMode: z.enum(["off", "experimental_wsl"]).default("off"),
  installSource: z.object({
    repoUrl: z.string().trim().url(),
    branch: z.string().trim().max(200).optional(),
    commit: z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/).optional(),
    sourceLabel: z.enum(["official", "fork", "pinned"]).default("official"),
  }).optional(),
});

export const runtimeConfigSchema = z.object({
  defaultModelProfileId: z.string().max(120).optional(),
  modelRoleAssignments: z.partialRecord(modelRoleSchema, z.string().trim().min(1).max(120)).optional(),
  modelProfiles: z.array(modelProfileSchema).default([]),
  providerProfiles: z.array(modelProviderProfileSchema).optional(),
  updateSources: z.record(z.string(), z.string().url()).default({}),
  enginePaths: z.record(z.string(), z.string().trim().min(1).max(1000)).optional(),
  startupWarmupMode: z.enum(["off", "cheap", "real_probe"]).default("off"),
  startupGatewayAutoStart: z.boolean().default(false),
  enginePermissions: z.record(z.string(), enginePermissionPolicySchema.partial()).optional(),
  hermesRuntime: hermesRuntimeSchema.default({ mode: "wsl", pythonCommand: "python3", windowsAgentMode: "hermes_native", cliPermissionMode: "yolo", permissionPolicy: "bridge_guarded", workerMode: "off" }),
}).transform((config) => ({
  ...config,
  defaultModelProfileId: config.modelRoleAssignments?.chat ?? config.defaultModelProfileId,
  modelRoleAssignments: normalizeModelRoleAssignments(config.modelRoleAssignments, config.defaultModelProfileId, config.modelProfiles),
  updateSources: pickHermesRecord(config.updateSources),
  enginePaths: config.enginePaths ? pickHermesRecord(config.enginePaths) : undefined,
  enginePermissions: config.enginePermissions ? pickHermesRecord(config.enginePermissions) : undefined,
}));

function normalizeModelRoleAssignments(
  assignments: Partial<Record<z.infer<typeof modelRoleSchema>, string>> | undefined,
  defaultModelProfileId: string | undefined,
  profiles: Array<{ id: string }>,
) {
  const ids = new Set(profiles.map((profile) => profile.id));
  const next: Partial<Record<z.infer<typeof modelRoleSchema>, string>> = {};
  for (const [role, profileId] of Object.entries(assignments ?? {}) as Array<[z.infer<typeof modelRoleSchema>, string | undefined]>) {
    if (profileId && ids.has(profileId)) next[role] = profileId;
  }
  if (!next.chat && defaultModelProfileId && ids.has(defaultModelProfileId)) {
    next.chat = defaultModelProfileId;
  }
  if (!next.chat && profiles[0]) next.chat = profiles[0].id;
  return Object.keys(next).length ? next : undefined;
}

function pickHermesRecord<T>(record: Record<string, T>) {
  const next: Partial<Record<"hermes" | "client", T>> = {};
  if ("hermes" in record) next.hermes = record.hermes;
  if ("client" in record) next.client = record.client;
  return next;
}
