import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppPaths } from "./app-paths";
import { ensureHermesHomeLayout, resolveActiveHermesHome } from "./hermes-home";
import { atomicWriteText, readTextIfExists, withHermesHomeLock } from "./hermes-config-files";
import { requireManagedHermesEnvironment } from "../runtime/managed-hermes-environment";
import { runCommand } from "../process/command-runner";
import type { RuntimeAdapterFactory } from "../runtime/runtime-adapter";
import { validateWslHermesCli } from "../runtime/hermes-cli-resolver";
import { defaultHermesCliPath, resolveHermesCliPathSync } from "../runtime/hermes-cli-paths";
import type { RuntimeProbeService } from "../runtime/runtime-probe-service";
import { summarizePreflightFailure } from "../runtime/runtime-preflight";
import type { SecretVault } from "../auth/secret-vault";
import { redactSensitiveText } from "../shared/redaction";
import type {
  HermesConnectorConfig,
  HermesConnectorField,
  HermesConnectorListResult,
  HermesConnectorPlatform,
  HermesConnectorPlatformId,
  HermesConnectorSaveInput,
  HermesConnectorStatus,
  HermesGatewayActionResult,
  HermesGatewayStatus,
  WeixinQrLoginResult,
  WeixinQrLoginStatus,
  RuntimeConfig,
} from "../shared/types";

type StoredPlatformConfig = {
  enabled?: boolean;
  values?: Record<string, string | boolean>;
  secretRefs?: Record<string, string>;
  updatedAt?: string;
  lastSyncedAt?: string;
  instances?: Record<string, StoredFeishuInstanceConfig>;
};

type StoredConnectorConfig = {
  platforms?: Partial<Record<HermesConnectorPlatformId, StoredPlatformConfig>>;
};

type StoredFeishuInstanceConfig = Omit<StoredPlatformConfig, "instances"> & {
  instanceId?: string;
};

type WeixinQrEvent =
  | { type: "phase"; phase: WeixinQrLoginStatus["phase"]; message?: string }
  | { type: "qr"; qrUrl: string; expiresAt?: string; message?: string }
  | { type: "confirmed"; accountId: string; token: string; baseUrl?: string; userId?: string }
  | { type: "error"; code?: string; message?: string };

type PythonCommand = {
  command: string;
  args: string[];
  label: string;
};

type GatewayStateSnapshot = {
  running: boolean;
  pid?: number;
  updatedAt?: string;
  message?: string;
  platformStates?: Record<string, string>;
  connectedPlatforms?: string[];
};

type GatewayModelSyncResult = {
  synced: boolean;
  skippedReason?: string;
  model?: string;
  provider?: string;
  envPath?: string;
};

type ConnectorRuntimeContext =
  | {
      ok: true;
      root: string;
      runtime: NonNullable<RuntimeConfig["hermesRuntime"]>;
      adapter: ReturnType<RuntimeAdapterFactory>;
      label: string;
    }
  | {
      ok: false;
      message: string;
      debugContext?: Record<string, unknown>;
    };

const MANAGED_START = "# >>> Hermes Desktop Connectors >>>";
const MANAGED_END = "# <<< Hermes Desktop Connectors <<<";

const PYTHON_ENV = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8:replace",
};

const PLATFORM_REGISTRY: HermesConnectorPlatform[] = [
  platform("telegram", "Telegram", "official", "BotFather 机器人，支持私聊、群组、线程、语音和文件。", [
    password("botToken", "TELEGRAM_BOT_TOKEN", "Bot Token", true, "7123456789:AAH..."),
    text("allowedUsers", "TELEGRAM_ALLOWED_USERS", "允许用户", false, "123456789,987654321"),
    text("homeChannel", "TELEGRAM_HOME_CHANNEL", "Home Channel", false, "123456789"),
  ], ["在 Telegram 中向 @BotFather 创建 bot 并复制 token。", "建议填写 TELEGRAM_ALLOWED_USERS 限制可访问用户。"]),
  platform("discord", "Discord", "official", "Discord Bot，支持服务器、DM、线程和附件。", [
    password("botToken", "DISCORD_BOT_TOKEN", "Bot Token", true, "MTI..."),
    text("allowedUsers", "DISCORD_ALLOWED_USERS", "允许用户", false, "123456789012345678"),
    text("homeChannel", "DISCORD_HOME_CHANNEL", "Home Channel", false, "channel id"),
  ], ["在 Discord Developer Portal 创建 Bot 并开启 Message Content Intent。", "邀请 bot 时授予发送消息、读取历史和查看频道权限。"]),
  platform("slack", "Slack", "official", "Slack Socket Mode，支持频道、DM、线程和 /hermes 命令。", [
    password("botToken", "SLACK_BOT_TOKEN", "Bot Token", true, "xoxb-..."),
    password("appToken", "SLACK_APP_TOKEN", "App Token", true, "xapp-..."),
    text("allowedUsers", "SLACK_ALLOWED_USERS", "允许用户", false, "U0123456789"),
    text("homeChannel", "SLACK_HOME_CHANNEL", "Home Channel", false, "C0123456789"),
  ], ["在 api.slack.com/apps 创建应用并启用 Socket Mode。", "Bot token 需要 chat:write、app_mentions:read、im:history 等权限。"]),
  platform("whatsapp", "WhatsApp", "official", "内置 Baileys 桥接，使用二维码配对手机。", [
    bool("enabled", "WHATSAPP_ENABLED", "启用 WhatsApp", true),
    text("allowedUsers", "WHATSAPP_ALLOWED_USERS", "允许号码", false, "15551234567"),
  ], ["先同步配置，再运行 Hermes 的 WhatsApp 配对流程扫描二维码。"]),
  platform("signal", "Signal", "official", "通过 signal-cli HTTP bridge 接入 Signal。", [
    url("httpUrl", "SIGNAL_HTTP_URL", "HTTP URL", true, "http://localhost:8080"),
    text("account", "SIGNAL_ACCOUNT", "账号", true, "+15551234567"),
    text("allowedUsers", "SIGNAL_ALLOWED_USERS", "允许用户", false, "+15559876543"),
    text("homeChannel", "SIGNAL_HOME_CHANNEL", "Home Channel", false, "+15559876543"),
  ], ["先启动 signal-cli HTTP 服务，例如 signal-cli daemon --http=localhost:8080。"]),
  platform("email", "Email", "official", "IMAP/SMTP 邮箱接入，适合后台任务通知和邮件对话。", [
    text("address", "EMAIL_ADDRESS", "邮箱地址", true, "hermes@example.com"),
    password("password", "EMAIL_PASSWORD", "邮箱密码/App Password", true, "app password"),
    text("imapHost", "EMAIL_IMAP_HOST", "IMAP Host", true, "imap.gmail.com"),
    text("smtpHost", "EMAIL_SMTP_HOST", "SMTP Host", true, "smtp.gmail.com"),
    text("allowedUsers", "EMAIL_ALLOWED_USERS", "允许发件人", false, "you@example.com"),
    text("homeAddress", "EMAIL_HOME_ADDRESS", "Home Address", false, "you@example.com"),
  ], ["Gmail 建议使用 App Password，并确认 IMAP 已开启。"]),
  platform("matrix", "Matrix", "official", "Matrix homeserver bot，支持房间、DM 和可选端到端加密。", [
    url("homeserver", "MATRIX_HOMESERVER", "Homeserver", true, "https://matrix.org"),
    password("accessToken", "MATRIX_ACCESS_TOKEN", "Access Token", false, "syt_..."),
    text("userId", "MATRIX_USER_ID", "User ID", false, "@hermes:matrix.org"),
    password("password", "MATRIX_PASSWORD", "Password", false),
    text("allowedUsers", "MATRIX_ALLOWED_USERS", "允许用户", false, "@you:matrix.org"),
    text("homeRoom", "MATRIX_HOME_ROOM", "Home Room", false, "!room:matrix.org"),
  ], ["Access Token 或 Password 至少填写一个。"]),
  platform("mattermost", "Mattermost", "official", "自托管 Mattermost Bot 接入。", [
    url("url", "MATTERMOST_URL", "Server URL", true, "https://mattermost.example.com"),
    password("token", "MATTERMOST_TOKEN", "Bot Token", true),
    text("allowedUsers", "MATTERMOST_ALLOWED_USERS", "允许用户", false),
    text("homeChannel", "MATTERMOST_HOME_CHANNEL", "Home Channel", false),
  ], ["在 Mattermost Integrations 中创建 Bot Account 并复制 token。"]),
  platform("dingtalk", "DingTalk", "official", "钉钉 Stream Mode 企业机器人。", [
    text("clientId", "DINGTALK_CLIENT_ID", "Client ID / AppKey", true),
    password("clientSecret", "DINGTALK_CLIENT_SECRET", "Client Secret / AppSecret", true),
    text("allowedUsers", "DINGTALK_ALLOWED_USERS", "允许用户", false),
    text("homeChannel", "DINGTALK_HOME_CHANNEL", "Home Channel", false),
  ], ["在钉钉开放平台创建企业内部应用，复制 AppKey 和 AppSecret。"]),
  platform("feishu", "Feishu", "official", "飞书机器人/应用接入。", [
    text("appId", "FEISHU_APP_ID", "App ID", true),
    password("appSecret", "FEISHU_APP_SECRET", "App Secret", true),
    text("domain", "FEISHU_DOMAIN", "Domain", false, "feishu"),
    text("connectionMode", "FEISHU_CONNECTION_MODE", "连接模式", false, "websocket"),
    bool("allowAllUsers", "FEISHU_ALLOW_ALL_USERS", "允许所有私聊用户", false),
    text("allowedUsers", "FEISHU_ALLOWED_USERS", "允许用户", false),
    text("groupPolicy", "FEISHU_GROUP_POLICY", "群聊策略", false, "open"),
    bool("requireMention", "FEISHU_REQUIRE_MENTION", "群聊需 @ 机器人", false),
    text("allowBots", "FEISHU_ALLOW_BOTS", "允许机器人消息", false, "none / mentions / all"),
    text("botOpenId", "FEISHU_BOT_OPEN_ID", "Bot Open ID", false, "ou_xxx"),
    text("botUserId", "FEISHU_BOT_USER_ID", "Bot User ID", false),
    text("botName", "FEISHU_BOT_NAME", "Bot 名称", false),
    text("agentId", "HERMES_AGENT_ID", "绑定 Agent", false, "default / agent-id"),
    password("encryptKey", "FEISHU_ENCRYPT_KEY", "Webhook Encrypt Key", false),
    password("verificationToken", "FEISHU_VERIFICATION_TOKEN", "Webhook Verification Token", false),
    text("agentMapping", "FEISHU_AGENT_MAPPING", "Hermes Agent 映射", false, "agent-a=cli_xxx,agent-b=cli_yyy"),
    text("homeChannel", "FEISHU_HOME_CHANNEL", "Home Channel", false),
  ], ["对齐 `hermes gateway setup`：App ID / App Secret + WebSocket 为默认推荐。", "私聊默认走配对审批：FEISHU_ALLOW_ALL_USERS=false；群聊默认 open 且需要 @ 机器人。", "每个飞书实例会隔离启动独立 Gateway；绑定 Agent 后使用对应 Hermes profile 的技能/记忆。"]),
  platform("homeassistant", "Home Assistant", "official", "Home Assistant Assist pipeline 集成。", [
    url("url", "HASS_URL", "Home Assistant URL", true, "http://homeassistant.local:8123"),
    password("token", "HASS_TOKEN", "Long-Lived Access Token", true),
  ], ["在 Home Assistant 用户资料页创建 Long-Lived Access Token。"]),
  platform("wecom", "WeCom", "advanced", "企业微信 AI Bot 模式。", [
    text("botId", "WECOM_BOT_ID", "Bot ID", true),
    password("secret", "WECOM_SECRET", "Secret", true),
    text("allowedUsers", "WECOM_ALLOWED_USERS", "允许用户", false),
    text("homeChannel", "WECOM_HOME_CHANNEL", "Home Channel", false),
  ], ["在企业微信管理后台创建 AI Bot，并限制允许用户。"]),
  platform("wecom_callback", "WeCom Callback", "advanced", "企业微信自建应用回调模式，需要公网/内网可访问回调端口。", [
    text("corpId", "WECOM_CALLBACK_CORP_ID", "Corp ID", true),
    password("corpSecret", "WECOM_CALLBACK_CORP_SECRET", "Corp Secret", true),
    text("agentId", "WECOM_CALLBACK_AGENT_ID", "Agent ID", false),
    password("token", "WECOM_CALLBACK_TOKEN", "Callback Token", false),
    password("aesKey", "WECOM_CALLBACK_ENCODING_AES_KEY", "EncodingAESKey", false),
    number("port", "WECOM_CALLBACK_PORT", "Callback Port", false, "8645"),
    text("allowedUsers", "WECOM_CALLBACK_ALLOWED_USERS", "允许用户", false),
  ], ["回调模式需要配置可信回调地址，并确保端口可达。"]),
  platform("weixin", "Weixin / WeChat", "advanced", "个人微信 iLink Bot API 接入。", [
    text("accountId", "WEIXIN_ACCOUNT_ID", "Account ID", true),
    password("token", "WEIXIN_TOKEN", "Token", true),
    url("baseUrl", "WEIXIN_BASE_URL", "Base URL", false),
    url("cdnBaseUrl", "WEIXIN_CDN_BASE_URL", "CDN Base URL", false, "https://novac2c.cdn.weixin.qq.com/c2c"),
    text("dmPolicy", "WEIXIN_DM_POLICY", "私聊策略", false, "pairing"),
    bool("allowAllUsers", "WEIXIN_ALLOW_ALL_USERS", "允许所有私聊用户", false),
    text("allowedUsers", "WEIXIN_ALLOWED_USERS", "允许用户", false),
    text("groupPolicy", "WEIXIN_GROUP_POLICY", "群聊策略", false, "disabled"),
    text("groupAllowedUsers", "WEIXIN_GROUP_ALLOWED_USERS", "允许群聊", false),
    text("homeChannel", "WEIXIN_HOME_CHANNEL", "Home Channel", false),
  ], ["需要可用的 iLink Bot API 服务和账号授权。"]),
  platform("bluebubbles", "BlueBubbles", "advanced", "通过 Mac 上的 BlueBubbles Server 接入 iMessage。", [
    url("serverUrl", "BLUEBUBBLES_SERVER_URL", "Server URL", true),
    password("password", "BLUEBUBBLES_PASSWORD", "Password", true),
    text("allowedUsers", "BLUEBUBBLES_ALLOWED_USERS", "允许用户", false),
    text("homeChannel", "BLUEBUBBLES_HOME_CHANNEL", "Home Channel", false),
  ], ["需要一台已配置 BlueBubbles Server 的 Mac。"]),
  platform("sms", "SMS", "advanced", "Hermes SMS 平台配置入口。", [
    text("homeChannel", "SMS_HOME_CHANNEL", "Home Channel", false),
    text("allowedUsers", "SMS_ALLOWED_USERS", "允许用户", false),
  ], ["SMS 具体依赖取决于 Hermes 安装的短信适配器。"]),
  platform("qqbot", "QQ Bot", "advanced", "QQ Bot 平台配置入口。", [
    text("appId", "QQ_APP_ID", "App ID", true),
    password("clientSecret", "QQ_CLIENT_SECRET", "App Secret", true),
    bool("allowAllUsers", "QQ_ALLOW_ALL_USERS", "允许所有私聊用户", false),
    text("allowedUsers", "QQ_ALLOWED_USERS", "允许用户", false),
    text("groupAllowedUsers", "QQ_GROUP_ALLOWED_USERS", "群聊允许用户", false),
    text("homeChannel", "QQBOT_HOME_CHANNEL", "Home Channel", false),
  ], ["对齐 `hermes gateway setup`：QQ_APP_ID 和 QQ_CLIENT_SECRET 是最小必填。", "Gateway 仍兼容旧的 QQ_HOME_CHANNEL，但 Forge 会写入官方推荐的 QQBOT_HOME_CHANNEL。"]),
];

