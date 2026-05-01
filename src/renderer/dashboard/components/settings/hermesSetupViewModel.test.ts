import { describe, expect, it } from "vitest";
import { buildHermesSetupViewModel } from "./hermesSetupViewModel";
import type { PermissionOverview, SetupCheck } from "../../../../shared/types";

function check(input: Partial<SetupCheck>): SetupCheck {
  return {
    id: "hermes",
    label: "Hermes",
    status: "failed",
    message: "Hermes root 不存在。",
    ...input,
  };
}

describe("buildHermesSetupViewModel", () => {
  it("shows a single missing install action when no Windows Agent is available", () => {
    const model = buildHermesSetupViewModel({
      rootPath: "",
      hermesAvailable: false,
      setupBlocking: [],
      setupLoading: false,
    });

    expect(model.state).toBe("missing");
    expect(model.primaryAction).toBe("install");
    expect(model.title).toContain("未安装");
  });

  it("shows compatibility mode for non-blocking missing Hermes capabilities", () => {
    const model = buildHermesSetupViewModel({
      rootPath: "C:\\Users\\xia\\AppData\\Local\\hermes\\hermes-agent",
      hermesAvailable: true,
      setupBlocking: [
        check({
          fixAction: "update_hermes",
          message: "当前 Hermes Agent 缺少 v0.2.0 所需的关键能力。",
        }),
      ],
      setupLoading: false,
    });

    expect(model.state).toBe("degraded");
    expect(model.primaryAction).toBe("diagnose");
    expect(model.statusPill).toBe("兼容模式");
  });

  it("keeps install success from fighting with a capability warning", () => {
    const permissionOverview = {
      blocked: true,
      blockReason: {
        code: "unsupported_cli_capability",
        summary: "关键能力缺失",
        detail: "AIAgent.run_conversation 不存在。",
        fixHint: "请升级 Hermes Agent。",
      },
      capabilityProbe: { minimumSatisfied: false },
    } as PermissionOverview;

    const model = buildHermesSetupViewModel({
      rootPath: "C:\\Users\\xia\\AppData\\Local\\hermes\\hermes-agent",
      hermesAvailable: true,
      permissionOverview,
      setupBlocking: [],
      setupLoading: false,
    });

    expect(model.state).toBe("degraded");
    expect(model.detailRows.find((row) => row.id === "install")?.value).toBe("可用");
  });

  it("shows version row when updateStatus provides currentVersion", () => {
    const model = buildHermesSetupViewModel({
      rootPath: "C:\\Users\\xia\\AppData\\Local\\hermes\\hermes-agent",
      hermesAvailable: true,
      setupBlocking: [],
      setupLoading: false,
      updateStatus: {
        engineId: "hermes",
        currentVersion: "v0.11.0",
        latestVersion: "origin/main @ abc1234",
        behindCount: 217,
        remoteRef: "origin/main",
        updateAvailable: true,
        sourceConfigured: true,
        message: "有 217 个提交可更新",
      },
    });

    expect(model.state).toBe("update_required");
    const versionRow = model.detailRows.find((row) => row.id === "version");
    expect(versionRow).toBeDefined();
    expect(versionRow?.value).toBe("v0.11.0");
    expect(versionRow?.detail).toBe("有 217 个提交可更新");
    expect(model.detailRows.find((row) => row.id === "latestVersion")?.value).toBe("origin/main @ abc1234");
  });

  it("shows version row from version prop when hermesStatus version is available", () => {
    const model = buildHermesSetupViewModel({
      rootPath: "C:\\Users\\xia\\AppData\\Local\\hermes\\hermes-agent",
      hermesAvailable: true,
      setupBlocking: [],
      setupLoading: false,
      version: "v0.12.0",
    });

    expect(model.state).toBe("ready");
    const versionRow = model.detailRows.find((row) => row.id === "version");
    expect(versionRow).toBeDefined();
    expect(versionRow?.value).toBe("v0.12.0");
  });
});
