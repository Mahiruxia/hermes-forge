import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigWizard } from "./ModelConfigWizard";
import { stableModelProfileId } from "../../../../shared/model-config";

const testModelConnection = vi.fn();
const updateModelConfig = vi.fn();
const saveSecret = vi.fn();
const setDefaultModel = vi.fn();
const discoverLocalModelSources = vi.fn();

beforeEach(() => {
  testModelConnection.mockReset();
  updateModelConfig.mockReset();
  saveSecret.mockReset();
  setDefaultModel.mockReset();
  discoverLocalModelSources.mockReset();
  setDefaultModel.mockResolvedValue({ success: true, defaultModelId: "wizard-openrouter_api_key", models: [] });
  Object.assign(window, {
    workbenchClient: {
      testModelConnection,
      updateModelConfig,
      setDefaultModel,
      saveSecret,
      discoverLocalModelSources,
    },
  });
});

describe("ModelConfigWizard", () => {
  it("highlights the recommended fix when a connection test fails", async () => {
    testModelConnection.mockResolvedValue({
      ok: false,
      profileId: "draft-openai_compatible",
      sourceType: "openai_compatible",
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
      profileId: "draft-openai_compatible",
      sourceType: "openai_compatible",
      agentRole: "primary_agent",
      supportsTools: true,
      contextWindow: 32000,
      message: "连接成功。",
    });
    updateModelConfig.mockResolvedValue({});
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();

    renderWizard({ onRefresh, onSaved });

    expect(screen.getByRole("button", { name: /保存并复检/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));

    expect((await screen.findAllByText("测试通过")).length).toBeGreaterThan(0);
    expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 256000 }));
    const saveButton = screen.getByRole("button", { name: /保存并复检/ });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({ defaultProfileId: "wizard-openai_compatible" }));
    });
  });

  it("saves an entered API key before testing the connection", async () => {
    testModelConnection.mockResolvedValue({
      ok: true,
      profileId: "draft-openai_compatible",
      sourceType: "openai_compatible",
      agentRole: "primary_agent",
      supportsTools: true,
      message: "连接成功。",
    });
    saveSecret.mockResolvedValue({});

    renderWizard();

    fireEvent.change(screen.getByPlaceholderText(/云接口请填写/), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));

    await waitFor(() => {
      expect(saveSecret).toHaveBeenCalledWith({ ref: "provider.custom.apiKey", plainText: "sk-test" });
      expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({ secretRef: "provider.custom.apiKey" }));
    });
  });

  it("keeps context length hidden and saves an internal maximum when provider does not report one", async () => {
    testModelConnection.mockResolvedValue({
      ok: true,
      profileId: "draft-openai_compatible",
      sourceType: "openai_compatible",
      agentRole: "primary_agent",
      supportsTools: true,
      message: "连接成功。",
    });
    updateModelConfig.mockResolvedValue({});

    renderWizard({
      models: {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [],
      },
    });

    expect(screen.queryByText(/上下文长度/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "MiniMax-M2.7" } });
    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));
    expect((await screen.findAllByText("测试通过")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /新增并复检/ }));

    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        modelProfiles: expect.arrayContaining([
          expect.objectContaining({ sourceType: "openai_compatible", maxTokens: 256000 }),
        ]),
      }));
    });
  });

  it("shows multiple saved profiles and keeps same-source additions unique", async () => {
    testModelConnection.mockResolvedValue({
      ok: true,
      profileId: "draft-openai_compatible",
      sourceType: "openai_compatible",
      agentRole: "primary_agent",
      supportsTools: true,
      contextWindow: 32000,
      message: "连接成功。",
    });
    updateModelConfig.mockResolvedValue({});

    renderWizard({
      models: {
        defaultProfileId: "wizard-openai_compatible",
        providerProfiles: [],
        modelProfiles: [
          { id: "wizard-openai_compatible", name: "OpenAI-compatible · qwen", provider: "custom", sourceType: "openai_compatible", model: "qwen", baseUrl: "http://127.0.0.1:8080/v1", agentRole: "primary_agent" },
          { id: "wizard-openrouter_api_key", name: "OpenRouter · anthropic/claude-sonnet-4-5", provider: "openrouter", sourceType: "openrouter_api_key", model: "anthropic/claude-sonnet-4-5", baseUrl: "https://openrouter.ai/api/v1", agentRole: "primary_agent" },
        ],
      },
    });

    expect(screen.getByText("当前使用模型")).toBeInTheDocument();
    expect(screen.getAllByText("OpenAI-compatible · qwen").length).toBeGreaterThan(0);
    expect(screen.getByText("OpenRouter · anthropic/claude-sonnet-4-5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "qwen3-coder-plus" } });
    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));
    expect((await screen.findAllByText("测试通过")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: /新增并复检/ }).at(-1)!);

    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        modelProfiles: expect.arrayContaining([
          expect.objectContaining({ id: "wizard-openai_compatible", model: "qwen" }),
          expect.objectContaining({ id: "wizard-openrouter_api_key", model: "anthropic/claude-sonnet-4-5" }),
          expect.objectContaining({ id: stableModelProfileId({ provider: "custom", model: "qwen3-coder-plus", baseUrl: "http://127.0.0.1:8080/v1" }), model: "qwen3-coder-plus" }),
        ]),
      }));
    });
  });

  it("keeps the previous profile in history when a different model is saved from the editor", async () => {
    testModelConnection.mockResolvedValue({
      ok: true,
      profileId: "draft-openai_compatible",
      sourceType: "openai_compatible",
      agentRole: "primary_agent",
      supportsTools: true,
      contextWindow: 256000,
      message: "连接成功。",
    });
    updateModelConfig.mockResolvedValue({});

    renderWizard({
      models: {
        defaultProfileId: "wizard-openai_compatible",
        providerProfiles: [],
        modelProfiles: [
          { id: "wizard-openai_compatible", name: "OpenAI-compatible · qwen", provider: "custom", sourceType: "openai_compatible", model: "qwen", baseUrl: "http://127.0.0.1:8080/v1", agentRole: "primary_agent" },
        ],
      },
    });

    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "MiniMax-M2.7" } });
    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:8080/v1"), { target: { value: "https://api.minimaxi.com/v1" } });
    expect(screen.getByRole("button", { name: /新增并复检/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /立即测试/ }));
    expect((await screen.findAllByText("测试通过")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /新增并复检/ }));

    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        modelProfiles: expect.arrayContaining([
          expect.objectContaining({ id: "wizard-openai_compatible", model: "qwen" }),
          expect.objectContaining({ model: "MiniMax-M2.7", baseUrl: "https://api.minimaxi.com/v1" }),
        ]),
      }));
    });
  });

  it("creates a clean model draft from the current provider", () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "temporary-model" } });
    expect(screen.getByDisplayValue("temporary-model")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新增模型草稿" }));

    expect(screen.queryByDisplayValue("temporary-model")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("http://127.0.0.1:8080/v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增并复检/ })).toBeDisabled();
  });

  it("supports editing and deleting saved model profiles", async () => {
    updateModelConfig.mockResolvedValue({});
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();

    renderWizard({
      onRefresh,
      onSaved,
      models: {
        defaultProfileId: "wizard-openai_compatible",
        providerProfiles: [],
        modelProfiles: [
          { id: "wizard-openai_compatible", name: "OpenAI-compatible · qwen", provider: "custom", sourceType: "openai_compatible", model: "qwen", baseUrl: "http://127.0.0.1:8080/v1", agentRole: "primary_agent" },
          { id: "wizard-openrouter_api_key", name: "OpenRouter · claude", provider: "openrouter", sourceType: "openrouter_api_key", model: "claude", baseUrl: "https://openrouter.ai/api/v1", agentRole: "primary_agent" },
        ],
      },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "编辑" }).at(-1)!);
    expect(screen.getByDisplayValue("claude")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://openrouter.ai/api/v1")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "删除" }).at(-1)!);
    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        modelProfiles: [expect.objectContaining({ id: "wizard-openai_compatible" })],
      }));
      expect(onRefresh).toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalledWith("模型已删除");
    });
  });

  it("sets an older saved profile as default through the backend API", async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();
    renderWizard({
      onRefresh,
      onSaved,
      models: {
        defaultProfileId: "openrouter-elephant",
        providerProfiles: [],
        modelProfiles: [
          { id: "openrouter-elephant", name: "OpenRouter · elephant", provider: "openrouter", sourceType: "openrouter_api_key", model: "openrouter/elephant-alpha", baseUrl: "https://openrouter.ai/api/v1", agentRole: "primary_agent" },
          { id: "mock-model", name: "Mock", provider: "local", sourceType: "legacy", model: "mock-model", agentRole: "auxiliary_model" },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "设为默认" }));

    await waitFor(() => {
      expect(setDefaultModel).toHaveBeenCalledWith("mock-model");
      expect(onRefresh).toHaveBeenCalled();
      expect(onSaved).toHaveBeenCalledWith("默认模型已切换");
    });
  });

  it("applies API key family presets into connection fields", () => {
    renderWizard({
      models: {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "选择 provider family" }));
    fireEvent.click(screen.getByRole("button", { name: /Gemini API Key/ }));

    expect(screen.getByText("模型名称 / Model ID")).toBeInTheDocument();
    expect(screen.getByDisplayValue("gemini-2.5-pro")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://generativelanguage.googleapis.com/v1beta")).toBeInTheDocument();
  });

  it("shows OpenAI-compatible as the first recommended provider family", () => {
    renderWizard({
      models: {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "选择 provider family" }));

    expect(screen.getByText("推荐 / 通用")).toBeInTheDocument();
    const providerItems = screen.getAllByText(/OpenAI-compatible|OpenRouter|Anthropic API Key/);
    expect(providerItems[0]).toHaveTextContent("OpenAI-compatible");
  });

  it("allows manual model IDs for provider presets with suggestions", () => {
    renderWizard({
      models: {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "选择 provider family" }));
    fireEvent.click(screen.getByRole("button", { name: /Gemini API Key/ }));
    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "gemini-custom-preview" } });

    expect(screen.getByDisplayValue("gemini-custom-preview")).toBeInTheDocument();
  });

  it("applies custom endpoint family preset", () => {
    renderWizard({
      models: {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "选择 provider family" }));
    fireEvent.click(screen.getByRole("button", { name: /Ollama/ }));

    expect(screen.getByDisplayValue("http://127.0.0.1:11434/v1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/填写 Ollama 模型名/)).toBeInTheDocument();
  });

  it("runs discovery, applies a discovered candidate, and toggles advanced secret ref", async () => {
    discoverLocalModelSources.mockResolvedValue({
      ok: true,
      recommendedBaseUrl: "http://127.0.0.1:1234/v1",
      recommendedModel: "local-qwen",
      message: "ok",
      candidates: [
        {
          baseUrl: "http://127.0.0.1:1234/v1",
          ok: true,
          availableModels: ["local-qwen"],
          message: "ready",
        },
      ],
    });

    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: /自动探测/ }));
    expect(await screen.findByText("发现可用本地接口")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://127.0.0.1:1234/v1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("qwen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /http:\/\/127\.0\.0\.1:1234\/v1/ }));
    expect(screen.getByDisplayValue("local-qwen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /高级项：密钥引用名/ }));
    const secretRefInput = screen.getByDisplayValue("provider.custom.apiKey");
    fireEvent.change(secretRefInput, { target: { value: "provider.minimax.apiKey" } });
    expect(screen.getByDisplayValue("provider.minimax.apiKey")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /收起高级项/ }));
    expect(screen.queryByDisplayValue("provider.minimax.apiKey")).not.toBeInTheDocument();
  });
});

function renderWizard(overrides: { models?: Parameters<typeof ModelConfigWizard>[0]["models"]; onRefresh?: () => Promise<void>; onSaved?: (message: string) => void } = {}) {
  return render(
    <ModelConfigWizard
      models={overrides.models ?? {
        defaultProfileId: undefined,
        providerProfiles: [],
        modelProfiles: [{ id: "wizard-openai_compatible", provider: "custom", sourceType: "openai_compatible", model: "qwen", baseUrl: "http://127.0.0.1:8080/v1", agentRole: "primary_agent" }],
      }}
      secrets={[]}
      onRefresh={overrides.onRefresh ?? vi.fn().mockResolvedValue(undefined)}
      onSaved={overrides.onSaved ?? vi.fn()}
    />,
  );
}