export class HermesConnectorService {
  private gatewayProcess?: ChildProcessWithoutNullStreams;
  private readonly feishuGatewayProcesses = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly feishuGatewayStartedAt = new Map<string, string>();
  private gatewayStartedAt?: string;
  private gatewayOutput = "";
  private gatewayError = "";
  private gatewayExitMessage = "";
  private gatewayLastExitCode?: number | null;
  private gatewayLastExitAt?: string;
  private gatewayRestartCount = 0;
  private gatewayBackoffUntil?: string;
  private gatewayAutoStartState: HermesGatewayStatus["autoStartState"] = "idle";
  private gatewayAutoStartMessage = "等待自动启动。";
  private gatewayStartPromise?: Promise<HermesGatewayActionResult>;
  private gatewayStopPromise?: Promise<HermesGatewayActionResult>;
  private gatewayStartGeneration = 0;
  private gatewayMaintenance = false;
  private readonly expectedGatewayExits = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly spawnGatewayProcess = spawn;
  private readonly killGatewayProcess = killProcessTree;
  private gatewayUserStopped = false;
  private gatewayAutoRestartTimer?: NodeJS.Timeout;
  private readonly gatewayFailures = new Map<string, string>();
  private gatewayCliCache?: Awaited<ReturnType<HermesConnectorService["gatewayCliStatus"]>>;
  private gatewayCliCachedAt = 0;
  private gatewayCliCheck?: Promise<Awaited<ReturnType<HermesConnectorService["gatewayCliStatus"]>> | undefined>;
  private weixinQrProcess?: ChildProcessWithoutNullStreams;
  private weixinQrStatus: WeixinQrLoginStatus = { running: false, phase: "idle", message: "请点击开始扫码获取微信二维码。" };
  private weixinQrLineBuffer = "";
  private weixinQrRunCounter = 0;
  private activeWeixinQrRunId?: number;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly secretVault: SecretVault,
    private readonly resolveHermesRoot: () => Promise<string>,
    private readonly resolveConfiguredPythonCommand?: () => Promise<string | undefined>,
    private readonly runtimeProbeService?: RuntimeProbeService,
    private readonly runtimeAdapterFactory?: RuntimeAdapterFactory,
    private readonly readRuntimeConfig?: () => Promise<RuntimeConfig>,
    private readonly syncModelRuntime?: () => Promise<GatewayModelSyncResult>,
  ) {}

  async list(): Promise<HermesConnectorListResult> {
    const [stored, envValues, gateway] = await Promise.all([
      this.readConfig(),
      this.readEnvValues(),
      this.status(),
    ]);
    const connectors: HermesConnectorConfig[] = [];
    for (const platform of PLATFORM_REGISTRY) {
      if (platform.id !== "feishu") {
        connectors.push(await this.toConnector(platform, stored, envValues, gateway));
        continue;
      }
      const instances = this.feishuInstances(stored.platforms?.feishu);
      if (instances.length === 0) {
        connectors.push(await this.toConnector(platform, stored, envValues, gateway, "default"));
      } else {
        for (const [instanceId, instance] of instances) {
          connectors.push(await this.toConnector(platform, stored, envValues, gateway, instanceId, instance));
        }
      }
    }
    return { connectors, gateway, envPath: await this.envPath() };
  }

  async save(input: HermesConnectorSaveInput): Promise<HermesConnectorConfig> {
    return withHermesHomeLock(this.baseHermesHome(), () => this.saveInternal(input));
  }

  private async saveInternal(input: HermesConnectorSaveInput): Promise<HermesConnectorConfig> {
    const platform = platformById(input.platformId);
    const stored = await this.readConfig();
    const instanceId = platform.id === "feishu" ? normalizeFeishuInstanceId(input.instanceId) : undefined;
    const current: StoredPlatformConfig = platform.id === "feishu"
      ? this.feishuInstanceConfig(stored.platforms?.feishu, instanceId ?? "default")
        ?? {}
      : stored.platforms?.[platform.id] ?? {};
    const values: Record<string, string | boolean> = { ...(current.values ?? {}) };
    const secretRefs: Record<string, string> = { ...(current.secretRefs ?? {}) };

    for (const field of platform.fields) {
      if (!(field.key in input.values)) continue;
      const rawValue = input.values[field.key];
      if (field.secret) {
        if (typeof rawValue === "string" && rawValue.trim()) {
          const ref = secretRef(platform.id, field.key, instanceId);
          await this.secretVault.saveSecret(ref, rawValue.trim());
          secretRefs[field.key] = ref;
        }
        continue;
      }
      if (field.type === "boolean") {
        values[field.key] = Boolean(rawValue);
      } else {
        const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
        if (value) values[field.key] = value;
        else delete values[field.key];
      }
    }

    const next: StoredPlatformConfig = {
      enabled: input.enabled ?? true,
      values,
      secretRefs,
      updatedAt: new Date().toISOString(),
      lastSyncedAt: current.lastSyncedAt,
    };
    stored.platforms ??= {};
    if (platform.id === "feishu") {
      const feishu = this.ensureFeishuInstances(stored.platforms.feishu);
      feishu.instances![instanceId ?? "default"] = next;
      stored.platforms.feishu = feishu;
    } else {
      stored.platforms[platform.id] = next;
    }
    await this.writeConfig(stored);

    const envValues = await this.readEnvValues();
    return this.toConnector(platform, stored, envValues, await this.status(), instanceId);
  }

  async disable(input: HermesConnectorPlatformId | { platformId: HermesConnectorPlatformId; instanceId?: string }) {
    return withHermesHomeLock(this.baseHermesHome(), () => this.disableInternal(input));
  }

  private async disableInternal(input: HermesConnectorPlatformId | { platformId: HermesConnectorPlatformId; instanceId?: string }) {
    const platformId = typeof input === "string" ? input : input.platformId;
    const platform = platformById(platformId);
    const instanceId = platform.id === "feishu" ? normalizeFeishuInstanceId(typeof input === "string" ? undefined : input.instanceId) : undefined;
    const stored = await this.readConfig();
    stored.platforms ??= {};
    if (platform.id === "feishu") {
      const feishu = this.ensureFeishuInstances(stored.platforms.feishu);
      const current = feishu.instances![instanceId ?? "default"] ?? {};
      feishu.instances![instanceId ?? "default"] = {
        ...current,
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
      stored.platforms.feishu = feishu;
    } else {
      stored.platforms[platform.id] = {
        ...(stored.platforms[platform.id] ?? {}),
        enabled: false,
        updatedAt: new Date().toISOString(),
      };
    }
    await this.writeConfig(stored);
    const envValues = await this.readEnvValues();
    return this.toConnector(platform, stored, envValues, await this.status(), instanceId);
  }

  async syncEnv(): Promise<{ ok: boolean; envPath: string; message: string; connectors: HermesConnectorConfig[] }> {
    return withHermesHomeLock(this.baseHermesHome(), () => this.syncEnvInternal());
  }

  private async syncEnvInternal(): Promise<{ ok: boolean; envPath: string; message: string; connectors: HermesConnectorConfig[] }> {
    const stored = await this.readConfig();
    const lines: string[] = [
      MANAGED_START,
      "# Managed by Hermes Desktop. Edit connector settings in the desktop app.",
    ];
    const syncedAt = new Date().toISOString();

    const feishuInstanceHomes: string[] = [];
    for (const platform of PLATFORM_REGISTRY) {
      const config = stored.platforms?.[platform.id];
      if (!config || config.enabled === false) continue;
      if (platform.id === "feishu") {
        for (const [instanceId, instance] of this.feishuInstances(config)) {
          if (instance.enabled === false) continue;
          const missing = await this.missingRequired(platform, instance, {});
          if (missing.length > 0) continue;
          const envLines = await this.envLinesFor(platform, instance);
          if (envLines.length === 0) continue;
          await this.writeFeishuInstanceEnv(instanceId, instance, envLines);
          instance.lastSyncedAt = syncedAt;
          feishuInstanceHomes.push(await this.feishuInstanceHome(instanceId, instance));
        }
        stored.platforms!.feishu = this.ensureFeishuInstances(config);
        continue;
      }
      const missing = await this.missingRequired(platform, config, {});
      if (missing.length > 0) continue;
      const envLines = await this.envLinesFor(platform, config);
      if (envLines.length === 0) continue;
      lines.push("", `# ${platform.label}`, ...envLines);
      stored.platforms![platform.id] = { ...config, lastSyncedAt: syncedAt };
    }
    lines.push(MANAGED_END);

    const envPath = await this.envPath();
    const hasAnyConnector = lines.some((line) => line.includes("=")) || feishuInstanceHomes.length > 0;
    const writeEnv = async () => {
      const existing = await readTextIfExists(envPath);
      const withoutBlock = removeManagedBlock(existing).trimEnd();
      const next = hasAnyConnector
        ? `${withoutBlock ? `${withoutBlock}\n\n` : ""}${lines.join("\n")}\n`
        : `${withoutBlock}${withoutBlock ? "\n" : ""}`;
      if (next !== existing) await atomicWriteText(envPath, next);
    };
    const activeHome = path.dirname(envPath);
    if (path.resolve(activeHome) === path.resolve(this.baseHermesHome())) await writeEnv();
    else await withHermesHomeLock(activeHome, writeEnv);
    await this.writeConfig(stored);
    const list = await this.list();
    return {
      ok: true,
      envPath,
      message: hasAnyConnector ? `已同步连接器配置到 ${envPath}` : "没有完整可同步的连接器，已移除桌面端管理区块。",
      connectors: list.connectors,
    };
  }

  async status(options: { refresh?: boolean } = {}): Promise<HermesGatewayStatus> {
    const managedRunning = Boolean(this.gatewayProcess && !this.gatewayProcess.killed) || [...this.feishuGatewayProcesses.values()].some((child) => !child.killed);
    const [cliStatus, stateStatus] = await Promise.all([
      options.refresh ? this.refreshGatewayCliStatus() : Promise.resolve(Date.now() - this.gatewayCliCachedAt < 5000 ? this.gatewayCliCache : undefined),
      this.gatewayStateStatus().catch(() => undefined),
    ]);
    const cliRunning = cliStatus?.exitCode === 0 && looksLikeGatewayRunning(cliStatus?.stdout, cliStatus?.stderr);
    const cliFailed = looksLikeGatewayFailure(cliStatus?.stdout, cliStatus?.stderr);
    const stateRunning = Boolean(stateStatus?.running);
    const running = managedRunning || cliRunning || stateRunning;
    const gatewayError = gatewayErrorOutput(this.gatewayError);
    const gatewayWarnings = gatewayWarningOutput(this.gatewayError);
    const cliError = gatewayErrorOutput(cliStatus?.stderr ?? "");
    const cliWarnings = gatewayWarningOutput(cliStatus?.stderr ?? "");
    const healthStatus = this.gatewayFailures.size > 0 ? "error" : running ? "running" : (gatewayError || cliFailed) ? "error" : "stopped";
    return {
      running,
      managedRunning,
      healthStatus,
      platformStates: { ...stateStatus?.platformStates, ...Object.fromEntries([...this.gatewayFailures.keys()].map((key) => [key, "error"])) },
      connectedPlatforms: stateStatus?.connectedPlatforms,
      autoStartState: this.gatewayAutoStartState,
      autoStartMessage: this.gatewayAutoStartMessage,
      lastExitCode: this.gatewayLastExitCode,
      lastExitAt: this.gatewayLastExitAt,
      restartCount: this.gatewayRestartCount,
      backoffUntil: this.gatewayBackoffUntil,
      pid: this.gatewayProcess?.pid ?? [...this.feishuGatewayProcesses.values()].find((child) => child.pid)?.pid ?? stateStatus?.pid,
      startedAt: this.gatewayStartedAt ?? this.feishuGatewayStartedAt.values().next().value ?? stateStatus?.updatedAt,
      command: managedRunning || stateRunning ? "Hermes Python gateway run" : undefined,
      message: managedRunning
        ? "Gateway 正由桌面端托管运行。"
        : cliRunning
          ? "Gateway 已运行，但不是由桌面端托管启动。"
          : stateRunning
            ? stateStatus?.message || "Gateway 状态文件显示正在运行。"
            : cliStatus?.message || this.gatewayExitMessage || "Gateway 未由桌面端托管运行。",
      lastOutput: trimLog([this.gatewayOutput, gatewayWarnings, cliStatus?.stdout, cliWarnings].filter(Boolean).join("\n")),
      lastError: trimLog([gatewayError, cliError, ...this.gatewayFailures.values()].filter(Boolean).join("\n")),
      checkedAt: new Date().toISOString(),
    };
  }

  private async refreshGatewayCliStatus() {
    if (!this.gatewayCliCheck) {
      this.gatewayCliCheck = this.gatewayCliStatus().then((status) => {
        this.gatewayCliCache = status;
        this.gatewayCliCachedAt = Date.now();
        return status;
      }).catch(() => undefined).finally(() => { this.gatewayCliCheck = undefined; });
    }
    return this.gatewayCliCheck;
  }

  async checkPreflight(): Promise<{
    ok: boolean;
    message: string;
    root?: string;
    runtimeMode?: NonNullable<RuntimeConfig["hermesRuntime"]>["mode"];
    distro?: string;
    label?: string;
    status: HermesGatewayStatus;
    debugContext?: Record<string, unknown>;
  }> {
    const status = await this.status();
    let root: string;
    try {
      root = await this.resolveHermesRoot();
    } catch (error) {
      return {
        ok: false,
        status,
        message: "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。",
      };
    }
    const runtime = await this.runtimeContext(root);
    if (!runtime.ok) {
      return {
        ok: false,
        root,
        status,
        message: runtime.message,
        debugContext: runtime.debugContext,
      };
    }
    const preflight = await this.preflightGatewayRuntime(runtime);
    return {
      ok: preflight.ok,
      root,
      runtimeMode: runtime.runtime.mode,
      distro: runtime.runtime.distro,
      label: runtime.label,
      status,
      message: preflight.ok ? "Gateway 启动前检查通过。" : preflight.message,
    };
  }

  async start(options: { forceReplace?: boolean } = {}): Promise<HermesGatewayActionResult> {
    if (this.gatewayMaintenance) return this.cancelledGatewayStart("Hermes 正在维护，请等待结束后再启动 Gateway。");
    if (this.gatewayStopPromise) {
      await this.gatewayStopPromise;
      return this.cancelledGatewayStart("Gateway 已停止，请重新发起启动。");
    }
    if (this.gatewayMaintenance) return this.cancelledGatewayStart("Hermes 正在维护，请等待结束后再启动 Gateway。");
    if (this.gatewayStartPromise) {
      return this.gatewayStartPromise;
    }
    const generation = ++this.gatewayStartGeneration;
    this.gatewayUserStopped = false;
    const promise = this.startInternal(options, generation).catch((error) => {
      if (!this.gatewayStartIsCurrent(generation)) return this.cancelledGatewayStart("Gateway 启动已取消。");
      throw error;
    });
    this.gatewayStartPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.gatewayStartPromise === promise) {
        this.gatewayStartPromise = undefined;
      }
    }
  }

  setMaintenance(active: boolean) {
    this.gatewayMaintenance = active;
    if (active) this.invalidateGatewayStartup();
  }

  private invalidateGatewayStartup() {
    this.gatewayStartGeneration += 1;
    this.gatewayUserStopped = true;
    if (this.gatewayAutoRestartTimer) clearTimeout(this.gatewayAutoRestartTimer);
    this.gatewayAutoRestartTimer = undefined;
  }

  private gatewayStartIsCurrent(generation: number) {
    return generation === this.gatewayStartGeneration && !this.gatewayUserStopped && !this.gatewayMaintenance;
  }

  private assertGatewayStartCurrent(generation: number) {
    if (!this.gatewayStartIsCurrent(generation)) throw new Error("Gateway 启动已取消。");
  }

  private async cancelledGatewayStart(message: string): Promise<HermesGatewayActionResult> {
    return { ok: false, status: await this.status(), message };
  }

  private async startInternal(options: { forceReplace?: boolean } = {}, generation = this.gatewayStartGeneration): Promise<HermesGatewayActionResult> {
    const config = await this.readRuntimeConfig?.();
    this.assertGatewayStartCurrent(generation);
    if (config?.extensionSettings && !config.extensionSettings.connectorsEnabled && !config.extensionSettings.cronEnabled) {
      return { ok: false, status: await this.status(), message: "请先在设置中启用消息连接器或定时任务扩展。" };
    }
    const connectorsEnabled = config?.extensionSettings?.connectorsEnabled ?? true;
    const cronEnabled = config?.extensionSettings?.cronEnabled ?? false;
    if (this.gatewayAutoRestartTimer) {
      clearTimeout(this.gatewayAutoRestartTimer);
      this.gatewayAutoRestartTimer = undefined;
    }
    const current = await this.status();
    this.assertGatewayStartCurrent(generation);
    if (current.running && !options.forceReplace) {
      const stored = await this.readConfig().catch(() => ({ platforms: {} }));
      const readyFeishuInstances = connectorsEnabled ? await this.configuredFeishuInstances(stored).catch(() => []) : [];
      this.assertGatewayStartCurrent(generation);
      const hasMissingFeishuInstance = readyFeishuInstances.some(([instanceId]) => {
        const key = feishuRuntimeKey(instanceId);
        return current.platformStates?.[key]?.toLowerCase() !== "connected" && !this.feishuGatewayProcesses.has(normalizeFeishuInstanceId(instanceId));
      });
      if (!hasMissingFeishuInstance && !this.gatewayFailures.has("main")) {
        this.gatewayAutoStartState = "running";
        this.gatewayAutoStartMessage = "Gateway 已在运行。";
        return { ok: true, status: current, message: "Gateway 已在运行。" };
      }
    }
    if (options.forceReplace) {
      this.gatewayBackoffUntil = undefined;
      if (this.gatewayProcess?.pid) {
        const previous = this.gatewayProcess;
        this.expectedGatewayExits.add(previous);
        try { await this.killGatewayProcess(previous.pid!); }
        catch (error) { this.expectedGatewayExits.delete(previous); throw error; }
        if (this.gatewayProcess === previous) this.gatewayProcess = undefined;
        this.assertGatewayStartCurrent(generation);
      }
      for (const [instanceId, child] of this.feishuGatewayProcesses) {
        if (!child.pid) continue;
        this.expectedGatewayExits.add(child);
        try { await this.killGatewayProcess(child.pid); }
        catch (error) { this.expectedGatewayExits.delete(child); throw error; }
        this.assertGatewayStartCurrent(generation);
      }
      this.feishuGatewayProcesses.clear();
      this.feishuGatewayStartedAt.clear();
    }
    if (this.gatewayBackoffUntil && Date.parse(this.gatewayBackoffUntil) > Date.now()) {
      return {
        ok: false,
        status: current,
        message: `Gateway 正在退避期，请在 ${this.gatewayBackoffUntil} 后重试。`,
      };
    }
    let root: string;
    try {
      root = await this.resolveHermesRoot();
    } catch (error) {
      const message = "Hermes Agent 未安装或路径不存在，请重新安装 / 修复安装。";
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = message;
      return {
        ok: false,
        status: { ...current, running: false, healthStatus: "error", message, lastError: message, checkedAt: new Date().toISOString() },
        message,
      };
    }
    const runtime = await this.runtimeContext(root);
    this.assertGatewayStartCurrent(generation);
    this.gatewayAutoStartState = "starting";
    this.gatewayAutoStartMessage = "正在启动 Gateway...";
    if (!runtime.ok) {
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = runtime.message;
      return {
        ok: false,
        status: { ...current, running: false, healthStatus: "error", message: runtime.message, lastError: runtime.message, checkedAt: new Date().toISOString() },
        message: runtime.message,
      };
    }
    const preflight = await this.preflightGatewayRuntime(runtime);
    this.assertGatewayStartCurrent(generation);
    if (!preflight.ok) {
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = preflight.message;
      return {
        ok: false,
        status: { ...current, running: false, healthStatus: "error", message: preflight.message, lastError: preflight.message, checkedAt: new Date().toISOString() },
        message: preflight.message,
      };
    }
    const modelSync = await this.ensureGatewayModelRuntime();
    this.assertGatewayStartCurrent(generation);
    if (!modelSync.ok) {
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = modelSync.message;
      return {
        ok: false,
        status: { ...current, running: false, healthStatus: "error", message: modelSync.message, lastError: modelSync.message, checkedAt: new Date().toISOString() },
        message: modelSync.message,
      };
    }
    await this.clearGatewayRuntimeMarkers();
    try {
      await this.syncEnv();
      this.assertGatewayStartCurrent(generation);
    } catch (error) {
      const message = `连接器配置同步失败：${redactSensitiveText(error instanceof Error ? error.message : String(error))}`;
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = message;
      return { ok: false, status: { ...current, healthStatus: "error", lastError: message }, message };
    }
    const stored = await this.readConfig();
    const hermesEnv = await this.readEnvValues();
    const feishuInstances = connectorsEnabled ? await this.configuredFeishuInstances(stored) : [];
    const hasNonFeishuConnector = cronEnabled || (connectorsEnabled && await this.hasConfiguredNonFeishuConnector(stored, hermesEnv));
    this.assertGatewayStartCurrent(generation);
    let mainStarted = false;
    const mainGatewayAlreadyRunning = !options.forceReplace && !this.gatewayFailures.has("main") && hasMainGatewayRuntime(current, {
      managedMainRunning: Boolean(this.gatewayProcess && !this.gatewayProcess.killed),
      managedFeishuCount: this.feishuGatewayProcesses.size,
    });
    if (hasNonFeishuConnector && !mainGatewayAlreadyRunning) {
      const launch = await this.gatewayLaunchFromRuntime(runtime, hermesEnv);
      this.assertGatewayStartCurrent(generation);
      console.info("[Hermes Forge] Gateway launch", {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        label: launch.label,
        runtimeMode: runtime.runtime.mode,
        distro: runtime.runtime.distro,
        hermesRoot: runtime.root,
      });
      const child = this.spawnGatewayProcess(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        windowsHide: true,
        shell: false,
      });
      this.gatewayProcess = child;
      this.gatewayFailures.delete("main");
      this.gatewayCliCache = undefined;
      this.gatewayStartedAt = new Date().toISOString();
      this.gatewayOutput = "";
      this.gatewayError = "";
      this.gatewayExitMessage = "";
      this.gatewayBackoffUntil = undefined;
      this.gatewayOutput = `Using runtime: ${launch.label}`;
      child.stdout.on("data", (chunk: Buffer) => {
        this.gatewayOutput = trimLog(`${this.gatewayOutput}${chunk.toString("utf8")}`);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        this.gatewayError = trimLog(`${this.gatewayError}${chunk.toString("utf8")}`);
      });
      child.on("error", (error) => {
        this.gatewayError = trimLog(`${this.gatewayError}\n${error.message}`);
      });
      child.on("close", (exitCode) => {
        this.handleGatewayProcessClose(child, exitCode);
      });
      await this.sleep(1200);
      const status = await this.status();
      this.assertGatewayStartCurrent(generation);
      if (!status.running) {
        this.gatewayAutoStartState = "failed";
        this.gatewayAutoStartMessage = status.lastError || status.message || "Gateway 启动失败。";
        return {
          ok: false,
          status,
          message: status.lastError || status.message || "Gateway 启动失败。",
        };
      }
      mainStarted = true;
    } else if (hasNonFeishuConnector) {
      mainStarted = true;
    }
    for (const [instanceId, instance] of feishuInstances) {
      this.assertGatewayStartCurrent(generation);
      await this.startFeishuGatewayInstance(runtime, instanceId, instance, generation);
      this.assertGatewayStartCurrent(generation);
    }
    if (!mainStarted && feishuInstances.length === 0) {
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = "没有完整可启动的连接器。";
      return {
        ok: false,
        status: await this.status(),
        message: "没有完整可启动的连接器。",
      };
    }
    const status = await this.status();
    this.assertGatewayStartCurrent(generation);
    if (!status.running || status.healthStatus === "error") {
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = status.lastError || status.message || "Gateway 启动失败。";
      return { ok: false, status, message: status.lastError || status.message || "Gateway 启动失败。" };
    }
    this.gatewayAutoStartState = "running";
    this.gatewayAutoStartMessage = "Gateway 已自动启动。";
    return { ok: true, status, message: status.managedRunning ? "Gateway 已启动。" : "Gateway 已可用。" };
  }

  async stop(): Promise<HermesGatewayActionResult> {
    this.invalidateGatewayStartup();
    if (this.gatewayStopPromise) return this.gatewayStopPromise;
    const promise = this.stopInternal(this.gatewayStartPromise);
    this.gatewayStopPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.gatewayStopPromise === promise) this.gatewayStopPromise = undefined;
    }
  }

  private async stopInternal(starting?: Promise<HermesGatewayActionResult>): Promise<HermesGatewayActionResult> {
    if (this.gatewayProcess?.pid) {
      await this.killGatewayProcess(this.gatewayProcess.pid);
      this.gatewayProcess = undefined;
    }
    for (const [instanceId, child] of this.feishuGatewayProcesses) {
      if (child.pid) {
        await this.killGatewayProcess(child.pid);
      }
    }
    await starting?.catch(() => undefined);
    this.feishuGatewayProcesses.clear();
    this.feishuGatewayStartedAt.clear();
    this.gatewayStartedAt = undefined;
    this.gatewayLastExitCode = 0;
    this.gatewayLastExitAt = new Date().toISOString();
    this.gatewayExitMessage = "Gateway 已由桌面端停止。";
    this.gatewayAutoStartState = "idle";
    this.gatewayAutoStartMessage = "Gateway 已停止。";
    this.gatewayFailures.clear();
    this.gatewayCliCache = undefined;
    return { ok: true, status: await this.status(), message: "Gateway 已停止。" };
  }

  private handleGatewayProcessClose(child: ChildProcessWithoutNullStreams, exitCode: number | null) {
    if (this.gatewayProcess !== child) {
      return;
    }
    if (this.expectedGatewayExits.delete(child)) {
      this.gatewayProcess = undefined;
      this.gatewayStartedAt = undefined;
      return;
    }
    const wasRunning = this.gatewayAutoStartState === "running" || this.gatewayAutoStartState === "starting";
    this.gatewayLastExitCode = exitCode;
    this.gatewayLastExitAt = new Date().toISOString();
    this.gatewayExitMessage = `Gateway 已退出，退出码：${exitCode ?? "unknown"}`;
    if (!this.gatewayUserStopped) {
      this.gatewayFailures.set("main", this.gatewayExitMessage);
      this.gatewayRestartCount += 1;
      this.gatewayBackoffUntil = new Date(Date.now() + 5_000).toISOString();
      this.gatewayAutoStartState = "failed";
      this.gatewayAutoStartMessage = this.gatewayError.trim() || this.gatewayExitMessage;
    } else {
      this.gatewayAutoStartState = "idle";
      this.gatewayAutoStartMessage = "Gateway 已停止。";
    }
    this.gatewayProcess = undefined;
    this.gatewayStartedAt = undefined;
    if (wasRunning && !this.gatewayUserStopped) {
      this.scheduleAutoRestart();
    }
  }

  async restart(): Promise<HermesGatewayActionResult> {
    await this.stop();
    return this.start({ forceReplace: true });
  }

  async shutdown() {
    await this.stop();
    await this.cancelWeixinQrLogin();
  }

  async autoStartIfConfigured() {
    const runtimeConfig = await this.readRuntimeConfig?.();
    if (runtimeConfig?.extensionSettings?.cronEnabled) {
      const result = await this.start();
      this.gatewayAutoStartState = result.ok ? "running" : "failed";
      this.gatewayAutoStartMessage = result.message;
      return;
    }
    if (runtimeConfig?.extensionSettings?.connectorsEnabled === false) {
      this.gatewayAutoStartState = "idle";
      this.gatewayAutoStartMessage = "扩展未启用，已跳过自动启动。";
      return;
    }
    this.gatewayAutoStartState = "starting";
    this.gatewayAutoStartMessage = "正在检查连接器并准备自动启动...";
    const stored = await this.readConfig();
    const envValues = await this.readEnvValues();
    const readyFeishuInstances = await this.configuredFeishuInstances(stored);
    const enabledPlatforms = PLATFORM_REGISTRY
      .map((platform) => ({ platform, config: stored.platforms?.[platform.id] }))
      .filter((item) => item.platform.id !== "feishu" && item.config && item.config.enabled !== false);
    if (enabledPlatforms.length === 0 && readyFeishuInstances.length === 0) {
      this.gatewayAutoStartState = "idle";
      this.gatewayAutoStartMessage = "没有已启用的连接器，已跳过自动启动。";
      return;
    }
    if (readyFeishuInstances.length > 0) {
      await this.syncEnv();
      const result = await this.start();
      this.gatewayAutoStartState = result.ok ? "running" : "failed";
      this.gatewayAutoStartMessage = result.message;
      return;
    }
    for (const item of enabledPlatforms) {
      const missing = await this.missingRequired(item.platform, item.config, envValues);
      if (missing.length === 0) {
        await this.syncEnv();
        const result = await this.start();
        this.gatewayAutoStartState = result.ok ? "running" : "failed";
        this.gatewayAutoStartMessage = result.message;
        return;
      }
    }
    this.gatewayAutoStartState = "idle";
    this.gatewayAutoStartMessage = "连接器尚未配置完整，已跳过自动启动。";
  }

  private scheduleAutoRestart() {
    if (this.gatewayMaintenance || this.gatewayUserStopped) return;
    if (this.gatewayAutoRestartTimer) {
      clearTimeout(this.gatewayAutoRestartTimer);
    }
    const maxRetries = 10;
    if (this.gatewayRestartCount > maxRetries) {
      this.gatewayAutoStartMessage = `Gateway 已连续崩溃 ${maxRetries} 次，自动重启已停止。请检查日志或手动启动。`;
      return;
    }
    const backoffMs = this.gatewayRestartCount <= 1
      ? 3_000
      : this.gatewayRestartCount <= 3
        ? 10_000
        : this.gatewayRestartCount <= 5
          ? 30_000
          : 60_000;
    this.gatewayBackoffUntil = new Date(Date.now() + backoffMs).toISOString();
    this.gatewayAutoStartMessage = `Gateway 异常退出，将在 ${Math.round(backoffMs / 1000)} 秒后自动重启（第 ${this.gatewayRestartCount} 次）...`;
    this.gatewayAutoRestartTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.autoStartIfConfigured();
        } catch (error) {
          console.warn("[Hermes Forge] Gateway auto-restart failed:", error);
        }
      })();
    }, backoffMs);
  }

  getWeixinQrStatus(): WeixinQrLoginStatus {
    return { ...this.weixinQrStatus };
  }

  private failWeixinQrStart(error: unknown, failureCode: string, recommendedFix: string): WeixinQrLoginResult {
    const message = recommendedFix;
    const status: WeixinQrLoginStatus = {
      ...this.weixinQrStatus,
      running: false,
      phase: "failed",
      completedAt: new Date().toISOString(),
      success: false,
      failureCode,
      lastHeartbeatAt: new Date().toISOString(),
      message,
      recoveryAction: undefined,
      recoveryCommand: undefined,
      failureKind: "manual_fix",
      recommendedFix,
    };
    this.weixinQrStatus = status;
    return { ok: false, status: this.getWeixinQrStatus(), message };
  }

  async startWeixinQrLogin(): Promise<WeixinQrLoginResult> {
    if (this.weixinQrProcess && !this.weixinQrProcess.killed) {
      return { ok: true, status: this.getWeixinQrStatus(), message: "微信扫码登录已在进行中。" };
    }
    let root: string;
    try {
      root = await this.resolveHermesRoot();
    } catch (error) {
      return this.failWeixinQrStart(error, "hermes_root_unavailable", "无法定位 Hermes Agent 安装位置。请到「设置 → Hermes 运行时」中检查 Hermes Agent 安装状态，或运行一键诊断。");
    }
    const runtime = await this.runtimeContext(root);
    if (!runtime.ok && runtime.debugContext?.preflight) {
      // Preflight definitively failed (Hermes/Python missing). Surface that as the user-facing reason
      // rather than silently retrying the legacy fallback, which would just throw a less actionable error.
      return this.failWeixinQrStart(
        new Error(runtime.message),
        "runtime_preflight_failed",
        "请到「设置 → Hermes 运行时」中检查 Hermes Agent 安装状态，或运行一键诊断。",
      );
    }
    let dependencyStatus: WeixinQrLoginStatus | undefined;
    try {
      dependencyStatus = runtime.ok
        ? await this.preflightWeixinDependenciesWithRuntime(runtime)
        : await this.preflightWeixinDependencies(root, await this.resolvePythonCommand(root));
    } catch (error) {
      return this.failWeixinQrStart(error, "python_unavailable", "请在「设置 → Hermes 运行时」配置可用的 Python 命令（例如 py -3 或 python.exe 完整路径），并确认 Hermes Agent 已安装。");
    }
    if (dependencyStatus) {
      this.weixinQrStatus = dependencyStatus;
      return { ok: false, status: this.getWeixinQrStatus(), message: dependencyStatus.message };
    }
    const scriptPath = this.weixinQrLoginScriptPath();

    this.weixinQrLineBuffer = "";
    this.weixinQrStatus = {
      running: true,
      phase: "fetching_qr",
      startedAt: new Date().toISOString(),
      success: undefined,
      message: "正在获取微信二维码...",
      failureCode: undefined,
      lastHeartbeatAt: new Date().toISOString(),
      attempt: (this.weixinQrStatus.attempt ?? 0) + 1,
      recoveryAction: undefined,
      recoveryCommand: undefined,
      runtimePythonLabel: runtime.ok ? runtime.label : undefined,
      failureKind: undefined,
      recommendedFix: undefined,
    };
    const runId = ++this.weixinQrRunCounter;
    this.activeWeixinQrRunId = runId;
    let launch: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv };
    try {
      launch = runtime.ok
        ? await runtime.adapter.buildPythonLaunch({
          runtime: runtime.runtime,
          rootPath: runtime.adapter.toRuntimePath(root),
          pythonArgs: [runtime.adapter.toRuntimePath(scriptPath)],
          cwd: root,
          env: buildPythonEnv(process.env, await this.isEditableInstall(root) ? [runtime.adapter.toRuntimePath(root)] : []),
        })
        : await this.legacyPythonLaunch(root, [scriptPath]);
    } catch (error) {
      this.activeWeixinQrRunId = undefined;
      return this.failWeixinQrStart(error, "launch_build_failed", "请在「设置 → Hermes 运行时」配置可用的 Python 命令，并确认 Hermes Agent 已正确安装。");
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      this.activeWeixinQrRunId = undefined;
      return this.failWeixinQrStart(error, "spawn_failed", "无法启动微信扫码进程。请确认 Python 可执行文件存在并具有运行权限。");
    }
    this.weixinQrProcess = child;
    child.stdout.on("data", (chunk: Buffer) => this.handleWeixinQrOutput(runId, chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.handleWeixinQrStderr(runId, chunk.toString("utf8")));
    child.on("error", (error) => this.handleWeixinQrProcessError(runId, error));
    child.on("close", (exitCode) => this.handleWeixinQrProcessClose(runId, exitCode));
    return { ok: true, status: this.getWeixinQrStatus(), message: "微信扫码登录已启动。" };
  }

  async cancelWeixinQrLogin(): Promise<WeixinQrLoginResult> {
    this.activeWeixinQrRunId = undefined;
    if (this.weixinQrProcess?.pid) {
      await killProcessTree(this.weixinQrProcess.pid);
      this.weixinQrProcess = undefined;
    }
    this.weixinQrLineBuffer = "";
    this.weixinQrStatus = {
      ...this.weixinQrStatus,
      running: false,
      phase: "cancelled",
      completedAt: new Date().toISOString(),
      success: false,
      failureCode: "cancelled",
      lastHeartbeatAt: new Date().toISOString(),
      message: "微信扫码登录已取消。",
      recoveryAction: undefined,
      recoveryCommand: undefined,
      failureKind: undefined,
      recommendedFix: undefined,
    };
    return { ok: true, status: this.getWeixinQrStatus(), message: "微信扫码登录已取消。" };
  }

  private handleWeixinQrOutput(runId: number, text: string) {
    if (!this.isActiveWeixinQrRun(runId)) return;
    this.weixinQrLineBuffer += text;
    const lines = this.weixinQrLineBuffer.split(/\r?\n/);
    this.weixinQrLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseWeixinQrEvent(line);
      if (!event) {
        const safeLine = sanitizeSensitiveLog(line);
        if (!safeLine.trim()) continue;
        this.weixinQrStatus = {
          ...this.weixinQrStatus,
          lastHeartbeatAt: new Date().toISOString(),
          output: trimLog(`${this.weixinQrStatus.output ?? ""}${safeLine}\n`),
        };
        continue;
      }
      if (event.type === "qr") {
        this.weixinQrStatus = {
          ...this.weixinQrStatus,
          running: true,
          phase: "waiting_scan",
          qrUrl: event.qrUrl,
          expiresAt: event.expiresAt,
          lastHeartbeatAt: new Date().toISOString(),
          message: event.message || "请使用微信扫码。",
        };
        continue;
      }
      if (event.type === "phase") {
        this.weixinQrStatus = {
          ...this.weixinQrStatus,
          running: true,
          phase: event.phase,
          lastHeartbeatAt: new Date().toISOString(),
          message: event.message || this.weixinQrStatus.message,
          recoveryAction: undefined,
          recoveryCommand: undefined,
          failureKind: undefined,
          recommendedFix: undefined,
        };
        continue;
      }
      if (event.type === "error") {
        const decorated = decorateWeixinFailure(
          event.code,
          event.message || "微信扫码登录失败。",
          this.weixinQrStatus.runtimePythonLabel,
        );
        this.weixinQrStatus = {
          ...this.weixinQrStatus,
          running: false,
          phase: event.code === "timeout" ? "timeout" : "failed",
          completedAt: new Date().toISOString(),
          success: false,
          failureCode: event.code ?? "unknown_error",
          lastHeartbeatAt: new Date().toISOString(),
          message: decorated.message,
          recoveryAction: decorated.recoveryAction,
          recoveryCommand: decorated.recoveryCommand,
          failureKind: decorated.failureKind,
          recommendedFix: decorated.recommendedFix,
        };
        continue;
      }
      // Confirmed: move to saving immediately so handleWeixinQrProcessClose does not race
      // and overwrite the status with failed/timeout before completeWeixinQrLogin finishes.
      this.weixinQrStatus = {
        ...this.weixinQrStatus,
        phase: "saving",
      };
      void this.completeWeixinQrLogin(runId, event);
    }
  }

  private handleWeixinQrStderr(runId: number, text: string) {
    if (!this.isActiveWeixinQrRun(runId)) return;
    this.weixinQrStatus = {
      ...this.weixinQrStatus,
      lastHeartbeatAt: new Date().toISOString(),
      output: trimLog(`${this.weixinQrStatus.output ?? ""}${sanitizeSensitiveLog(text)}`),
    };
  }

  private handleWeixinQrProcessError(runId: number, error: Error) {
    if (!this.isActiveWeixinQrRun(runId)) return;
    this.activeWeixinQrRunId = undefined;
    this.weixinQrStatus = {
      ...this.weixinQrStatus,
      running: false,
      phase: "failed",
      completedAt: new Date().toISOString(),
      success: false,
      failureCode: "spawn_failed",
      lastHeartbeatAt: new Date().toISOString(),
      message: `微信扫码登录启动失败：${error.message}`,
    };
  }

  private handleWeixinQrProcessClose(runId: number, exitCode: number | null) {
    if (!this.isActiveWeixinQrRun(runId)) return;
    this.weixinQrProcess = undefined;
    this.weixinQrLineBuffer = "";
    if (isWeixinQrTerminal(this.weixinQrStatus.phase) || ["saving", "syncing", "starting_gateway"].includes(this.weixinQrStatus.phase)) return;
    this.activeWeixinQrRunId = undefined;
    // Exit 0 only means the Python process ended cleanly. Login success is recognized
    // earlier from a confirmed credential event; without that event, this is missing credentials.
    this.weixinQrStatus = {
      ...this.weixinQrStatus,
      running: false,
      phase: exitCode === 0 ? "failed" : "timeout",
      completedAt: new Date().toISOString(),
      success: false,
      failureCode: exitCode === 0 ? "missing_credentials" : "timeout",
      lastHeartbeatAt: new Date().toISOString(),
      message: exitCode === 0 ? "微信扫码登录已结束，但未返回凭据。" : "微信扫码登录未完成或已超时。",
    };
  }

  private async preflightWeixinDependencies(root: string, python: PythonCommand): Promise<WeixinQrLoginStatus | undefined> {
    // Legacy fallback: dependency probing uses the same result parser as runtime-backed probing.
    const result = await runCommand(
      python.command,
      [...python.args, "-c", "import importlib.util, json; print(json.dumps({'aiohttp': bool(importlib.util.find_spec('aiohttp'))}))"],
      {
        cwd: root,
        timeoutMs: 10000,
        env: buildPythonEnv(undefined, await this.isEditableInstall(root) ? [root] : []),
        commandId: "connector.weixin.preflight-dependencies.legacy",
        runtimeKind: "windows",
      },
    );
    return this.weixinDependencyStatusFromResult(result, python.label);
  }

  private weixinDependencyStatusFromResult(
    result: Awaited<ReturnType<typeof runCommand>>,
    runtimePythonLabel?: string,
  ): WeixinQrLoginStatus | undefined {
    if (result.exitCode !== 0) {
      return {
        running: false,
        phase: "failed",
        completedAt: new Date().toISOString(),
        success: false,
        message: "无法检查微信扫码运行环境，请确认 Hermes Python 可正常执行。",
        failureCode: "python_preflight_failed",
        runtimePythonLabel,
        failureKind: "manual_fix",
        recommendedFix: "请先在设置里确认 Hermes Python 命令可执行，再重新尝试扫码。",
      };
    }
    let payload: { aiohttp?: boolean };
    try {
      payload = JSON.parse(result.stdout.trim() || "{}") as { aiohttp?: boolean };
    } catch (error) {
      console.warn("[Hermes Forge] Weixin dependency probe returned invalid JSON:", {
        error: error instanceof Error ? error.message : String(error),
        stdout: redactSensitiveText(result.stdout).slice(0, 1000),
        stderr: redactSensitiveText(result.stderr).slice(0, 1000),
      });
      return decorateWeixinFailure("python_probe_invalid_json", "微信扫码依赖探测返回了非 JSON 输出，运行环境可能异常。", runtimePythonLabel);
    }
    if (!payload.aiohttp) {
      return decorateWeixinFailure("missing_aiohttp", "缺少 aiohttp，微信扫码运行环境不完整。", runtimePythonLabel);
    }
    return undefined;
  }

  private async completeWeixinQrLogin(runId: number, credentials: Extract<WeixinQrEvent, { type: "confirmed" }>) {
    if (!this.isActiveWeixinQrRun(runId)) return;
    const setPhase = (phase: WeixinQrLoginStatus["phase"], message: string) => {
      if (!this.isActiveWeixinQrRun(runId)) return false;
      this.weixinQrStatus = {
        ...this.weixinQrStatus,
        running: true,
        phase,
        message,
      };
      return true;
    };
    try {
      if (!credentials.accountId || !credentials.token) throw new Error("扫码结果缺少 accountId 或 token。");
      if (!setPhase("saving", "微信已确认，正在加密保存凭据...")) return;
      const stored = await this.readConfig();
      const current = stored.platforms?.weixin ?? {};
      const tokenRef = secretRef("weixin", "token");
      await this.secretVault.saveSecret(tokenRef, credentials.token);
      stored.platforms ??= {};
      stored.platforms.weixin = {
        enabled: true,
        values: {
          ...(current.values ?? {}),
          accountId: credentials.accountId,
          ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
          cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
          dmPolicy: "pairing",
          allowAllUsers: !credentials.userId,
          ...(credentials.userId ? { allowedUsers: credentials.userId } : {}),
          groupPolicy: "disabled",
          ...(credentials.userId ? { homeChannel: credentials.userId } : {}),
        },
        secretRefs: { ...(current.secretRefs ?? {}), token: tokenRef },
        updatedAt: new Date().toISOString(),
        lastSyncedAt: current.lastSyncedAt,
      };
      await this.writeConfig(stored);
      if (!setPhase("syncing", "凭据已保存，正在同步 Hermes .env...")) return;
      await this.syncEnv();
      if (!setPhase("starting_gateway", "配置已同步，正在启动 Gateway...")) return;
      const gatewayResult = await this.start({ forceReplace: true });
      const gatewayStarted = gatewayResult.ok && gatewayResult.status.running;
      if (!this.isActiveWeixinQrRun(runId)) return;
      this.activeWeixinQrRunId = undefined;
      this.weixinQrStatus = {
        ...this.weixinQrStatus,
        running: false,
        phase: "success",
        completedAt: new Date().toISOString(),
        success: true,
        accountId: credentials.accountId,
        userId: credentials.userId,
        gatewayStarted,
        lastHeartbeatAt: new Date().toISOString(),
        message: gatewayStarted
          ? "微信扫码成功，凭据已保存并同步，Gateway 已启动。"
          : `微信扫码成功，凭据已保存并同步，但 Gateway 启动状态需要确认：${gatewayResult.message}`,
      };
    } catch (error) {
      if (!this.isActiveWeixinQrRun(runId)) return;
      this.activeWeixinQrRunId = undefined;
      this.weixinQrStatus = {
        ...this.weixinQrStatus,
        running: false,
        phase: "failed",
        completedAt: new Date().toISOString(),
        success: false,
        failureCode: "complete_failed",
        lastHeartbeatAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "微信扫码登录结果处理失败。",
      };
    }
  }

  private isActiveWeixinQrRun(runId: number) {
    return this.activeWeixinQrRunId === runId;
  }

  private async toConnector(
    platform: HermesConnectorPlatform,
    stored: StoredConnectorConfig,
    envValues: Record<string, string>,
    gateway: HermesGatewayStatus,
    instanceId?: string,
    instanceConfig?: StoredPlatformConfig,
  ): Promise<HermesConnectorConfig> {
    const saved = platform.id === "feishu"
      ? instanceConfig ?? this.feishuInstanceConfig(stored.platforms?.feishu, normalizeFeishuInstanceId(instanceId))
      : stored.platforms?.[platform.id];
    const enabled = saved?.enabled !== false;
    const values: Record<string, string | boolean> = {};
    const secretRefs: Record<string, string> = {};
    const secretStatus: Record<string, boolean> = {};

    for (const field of platform.fields) {
      if (field.secret) {
        const ref = saved?.secretRefs?.[field.key] ?? (envValues[field.envVar] ? secretRef(platform.id, field.key) : undefined);
        if (ref) {
          secretRefs[field.key] = ref;
          secretStatus[field.key] = await this.secretVault.hasSecret(ref);
        } else {
          secretStatus[field.key] = false;
        }
        continue;
      }
      const savedValue = saved?.values?.[field.key];
      const envValue = envValues[field.envVar];
      if (typeof savedValue !== "undefined") {
        values[field.key] = savedValue;
      } else if (typeof envValue !== "undefined") {
        values[field.key] = field.type === "boolean" ? parseBoolean(envValue) : envValue;
      } else if (field.type === "boolean") {
        values[field.key] = false;
      }
    }

    const missingRequired = await this.missingRequired(platform, saved, envValues);
    const configured = await this.hasConfigurationSignal(platform, saved, envValues) && missingRequired.length === 0;
    const status = connectorStatus(enabled, configured);
    const runtimeKey = platform.id === "feishu" ? feishuRuntimeKey(normalizeFeishuInstanceId(instanceId)) : platform.id;
    const runtimeStatus = connectorRuntimeStatus(runtimeKey, enabled, configured, gateway);
    const connectorInstanceId = platform.id === "feishu" ? normalizeFeishuInstanceId(instanceId) : undefined;
    const connectorAgentId = platform.id === "feishu" ? stringValue(values.agentId) || "default" : undefined;
    return {
      platform,
      instanceId: connectorInstanceId,
      instanceLabel: platform.id === "feishu" ? feishuInstanceLabel(connectorInstanceId, values) : undefined,
      agentId: connectorAgentId,
      status,
      runtimeStatus,
      enabled,
      configured,
      missingRequired,
      values,
      secretRefs,
      secretStatus,
      updatedAt: saved?.updatedAt,
      lastSyncedAt: saved?.lastSyncedAt,
      message: statusMessage(status, runtimeStatus, missingRequired),
    };
  }

  async importFromEnvValues(envValues: Record<string, string>) {
    const stored = await this.readConfig();
    const importedPlatforms: HermesConnectorPlatformId[] = [];
    const importedSecretRefs: string[] = [];
    let changed = false;

    for (const platform of PLATFORM_REGISTRY) {
      if (platform.id === "feishu") {
        const feishu = this.ensureFeishuInstances(stored.platforms?.feishu);
        const current = feishu.instances!.default ?? {};
        const values: Record<string, string | boolean> = { ...(current.values ?? {}) };
        const secretRefs: Record<string, string> = { ...(current.secretRefs ?? {}) };
        let importedForPlatform = false;

        for (const field of platform.fields) {
          const raw = envValues[field.envVar];
          if (typeof raw === "undefined" || !String(raw).trim()) continue;
          importedForPlatform = true;
          changed = true;
          if (field.secret) {
            const ref = secretRef(platform.id, field.key, "default");
            await this.secretVault.saveSecret(ref, String(raw).trim());
            secretRefs[field.key] = ref;
            importedSecretRefs.push(ref);
            continue;
          }
          values[field.key] = field.type === "boolean" ? parseBoolean(raw) : String(raw).trim();
        }

        if (!importedForPlatform) continue;
        stored.platforms ??= {};
        feishu.instances!.default = {
          ...current,
          enabled: current.enabled ?? true,
          values,
          secretRefs,
          updatedAt: new Date().toISOString(),
          lastSyncedAt: current.lastSyncedAt,
        };
        stored.platforms.feishu = feishu;
        importedPlatforms.push(platform.id);
        continue;
      }
      const current = stored.platforms?.[platform.id] ?? {};
      const values: Record<string, string | boolean> = { ...(current.values ?? {}) };
      const secretRefs: Record<string, string> = { ...(current.secretRefs ?? {}) };
      let importedForPlatform = false;

      for (const field of platform.fields) {
        const raw = envValues[field.envVar];
        if (typeof raw === "undefined" || !String(raw).trim()) continue;
        importedForPlatform = true;
        changed = true;
        if (field.secret) {
          const ref = secretRef(platform.id, field.key);
          await this.secretVault.saveSecret(ref, String(raw).trim());
          secretRefs[field.key] = ref;
          importedSecretRefs.push(ref);
          continue;
        }
        values[field.key] = field.type === "boolean" ? parseBoolean(raw) : String(raw).trim();
      }

      if (!importedForPlatform) continue;
      stored.platforms ??= {};
      stored.platforms[platform.id] = {
        ...current,
        enabled: current.enabled ?? true,
        values,
        secretRefs,
        updatedAt: new Date().toISOString(),
        lastSyncedAt: current.lastSyncedAt,
      };
      importedPlatforms.push(platform.id);
    }

    if (changed) {
      await this.writeConfig(stored);
    }

    return {
      importedPlatforms,
      importedSecretRefs: [...new Set(importedSecretRefs)],
    };
  }

  private async missingRequired(platform: HermesConnectorPlatform, saved: StoredPlatformConfig | undefined, envValues: Record<string, string>) {
    const missing: string[] = [];
    for (const field of platform.fields.filter((item) => item.required)) {
      if (field.secret) {
        const ref = saved?.secretRefs?.[field.key];
        const hasSavedSecret = ref ? await this.secretVault.hasSecret(ref) : false;
        if (!hasSavedSecret && !envValues[field.envVar]) missing.push(field.key);
        continue;
      }
      const savedValue = saved?.values?.[field.key];
      if (field.type === "boolean") {
        if (savedValue !== true && !parseBoolean(envValues[field.envVar])) missing.push(field.key);
      } else if (!String(savedValue ?? envValues[field.envVar] ?? "").trim()) {
        missing.push(field.key);
      }
    }
    if (platform.id === "matrix") {
      const tokenRef = saved?.secretRefs?.accessToken;
      const passwordRef = saved?.secretRefs?.password;
      const hasToken = (tokenRef ? await this.secretVault.hasSecret(tokenRef) : false) || Boolean(envValues.MATRIX_ACCESS_TOKEN);
      const hasPassword = (passwordRef ? await this.secretVault.hasSecret(passwordRef) : false) || Boolean(envValues.MATRIX_PASSWORD);
      if (!hasToken && !hasPassword) missing.push("accessToken");
    }
    return [...new Set(missing)];
  }

  private async hasConfigurationSignal(
    platform: HermesConnectorPlatform,
    saved: StoredPlatformConfig | undefined,
    envValues: Record<string, string>,
  ) {
    for (const field of platform.fields) {
      if (field.secret) {
        const ref = saved?.secretRefs?.[field.key];
        if ((ref && await this.secretVault.hasSecret(ref)) || Boolean(envValues[field.envVar]?.trim())) {
          return true;
        }
        continue;
      }
      const savedValue = saved?.values?.[field.key];
      if (field.type === "boolean") {
        if (savedValue === true || parseBoolean(envValues[field.envVar])) {
          return true;
        }
        continue;
      }
      if (String(savedValue ?? envValues[field.envVar] ?? "").trim()) {
        return true;
      }
    }
    return false;
  }

  private async runtimeContext(root: string): Promise<ConnectorRuntimeContext> {
    if (!this.runtimeAdapterFactory || !this.readRuntimeConfig) {
      // Legacy fallback: older tests and standalone construction paths still rely on resolvePythonCommand().
      return {
        ok: false,
        message: "RuntimeAdapter 未注入，连接器将回退 legacy Python 解析。",
      };
    }
    const config = await this.readRuntimeConfig();
    const mode = config.hermesRuntime?.mode ?? "windows";
    const runtime = {
      mode,
      distro: config.hermesRuntime?.distro?.trim() || undefined,
      pythonCommand: config.hermesRuntime?.pythonCommand?.trim() || (mode === "windows" ? "python" : "python3"),
      windowsAgentMode: config.hermesRuntime?.windowsAgentMode ?? "hermes_native",
    } satisfies NonNullable<RuntimeConfig["hermesRuntime"]>;
    const adapter = this.runtimeAdapterFactory(runtime);
    const preflight = await adapter.preflight();
    if (!preflight.ok) {
      const failure = summarizePreflightFailure(preflight);
      return {
        ok: false,
        message: failure.message,
        debugContext: { preflight },
      };
    }
    const probe = await this.runtimeProbeService?.probe({ runtime }).catch(() => undefined);
    return {
      ok: true,
      root,
      runtime,
      adapter,
      label: probe?.runtimeMode === "wsl"
        ? `WSL ${probe.distroName ?? "default"} ${probe.commands.wsl.pythonCommand ?? runtime.pythonCommand ?? "python3"}`
        : probe?.commands.python.label ?? runtime.pythonCommand ?? "python",
    };
  }

  private async preflightGatewayRuntime(runtime: Extract<ConnectorRuntimeContext, { ok: true }>): Promise<{ ok: true } | { ok: false; message: string }> {
    const runtimeRoot = runtime.adapter.toRuntimePath(runtime.root);
    const cliPath = runtime.runtime.mode === "wsl" ? `${runtimeRoot.replace(/\/+$/, "")}/hermes` : this.hermesCliPath(runtime.root);
    if (runtime.runtime.mode === "wsl") {
      const validation = await validateWslHermesCli(runtime.runtime, cliPath);
      console.info("[Hermes Forge] Gateway WSL preflight", {
        distro: runtime.runtime.distro,
        hermesRoot: runtimeRoot,
        cliPath,
        ok: validation.ok,
        command: validation.command,
        exitCode: validation.result?.exitCode,
        stderr: validation.result?.stderr,
      });
      if (!validation.ok) {
        return { ok: false, message: validation.message };
      }
      return { ok: true };
    }
    const runtimeHermesHome = runtime.adapter.toRuntimePath(await this.activeHermesHome());
    const launch = await runtime.adapter.buildHermesLaunch({
      runtime: runtime.runtime,
      rootPath: runtimeRoot,
      pythonArgs: [cliPath, "--version"],
      cwd: runtime.root,
      env: buildPythonEnv({ HERMES_HOME: runtimeHermesHome }, await this.isEditableInstall(runtime.root) ? [runtimeRoot] : []),
    });
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: 20_000,
      env: launch.env,
      commandId: "connector.gateway.preflight.version",
      runtimeKind: runtime.runtime.mode,
    });
    console.info("[Hermes Forge] Gateway preflight", {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      runtimeMode: runtime.runtime.mode,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return result.exitCode === 0
      ? { ok: true }
      : { ok: false, message: `Gateway 启动前 Hermes 版本检查失败，请检查安装是否完整。` };
  }

  private async gatewayLaunchFromRuntime(runtime: Extract<ConnectorRuntimeContext, { ok: true }>, hermesEnv: Record<string, string>, hermesHomeOverride?: string) {
    const runtimeRoot = runtime.adapter.toRuntimePath(runtime.root);
    const runtimeConfig = await this.readRuntimeConfig?.();
    const gatewayScript = [
      path.join(process.resourcesPath ?? "", "hermes-forge-gateway.py"),
      path.join(process.cwd(), "resources", "hermes-forge-gateway.py"),
    ].find((candidate) => fsSync.existsSync(candidate));
    if (!gatewayScript) throw new Error("Gateway 适配资源缺失，请修复客户端安装。");
    const runtimeHermesHome = runtime.adapter.toRuntimePath(hermesHomeOverride ?? await this.activeHermesHome());
    const launch = await runtime.adapter.buildHermesLaunch({
      runtime: runtime.runtime,
      rootPath: runtimeRoot,
      pythonArgs: [runtime.adapter.toRuntimePath(gatewayScript), "--replace"],
      cwd: runtime.root,
      env: {
        ...buildGatewayEnv(process.env, hermesEnv, runtimeRoot, runtimeHermesHome, await this.isEditableInstall(runtime.root)),
        HERMES_FORGE_CONNECTORS_ENABLED: runtimeConfig?.extensionSettings?.connectorsEnabled === false ? "0" : "1",
        // Separate Feishu homes must not duplicate the main scheduler.
        HERMES_FORGE_CRON_ENABLED: !hermesHomeOverride && runtimeConfig?.extensionSettings?.cronEnabled ? "1" : "0",
      },
    });
    return {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      label: launch.diagnostics.label,
    };
  }

  private async startFeishuGatewayInstance(
    runtime: Extract<ConnectorRuntimeContext, { ok: true }>,
    instanceId: string,
    instance: StoredPlatformConfig,
    generation = this.gatewayStartGeneration,
  ) {
    this.assertGatewayStartCurrent(generation);
    const normalizedId = normalizeFeishuInstanceId(instanceId);
    const existing = this.feishuGatewayProcesses.get(normalizedId);
    if (existing && !existing.killed) return;
    const agent = await this.feishuAgentHome(instance, { create: true });
    const instanceHome = await this.feishuInstanceHome(normalizedId, instance, { create: true });
    await this.prepareFeishuInstanceRuntimeHome(instanceHome, agent.home);
    const envValues = await this.readEnvValuesFromPath(await this.feishuInstanceEnvPath(normalizedId, instance));
    const activeEnv = await this.readEnvValues();
    const agentEnv = await this.readEnvValuesFromPath(path.join(agent.home, ".env"));
    const launch = await this.gatewayLaunchFromRuntime(runtime, { ...activeEnv, ...agentEnv, ...envValues }, instanceHome);
    this.assertGatewayStartCurrent(generation);
    console.info("[Hermes Forge] Feishu Gateway launch", {
      instanceId: normalizedId,
      agentProfile: agent.profileId,
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      label: launch.label,
    });
    const child = this.spawnGatewayProcess(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      windowsHide: true,
      shell: false,
    });
    this.feishuGatewayProcesses.set(normalizedId, child);
    this.gatewayFailures.delete(feishuRuntimeKey(normalizedId));
    this.feishuGatewayStartedAt.set(normalizedId, new Date().toISOString());
    child.stdout.on("data", (chunk: Buffer) => {
      this.gatewayOutput = trimLog(`${this.gatewayOutput}\n[${feishuRuntimeKey(normalizedId)}] ${chunk.toString("utf8")}`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.gatewayError = trimLog(`${this.gatewayError}\n[${feishuRuntimeKey(normalizedId)}] ${chunk.toString("utf8")}`);
    });
    child.on("error", (error) => {
      this.gatewayError = trimLog(`${this.gatewayError}\n[${feishuRuntimeKey(normalizedId)}] ${error.message}`);
    });
    child.on("close", (exitCode) => {
      if (this.feishuGatewayProcesses.get(normalizedId) !== child) return;
      this.gatewayLastExitCode = exitCode;
      this.gatewayLastExitAt = new Date().toISOString();
      this.feishuGatewayProcesses.delete(normalizedId);
      this.feishuGatewayStartedAt.delete(normalizedId);
      if (this.expectedGatewayExits.delete(child)) return;
      if (!this.gatewayUserStopped) {
        this.gatewayRestartCount += 1;
        this.gatewayBackoffUntil = new Date(Date.now() + 5_000).toISOString();
        this.gatewayAutoStartState = "failed";
        this.gatewayAutoStartMessage = `${feishuRuntimeKey(normalizedId)} Gateway 已退出，退出码：${exitCode ?? "unknown"}`;
        this.gatewayFailures.set(feishuRuntimeKey(normalizedId), this.gatewayAutoStartMessage);
        this.scheduleAutoRestart();
      }
    });
    await this.sleep(1200);
  }

  private async legacyGatewayLaunch(root: string, hermesEnv: Record<string, string>, reason: string) {
    // Legacy fallback: retained until all tests/standalone construction paths inject RuntimeAdapterFactory.
    const python = await this.resolvePythonCommand(root);
    return {
      command: python.command,
      args: [...python.args, this.hermesCliPath(root), "gateway", "run", "--replace"],
      cwd: root,
      env: buildGatewayEnv(process.env, hermesEnv, root, await this.activeHermesHome(), await this.isEditableInstall(root)),
      label: `${python.label} (legacy fallback: ${reason})`,
    };
  }

  private async legacyPythonLaunch(root: string, pythonArgs: string[], command?: string, argsPrefix: string[] = []) {
    // Legacy fallback: retained until all connector callers are constructed with RuntimeAdapterFactory.
    const python = command ? { command, args: argsPrefix, label: [command, ...argsPrefix].join(" ") } : await this.resolvePythonCommand(root);
    return {
      command: python.command,
      args: [...python.args, ...pythonArgs],
      cwd: root,
      env: buildPythonEnv(process.env, await this.isEditableInstall(root) ? [root] : []),
      label: `${python.label} legacy`,
    };
  }

  private async legacyGatewayStatusLaunch(root: string) {
    // Legacy fallback: retained for construction paths without RuntimeAdapterFactory.
    const python = await this.resolvePythonCommand(root);
    return {
      command: python.command,
      args: [...python.args, this.hermesCliPath(root), "gateway", "status"],
      cwd: root,
      env: buildPythonEnv({ HERMES_HOME: await this.activeHermesHome() }),
    };
  }

  private async gatewayStatusFallback(root: string, reason: string) {
    const config = await this.readRuntimeConfig?.().catch(() => undefined);
    if (config?.hermesRuntime?.mode === "wsl") {
      throw new Error(`WSL runtime 已停用；请使用 Windows Native Hermes。${reason}`);
    }
    return this.legacyGatewayStatusLaunch(root);
  }

  private async preflightWeixinDependenciesWithRuntime(runtime: Extract<ConnectorRuntimeContext, { ok: true }>): Promise<WeixinQrLoginStatus | undefined> {
    const script = "import importlib.util, json; print(json.dumps({'aiohttp': bool(importlib.util.find_spec('aiohttp'))}))";
    const root = runtime.root;
    const runtimeRoot = runtime.adapter.toRuntimePath(root);
    const launch = await runtime.adapter.buildPythonLaunch({
      runtime: runtime.runtime,
      rootPath: runtimeRoot,
      pythonArgs: ["-c", script],
      cwd: root,
      env: buildPythonEnv(undefined, await this.isEditableInstall(root) ? [runtimeRoot] : []),
    });
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: 10000,
      env: launch.env,
      commandId: "connector.weixin.preflight-dependencies",
      runtimeKind: runtime.runtime.mode,
    });
    return this.weixinDependencyStatusFromResult(result, runtime.label);
  }

  private async envLinesFor(platform: HermesConnectorPlatform, config: StoredPlatformConfig) {
    const lines: string[] = [];
    for (const field of platform.fields) {
      let value: string | undefined;
      if (field.secret) {
        const ref = config.secretRefs?.[field.key];
        value = ref ? await this.secretVault.readSecret(ref) : undefined;
      } else {
        const raw = config.values?.[field.key];
        if (typeof raw === "boolean") value = raw ? "true" : "false";
        else value = typeof raw === "string" ? raw : undefined;
      }
      if (typeof value === "string" && value.trim()) {
        lines.push(`${field.envVar}=${quoteEnv(value.trim())}`);
      }
    }
    return lines;
  }

  private async resolvePythonCommand(root: string): Promise<PythonCommand> {
    const environment = await requireManagedHermesEnvironment(root);
    return { command: environment.pythonPath, args: [], label: environment.pythonPath };
  }

  private editableInstallCache = new Map<string, boolean>();

  private async isEditableInstall(rootPath: string): Promise<boolean> {
    const cached = this.editableInstallCache.get(rootPath);
    if (cached !== undefined) return cached;

    const markerPath = path.join(rootPath, ".zhenghebao-managed-install.json");
    try {
      const raw = await fs.readFile(markerPath, "utf8");
      const marker = JSON.parse(raw) as { editable?: boolean };
      if (typeof marker.editable === "boolean") {
        this.editableInstallCache.set(rootPath, marker.editable);
        return marker.editable;
      }
    } catch {
      // marker missing or invalid
    }

    const sitePackagesDirs = [
      path.join(rootPath, "venv", "Lib", "site-packages"),
      path.join(rootPath, ".venv", "Lib", "site-packages"),
    ];
    for (const dir of sitePackagesDirs) {
      try {
        const entries = await fs.readdir(dir);
        if (entries.some((e) => e.startsWith("__editable__") && e.endsWith(".pth"))) {
          this.editableInstallCache.set(rootPath, true);
          return true;
        }
      } catch {
        // ignore
      }
    }

    this.editableInstallCache.set(rootPath, false);
    return false;
  }

  private async gatewayCliStatus() {
    const root = await this.resolveHermesRoot();
    const runtime = await this.runtimeContext(root);
    const launch = runtime.ok
      ? await runtime.adapter.buildHermesLaunch({
        runtime: runtime.runtime,
        rootPath: runtime.adapter.toRuntimePath(root),
        pythonArgs: [runtime.runtime.mode === "wsl" ? `${runtime.adapter.toRuntimePath(root).replace(/\/+$/, "")}/hermes` : this.hermesCliPath(root), "gateway", "status"],
        cwd: root,
        env: buildPythonEnv(
          { HERMES_HOME: runtime.adapter.toRuntimePath(await this.activeHermesHome()) },
          await this.isEditableInstall(root) ? [runtime.adapter.toRuntimePath(root)] : [],
        ),
      })
      : await this.gatewayStatusFallback(root, runtime.message);
    const result = await runCommand(launch.command, launch.args, {
      cwd: launch.cwd,
      timeoutMs: 10000,
      env: launch.env,
      commandId: "connector.gateway.status",
      runtimeKind: runtime.ok ? runtime.runtime.mode : "windows",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      message: result.stdout.trim() || result.stderr.trim() || `gateway status exit ${result.exitCode}`,
    };
  }

  private async ensureGatewayModelRuntime(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.syncModelRuntime) return { ok: true };
    try {
      const sync = await this.syncModelRuntime();
      if (sync.synced) return { ok: true };
      if (sync.skippedReason === "missing-model-profile") {
        return { ok: false, message: "Gateway 启动前模型同步失败：尚未配置可用的主模型。请先在模型设置里选择一个可用模型。" };
      }
      if (sync.skippedReason === "local-placeholder-model") {
        return { ok: false, message: "Gateway 启动前模型同步失败：当前默认模型仍是本地占位模型。请先配置真实模型后再启动微信 Gateway。" };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: "Gateway 启动前模型同步失败，请检查模型配置。"
      };
    }
  }

  private async gatewayStateStatus(): Promise<GatewayStateSnapshot | undefined> {
    const snapshots: GatewayStateSnapshot[] = [];
    const raw = await fs.readFile(path.join(await this.activeHermesHome(), "gateway_state.json"), "utf8").catch(() => "");
    if (raw.trim()) {
      const parsed = parseGatewayStateSnapshot(raw, isPidAlive);
      if (parsed) snapshots.push(parsed);
    }
    const stored = await this.readConfig().catch(() => ({ platforms: {} } as StoredConnectorConfig));
    for (const [instanceId, instance] of this.feishuInstances(stored.platforms?.feishu)) {
      const instanceHome = await this.feishuInstanceHome(instanceId, instance);
      const instanceRaw = await fs.readFile(path.join(instanceHome, "gateway_state.json"), "utf8").catch(() => "");
      if (!instanceRaw.trim()) continue;
      const parsed = parseGatewayStateSnapshot(instanceRaw, isPidAlive, feishuRuntimeKey(instanceId));
      if (parsed) snapshots.push(parsed);
    }
    return mergeGatewayStateSnapshots(snapshots);
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async activeHermesHome() {
    return await resolveActiveHermesHome(this.appPaths.hermesDir());
  }

  private baseHermesHome() {
    return this.appPaths.hermesDir();
  }

  private async envPath() {
    return path.join(await this.activeHermesHome(), ".env");
  }

  private async feishuAgentHome(config: StoredPlatformConfig | undefined, options: { create?: boolean } = {}) {
    const base = this.baseHermesHome();
    const profileId = normalizeHermesProfileId(stringValue(config?.values?.agentId));
    const home = profileId === "default" ? base : path.join(base, "profiles", profileId);
    if (options.create) {
      await ensureHermesHomeLayout(home);
    }
    return { profileId, home };
  }

  private async feishuInstanceHome(instanceId: string, config?: StoredPlatformConfig, options: { create?: boolean } = {}) {
    const agent = await this.feishuAgentHome(config, options);
    return path.join(agent.home, "connector-instances", "feishu", normalizeFeishuInstanceId(instanceId));
  }

  private async feishuInstanceEnvPath(instanceId: string, config?: StoredPlatformConfig) {
    return path.join(await this.feishuInstanceHome(instanceId, config), ".env");
  }

  private async writeFeishuInstanceEnv(instanceId: string, config: StoredPlatformConfig, envLines: string[]) {
    const agent = await this.feishuAgentHome(config, { create: true });
    const instanceHome = await this.feishuInstanceHome(instanceId, config, { create: true });
    await this.prepareFeishuInstanceRuntimeHome(instanceHome, agent.home);
    const envPath = path.join(instanceHome, ".env");
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    const lines = [
      MANAGED_START,
      "# Managed by Hermes Desktop. This file is isolated for one Feishu bot instance.",
      `HERMES_CONNECTOR_INSTANCE_ID=${quoteEnv(feishuRuntimeKey(instanceId))}`,
      `HERMES_AGENT_PROFILE=${quoteEnv(agent.profileId)}`,
      ...envLines,
      MANAGED_END,
    ];
    await withHermesHomeLock(instanceHome, () => atomicWriteText(envPath, `${lines.join("\n")}\n`));
    await fs.chmod(envPath, 0o600).catch(() => undefined);
  }

  private async prepareFeishuInstanceRuntimeHome(instanceHome: string, agentHome: string) {
    await fs.mkdir(instanceHome, { recursive: true });
    await Promise.all(["skills", "memories", "skins"].map((name) => this.ensureProfileDirectoryLink(path.join(agentHome, name), path.join(instanceHome, name))));
    await Promise.all(["config.yaml", "SOUL.md", "auth.json"].map((name) => this.ensureProfileFileLink(path.join(agentHome, name), path.join(instanceHome, name))));
  }

  private async ensureProfileDirectoryLink(source: string, target: string) {
    await fs.mkdir(source, { recursive: true });
    const existing = await fs.lstat(target).catch(() => undefined);
    if (existing) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir").catch(async () => {
      await fs.cp(source, target, { recursive: true, force: false }).catch(() => undefined);
    });
  }

  private async ensureProfileFileLink(source: string, target: string) {
    const stat = await fs.stat(source).catch(() => undefined);
    if (!stat?.isFile()) return;
    const existing = await fs.lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) return;
    if (existing?.isFile()) {
      const [content, current] = await Promise.all([fs.readFile(source, "utf8"), fs.readFile(target, "utf8")]);
      if (content !== current) await atomicWriteText(target, content);
      return;
    }
    if (existing) throw new Error(`Profile 目标不是文件：${target}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, "file").catch(async () => {
      await atomicWriteText(target, await fs.readFile(source, "utf8"));
    });
  }

  private async feishuInstanceRoots() {
    const base = this.baseHermesHome();
    const roots = [path.join(base, "connector-instances", "feishu")];
    const profileRoot = path.join(base, "profiles");
    const profiles = await fs.readdir(profileRoot, { withFileTypes: true }).catch(() => []);
    for (const profile of profiles) {
      if (profile.isDirectory()) {
        roots.push(path.join(profileRoot, profile.name, "connector-instances", "feishu"));
      }
    }
    return roots;
  }

  private hermesCliPath(root: string) {
    return resolveHermesCliPathSync(root) ?? defaultHermesCliPath(root);
  }

  private weixinQrLoginScriptPath() {
    const candidates = [
      path.join(process.cwd(), "resources", "weixin-qr-login.py"),
      path.join(process.resourcesPath, "resources", "weixin-qr-login.py"),
    ];
    return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? candidates[0];
  }

  private async clearGatewayRuntimeMarkers() {
    const home = await this.activeHermesHome();
    await Promise.all([
      fs.rm(path.join(home, "gateway.pid"), { force: true }).catch(() => undefined),
      fs.rm(path.join(home, "gateway_state.json"), { force: true }).catch(() => undefined),
    ]);
  }

  private configPath() {
    return path.join(this.appPaths.baseDir(), "connectors-config.json");
  }

  private async readConfig(): Promise<StoredConnectorConfig> {
    const raw = await fs.readFile(this.configPath(), "utf8").catch(() => "");
    if (!raw) return { platforms: {} };
    try {
      const parsed = JSON.parse(raw) as StoredConnectorConfig;
      return { platforms: migrateConnectorConfig(parsed.platforms ?? {}) };
    } catch {
      return { platforms: {} };
    }
  }

  private async writeConfig(config: StoredConnectorConfig) {
    await fs.mkdir(path.dirname(this.configPath()), { recursive: true });
    await atomicWriteText(this.configPath(), JSON.stringify(config, null, 2));
  }

  private ensureFeishuInstances(config: StoredPlatformConfig | undefined): StoredPlatformConfig {
    const migrated = migrateFeishuPlatformConfig(config);
    return {
      ...migrated,
      enabled: true,
      instances: migrated.instances ?? {},
    };
  }

  private feishuInstances(config: StoredPlatformConfig | undefined): Array<[string, StoredPlatformConfig]> {
    const migrated = migrateFeishuPlatformConfig(config);
    return Object.entries(migrated.instances ?? {})
      .map(([id, instance]) => [normalizeFeishuInstanceId(id), instance] as [string, StoredPlatformConfig])
      .sort(([left], [right]) => left.localeCompare(right));
  }

  private feishuInstanceConfig(config: StoredPlatformConfig | undefined, instanceId = "default"): StoredPlatformConfig | undefined {
    return migrateFeishuPlatformConfig(config).instances?.[normalizeFeishuInstanceId(instanceId)];
  }

  private async configuredFeishuInstances(stored: StoredConnectorConfig): Promise<Array<[string, StoredPlatformConfig]>> {
    const platform = platformById("feishu");
    const ready: Array<[string, StoredPlatformConfig]> = [];
    for (const [instanceId, instance] of this.feishuInstances(stored.platforms?.feishu)) {
      if (instance.enabled === false) continue;
      const missing = await this.missingRequired(platform, instance, {});
      if (missing.length === 0) ready.push([instanceId, instance]);
    }
    return ready;
  }

  private async hasConfiguredNonFeishuConnector(stored: StoredConnectorConfig, envValues: Record<string, string>) {
    for (const platform of PLATFORM_REGISTRY) {
      if (platform.id === "feishu") continue;
      const config = stored.platforms?.[platform.id];
      if (!config || config.enabled === false) continue;
      if ((await this.missingRequired(platform, config, envValues)).length === 0) return true;
    }
    return false;
  }

  private async readEnvValues() {
    return this.readEnvValuesFromPath(await this.envPath());
  }

  private async readEnvValuesFromPath(envPath: string) {
    const raw = await fs.readFile(envPath, "utf8").catch(() => "");
    const values: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      values[trimmed.slice(0, index).trim()] = unquoteEnv(trimmed.slice(index + 1).trim());
    }
    return values;
  }


}

function platform(
  id: HermesConnectorPlatformId,
  label: string,
  category: HermesConnectorPlatform["category"],
  description: string,
  fields: HermesConnectorField[],
  setupHelp: string[],
): HermesConnectorPlatform {
  return { id, label, category, description, fields, setupHelp };
}

function text(key: string, envVar: string, label: string, required = false, placeholder?: string): HermesConnectorField {
  return { key, envVar, label, type: "text", required, placeholder };
}

function url(key: string, envVar: string, label: string, required = false, placeholder?: string): HermesConnectorField {
  return { key, envVar, label, type: "url", required, placeholder };
}

function password(key: string, envVar: string, label: string, required = false, placeholder?: string): HermesConnectorField {
  return { key, envVar, label, type: "password", required, secret: true, placeholder };
}

function bool(key: string, envVar: string, label: string, required = false): HermesConnectorField {
  return { key, envVar, label, type: "boolean", required };
}

function number(key: string, envVar: string, label: string, required = false, placeholder?: string): HermesConnectorField {
  return { key, envVar, label, type: "number", required, placeholder };
}

function platformById(id: HermesConnectorPlatformId) {
  const platform = PLATFORM_REGISTRY.find((item) => item.id === id);
  if (!platform) throw new Error(`未知连接器平台：${id}`);
  return platform;
}

function secretRef(platformId: HermesConnectorPlatformId, fieldKey: string, instanceId?: string) {
  if (platformId === "feishu") {
    return `connector.feishu.${normalizeFeishuInstanceId(instanceId)}.${fieldKey}`;
  }
  return `connector.${platformId}.${fieldKey}`;
}

function migrateConnectorConfig(platforms: Partial<Record<HermesConnectorPlatformId, StoredPlatformConfig>>) {
  return {
    ...platforms,
    ...(platforms.feishu ? { feishu: migrateFeishuPlatformConfig(platforms.feishu) } : {}),
  };
}

function migrateFeishuPlatformConfig(config: StoredPlatformConfig | undefined): StoredPlatformConfig {
  if (!config) return { enabled: true, instances: {} };
  if (config.instances) {
    const instances = Object.fromEntries(
      Object.entries(config.instances).map(([id, instance]) => [normalizeFeishuInstanceId(id), instance]),
    );
    return { ...config, enabled: true, instances };
  }
  const hasLegacyConfig = Boolean(
    Object.keys(config.values ?? {}).length ||
    Object.keys(config.secretRefs ?? {}).length ||
    typeof config.enabled !== "undefined" ||
    config.updatedAt ||
    config.lastSyncedAt,
  );
  if (!hasLegacyConfig) return { ...config, enabled: true, instances: {} };
  const { instances: _instances, ...legacy } = config;
  return {
    enabled: true,
    instances: {
      default: legacy,
    },
  };
}

function normalizeFeishuInstanceId(instanceId?: string) {
  const normalized = (instanceId || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "default";
}

function normalizeHermesProfileId(profileId?: string) {
  const normalized = (profileId || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "default";
}

function feishuRuntimeKey(instanceId?: string) {
  return `feishu:${normalizeFeishuInstanceId(instanceId)}`;
}

function feishuInstanceLabel(instanceId: string | undefined, values: Record<string, string | boolean>) {
  const name = stringValue(values.botName) || stringValue(values.appId) || normalizeFeishuInstanceId(instanceId);
  return name === "default" ? "飞书默认机器人" : name;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function connectorStatus(enabled: boolean, configured: boolean): HermesConnectorStatus {
  if (!enabled) return "disabled";
  if (!configured) return "unconfigured";
  return "configured";
}

function connectorRuntimeStatus(platformId: string, enabled: boolean, configured: boolean, gateway: HermesGatewayStatus): HermesConnectorConfig["runtimeStatus"] {
  if (!enabled || !configured) return "stopped";
  const hasPlatformState = Boolean(gateway.platformStates && Object.keys(gateway.platformStates).length > 0);
  const platformState = (gateway.platformStates?.[platformId]
    ?? (platformId === feishuRuntimeKey("default") ? gateway.platformStates?.feishu : undefined))
    ?.toLowerCase();
  if (platformState === "connected") return "running";
  if (platformState && platformState !== "connected") return "error";
  if (gateway.running && !hasPlatformState) return "running";
  if (gateway.healthStatus === "error" || Boolean(gateway.lastError)) return "error";
  return "stopped";
}

function hasMainGatewayRuntime(gateway: HermesGatewayStatus, options: { managedMainRunning: boolean; managedFeishuCount: number }) {
  if (options.managedMainRunning) return true;
  if (!gateway.running) return false;
  const platformKeys = Object.keys(gateway.platformStates ?? {});
  if (platformKeys.some((key) => !isFeishuPlatformKey(key))) return true;
  if (platformKeys.length > 0) return false;
  return options.managedFeishuCount === 0;
}

function isFeishuPlatformKey(key: string) {
  return key === "feishu" || key.startsWith("feishu:");
}

function statusMessage(status: HermesConnectorStatus, runtimeStatus: HermesConnectorConfig["runtimeStatus"], missing: string[]) {
  if (status === "disabled") return "已禁用，不会同步到 Hermes .env。";
  if (status === "unconfigured") {
    return missing.length > 0 ? `缺少必填配置：${missing.join("、")}` : "尚未配置，点击快速配置开始接入。";
  }
  if (runtimeStatus === "running") return "已配置，Gateway 正在运行。";
  if (runtimeStatus === "error") return "已配置，但 Gateway 最近报告错误。";
  return "已配置，等待同步或启动 Gateway。";
}

function parseBoolean(value: unknown) {
  return String(value ?? "").trim().toLowerCase() === "true" || String(value ?? "").trim() === "1" || String(value ?? "").trim().toLowerCase() === "yes";
}

function quoteEnv(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquoteEnv(value: string) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function normalizeFsPath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function buildPythonEnv(baseEnv?: NodeJS.ProcessEnv, pythonPathEntries: string[] = []): NodeJS.ProcessEnv {
  const mergedBase = baseEnv ?? {};
  const pythonPath = joinPythonPath([
    pythonSiteCustomizePath(),
    ...pythonPathEntries,
    mergedBase.PYTHONPATH,
  ]);
  return {
    ...mergedBase,
    ...PYTHON_ENV,
    ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
  };
}

function buildGatewayEnv(baseEnv: NodeJS.ProcessEnv, hermesEnv: Record<string, string>, runtimeRoot?: string, hermesHome?: string, editable?: boolean): NodeJS.ProcessEnv {
  const mergedBase = { ...baseEnv, ...hermesEnv };
  const pythonPath = joinPythonPath([
    pythonSiteCustomizePath(),
    editable ? runtimeRoot : undefined,
    mergedBase.PYTHONPATH,
  ]);
  return {
    ...mergedBase,
    ...PYTHON_ENV,
    PYTHONUNBUFFERED: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
    ...(hermesHome ? { HERMES_HOME: hermesHome } : {}),
  };
}

function joinPythonPath(entries: Array<string | undefined>) {
  const seen = new Set<string>();
  const clean = entries
    .flatMap((entry) => (entry ?? "").split(path.delimiter))
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
  return clean.join(path.delimiter);
}

function pythonSiteCustomizePath() {
  if (process.platform !== "win32") return undefined;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.join(process.cwd(), "resources", "python-sitecustomize"),
    resourcesPath ? path.join(resourcesPath, "python-sitecustomize") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? candidates[0];
}

function gatewayWarningOutput(text: string) {
  return splitGatewayStderr(text).warnings;
}

function gatewayErrorOutput(text: string) {
  return splitGatewayStderr(text).errors;
}

function splitGatewayStderr(text: string) {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:WARNING|WARN)\b/i.test(trimmed)) warnings.push(line);
    else errors.push(line);
  }
  return {
    warnings: trimLog(warnings.join("\n")),
    errors: trimLog(errors.join("\n")),
  };
}

export function removeManagedBlock(content: string) {
  const start = content.indexOf(MANAGED_START);
  if (start === -1) return content;
  const end = content.indexOf(MANAGED_END, start);
  if (end === -1) return content.slice(0, start).trimEnd();
  return `${content.slice(0, start)}${content.slice(end + MANAGED_END.length)}`.trimEnd();
}

function sanitizeEnvBackup(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return line;
      }
      const index = line.indexOf("=");
      if (index <= 0) {
        return line;
      }
      const key = line.slice(0, index).trim();
      if (/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AES_KEY)/i.test(key)) {
        return `${key}=<redacted>`;
      }
      return line;
    })
    .join("\n");
}

function decorateWeixinFailure(code: string | undefined, message: string, runtimePythonLabel?: string): WeixinQrLoginStatus {
  if (code === "missing_aiohttp") {
    return {
      running: false,
      phase: "failed",
      completedAt: new Date().toISOString(),
      success: false,
      message,
      failureCode: code,
      recoveryAction: "install_aiohttp",
      recoveryCommand: undefined,
      runtimePythonLabel,
      failureKind: "recoverable",
      recommendedFix: "点击“一键安装依赖”，系统会把 aiohttp 安装到 Hermes 正在使用的 Python 环境里，然后自动重试扫码。",
    };
  }
  if (code === "missing_crypto") {
    return {
      running: false,
      phase: "failed",
      completedAt: new Date().toISOString(),
      success: false,
      message,
      failureCode: code,
      runtimePythonLabel,
      failureKind: "manual_fix",
      recommendedFix: "当前缺少 cryptography，请在设置中修复 Hermes 受管运行环境后重新扫码。",
    };
  }
  return {
    running: false,
    phase: code === "timeout" ? "timeout" : "failed",
    completedAt: new Date().toISOString(),
    success: false,
    message,
    failureCode: code ?? "unknown_error",
    runtimePythonLabel,
    failureKind: code === "fetch_qr_failed" ? "external_unreachable" : "manual_fix",
  };
}

function classifyWeixinInstallFailure(output: string) {
  const text = output.toLowerCase();
  if (text.includes("temporary failure in name resolution") || text.includes("connection timed out") || text.includes("no matching distribution found")) {
    return {
      category: "network" as const,
      message: "网络不可用，无法从 pip 源下载 aiohttp。",
      recommendedFix: "请确认当前网络可访问 Python 包源，或切换到可用镜像后重试。",
    };
  }
  if (text.includes("no module named pip") || text.includes("pip is not recognized")) {
    return {
      category: "pip_unavailable" as const,
      message: "当前 Python 环境没有可用的 pip。",
      recommendedFix: "请先为 Hermes 的 Python 环境安装 pip，再重新点击安装依赖。",
    };
  }
  if (text.includes("permission denied") || text.includes("access is denied")) {
    return {
      category: "permission_denied" as const,
      message: "当前环境没有安装依赖的权限。",
      recommendedFix: "请确认 Hermes Python 环境可写，或用有权限的终端先完成 aiohttp 安装。",
    };
  }
  if (text.includes("python") && text.includes("traceback")) {
    return {
      category: "interpreter_error" as const,
      message: "Hermes Python 解释器执行异常。",
      recommendedFix: "请先在设置里检查 Hermes Python 命令是否正确，再重新尝试。",
    };
  }
  return {
    category: "unknown" as const,
    message: "依赖安装失败。",
    recommendedFix: "请查看错误输出，确认 pip 和网络后再重试。",
  };
}

function looksLikeGatewayRunning(stdout?: string, stderr?: string) {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`;
  const structured = parseGatewayRunningHint(text);
  if (structured !== undefined) return structured;
  return /gateway is running|gateway.+running/i.test(text) && !/not running|running\s*[:=]\s*false/i.test(text);
}

