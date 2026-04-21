import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPanel } from "./ConnectorsPanel";
import type { HermesConnectorListResult, WeixinQrLoginStatus } from "../../../../shared/types";

const listConnectors = vi.fn<() => Promise<HermesConnectorListResult>>();
const getWeixinQrLoginStatus = vi.fn<() => Promise<WeixinQrLoginStatus>>();
const startWeixinQrLogin = vi.fn<() => Promise<{ ok: boolean; status: WeixinQrLoginStatus; message: string }>>();
const cancelWeixinQrLogin = vi.fn<() => Promise<{ ok: boolean; status: WeixinQrLoginStatus; message: string }>>();
const installWeixinDependency = vi.fn<() => Promise<{ ok: boolean; message: string; command: string; stdout: string; stderr: string; status?: WeixinQrLoginStatus }>>();

beforeEach(() => {
  listConnectors.mockReset();
  getWeixinQrLoginStatus.mockReset();
  startWeixinQrLogin.mockReset();
  cancelWeixinQrLogin.mockReset();
  installWeixinDependency.mockReset();
  Object.assign(window, {
    workbenchClient: {
      listConnectors,
      getWeixinQrLoginStatus,
      startWeixinQrLogin,
      cancelWeixinQrLogin,
      installWeixinDependency,
      syncConnectorsEnv: vi.fn(),
      saveConnector: vi.fn(),
      disableConnector: vi.fn(),
      startGateway: vi.fn(),
      stopGateway: vi.fn(),
      restartGateway: vi.fn(),
    },
  });
});

describe("ConnectorsPanel", () => {
  it("renders connector config status separately from runtime status", async () => {
    listConnectors.mockResolvedValue(buildListResult({
      connectors: [
        buildConnector({
          platformId: "weixin",
          label: "微信",
          status: "configured",
          runtimeStatus: "error",
          configured: true,
          message: "Gateway 崩溃，需要重启。",
        }),
      ],
      gateway: {
        running: false,
        managedRunning: false,
        healthStatus: "error",
        message: "Gateway exited with code 1.",
        checkedAt: "2026-04-21T01:00:00.000Z",
        lastExitCode: 1,
        restartCount: 2,
      },
    }));

    render(<ConnectorsPanel />);

    expect(await screen.findByText("微信")).toBeInTheDocument();
    expect(screen.getByText("已配置")).toBeInTheDocument();
    expect(screen.getByText("运行异常")).toBeInTheDocument();
    expect(screen.getByText("异常")).toBeInTheDocument();
  });

  it("shows timeout state in the Weixin QR wizard", async () => {
    listConnectors.mockResolvedValue(buildListResult({
      connectors: [
        buildConnector({
          platformId: "weixin",
          label: "微信",
          status: "unconfigured",
          runtimeStatus: "stopped",
          configured: false,
          message: "等待扫码接入。",
        }),
      ],
    }));
    getWeixinQrLoginStatus.mockResolvedValue({
      running: false,
      phase: "idle",
      message: "准备开始微信扫码接入。",
    });
    startWeixinQrLogin.mockResolvedValue({
      ok: false,
      message: "二维码已超时，请重新扫码。",
      status: {
        running: false,
        phase: "timeout",
        message: "二维码已超时，请重新扫码。",
        failureCode: "qr_timeout",
        attempt: 2,
      },
    });

    render(<ConnectorsPanel />);

    expect(await screen.findByText("微信")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "扫码接入" })[0]);

    expect((await screen.findAllByText("扫码超时")).length).toBeGreaterThan(0);
    expect(screen.getByText("错误码：qr_timeout")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新扫码" })).toBeInTheDocument();
  });

  it("shows one-click dependency repair when aiohttp is missing", async () => {
    listConnectors.mockResolvedValue(buildListResult({
      connectors: [
        buildConnector({
          platformId: "weixin",
          label: "微信",
          status: "unconfigured",
          runtimeStatus: "stopped",
          configured: false,
          message: "等待扫码接入。",
        }),
      ],
    }));
    startWeixinQrLogin.mockResolvedValue({
      ok: false,
      message: "缺少 aiohttp，微信扫码运行环境不完整。",
      status: {
        running: false,
        phase: "failed",
        message: "缺少 aiohttp，微信扫码运行环境不完整。",
        failureCode: "missing_aiohttp",
        recoveryAction: "install_aiohttp",
        recoveryCommand: "py -3 -m pip install aiohttp",
        runtimePythonLabel: "py -3",
        failureKind: "recoverable",
      },
    });
    getWeixinQrLoginStatus.mockResolvedValue({
      running: false,
      phase: "idle",
      message: "准备开始微信扫码接入。",
    });

    render(<ConnectorsPanel />);
    expect(await screen.findByText("微信")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "扫码接入" })[0]);

    expect(await screen.findByRole("button", { name: "一键安装依赖" })).toBeInTheDocument();
    expect(screen.getByText("缺少 `aiohttp`，微信扫码运行环境不完整。")).toBeInTheDocument();
    expect(screen.getByText("py -3 -m pip install aiohttp")).toBeInTheDocument();
  });
});

function buildListResult(overrides: Partial<HermesConnectorListResult> = {}): HermesConnectorListResult {
  return {
    connectors: [],
    gateway: {
      running: false,
      managedRunning: false,
      healthStatus: "stopped",
      message: "Gateway stopped.",
      checkedAt: "2026-04-21T01:00:00.000Z",
    },
    envPath: "D:/workspace/.env",
    ...overrides,
  };
}

function buildConnector(overrides: {
  platformId: "weixin" | "telegram";
  label: string;
  status: "unconfigured" | "configured" | "running" | "error" | "disabled";
  runtimeStatus: "stopped" | "running" | "error";
  configured: boolean;
  message: string;
}) {
  return {
    platform: {
      id: overrides.platformId,
      label: overrides.label,
      category: "official" as const,
      description: `${overrides.label} connector`,
      fields: [],
      setupHelp: [],
    },
    status: overrides.status,
    runtimeStatus: overrides.runtimeStatus,
    enabled: true,
    configured: overrides.configured,
    missingRequired: [],
    values: {},
    secretRefs: {},
    secretStatus: {},
    message: overrides.message,
  };
}
