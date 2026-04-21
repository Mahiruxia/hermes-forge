import { describe, expect, it } from "vitest";
import { testOnly } from "./hermes-connector-service";

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
      },
      {
        OPENAI_API_KEY: "pwd",
        OPENAI_BASE_URL: "http://127.0.0.1:8080/v1",
        OPENAI_MODEL: "gpt-5.4",
      },
    );

    expect(env.OPENAI_API_KEY).toBe("pwd");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:8080/v1");
    expect(env.OPENAI_MODEL).toBe("gpt-5.4");
    expect(env.PYTHONUTF8).toBe("1");
  });
});
