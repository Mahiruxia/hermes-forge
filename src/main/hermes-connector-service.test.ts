import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HermesConnectorService, testOnly } from "./hermes-connector-service";

describe("HermesConnectorService helpers", () => {
  it("keeps the connector registry aligned with Hermes messaging platforms", () => {
    const ids = testOnly.PLATFORM_REGISTRY.map((platform) => platform.id);
    expect(ids).toEqual(expect.arrayContaining([
      "telegram",
      "discord",
      "slack",
      "whatsapp",
      "signal",
      "email",
      "matrix",
      "mattermost",
      "dingtalk",
      "feishu",
      "homeassistant",
      "wecom",
      "wecom_callback",
      "weixin",
      "bluebubbles",
    ]));
    expect(testOnly.PLATFORM_REGISTRY.find((platform) => platform.id === "slack")?.fields.map((field) => field.envVar)).toEqual(expect.arrayContaining([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]));
    expect(testOnly.PLATFORM_REGISTRY.find((platform) => platform.id === "weixin")?.fields.map((field) => field.envVar)).toEqual(expect.arrayContaining([
      "WEIXIN_ACCOUNT_ID",
      "WEIXIN_TOKEN",
      "WEIXIN_DM_POLICY",
      "WEIXIN_GROUP_POLICY",
    ]));
  });

  it("removes only the managed .env block", () => {
    const original = [
      "OPENAI_API_KEY=keep",
      "",
      "# >>> Hermes Desktop Connectors >>>",
      "TELEGRAM_BOT_TOKEN=remove",
      "# <<< Hermes Desktop Connectors <<<",
      "",
      "CUSTOM_VALUE=keep-too",
    ].join("\n");
    expect(testOnly.removeManagedBlock(original)).toContain("OPENAI_API_KEY=keep");
    expect(testOnly.removeManagedBlock(original)).toContain("CUSTOM_VALUE=keep-too");
    expect(testOnly.removeManagedBlock(original)).not.toContain("TELEGRAM_BOT_TOKEN=remove");
  });

  it("redacts sensitive env values in backups", () => {
    const backup = testOnly.sanitizeEnvBackup([
      "OPENAI_API_KEY=sk-secret",
      "WEIXIN_TOKEN=wx-secret",
      "NORMAL_VALUE=keep",
    ].join("\n"));

    expect(backup).toContain("OPENAI_API_KEY=<redacted>");
    expect(backup).toContain("WEIXIN_TOKEN=<redacted>");
    expect(backup).toContain("NORMAL_VALUE=keep");
    expect(backup).not.toContain("sk-secret");
    expect(backup).not.toContain("wx-secret");
  });

  it("parses configured Python commands with launcher arguments", () => {
    expect(testOnly.parseCommandLine("py -3")).toEqual({ command: "py", args: ["-3"], label: "py -3" });
    expect(testOnly.parseCommandLine('"D:\\Python311\\python.exe"')).toEqual({
      command: "D:\\Python311\\python.exe",
      args: [],
      label: "D:\\Python311\\python.exe",
    });
  });

  it("parses Weixin QR JSONL events without relying on terminal art", () => {
    expect(testOnly.parseWeixinQrEvent(JSON.stringify({
      type: "qr",
      qrUrl: "https://ilinkai.weixin.qq.com/qrcode/example",
      expiresAt: "2026-04-20T12:00:00.000Z",
    }))).toMatchObject({
      type: "qr",
      qrUrl: "https://ilinkai.weixin.qq.com/qrcode/example",
    });
    expect(testOnly.parseWeixinQrEvent(JSON.stringify({
      type: "phase",
      phase: "waiting_confirm",
      message: "已扫码，请确认",
    }))).toMatchObject({
      type: "phase",
      phase: "waiting_confirm",
    });
    expect(testOnly.parseWeixinQrEvent("████ terminal qr art ████")).toBeUndefined();
  });

  it("uses gateway state snapshots as a Windows-safe running fallback", () => {
    const snapshot = testOnly.parseGatewayStateSnapshot(JSON.stringify({
      pid: 12345,
      gateway_state: "running",
      platforms: {
        weixin: { state: "connected" },
      },
      updated_at: "2026-04-21T04:01:04.129897+00:00",
    }), (pid) => pid === 12345);

    expect(snapshot).toMatchObject({
      running: true,
      pid: 12345,
      updatedAt: "2026-04-21T04:01:04.129897+00:00",
    });
    expect(snapshot?.message).toContain("weixin");
    expect(testOnly.parseGatewayStateSnapshot(JSON.stringify({
      pid: 12345,
      gateway_state: "running",
    }), () => false)).toBeUndefined();
  });

  it("ignores stale pidless gateway state snapshots", () => {
    expect(testOnly.parseGatewayStateSnapshot(JSON.stringify({
      gateway_state: "running",
      updated_at: "2026-04-21T04:01:04.129897+00:00",
    }), () => false, Date.parse("2026-04-21T04:04:05.000Z"))).toBeUndefined();

    expect(testOnly.parseGatewayStateSnapshot(JSON.stringify({
      gateway_state: "running",
      updated_at: "2026-04-21T04:01:04.129897+00:00",
    }), () => false, Date.parse("2026-04-21T04:01:30.000Z"))).toMatchObject({
      running: true,
      updatedAt: "2026-04-21T04:01:04.129897+00:00",
    });
  });

  it("keeps confirmed Weixin token inside the main-process event boundary", () => {
    const publicFixtureValue = "public-fixture-value";
    const event = testOnly.parseWeixinQrEvent(JSON.stringify({
      type: "confirmed",
      accountId: "wx-account",
      token: publicFixtureValue,
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "user-1",
    }));
    expect(event).toMatchObject({
      type: "confirmed",
      accountId: "wx-account",
      token: publicFixtureValue,
    });

    const rendererStatusKeys = ["running", "phase", "message", "accountId", "userId", "gatewayStarted"];
    expect(rendererStatusKeys).not.toContain("token");
  });

  it("marks missing aiohttp as recoverable and provides install command", () => {
    const decorated = testOnly.decorateWeixinFailure("missing_aiohttp", "缺少 aiohttp", "py -3");
    expect(decorated.failureKind).toBe("recoverable");
    expect(decorated.recoveryAction).toBe("install_aiohttp");
    expect(decorated.recoveryCommand).toContain("pip install aiohttp");
  });

  it("classifies pip/network install failures for Weixin dependency repair", () => {
    expect(testOnly.classifyWeixinInstallFailure("No module named pip")).toMatchObject({
      category: "pip_unavailable",
    });
    expect(testOnly.classifyWeixinInstallFailure("Temporary failure in name resolution")).toMatchObject({
      category: "network",
    });
  });

  it("lets Hermes .env override stale parent model credentials for Gateway", () => {
    const env = testOnly.buildGatewayEnv(
      {
        OPENAI_API_KEY: "lm-studio",
        OPENAI_BASE_URL: "http://127.0.0.1:8081/v1",
        PYTHONPATH: "parent-pythonpath",
      },
      {
        OPENAI_API_KEY: "pwd",
        OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
        OPENAI_MODEL: "gpt-5.4",
      },
      "D:\\Hermes Agent",
      "D:\\Forge\\.hermes\\profiles\\wechat",
    );

    expect(env.OPENAI_API_KEY).toBe("pwd");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(env.OPENAI_MODEL).toBe("gpt-5.4");
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONUNBUFFERED).toBe("1");
    expect(env.HERMES_HOME).toBe("D:\\Forge\\.hermes\\profiles\\wechat");
    expect(env.PYTHONPATH).toBe(["D:\\Hermes Agent", "parent-pythonpath"].join(path.delimiter));
  });

  it("syncs connector env into the active Hermes profile used by Gateway", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-connector-"));
    const forgeHome = path.join(tempDir, "hermes-home");
    const activeHome = path.join(forgeHome, "profiles", "wechat");
    await fs.mkdir(activeHome, { recursive: true });
    await fs.writeFile(path.join(forgeHome, "active_profile"), "wechat", "utf8");
    await fs.writeFile(path.join(tempDir, "connectors-config.json"), JSON.stringify({
      platforms: {
        weixin: {
          enabled: true,
          values: {
            accountId: "wx-account",
            baseUrl: "https://ilinkai.weixin.qq.com",
            dmPolicy: "pairing",
            allowAllUsers: true,
            groupPolicy: "disabled",
          },
          secretRefs: { token: "connector.weixin.token" },
        },
      },
    }), "utf8");

    const service = new HermesConnectorService(
      {
        baseDir: () => tempDir,
        hermesDir: () => forgeHome,
      } as never,
      {
        hasSecret: vi.fn(async (ref: string) => ref === "connector.weixin.token"),
        readSecret: vi.fn(async (ref: string) => ref === "connector.weixin.token" ? "wx-secret" : undefined),
      } as never,
      async () => {
        throw new Error("Hermes root is not needed for this sync-only test.");
      },
    );

    const result = await service.syncEnv();
    const profileEnv = await fs.readFile(path.join(activeHome, ".env"), "utf8");
    const baseEnvExists = await fs.stat(path.join(forgeHome, ".env")).then(() => true).catch(() => false);

    expect(result.envPath).toBe(path.join(activeHome, ".env"));
    expect(profileEnv).toContain("WEIXIN_ACCOUNT_ID=wx-account");
    expect(profileEnv).toContain("WEIXIN_TOKEN=wx-secret");
    expect(baseEnvExists).toBe(false);
  });

  it("ignores stale Weixin QR close events after a refresh starts a new run", () => {
    const service = new HermesConnectorService({} as never, {} as never, async () => "D:\\Hermes Agent");
    const stateful = service as any;
    stateful.weixinQrProcess = { killed: false } as never;
    stateful.weixinQrLineBuffer = "pending-json";
    stateful.weixinQrStatus = {
      running: true,
      phase: "waiting_scan",
      message: "新二维码已经拉起。",
      qrUrl: "https://ilinkai.weixin.qq.com/qrcode/new",
    };
    stateful.activeWeixinQrRunId = 2;

    stateful.handleWeixinQrProcessClose(1, 1);

    expect(stateful.weixinQrStatus).toMatchObject({
      running: true,
      phase: "waiting_scan",
      message: "新二维码已经拉起。",
      qrUrl: "https://ilinkai.weixin.qq.com/qrcode/new",
    });
    expect(stateful.weixinQrProcess).toMatchObject({ killed: false });
    expect(stateful.weixinQrLineBuffer).toBe("pending-json");
    expect(stateful.activeWeixinQrRunId).toBe(2);
  });

  it("does not mark QQ Bot as configured when no values or secrets exist", async () => {
    const service = new HermesConnectorService({} as never, { hasSecret: vi.fn(async () => false) } as never, async () => "D:\\Hermes Agent");
    const stateful = service as any;

    const connector = await stateful.toConnector(
      testOnly.PLATFORM_REGISTRY.find((platform: { id: string }) => platform.id === "qqbot"),
      { platforms: {} },
      {},
      { running: false, healthStatus: "stopped", message: "Gateway 未运行。", checkedAt: "2026-04-23T00:00:00.000Z" },
    );

    expect(connector.configured).toBe(false);
    expect(connector.status).toBe("unconfigured");
    expect(connector.message).toContain("尚未配置");
  });

  it("marks QQ Bot as configured once optional routing values are present", async () => {
    const service = new HermesConnectorService({} as never, { hasSecret: vi.fn(async () => false) } as never, async () => "D:\\Hermes Agent");
    const stateful = service as any;

    const connector = await stateful.toConnector(
      testOnly.PLATFORM_REGISTRY.find((platform: { id: string }) => platform.id === "qqbot"),
      {
        platforms: {
          qqbot: {
            enabled: true,
            values: { allowedUsers: "alice,bob" },
            secretRefs: {},
          },
        },
      },
      {},
      { running: false, healthStatus: "stopped", message: "Gateway 未运行。", checkedAt: "2026-04-23T00:00:00.000Z" },
    );

    expect(connector.configured).toBe(true);
    expect(connector.status).toBe("configured");
  });

  it("returns a structured Weixin failure status when Hermes root cannot be resolved", async () => {
    const service = new HermesConnectorService(
      {} as never,
      {} as never,
      async () => {
        throw new Error("Hermes Agent 路径未配置。");
      },
    );

    const result = await service.startWeixinQrLogin();

    expect(result.ok).toBe(false);
    expect(result.status.phase).toBe("failed");
    expect(result.status.failureCode).toBe("hermes_root_unavailable");
    expect(result.status.message).toContain("Hermes Agent 路径未配置");
    expect(result.status.recommendedFix).toBeDefined();
    expect(result.status.failureKind).toBe("manual_fix");
  });

  it("returns a structured Weixin install failure when Hermes root cannot be resolved", async () => {
    const service = new HermesConnectorService(
      {} as never,
      {} as never,
      async () => {
        throw new Error("Hermes Agent 路径未配置。");
      },
    );

    const result = await service.installWeixinDependency();

    expect(result.ok).toBe(false);
    expect(result.status?.phase).toBe("failed");
    expect(result.status?.failureCode).toBe("hermes_root_unavailable");
    expect(result.message).toContain("Hermes Agent 路径未配置");
    expect(result.recommendedFix).toBeDefined();
  });
});
