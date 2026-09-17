import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { WelcomePage } from "./WelcomePage";
import type { HermesInstallEvent, SetupSummary } from "../../shared/types";

const getHermesProbe = vi.fn();
const installHermes = vi.fn();
const getRuntimeConfig = vi.fn();
const getSetupSummary = vi.fn();
const cancelInstallHermes = vi.fn();
let installListener: (event: HermesInstallEvent) => void;

beforeEach(() => {
  useAppStore.getState().resetStore();
  getHermesProbe.mockReset();
  installHermes.mockReset();
  getRuntimeConfig.mockReset();
  getSetupSummary.mockReset();
  cancelInstallHermes.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network skipped")));
  Object.assign(window, {
    workbenchClient: {
      onInstallHermesEvent: vi.fn((listener) => { installListener = listener; return () => undefined; }),
      getHermesProbe,
      installHermes,
      getRuntimeConfig,
      getSetupSummary,
      cancelInstallHermes,
      repairSetupDependency: vi.fn(),
    },
  });
  getRuntimeConfig.mockResolvedValue({ hermesRuntime: { mode: "windows" } });
  getSetupSummary.mockResolvedValue({ checks: [], blocking: [], ready: false } satisfies SetupSummary);
});

describe("WelcomePage Hermes installation", () => {
  it("waits for model checks and reuses their result when continuing", async () => {
    let finish!: (value: SetupSummary) => void;
    getSetupSummary.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    getHermesProbe.mockResolvedValue({ probe: { status: "healthy", secondaryMetric: "Hermes 0.21.3" } });
    const onComplete = vi.fn();
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));
    expect(await screen.findByRole("button", { name: "正在确认设置…" })).toBeDisabled();
    expect(screen.queryByText(/Hermes 和默认模型都已可用/)).toBeNull();
    await act(async () => finish({ checks: [], blocking: [], ready: true }));
    fireEvent.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(onComplete).toHaveBeenCalledWith("workbench");
    expect(getSetupSummary).toHaveBeenCalledTimes(1);
  });

  it("routes incomplete setup checks to settings instead of declaring the model ready", async () => {
    getSetupSummary.mockRejectedValue(new Error("IPC disconnected"));
    getHermesProbe.mockResolvedValue({ probe: { status: "healthy", secondaryMetric: "Hermes 0.21.3" } });
    const onComplete = vi.fn();
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续配置模型" }));
    expect(onComplete).toHaveBeenCalledWith("model");
    expect(screen.queryByText(/Hermes 和默认模型都已可用/)).toBeNull();
  });

  it("keeps the final installation log accessible after failure", async () => {
    installHermes.mockResolvedValue({ ok: false, message: "依赖下载失败", log: ["uv: connection timed out"] });
    await startOfficialInstall();
    fireEvent.click(await screen.findByRole("button", { name: /查看安装日志/ }));
    expect(screen.getByText("uv: connection timed out")).toBeInTheDocument();
  });
  async function startOfficialInstall() {
    getHermesProbe.mockResolvedValue({ probe: { status: "offline", message: "missing" } });
    render(<WelcomePage onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));
    fireEvent.click(await screen.findByRole("button", { name: /选择安装方式/ }));
    fireEvent.click(await screen.findByRole("button", { name: /官方 GitHub/ }));
    await waitFor(() => expect(installHermes).toHaveBeenCalledTimes(1));
  }

  it("allows macOS users to reach the native installation flow", async () => {
    getRuntimeConfig.mockResolvedValue({ hermesRuntime: { mode: "darwin" } });
    installHermes.mockResolvedValue({ ok: false, message: "Git missing", log: [] });
    await startOfficialInstall();
    expect(installHermes).toHaveBeenCalledWith({ source: { kind: "official" } });
    expect(screen.queryByText("macOS 暂不支持一键自动安装")).toBeNull();
  });

  it("keeps the install locked until the cancelled request settles", async () => {
    let finish!: (value: unknown) => void;
    installHermes.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    cancelInstallHermes.mockResolvedValue({ ok: true, message: "正在终止后台进程" });
    await startOfficialInstall();
    fireEvent.click(screen.getByRole("button", { name: "取消安装" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled());
    act(() => installListener({ stage: "cancelled", progress: 100, message: "已取消", startedAt: "now", at: "now" }));
    expect(screen.queryByRole("button", { name: /选择安装方式/ })).toBeNull();
    expect(getSetupSummary).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: false, message: "Hermes 安装已取消", log: [] }));
    expect(await screen.findByRole("button", { name: /选择安装方式/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /改用国内社区镜像重试/ })).toBeNull();
  });

  it("keeps cancellation retryable if the cancel IPC fails", async () => {
    installHermes.mockReturnValue(new Promise(() => {}));
    cancelInstallHermes.mockRejectedValue(new Error("IPC failed"));
    await startOfficialInstall();
    fireEvent.click(screen.getByRole("button", { name: "取消安装" }));
    expect(await screen.findByText("取消请求未送达，请重试。安装状态会继续更新。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消安装" })).toBeEnabled();
  });

  it("offers re-detection without claiming installation failed when only the refresh failed", async () => {
    let finish!: (value: unknown) => void;
    installHermes.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await startOfficialInstall();
    getHermesProbe.mockRejectedValueOnce(new Error("temporary IPC failure"));
    await act(async () => finish({ ok: true, message: "安装完成", rootPath: "/hermes", log: [] }));
    expect(await screen.findByText("Hermes 已安装，状态刷新未完成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /改用国内社区镜像重试/ })).toBeNull();
  });

  it("renders first setup without probing until the user starts detection", async () => {
    getHermesProbe.mockResolvedValue({ probe: { status: "offline", message: "missing" } });
    render(<WelcomePage onComplete={vi.fn()} />);
    await Promise.resolve();
    expect(screen.getByRole("button", { name: "检测环境" })).toBeInTheDocument();
    expect(getHermesProbe).not.toHaveBeenCalled();
    expect(getSetupSummary).not.toHaveBeenCalled();
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));
    await waitFor(() => expect(getHermesProbe).toHaveBeenCalledTimes(1));
    expect(getSetupSummary).toHaveBeenCalledTimes(1);
  });
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
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));

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
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));

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
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));

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
    fireEvent.click(screen.getByRole("button", { name: "检测环境" }));

    fireEvent.click(await screen.findByRole("button", { name: "手动配置路径" }));
    expect(onComplete).toHaveBeenCalledWith("hermes");
  });
});