function looksLikeGatewayFailure(stdout?: string, stderr?: string) {
  const text = `${stdout ?? ""}\n${stderr ?? ""}`;
  return /traceback|module not found|error:|exception/i.test(text);
}

function parseGatewayRunningHint(text: string): boolean | undefined {
  for (const candidate of jsonObjectCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const hint = gatewayRunningHintFromObject(parsed);
    if (hint !== undefined) return hint;
  }
  const runningMatch = /(?:^|[\s,{])"?running"?\s*[:=]\s*(true|false)\b/i.exec(text);
  if (runningMatch) return runningMatch[1].toLowerCase() === "true";
  const stateMatch = /(?:gateway_)?state"?\s*[:=]\s*"?([a-z_ -]+)"?/i.exec(text);
  if (stateMatch) {
    const state = stateMatch[1].trim().toLowerCase();
    if (["running", "started", "active"].includes(state)) return true;
    if (["stopped", "not_running", "not running", "offline", "error", "failed"].includes(state)) return false;
  }
  return undefined;
}

function jsonObjectCandidates(text: string) {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (value.startsWith("{") && value.endsWith("}")) candidates.push(value);
  }
  return [...new Set(candidates)];
}

function gatewayRunningHintFromObject(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.running === "boolean") return record.running;
  const state = typeof record.gateway_state === "string"
    ? record.gateway_state
    : typeof record.state === "string"
      ? record.state
      : undefined;
  if (!state) return undefined;
  const normalized = state.trim().toLowerCase();
  if (["running", "started", "active"].includes(normalized)) return true;
  if (["stopped", "not_running", "not running", "offline", "error", "failed"].includes(normalized)) return false;
  return undefined;
}

