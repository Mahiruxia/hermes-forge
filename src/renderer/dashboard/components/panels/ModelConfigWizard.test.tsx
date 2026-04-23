import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigWizard } from "./ModelConfigWizard";

const testModelConnection = vi.fn();
const updateModelConfig = vi.fn();
const saveSecret = vi.fn();

beforeEach(() => {
  testModelConnection.mockReset();
  updateModelConfig.mockReset();
  saveSecret.mockReset();
  Object.assign(window, {
    workbenchClient: {
      testModelConnection,
      updateModelConfig,
      saveSecret,
      discoverLocalModelSources: vi.fn(),
    },
  });
});

describe("ModelConfigWizard", () => {
  it("highlights the recommended fix when a connection test fails", async () => {
    testModelConnection.mockResolvedValue({
      ok: false,
      profileId: "draft-local_openai",
      sourceType: "local_openai",
      failureCategory: "network_unreachable",
      message: "连不上模型服务。",
      recommendedFix: "请确认服务已经启动，而且 Base URL 指向 /v1。",
    });

    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));

    expect(await screen.findByText("测试失败")).toBeInTheDocument();
    expect(screen.getByText(/建议动作：请确认服务已经启动/)).toBeInTheDocument();
  });

  it("enables saving after a successful connection test", async () => {
    testModelConnection.mockResolvedValue({
      ok: true,
      profileId: "draft-local_openai",
      sourceType: "local_openai",
      message: "连接成功。",
    });
    updateModelConfig.mockResolvedValue({});
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();

    renderWizard({ onRefresh, onSaved });

    expect(screen.getByRole("button", { name: /保存模型/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));

    expect((await screen.findAllByText("测试通过")).length).toBeGreaterThan(0);
    const saveButton = screen.getByRole("button", { name: /保存模型/ });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({ defaultProfileId: "wizard-local_openai" }));
    });
  });

  it("shows multiple saved profiles and keeps same-source additions unique", async () => {
    testModelConnection.mockResolvedValue({
      ok: true,
      profileId: "draft-local_openai",
      sourceType: "local_openai",
      message: "连接成功。",
    });
    updateModelConfig.mockResolvedValue({});

    renderWizard({
      models: {
        defaultProfileId: "wizard-local_openai",
        providerProfiles: [],
        modelProfiles: [
          { id: "wizard-local_openai", name: "本地 OpenAI-Compatible · qwen", provider: "custom", model: "qwen", baseUrl: "http://127.0.0.1:1234/v1" },
          { id: "wizard-openrouter", name: "OpenRouter · anthropic/claude-sonnet-4-5", provider: "openrouter", model: "anthropic/claude-sonnet-4-5", baseUrl: "https://openrouter.ai/api/v1" },
        ],
      },
    });

    expect(screen.getByText("本地 OpenAI-Compatible · qwen")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter · anthropic/claude-sonnet-4-5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "qwen3-coder-plus" } });
    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));
    expect((await screen.findAllByText("测试通过")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: /新增模型/ }).at(-1)!);

    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        modelProfiles: expect.arrayContaining([
          expect.objectContaining({ id: "wizard-local_openai", model: "qwen" }),
          expect.objectContaining({ id: "wizard-openrouter", model: "anthropic/claude-sonnet-4-5" }),
          expect.objectContaining({ id: "wizard-local_openai-2", model: "qwen3-coder-plus" }),
        ]),
      }));
    });
  });

  it("applies mainstream vendor presets into connection fields", () => {
    renderWizard({
      models: {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "选择模型通道" }));
    fireEvent.click(screen.getByRole("button", { name: /阿里云百炼 \/ Qwen/ }));

    expect(screen.getByText("模型名称 / Model ID")).toBeInTheDocument();
    expect(screen.getByLabelText("添加模型名称")).toHaveValue("qwen3-coder-plus");
    expect(screen.getByDisplayValue("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBeInTheDocument();
  });

  it("applies Volcengine Coding Plan preset", () => {
    renderWizard({
      models: {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "选择模型通道" }));
    fireEvent.click(screen.getByRole("button", { name: /火山方舟 Coding Plan/ }));

    expect(screen.getByLabelText("添加模型名称")).toHaveValue("ark-code-latest");
    expect(screen.getByDisplayValue("https://ark.cn-beijing.volces.com/api/coding/v3")).toBeInTheDocument();
  });
});

function renderWizard(overrides: { models?: Parameters<typeof ModelConfigWizard>[0]["models"]; onRefresh?: () => Promise<void>; onSaved?: (message: string) => void } = {}) {
  return render(
    <ModelConfigWizard
      models={overrides.models ?? {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [{ id: "wizard-local_openai", provider: "custom", model: "qwen", baseUrl: "http://127.0.0.1:1234/v1" }],
      }}
      secrets={[]}
      onRefresh={overrides.onRefresh ?? vi.fn().mockResolvedValue(undefined)}
      onSaved={overrides.onSaved ?? vi.fn()}
    />,
  );
}
