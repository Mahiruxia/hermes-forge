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
      "qqbot",
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
    expect(testOnly.PLATFORM_REGISTRY.find((platform) => platform.id === "feishu")?.fields.map((field) => field.envVar)).toEqual(expect.arrayContaining([
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "FEISHU_DOMAIN",
      "FEISHU_CONNECTION_MODE",
      "FEISHU_ALLOW_ALL_USERS",
      "FEISHU_BOT_OPEN_ID",
      "FEISHU_AGENT_MAPPING",
    ]));
    expect(testOnly.PLATFORM_REGISTRY.find((platform) => platform.id === "qqbot")?.fields.map((field) => field.envVar)).toEqual(expect.arrayContaining([
      "QQ_APP_ID",
      "QQ_CLIENT_SECRET",
      "QQ_ALLOW_ALL_USERS",
      "QQ_ALLOWED_USERS",
      "QQ_GROUP_ALLOWED_USERS",
      "QQBOT_HOME_CHANNEL",
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
      platformStates: { weixin: "connected" },
      connectedPlatforms: ["weixin"],
    });
    expect(snapshot?.message).toContain("weixin");
    expect(testOnly.parseGatewayStateSnapshot(JSON.stringify({
      pid: 12345,
      gateway_state: "running",
    }), () => false)).toBeUndefined();
  });

  it("does not treat a Feishu-only Gateway runtime as the main connector Gateway", () => {
    expect(testOnly.hasMainGatewayRuntime(
      { running: true, healthStatus: "running", platformStates: { "feishu:alpha": "connected" }, checkedAt: "2026-05-20T01:00:00.000Z", message: "" },
      { managedMainRunning: false, managedFeishuCount: 0 },
    )).toBe(false);
    expect(testOnly.hasMainGatewayRuntime(
      { running: true, healthStatus: "running", platformStates: { weixin: "connected", "feishu:alpha": "connected" }, checkedAt: "2026-05-20T01:00:00.000Z", message: "" },
      { managedMainRunning: false, managedFeishuCount: 0 },
    )).toBe(true);
    expect(testOnly.hasMainGatewayRuntime(
      { running: true, healthStatus: "running", checkedAt: "2026-05-20T01:00:00.000Z", message: "" },
      { managedMainRunning: false, managedFeishuCount: 1 },
    )).toBe(false);
    expect(testOnly.hasMainGatewayRuntime(
      { running: true, healthStatus: "running", checkedAt: "2026-05-20T01:00:00.000Z", message: "" },
      { managedMainRunning: false, managedFeishuCount: 0 },
    )).toBe(true);
  });

  it("treats legacy unprefixed Feishu state as the default instance runtime", () => {
    expect(testOnly.connectorRuntimeStatus(
      "feishu:default",
      true,
      true,
      {
        running: true,
        managedRunning: false,
        healthStatus: "running",
        platformStates: { feishu: "connected" },
        connectedPlatforms: ["feishu"],
        checkedAt: "2026-05-20T01:00:00.000Z",
        message: "",
      },
    )).toBe("running");
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
    const hermesRoot = path.join(os.tmpdir(), "Hermes Agent");
    const hermesHome = path.join(os.tmpdir(), "Forge", ".hermes", "profiles", "wechat");
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
      hermesRoot,
      hermesHome,
      true,
    );

    expect(env.OPENAI_API_KEY).toBe("pwd");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(env.OPENAI_MODEL).toBe("gpt-5.4");
    expect(env.PYTHONUTF8).toBe("1");
    expect(env.PYTHONIOENCODING).toBe("utf-8:replace");
    expect(env.PYTHONUNBUFFERED).toBe("1");
    expect(env.HERMES_HOME).toBe(hermesHome);
    expect(env.PYTHONPATH?.split(path.delimiter)).toEqual(expect.arrayContaining([
      hermesRoot,
      "parent-pythonpath",
    ]));
    if (process.platform === "win32") {
      expect(env.PYTHONPATH).toContain("python-sitecustomize");
    }
  });

  it("keeps Gateway WARNING stderr out of the red error channel", () => {
    expect(testOnly.splitGatewayStderr([
      "WARNING gateway.run: Process checkpoint recovery: [WinError 87] 参数错误。",
      "WARNING agent.auxiliary_client: OPENAI_BASE_URL is set but model.provider differs.",
    ].join("\n"))).toMatchObject({
      warnings: expect.stringContaining("OPENAI_BASE_URL"),
      errors: "",
    });

    expect(testOnly.splitGatewayStderr("Traceback (most recent call last):\nRuntimeError: boom")).toMatchObject({
      warnings: "",
      errors: expect.stringContaining("RuntimeError"),
    });
  });

  it("does not misread structured stopped Gateway status as running", () => {
    expect(testOnly.looksLikeGatewayRunning('{"gateway_state":"stopped","running":false}')).toBe(false);
    expect(testOnly.looksLikeGatewayRunning('Gateway status: running=false')).toBe(false);
    expect(testOnly.looksLikeGatewayRunning('{"gateway_state":"running","running":true}')).toBe(true);
    expect(testOnly.looksLikeGatewayRunning("Gateway is running")).toBe(true);
    expect(testOnly.looksLikeGatewayRunning("Gateway is not running")).toBe(false);
  });

  it("fails Gateway startup preflight clearly when no real model can be synced", async () => {
    const service = new HermesConnectorService(
      {} as never,
      {} as never,
      async () => "D:\\Hermes Agent",
      undefined,
      undefined,
      undefined,
      undefined,
      async () => ({ synced: false, skippedReason: "local-placeholder-model" }),
    );
    const result = await (service as any).ensureGatewayModelRuntime();

    expect(result.ok).toBe(false);
    expect(result.message).toContain("本地占位模型");
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

  it("migrates legacy Feishu config into an isolated default instance env", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-connector-feishu-"));
    const forgeHome = path.join(tempDir, "hermes-home");
    await fs.mkdir(forgeHome, { recursive: true });
    await fs.writeFile(path.join(tempDir, "connectors-config.json"), JSON.stringify({
      platforms: {
        feishu: {
          enabled: true,
          values: {
            appId: "cli_a",
            domain: "feishu",
            connectionMode: "websocket",
            allowAllUsers: false,
            groupPolicy: "open",
            botOpenId: "ou_bot",
            requireMention: true,
            agentMapping: "agent-a=cli_a,agent-b=cli_b",
          },
          secretRefs: { appSecret: "connector.feishu.appSecret" },
        },
      },
    }), "utf8");

    const service = new HermesConnectorService(
      {
        baseDir: () => tempDir,
        hermesDir: () => forgeHome,
      } as never,
      {
        hasSecret: vi.fn(async (ref: string) => ref === "connector.feishu.appSecret"),
        readSecret: vi.fn(async (ref: string) => ref === "connector.feishu.appSecret" ? "feishu-secret" : undefined),
      } as never,
      async () => {
        throw new Error("Hermes root is not needed for this sync-only test.");
      },
    );

    const result = await service.syncEnv();
    const env = await fs.readFile(path.join(forgeHome, "connector-instances", "feishu", "default", ".env"), "utf8");
    const mainEnv = await fs.readFile(result.envPath, "utf8");

    expect(mainEnv).not.toContain("FEISHU_APP_ID=cli_a");
    expect(env).toContain("FEISHU_APP_ID=cli_a");
    expect(env).toContain("FEISHU_APP_SECRET=feishu-secret");
    expect(env).toContain("FEISHU_DOMAIN=feishu");
    expect(env).toContain("FEISHU_CONNECTION_MODE=websocket");
    expect(env).toContain("FEISHU_ALLOW_ALL_USERS=false");
    expect(env).toContain("FEISHU_GROUP_POLICY=open");
    expect(env).toContain("FEISHU_BOT_OPEN_ID=ou_bot");
    expect(env).toContain("FEISHU_REQUIRE_MENTION=true");
    expect(env).toContain("FEISHU_AGENT_MAPPING=agent-a=cli_a,agent-b=cli_b");
  });

  it("syncs multiple Feishu bot instances into separate env files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-connector-feishu-multi-"));
    const forgeHome = path.join(tempDir, "hermes-home");
    await fs.mkdir(forgeHome, { recursive: true });
    await fs.mkdir(path.join(forgeHome, "profiles", "agent-alpha"), { recursive: true });
    const staleDefaultHome = path.join(forgeHome, "connector-instances", "feishu", "stale-default");
    const staleProfileHome = path.join(forgeHome, "profiles", "agent-old", "connector-instances", "feishu", "stale-profile");
    await fs.mkdir(staleDefaultHome, { recursive: true });
    await fs.mkdir(staleProfileHome, { recursive: true });
    await fs.writeFile(path.join(forgeHome, "profiles", "agent-alpha", "config.yaml"), "model:\n  default: alpha-model\n", "utf8");
    await fs.writeFile(path.join(forgeHome, "profiles", "agent-alpha", "auth.json"), "{\"token\":\"alpha\"}", "utf8");
    await fs.writeFile(path.join(tempDir, "connectors-config.json"), JSON.stringify({
      platforms: {
        feishu: {
          enabled: true,
          instances: {
            alpha: {
              enabled: true,
              values: { appId: "cli_alpha", domain: "feishu", connectionMode: "websocket", agentId: "agent-alpha" },
              secretRefs: { appSecret: "connector.feishu.alpha.appSecret" },
            },
            beta: {
              enabled: true,
              values: { appId: "cli_beta", domain: "feishu", connectionMode: "websocket", agentId: "agent-beta" },
              secretRefs: { appSecret: "connector.feishu.beta.appSecret" },
            },
          },
        },
      },
    }), "utf8");

    const service = new HermesConnectorService(
      { baseDir: () => tempDir, hermesDir: () => forgeHome } as never,
      {
        hasSecret: vi.fn(async () => true),
        readSecret: vi.fn(async (ref: string) => ref.includes("alpha") ? "secret-alpha" : "secret-beta"),
      } as never,
      async () => {
        throw new Error("Hermes root is not needed for this sync-only test.");
      },
    );

    const result = await service.syncEnv();
    const mainEnv = await fs.readFile(result.envPath, "utf8");
    const alphaHome = path.join(forgeHome, "profiles", "agent-alpha", "connector-instances", "feishu", "alpha");
    const betaHome = path.join(forgeHome, "profiles", "agent-beta", "connector-instances", "feishu", "beta");
    const alphaEnv = await fs.readFile(path.join(alphaHome, ".env"), "utf8");
    const betaEnv = await fs.readFile(path.join(betaHome, ".env"), "utf8");

    expect(mainEnv).not.toContain("FEISHU_APP_ID=");
    expect(alphaEnv).toContain("HERMES_CONNECTOR_INSTANCE_ID=feishu:alpha");
    expect(alphaEnv).toContain("HERMES_AGENT_PROFILE=agent-alpha");
    expect(alphaEnv).toContain("FEISHU_APP_ID=cli_alpha");
    expect(alphaEnv).toContain("FEISHU_APP_SECRET=secret-alpha");
    expect(alphaEnv).toContain("HERMES_AGENT_ID=agent-alpha");
    expect(betaEnv).toContain("HERMES_CONNECTOR_INSTANCE_ID=feishu:beta");
    expect(betaEnv).toContain("HERMES_AGENT_PROFILE=agent-beta");
    expect(betaEnv).toContain("FEISHU_APP_ID=cli_beta");
    expect(betaEnv).toContain("FEISHU_APP_SECRET=secret-beta");
    expect(betaEnv).toContain("HERMES_AGENT_ID=agent-beta");
    await expect(fs.lstat(path.join(alphaHome, "memories"))).resolves.toBeTruthy();
    await expect(fs.lstat(path.join(alphaHome, "config.yaml"))).resolves.toBeTruthy();
    await expect(fs.lstat(path.join(alphaHome, "auth.json"))).resolves.toBeTruthy();
    await expect(fs.lstat(path.join(betaHome, "skills"))).resolves.toBeTruthy();
    await expect(fs.stat(staleDefaultHome)).rejects.toThrow();
    await expect(fs.stat(staleProfileHome)).rejects.toThrow();
  });

  it("saves multiple Feishu bot instances without overwriting config, secrets, or env files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-connector-feishu-save-multi-"));
    const forgeHome = path.join(tempDir, "hermes-home");
    const secrets = new Map<string, string>();
    await fs.mkdir(forgeHome, { recursive: true });

    const service = new HermesConnectorService(
      { baseDir: () => tempDir, hermesDir: () => forgeHome } as never,
      {
        hasSecret: vi.fn(async (ref: string) => secrets.has(ref)),
        readSecret: vi.fn(async (ref: string) => secrets.get(ref)),
        saveSecret: vi.fn(async (ref: string, value: string) => {
          secrets.set(ref, value);
        }),
      } as never,
      async () => {
        throw new Error("Hermes root is not needed for this sync-only test.");
      },
    );

    await service.save({
      platformId: "feishu",
      instanceId: "alpha",
      enabled: true,
      values: {
        appId: "cli_alpha",
        appSecret: "secret-alpha",
        domain: "feishu",
        connectionMode: "websocket",
        agentId: "agent-alpha",
      },
    });
    await service.save({
      platformId: "feishu",
      instanceId: "beta",
      enabled: true,
      values: {
        appId: "cli_beta",
        appSecret: "secret-beta",
        domain: "feishu",
        connectionMode: "websocket",
        agentId: "agent-beta",
      },
    });

    const rawConfig = JSON.parse(await fs.readFile(path.join(tempDir, "connectors-config.json"), "utf8"));
    expect(rawConfig.platforms.feishu.instances.alpha.values).toMatchObject({ appId: "cli_alpha", agentId: "agent-alpha" });
    expect(rawConfig.platforms.feishu.instances.beta.values).toMatchObject({ appId: "cli_beta", agentId: "agent-beta" });
    expect(rawConfig.platforms.feishu.instances.alpha.secretRefs.appSecret).toBe("connector.feishu.alpha.appSecret");
    expect(rawConfig.platforms.feishu.instances.beta.secretRefs.appSecret).toBe("connector.feishu.beta.appSecret");
    expect(secrets.get("connector.feishu.alpha.appSecret")).toBe("secret-alpha");
    expect(secrets.get("connector.feishu.beta.appSecret")).toBe("secret-beta");

    const listed = await service.list();
    expect(listed.connectors.filter((item) => item.platform.id === "feishu").map((item) => item.instanceId)).toEqual(["alpha", "beta"]);

    const result = await service.syncEnv();
    const mainEnv = await fs.readFile(result.envPath, "utf8");
    const alphaEnv = await fs.readFile(path.join(forgeHome, "profiles", "agent-alpha", "connector-instances", "feishu", "alpha", ".env"), "utf8");
    const betaEnv = await fs.readFile(path.join(forgeHome, "profiles", "agent-beta", "connector-instances", "feishu", "beta", ".env"), "utf8");

    expect(mainEnv).not.toContain("FEISHU_APP_ID=");
    expect(alphaEnv).toContain("HERMES_CONNECTOR_INSTANCE_ID=feishu:alpha");
    expect(alphaEnv).toContain("FEISHU_APP_ID=cli_alpha");
    expect(alphaEnv).toContain("FEISHU_APP_SECRET=secret-alpha");
    expect(betaEnv).toContain("HERMES_CONNECTOR_INSTANCE_ID=feishu:beta");
    expect(betaEnv).toContain("FEISHU_APP_ID=cli_beta");
    expect(betaEnv).toContain("FEISHU_APP_SECRET=secret-beta");
  });

  it("imports legacy Feishu env into the default instance without dropping existing bot instances", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-connector-feishu-import-"));
    const forgeHome = path.join(tempDir, "hermes-home");
    const secrets = new Map<string, string>([["connector.feishu.alpha.appSecret", "secret-alpha"]]);
    await fs.mkdir(forgeHome, { recursive: true });
    await fs.writeFile(path.join(tempDir, "connectors-config.json"), JSON.stringify({
      platforms: {
        feishu: {
          enabled: true,
          instances: {
            alpha: {
              enabled: true,
              values: { appId: "cli_alpha", domain: "feishu", connectionMode: "websocket", agentId: "agent-alpha" },
              secretRefs: { appSecret: "connector.feishu.alpha.appSecret" },
            },
          },
        },
      },
    }), "utf8");

    const service = new HermesConnectorService(
      { baseDir: () => tempDir, hermesDir: () => forgeHome } as never,
      {
        hasSecret: vi.fn(async (ref: string) => secrets.has(ref)),
        readSecret: vi.fn(async (ref: string) => secrets.get(ref)),
        saveSecret: vi.fn(async (ref: string, value: string) => {
          secrets.set(ref, value);
        }),
      } as never,
      async () => {
        throw new Error("Hermes root is not needed for this sync-only test.");
      },
    );

    const imported = await service.importFromEnvValues({
      FEISHU_APP_ID: "cli_default",
      FEISHU_APP_SECRET: "secret-default",
      FEISHU_DOMAIN: "feishu",
      FEISHU_CONNECTION_MODE: "websocket",
    });
    const result = await service.syncEnv();
    const defaultEnv = await fs.readFile(path.join(forgeHome, "connector-instances", "feishu", "default", ".env"), "utf8");
    const alphaEnv = await fs.readFile(path.join(forgeHome, "profiles", "agent-alpha", "connector-instances", "feishu", "alpha", ".env"), "utf8");
    const mainEnv = await fs.readFile(result.envPath, "utf8");

    expect(imported.importedPlatforms).toContain("feishu");
    expect(imported.importedSecretRefs).toContain("connector.feishu.default.appSecret");
    expect(mainEnv).not.toContain("FEISHU_APP_ID=");
    expect(defaultEnv).toContain("HERMES_CONNECTOR_INSTANCE_ID=feishu:default");
    expect(defaultEnv).toContain("FEISHU_APP_ID=cli_default");
    expect(defaultEnv).toContain("FEISHU_APP_SECRET=secret-default");
    expect(alphaEnv).toContain("HERMES_CONNECTOR_INSTANCE_ID=feishu:alpha");
    expect(alphaEnv).toContain("FEISHU_APP_ID=cli_alpha");
    expect(alphaEnv).toContain("FEISHU_APP_SECRET=secret-alpha");
  });

  it("reads Feishu runtime state from the bound Agent profile instance home", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-connector-feishu-status-"));
    const forgeHome = path.join(tempDir, "hermes-home");
    const instanceHome = path.join(forgeHome, "profiles", "agent-alpha", "connector-instances", "feishu", "alpha");
    await fs.mkdir(instanceHome, { recursive: true });
    await fs.writeFile(path.join(tempDir, "connectors-config.json"), JSON.stringify({
      platforms: {
        feishu: {
          enabled: true,
          instances: {
            alpha: {
              enabled: true,
              values: { appId: "cli_alpha", domain: "feishu", connectionMode: "websocket", agentId: "agent-alpha" },
              secretRefs: { appSecret: "connector.feishu.alpha.appSecret" },
            },
          },
        },
      },
    }), "utf8");
    await fs.writeFile(path.join(instanceHome, "gateway_state.json"), JSON.stringify({
      gateway_state: "running",
      updated_at: new Date().toISOString(),
      platforms: { feishu: { state: "connected" } },
    }), "utf8");

    const service = new HermesConnectorService(
      { baseDir: () => tempDir, hermesDir: () => forgeHome } as never,
      {} as never,
      async () => {
        throw new Error("Hermes root is not needed for this status-only test.");
      },
    );

    const status = await (service as any).gatewayStateStatus();

    expect(status).toMatchObject({
      running: true,
      platformStates: { "feishu:alpha": "connected" },
      connectedPlatforms: ["feishu:alpha"],
    });
  });

  it("syncs QQ Bot credentials using Hermes CLI env names", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-connector-qqbot-"));
    const forgeHome = path.join(tempDir, "hermes-home");
    await fs.mkdir(forgeHome, { recursive: true });
    await fs.writeFile(path.join(tempDir, "connectors-config.json"), JSON.stringify({
      platforms: {
        qqbot: {
          enabled: true,
          values: {
            appId: "qq-app",
            allowAllUsers: false,
            allowedUsers: "qq-user",
            groupAllowedUsers: "qq-group-user",
            homeChannel: "qq-home",
          },
          secretRefs: { clientSecret: "connector.qqbot.clientSecret" },
        },
      },
    }), "utf8");

    const service = new HermesConnectorService(
      {
        baseDir: () => tempDir,
        hermesDir: () => forgeHome,
      } as never,
      {
        hasSecret: vi.fn(async (ref: string) => ref === "connector.qqbot.clientSecret"),
        readSecret: vi.fn(async (ref: string) => ref === "connector.qqbot.clientSecret" ? "qq-secret" : undefined),
      } as never,
      async () => {
        throw new Error("Hermes root is not needed for this sync-only test.");
      },
    );

    const result = await service.syncEnv();
    const env = await fs.readFile(result.envPath, "utf8");

    expect(env).toContain("QQ_APP_ID=qq-app");
    expect(env).toContain("QQ_CLIENT_SECRET=qq-secret");
    expect(env).toContain("QQ_ALLOW_ALL_USERS=false");
    expect(env).toContain("QQ_ALLOWED_USERS=qq-user");
    expect(env).toContain("QQ_GROUP_ALLOWED_USERS=qq-group-user");
    expect(env).toContain("QQBOT_HOME_CHANNEL=qq-home");
    expect(env).not.toContain("QQ_HOME_CHANNEL=qq-home");
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

  it("ignores stale Gateway close events after a replacement process starts", () => {
    const service = new HermesConnectorService({} as never, {} as never, async () => "D:\\Hermes Agent");
    const stateful = service as any;
    const oldChild = { pid: 111, killed: false };
    const newChild = { pid: 222, killed: false };
    stateful.gatewayProcess = newChild;
    stateful.gatewayStartedAt = "2026-04-23T00:00:00.000Z";
    stateful.gatewayAutoStartState = "running";
    stateful.gatewayAutoStartMessage = "Gateway 已自动启动。";

    stateful.handleGatewayProcessClose(oldChild, 1);

    expect(stateful.gatewayProcess).toBe(newChild);
    expect(stateful.gatewayStartedAt).toBe("2026-04-23T00:00:00.000Z");
    expect(stateful.gatewayAutoStartState).toBe("running");
    expect(stateful.gatewayLastExitCode).toBeUndefined();
  });

  it("clears the tracked Gateway process when the current process exits", () => {
    const service = new HermesConnectorService({} as never, {} as never, async () => "D:\\Hermes Agent");
    const stateful = service as any;
    const child = { pid: 333, killed: false };
    stateful.gatewayProcess = child;
    stateful.gatewayStartedAt = "2026-04-23T00:00:00.000Z";
    stateful.gatewayAutoStartState = "running";

    stateful.handleGatewayProcessClose(child, 0);

    expect(stateful.gatewayProcess).toBeUndefined();
    expect(stateful.gatewayStartedAt).toBeUndefined();
    expect(stateful.gatewayLastExitCode).toBe(0);
    expect(stateful.gatewayAutoStartState).toBe("idle");
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
    expect(connector.message).toContain("缺少必填配置：appId、clientSecret");
  });

  it("marks QQ Bot as configured once Hermes CLI credentials are present", async () => {
    const service = new HermesConnectorService(
      {} as never,
      { hasSecret: vi.fn(async (ref: string) => ref === "connector.qqbot.clientSecret") } as never,
      async () => "D:\\Hermes Agent",
    );
    const stateful = service as any;

    const connector = await stateful.toConnector(
      testOnly.PLATFORM_REGISTRY.find((platform: { id: string }) => platform.id === "qqbot"),
      {
        platforms: {
          qqbot: {
            enabled: true,
            values: { appId: "qq-app", allowedUsers: "alice,bob" },
            secretRefs: { clientSecret: "connector.qqbot.clientSecret" },
          },
        },
      },
      {},
      { running: false, healthStatus: "stopped", message: "Gateway 未运行。", checkedAt: "2026-04-23T00:00:00.000Z" },
    );

    expect(connector.configured).toBe(true);
    expect(connector.status).toBe("configured");
  });

  it("does not report Weixin as running when Gateway only connected another platform", async () => {
    const service = new HermesConnectorService(
      {} as never,
      { hasSecret: vi.fn(async (ref: string) => ref === "connector.weixin.token") } as never,
      async () => "D:\\Hermes Agent",
    );
    const stateful = service as any;

    const connector = await stateful.toConnector(
      testOnly.PLATFORM_REGISTRY.find((platform: { id: string }) => platform.id === "weixin"),
      {
        platforms: {
          weixin: {
            enabled: true,
            values: { accountId: "wx-account" },
            secretRefs: { token: "connector.weixin.token" },
          },
        },
      },
      {},
      {
        running: true,
        managedRunning: true,
        healthStatus: "running",
        platformStates: { telegram: "connected" },
        connectedPlatforms: ["telegram"],
        message: "Gateway 状态文件显示正在运行，已连接：telegram。",
        checkedAt: "2026-04-23T00:00:00.000Z",
      },
    );

    expect(connector.configured).toBe(true);
    expect(connector.runtimeStatus).toBe("stopped");
    expect(connector.message).toBe("已配置，等待同步或启动 Gateway。");
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
    expect(result.status.message).toContain("Hermes Agent");
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
    expect(result.message).toContain("Hermes Agent");
    expect(result.recommendedFix).toBeDefined();
  });
});
