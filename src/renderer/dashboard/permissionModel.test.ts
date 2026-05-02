import { describe, expect, it } from "vitest";
import { buildPreflightState, preflightChipsForUser, preflightSummaryForUser } from "./permissionModel";
import type { PermissionOverview } from "../../shared/types";

function overview(input: Partial<PermissionOverview>): PermissionOverview {
  return {
    runtime: "wsl",
    permissionPolicy: "bridge_guarded",
    cliPermissionMode: "guarded",
    transport: "native-arg-env",
    sessionMode: "fresh",
    bridge: {
      enabled: true,
      running: true,
      capabilities: ["windows.files.writeText", "windows.powershell.run"],
      capabilityCount: 2,
      reportedByBackend: true,
    },
    enforcement: {
      hardEnforceable: ["windowsBridgeTools: gated", "sessionPromptMetadata: natural query + metadata"],
      softGuarded: ["cliDangerousCommandApproval: guarded"],
      notEnforceableYet: ["shell: not hard-blocked", "git: not hard-blocked"],
    },
    blocked: false,
    blockReason: null,
    capabilityProbe: {
      minimumSatisfied: true,
      cliVersion: "0.12.0",
      missing: [],
      allowedTransports: ["native-arg-env"],
      support: "native",
    },
    runtimeReady: true,
    notes: [],
    ...input,
  };
}

describe("RC smoke matrix", () => {
  it("WSL + bridge_guarded + guarded is runnable", () => {
    const preflight = buildPreflightState({ events: [], overview: overview({}) });
    expect(preflight.tone).toBe("green");
    expect(preflight.permissionPolicy).toBe("bridge_guarded");
    expect(preflight.cliPermissionMode).toBe("guarded");
    expect(preflight.transport).toBe("native-arg-env");
    expect(preflight.blocked).toBe(false);
  });

  it("WSL + passthrough + guarded is yellow but runnable", () => {
    const preflight = buildPreflightState({ events: [], overview: overview({ permissionPolicy: "passthrough" }) });
    expect(preflight.tone).toBe("yellow");
    expect(preflight.blocked).toBe(false);
  });

  it("WSL + bridge_guarded + yolo is yellow but runnable", () => {
    const preflight = buildPreflightState({ events: [], overview: overview({ cliPermissionMode: "yolo" }) });
    expect(preflight.tone).toBe("yellow");
    expect(preflight.blocked).toBe(false);
  });

  it("WSL + restricted_workspace is blocked", () => {
    const preflight = buildPreflightState({
      events: [],
      overview: overview({
        permissionPolicy: "restricted_workspace",
        blocked: true,
        runtimeReady: false,
        blockReason: {
          code: "policy_not_enforceable",
          summary: "当前权限策略无法被真实执行",
          detail: "restricted_workspace requires hard isolation",
          fixHint: "switch policy",
        },
      }),
    });
    expect(preflight.tone).toBe("red");
    expect(preflight.blocked).toBe(true);
    expect(preflight.block?.code).toBe("policy_not_enforceable");
  });

  it("CLI capability below minimum gate is blocked", () => {
    const preflight = buildPreflightState({
      events: [],
      overview: overview({
        blocked: true,
        runtimeReady: false,
        transport: null,
        capabilityProbe: {
          minimumSatisfied: false,
          cliVersion: "0.9.0",
          missing: ["supportsLaunchMetadataArg"],
          allowedTransports: [],
          support: "unsupported",
          reason: "missing arg support",
        },
        blockReason: {
          code: "unsupported_cli_capability",
          summary: "Hermes CLI 不满足 Forge WSL 最低能力门槛",
          detail: "missing capability",
          fixHint: "upgrade CLI",
        },
      }),
    });
    expect(preflight.tone).toBe("red");
    expect(preflight.block?.code).toBe("unsupported_cli_capability");
  });

  it("bridge disabled or capability unreported stays consistent", () => {
    const preflight = buildPreflightState({
      events: [],
      overview: overview({
        bridge: {
          enabled: false,
          running: false,
          capabilities: [],
          capabilityCount: 0,
          reportedByBackend: false,
        },
      }),
    });
    expect(preflight.bridgeEnabled).toBe(false);
    expect(preflight.blocked).toBe(false);
  });

  it("treats an active task lock as a professional waiting state instead of an error", () => {
    const preflight = buildPreflightState({ events: [], overview: overview({}), locked: true });
    expect(preflight.tone).toBe("yellow");
    expect(preflight.blocked).toBe(true);
    expect(preflight.summary).toBe("当前会话正在处理中");
    expect(preflight.detail).toContain("完成后即可继续输入");
    expect(preflight.block).toBeUndefined();
  });

  it("sessionMode fresh resumed degraded are surfaced consistently", () => {
    expect(buildPreflightState({ events: [], overview: overview({ sessionMode: "fresh" }) }).sessionMode).toBe("fresh");
    expect(buildPreflightState({ events: [], overview: overview({ sessionMode: "resumed" }) }).sessionMode).toBe("resumed");
    const degraded = buildPreflightState({ events: [], overview: overview({ sessionMode: "degraded" }) });
    expect(degraded.sessionMode).toBe("degraded");
    expect(degraded.tone).toBe("yellow");
  });

  it("translates preflight state into user-facing copy", () => {
    const ready = buildPreflightState({ events: [], overview: overview({}) });
    expect(preflightSummaryForUser(ready)).toBe("环境就绪，可以发送");
    expect(preflightChipsForUser(ready)).toEqual(expect.arrayContaining(["新会话", "Windows 能力受保护", "危险命令会确认"]));

    const yolo = buildPreflightState({ events: [], overview: overview({ cliPermissionMode: "yolo" }) });
    expect(preflightSummaryForUser(yolo)).toBe("可以发送，但命令会自动放行");
    expect(preflightChipsForUser(yolo)).toContain("命令自动放行");

    const windowsYolo = buildPreflightState({ events: [], overview: overview({ runtime: "windows", cliPermissionMode: "yolo", transport: "windows-headless" }) });
    expect(windowsYolo.tone).toBe("green");
    expect(preflightSummaryForUser(windowsYolo)).toBe("环境就绪，可以发送");
  });
});
