import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { WelcomePage } from "./WelcomePage";
import type { SetupSummary } from "../../shared/types";

const getHermesProbe = vi.fn();
const installHermes = vi.fn();
const getRuntimeConfig = vi.fn();
const getSetupSummary = vi.fn();

beforeEach(() => {
  useAppStore.getState().resetStore();
  getHermesProbe.mockReset();
  installHermes.mockReset();
  getRuntimeConfig.mockReset();
  getSetupSummary.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network skipped")));
  Object.assign(window, {
    workbenchClient: {
      onInstallHermesEvent: vi.fn(() => () => undefined),
      getHermesProbe,
      installHermes,
      getRuntimeConfig,
      getSetupSummary,
      cancelInstallHermes: vi.fn(),
      repairSetupDependency: vi.fn(),
    },
  });
  getRuntimeConfig.mockResolvedValue({ hermesRuntime: { mode: "windows" } });
  getSetupSummary.mockResolvedValue({ checks: [], blocking: [], ready: false } satisfies SetupSummary);
});

describe("WelcomePage Hermes installation", () => {
  it("lets the user confirm before routing first launch to model settings", async () => {
    const onComplete = vi.fn();
    getHermesProbe.mockResolvedValue({
      probe: {
        status: "healthy",
        message: "ready",
        secondaryMetric: "Hermes Agent v1",
      },
    });
    getSetupSummary.mockResolvedValue({
      checks: [],
      ready: false,
      blocking: [
        {
          id: "model",
          label: "模型",
          status: "missing",
          message: "未配置默认模型",
          fixAction: "configure_model",
          blocking: true,
        },
      ],
    } satisfies SetupSummary);

    render(<WelcomePage onComplete={onComplete} />);

    const continueButton = await screen.findByRole("button", { name: "继续配置模型" });
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(continueButton);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith("model");
    });
  });

  it("waits for an explicit install action before opening source selection", async () => {
    getHermesProbe.mockResolvedValue({
      probe: {
        status: "offline",
        message: "missing",
        secondaryMetric: "",
      },
    });

    render(<WelcomePage onComplete={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /选择安装方式/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /选择安装方式/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("选择 Hermes Agent 安装来源")).toBeInTheDocument();
    expect(installHermes).not.toHaveBeenCalled();
  });

  it("starts mirror install after the user selects the community mirror", async () => {
    getHermesProbe.mockResolvedValue({
      probe: {
        status: "offline",
        message: "missing",
        secondaryMetric: "",
      },
    });
    installHermes.mockResolvedValue({ ok: false, message: "failed", rootPath: "C:/Hermes", log: [] });

    render(<WelcomePage onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /选择安装方式/ }));
    const mirrorButton = await screen.findByRole("button", { name: /国内社区镜像/ });
    fireEvent.click(mirrorButton);

    await waitFor(() => {
      expect(installHermes).toHaveBeenCalledWith({ source: { kind: "mirror" } });
    });
  });

  it("routes manual path configuration directly to Hermes settings", async () => {
    const onComplete = vi.fn();
    getHermesProbe.mockResolvedValue({
      probe: { status: "offline", message: "missing", secondaryMetric: "" },
    });

    render(<WelcomePage onComplete={onComplete} />);

    fireEvent.click(await screen.findByRole("button", { name: "手动配置路径" }));
    expect(onComplete).toHaveBeenCalledWith("hermes");
  });
});
