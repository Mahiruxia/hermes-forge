import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigWizard } from "./ModelConfigWizard";

const testModelConnection = vi.fn();
const updateModelConfig = vi.fn();
const saveSecret = vi.fn();
const setDefaultModel = vi.fn();
const setModelRole = vi.fn();
const discoverLocalModelSources = vi.fn();

beforeEach(() => {
  testModelConnection.mockReset();
  updateModelConfig.mockReset();
  saveSecret.mockReset();
  setDefaultModel.mockReset();
  setModelRole.mockReset();
  discoverLocalModelSources.mockReset();
  testModelConnection.mockResolvedValue({
    ok: true,
    sourceType: "openai_compatible",
    agentRole: "primary_agent",
    supportsTools: true,
    contextWindow: 256000,
    roleCompatibility: { chat: { ok: true, message: "ok" } },
    message: "连接成功。",
  });
  updateModelConfig.mockResolvedValue({});
  saveSecret.mockResolvedValue({});
  setDefaultModel.mockResolvedValue({ success: true, defaultModelId: "custom", models: [] });
  setModelRole.mockResolvedValue({ success: true, message: "用途已切换" });
  Object.assign(window, {
    workbenchClient: {
      testModelConnection,
      updateModelConfig,
      setDefaultModel,
      setModelRole,
      saveSecret,
      discoverLocalModelSources,
    },
  });
});

describe("ModelConfigWizard", () => {
  it("shows the compact three-entry template picker", () => {
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "自定义模型" }));

    expect(screen.getByRole("button", { name: "模型 Coding Plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "模型 API" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "自定义模型" }).length).toBeGreaterThan(0);
  });

  it("lists multi-vendor Coding Plan templates instead of only Volcengine", () => {
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "自定义模型" }));
    fireEvent.click(screen.getByRole("button", { name: "模型 Coding Plan" }));

    expect(screen.getByRole("button", { name: "腾讯云通用 Token Plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MiniMax Token Plan（国内）" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "智谱 Coding Plan（国内）" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kimi Coding Plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "百度千帆 Coding Plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "火山引擎方舟 Coding Plan" })).toBeInTheDocument();
  });

  it("saves JSON input through the existing backend draft flow", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "JSON 输入" }));
    fireEvent.change(screen.getByLabelText("JSON 输入"), {
      target: {
        value: JSON.stringify({
          provider: "custom",
          base_url: "https://api.example.com/v1",
          api: "openai",
          api_key: "sk-json",
          model: { id: "json-model", name: "JSON Model" },
        }, null, 2),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "测试并添加为默认" }));

    await waitFor(() => {
      expect(saveSecret).toHaveBeenCalledWith({ ref: "provider.custom.apiKey", plainText: "sk-json" });
      expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        model: "json-model",
      }));
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        modelRoleAssignments: expect.objectContaining({ chat: expect.any(String) }),
      }));
    });
  });

  it("uses API provider templates without hardcoding frontend metadata", async () => {
    renderWizard();

    openTemplate("模型 API", "Moonshot AI（Kimi 国内）");
    fireEvent.click(screen.getByRole("button", { name: "表单输入" }));
    fireEvent.change(screen.getByPlaceholderText("your-api-key-here"), { target: { value: "sk-kimi" } });
    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "moonshot-v1-128k" } });
    fireEvent.click(screen.getByRole("button", { name: "测试并添加为默认" }));

    await waitFor(() => {
      expect(saveSecret).toHaveBeenCalledWith({ ref: "provider.moonshot.apiKey", plainText: "sk-kimi" });
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        defaultProfileId: expect.any(String),
        modelRoleAssignments: expect.objectContaining({ chat: expect.any(String) }),
        modelProfiles: expect.arrayContaining([
          expect.objectContaining({
            sourceType: "moonshot_api_key",
            baseUrl: "https://api.moonshot.cn/v1",
            model: "moonshot-v1-128k",
          }),
        ]),
      }));
    });
  });

  it("saves Coding Plan templates to the coding_plan role", async () => {
    testModelConnection.mockResolvedValueOnce({
      ok: true,
      sourceType: "volcengine_coding_api_key",
      agentRole: "auxiliary_model",
      supportsTools: true,
      contextWindow: 256000,
      roleCompatibility: { coding_plan: { ok: true, message: "ok" } },
      message: "Coding Plan connected.",
    });
    renderWizard();

    openTemplate("模型 Coding Plan", "火山引擎方舟 Coding Plan");
    fireEvent.click(screen.getByRole("button", { name: "表单输入" }));
    fireEvent.change(screen.getByPlaceholderText("your-api-key-here"), { target: { value: "ark-coding-key" } });
    fireEvent.change(screen.getByLabelText("添加模型名称"), { target: { value: "doubao-coding-endpoint" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并同步到 Hermes" }));

    await waitFor(() => {
      expect(updateModelConfig).toHaveBeenCalledWith(expect.objectContaining({
        modelRoleAssignments: expect.objectContaining({ coding_plan: expect.any(String) }),
        modelProfiles: expect.arrayContaining([
          expect.objectContaining({
            sourceType: "volcengine_coding_api_key",
            baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
          }),
        ]),
      }));
    });
  });

  it("keeps saved model role actions wired to the backend", async () => {
    renderWizard({
      models: {
        defaultProfileId: undefined,
        roleAssignments: {},
        providerProfiles: [],
        modelProfiles: [
          { id: "kimi", name: "Kimi", provider: "custom", sourceType: "moonshot_api_key", model: "moonshot-v1-128k", baseUrl: "https://api.moonshot.cn/v1", agentRole: "primary_agent" },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "设为主模型" }));

    await waitFor(() => {
      expect(setModelRole).toHaveBeenCalledWith({ role: "chat", profileId: "kimi" });
    });
  });
});

function openTemplate(groupName: string, providerName: string) {
  fireEvent.click(screen.getByRole("button", { name: "自定义模型" }));
  fireEvent.click(screen.getByRole("button", { name: groupName }));
  fireEvent.click(screen.getByRole("button", { name: providerName }));
}

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