function trimLog(value: string) {
  const text = value.trim();
  return text.length > 6000 ? text.slice(text.length - 6000) : text;
}

function parseCommandLine(raw: string): PythonCommand | undefined {
  const parts = raw.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? [];
  const command = parts.shift()?.trim();
  if (!command) return undefined;
  return {
    command,
    args: parts,
    label: [command, ...parts].join(" "),
  };
}

function looksLikeFilePath(value: string) {
  return path.isAbsolute(value) || value.includes("\\") || value.includes("/");
}

async function fileExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSensitiveLog(value: string) {
  return value
    .replace(/(WEIXIN_TOKEN|bot_token|WEIXIN_QR_RESULT)\s*[:=]\s*["']?[^"'\s,}]+/gi, "$1=<redacted>")
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2")
    .replace(/("bot_token"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2");
}

function isWeixinQrTerminal(phase: WeixinQrLoginStatus["phase"]) {
  return phase === "success" || phase === "timeout" || phase === "failed" || phase === "cancelled";
}

export function parseWeixinQrEvent(line: string): WeixinQrEvent | undefined {
  if (!line.trim().startsWith("{")) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (record.type === "qr" && typeof record.qrUrl === "string" && record.qrUrl.trim()) {
    return {
      type: "qr",
      qrUrl: record.qrUrl,
      expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  if (record.type === "phase" && typeof record.phase === "string" && isWeixinQrPhase(record.phase)) {
    return {
      type: "phase",
      phase: record.phase,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  if (record.type === "confirmed" && typeof record.accountId === "string" && typeof record.token === "string") {
    return {
      type: "confirmed",
      accountId: record.accountId,
      token: record.token,
      baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : undefined,
      userId: typeof record.userId === "string" ? record.userId : undefined,
    };
  }
  if (record.type === "error") {
    return {
      type: "error",
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  return undefined;
}

function isWeixinQrPhase(value: string): value is WeixinQrLoginStatus["phase"] {
  return [
    "idle",
    "fetching_qr",
    "waiting_scan",
    "waiting_confirm",
    "saving",
    "syncing",
    "starting_gateway",
    "success",
    "timeout",
    "failed",
    "cancelled",
  ].includes(value);
}

function parseGatewayStateSnapshot(raw: string, pidAlive: (pid: number) => boolean, platformKeyPrefixOrNowMs?: string | number, nowMs = Date.now()): GatewayStateSnapshot | undefined {
  const platformKeyPrefix = typeof platformKeyPrefixOrNowMs === "string" ? platformKeyPrefixOrNowMs : undefined;
  const effectiveNowMs = typeof platformKeyPrefixOrNowMs === "number" ? platformKeyPrefixOrNowMs : nowMs;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (record.gateway_state !== "running") return undefined;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
  if (pid && !pidAlive(pid)) return undefined;
  const updatedAt = typeof record.updated_at === "string" ? record.updated_at : undefined;
  const updatedAtMs = updatedAt ? parseGatewayUpdatedAtMs(updatedAt) : undefined;
  const freshWithoutPid = typeof updatedAtMs === "number" && effectiveNowMs - updatedAtMs >= 0 && effectiveNowMs - updatedAtMs <= 120_000;
  if (!pid && !freshWithoutPid) return undefined;
  const platformStates = record.platforms && typeof record.platforms === "object"
    ? Object.fromEntries(
      Object.entries(record.platforms as Record<string, Record<string, unknown>>)
        .map(([key, value]) => [platformKeyPrefix && key === "feishu" ? platformKeyPrefix : key, typeof value?.state === "string" ? value.state : "unknown"]),
    )
    : undefined;
  const connectedPlatforms = platformStates
    ? Object.entries(platformStates).filter(([, state]) => state.toLowerCase() === "connected").map(([key]) => key)
    : [];
  const message = connectedPlatforms.length > 0
    ? `Gateway 状态文件显示正在运行，已连接：${connectedPlatforms.join(", ")}。`
    : "Gateway 状态文件显示正在运行。";
  return {
    running: true,
    pid,
    updatedAt,
    message,
    platformStates,
    connectedPlatforms,
  };
}

function mergeGatewayStateSnapshots(snapshots: GatewayStateSnapshot[]): GatewayStateSnapshot | undefined {
  const active = snapshots.filter((snapshot) => snapshot.running);
  if (active.length === 0) return undefined;
  const platformStates = Object.assign({}, ...active.map((snapshot) => snapshot.platformStates ?? {}));
  const connectedPlatforms = Object.entries(platformStates)
    .filter(([, state]) => String(state).toLowerCase() === "connected")
    .map(([key]) => key);
  return {
    running: true,
    pid: active.find((snapshot) => snapshot.pid)?.pid,
    updatedAt: active.map((snapshot) => snapshot.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1),
    platformStates: Object.keys(platformStates).length ? platformStates : undefined,
    connectedPlatforms,
    message: connectedPlatforms.length > 0
      ? `Gateway 状态文件显示正在运行，已连接：${connectedPlatforms.join(", ")}。`
      : "Gateway 状态文件显示正在运行。",
  };
}

function parseGatewayUpdatedAtMs(value: string) {
  const normalized = value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}$)/, "$1");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    const result = await runCommand("taskkill", ["/pid", String(pid), "/t", "/f"], {
      cwd: process.cwd(),
      timeoutMs: 10000,
    });
    if (result.exitCode !== 0) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
      throw new Error(`无法停止 Gateway 进程 ${pid}，请先结束进程再重试。`);
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already exited.
  }
}

export const testOnly = {
  PLATFORM_REGISTRY,
  classifyWeixinInstallFailure,
  decorateWeixinFailure,
  parseGatewayStateSnapshot,
  parseCommandLine,
  parseWeixinQrEvent,
  buildGatewayEnv,
  hasMainGatewayRuntime,
  connectorRuntimeStatus,
  splitGatewayStderr,
  looksLikeGatewayRunning,
  removeManagedBlock,
  sanitizeEnvBackup,
};
