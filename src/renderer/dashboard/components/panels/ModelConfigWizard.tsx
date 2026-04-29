import { useEffect, useMemo, useRef, useState } from "react";
import type { LocalModelDiscoveryResult, ModelConnectionTestResult, ModelSourceType } from "../../../../shared/types";
import { stableModelProfileId } from "../../../../shared/model-config";
import { ConnectionTestResult, noticeForTestResult } from "./model-config/ConnectionTestResult";
import { ModelConfigForm } from "./model-config/ModelConfigForm";
import { ProviderSelector } from "./model-config/ProviderSelector";
import { SavedModelList } from "./model-config/SavedModelList";
import {
  DEFAULT_MAX_CONTEXT,
  defaultSecretRefForSource,
  draftStateForNewProfile,
  draftStateForProfile,
  friendlyProfileName,
  inferSourceType,
  providerIdForSource,
  sameModelIdentity,
  sourceNeedsKey,
} from "./model-config/modelConfigUtils";
import { providerForCatalog, providerPresetsForDefinitions } from "./model-config/providerCatalog";
import type { BusyAction, OperationNotice, OverviewModels, SecretMeta } from "./model-config/types";

/**
 * Three-step model configuration wizard.
 *
 * The public props and backend calls are intentionally unchanged: this
 * component still talks to `window.workbenchClient`, while the UI is split into
 * provider selection, credentials/model setup, connection feedback, and saved
 * model cards.
 */
export function ModelConfigWizard(props: {
  models: OverviewModels;
  secrets: SecretMeta[];
  onRefresh: () => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const currentProfile = props.models.modelProfiles.find((item) => item.id === props.models.defaultProfileId) ?? props.models.modelProfiles[0];
  const providerCatalog = useMemo(() => providerPresetsForDefinitions(props.models.providers), [props.models.providers]);
  const initialDraft = draftStateForProfile(props.models, currentProfile?.id, providerCatalog);
  const [editingProfileId, setEditingProfileId] = useState<string | undefined>(currentProfile?.id);
  const [sourceType, setSourceType] = useState<ModelSourceType>(initialDraft.sourceType);
  const [baseUrl, setBaseUrl] = useState(initialDraft.baseUrl);
  const [model, setModel] = useState(initialDraft.model);
  const [secretRef, setSecretRef] = useState(initialDraft.secretRef);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [testResult, setTestResult] = useState<ModelConnectionTestResult | undefined>();
  const [discovery, setDiscovery] = useState<LocalModelDiscoveryResult | undefined>();
  const [busyAction, setBusyAction] = useState<BusyAction | undefined>();
  const [operationNotice, setOperationNotice] = useState<OperationNotice | undefined>();
  const [connectionTestPassedInSession, setConnectionTestPassedInSession] = useState(false);
  const [draftNonce, setDraftNonce] = useState(0);
  const feedbackPanelRef = useRef<HTMLDivElement | null>(null);
  const wizardTopRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef({ sourceType, baseUrl, model, secretRef, apiKey, apiSecret });

  useEffect(() => {
    const nextCurrent = props.models.modelProfiles.find((item) => item.id === editingProfileId)
      ?? props.models.modelProfiles.find((item) => item.id === props.models.defaultProfileId)
      ?? props.models.modelProfiles[0];
    const next = draftStateForProfile(props.models, nextCurrent?.id, providerCatalog);
    setEditingProfileId(nextCurrent?.id);
    setSourceType(next.sourceType);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setApiSecret("");
  }, [props.models, providerCatalog]);

  useEffect(() => {
    draftRef.current = { sourceType, baseUrl, model, secretRef, apiKey, apiSecret };
  }, [apiKey, apiSecret, baseUrl, model, secretRef, sourceType]);

  const provider = providerForCatalog(sourceType, providerCatalog);
  const effectiveSecretRef = secretRef.trim() || defaultSecretRefForSource(sourceType);
  const hasStoredSecret = props.secrets.some((item) => item.ref === effectiveSecretRef && item.exists);
  const requiresSecretInput = sourceNeedsKey(sourceType, providerCatalog);
  const hasSecretInput = sourceType === "baidu_wenxin_api_key"
    ? Boolean(apiKey.trim() && apiSecret.trim())
    : Boolean(apiKey.trim());
  const canUseSavedSecret = hasStoredSecret || hasSecretInput || !requiresSecretInput;
  const baseUrlRequired = !["oauth", "local_credentials", "external_process"].includes(provider.authModeToStore);
  const hasRequiredFields = model.trim().length > 0 && (!baseUrlRequired || baseUrl.trim().length > 0);
  const canTestConnection = hasRequiredFields && canUseSavedSecret && !busyAction;
  const canSaveModel = hasRequiredFields && canUseSavedSecret && !busyAction;
  const canSaveAsAuxiliary = hasRequiredFields && canUseSavedSecret && !busyAction && testResult && !testResult.ok;
  const currentEditingProfile = editingProfileId ? props.models.modelProfiles.find((item) => item.id === editingProfileId) : undefined;
  const pendingProviderId = providerIdForSource(sourceType);
  const pendingProfileIsCurrent = Boolean(currentEditingProfile && sameModelIdentity(currentEditingProfile, {
    provider: pendingProviderId,
    model: model.trim(),
    baseUrl: baseUrl.trim(),
  }));
  const willCreateNewProfile = !editingProfileId || !pendingProfileIsCurrent;
  const formBlockingHint = model.trim().length === 0
    ? "请先填写模型名称。"
    : baseUrlRequired && baseUrl.trim().length === 0
      ? "请先填写 Base URL。"
      : !canUseSavedSecret
        ? sourceType === "baidu_wenxin_api_key"
          ? "请填写百度 API Key 和 Secret Key，或选择已有密钥引用。"
          : "请先填写 API Key，或选择已有密钥引用。"
        : undefined;
  const modelOptions = useMemo(() => {
    const discovered = testResult?.availableModels?.length
      ? testResult.availableModels
      : discovery?.recommendedModel
        ? [discovery.recommendedModel]
        : [];
    return Array.from(new Set([...(provider.modelOptions ?? []), ...discovered, model].filter(Boolean)));
  }, [discovery?.recommendedModel, model, provider.modelOptions, testResult?.availableModels]);

  function updateSource(nextSource: ModelSourceType) {
    const next = draftStateForNewProfile(nextSource, providerCatalog);
    draftRef.current = { sourceType: next.sourceType, baseUrl: next.baseUrl, model: next.model, secretRef: next.secretRef, apiKey: "", apiSecret: "" };
    setEditingProfileId(undefined);
    setSourceType(next.sourceType);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setApiSecret("");
    setDiscovery(undefined);
    setTestResult(undefined);
    setOperationNotice(undefined);
    setConnectionTestPassedInSession(false);
  }

  function createNewProfile(nextSource: ModelSourceType = sourceType) {
    updateSource(nextSource);
    setDraftNonce((n) => n + 1);
    window.setTimeout(() => {
      wizardTopRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 0);
  }

  function editProfile(profileId: string) {
    const next = draftStateForProfile(props.models, profileId, providerCatalog);
    draftRef.current = { sourceType: next.sourceType, baseUrl: next.baseUrl, model: next.model, secretRef: next.secretRef, apiKey: "", apiSecret: "" };
    setEditingProfileId(profileId);
    setSourceType(next.sourceType);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setSecretRef(next.secretRef);
    setApiKey("");
    setApiSecret("");
    setDiscovery(undefined);
    setTestResult(undefined);
    setOperationNotice(undefined);
    setConnectionTestPassedInSession(false);
  }

  function updateBaseUrl(value: string) {
    draftRef.current.baseUrl = value;
    setBaseUrl(value);
    setTestResult(undefined);
    setOperationNotice(undefined);
    setConnectionTestPassedInSession(false);
  }

  function updateModel(value: string) {
    draftRef.current.model = value;
    setModel(value);
    setTestResult(undefined);
    setOperationNotice(undefined);
    setConnectionTestPassedInSession(false);
  }

  function updateApiKey(value: string) {
    draftRef.current.apiKey = value;
    setApiKey(value);
    setTestResult(undefined);
    setOperationNotice(undefined);
    setConnectionTestPassedInSession(false);
  }

  function updateApiSecret(value: string) {
    draftRef.current.apiSecret = value;
    setApiSecret(value);
    setTestResult(undefined);
    setOperationNotice(undefined);
    setConnectionTestPassedInSession(false);
  }

  function revealFeedbackPanel() {
    window.setTimeout(() => {
      feedbackPanelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 0);
  }

  async function discoverLocal() {
    setBusyAction("discover");
    setOperationNotice({
      tone: "info",
      title: "正在探测本地模型",
      message: "正在检查常见 localhost / WSL 可达地址，完成后会把可用地址和模型填回表单。",
    });
    revealFeedbackPanel();
    try {
      const result = await window.workbenchClient.discoverLocalModelSources();
      setDiscovery(result);
      if (result.recommendedBaseUrl) updateBaseUrl(result.recommendedBaseUrl);
      if (result.recommendedModel && !model.trim()) updateModel(result.recommendedModel);
      setOperationNotice({
        tone: result.ok ? "success" : "warning",
        title: result.ok ? "已发现可用本地接口" : "暂未发现本地接口",
        message: result.message || (result.ok ? "可以选择下方候选项继续测试。" : "请确认本地模型服务已经启动，或手动填写 Base URL 与模型名称。"),
      });
    } catch (error) {
      setOperationNotice({
        tone: "error",
        title: "自动探测没有完成",
        message: error instanceof Error ? error.message : String(error || "未知错误"),
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function runTestConnection(): Promise<ModelConnectionTestResult> {
    const ref = await ensureSecretIfNeeded(sourceType);
    const draft = draftRef.current;
    return await window.workbenchClient.testModelConnection({
      sourceType: draft.sourceType,
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      secretRef: ref,
      maxTokens: DEFAULT_MAX_CONTEXT,
    });
  }

  async function testConnection() {
    setBusyAction("test");
    setTestResult(undefined);
    setOperationNotice({
      tone: "info",
      title: "正在测试模型连接",
      message: "正在依次检查鉴权、模型可达性、最小 Chat、tool calling 和 WSL 可达性。",
    });
    revealFeedbackPanel();
    try {
      const result = await runTestConnection();
      setTestResult(result);
      setConnectionTestPassedInSession(result.ok);
      setOperationNotice(noticeForTestResult(result));
    } catch (error) {
      const failure = connectionFailureFromError(error, sourceType);
      setTestResult(failure);
      setOperationNotice(noticeForTestResult(failure));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function saveModel(asAuxiliary = false) {
    setBusyAction("save");
    revealFeedbackPanel();

    let health = testResult;

    if (!connectionTestPassedInSession && !asAuxiliary) {
      setOperationNotice({
        tone: "info",
        title: "正在测试并保存",
        message: "正在依次检查鉴权、模型可达性、最小 Chat、tool calling 和 WSL 可达性，通过后会自动保存。",
      });
      try {
        health = await runTestConnection();
        setTestResult(health);
        setConnectionTestPassedInSession(health.ok);
        if (!health.ok) {
          setOperationNotice(noticeForTestResult(health));
          setBusyAction(undefined);
          return;
        }
      } catch (error) {
        const failure = connectionFailureFromError(error, sourceType);
        setTestResult(failure);
        setOperationNotice(noticeForTestResult(failure));
        setBusyAction(undefined);
        return;
      }
    }

    setOperationNotice({
      tone: "info",
      title: asAuxiliary ? "正在保存为辅助模型" : "正在保存并测试",
      message: asAuxiliary ? "以辅助模型身份保存，不强制要求通过全部连接测试。" : "会先保存密钥，再复检模型能力，最后写入模型配置。",
    });
    try {
      const ref = await ensureSecretIfNeeded(sourceType);
      const draft = draftRef.current;
      if (!health) {
        health = await window.workbenchClient.testModelConnection({
          sourceType: draft.sourceType,
          model: draft.model.trim(),
          baseUrl: draft.baseUrl.trim(),
          secretRef: ref,
          maxTokens: DEFAULT_MAX_CONTEXT,
        });
        setTestResult(health);
      }

      const currentSourceType = draft.sourceType;
      const currentProvider = providerForCatalog(currentSourceType, providerCatalog);
      const nextProviderId = providerIdForSource(currentSourceType);
      const savedModel = health.model?.trim() || draft.model.trim();
      const profileId = editingProfileId && sameModelIdentity(currentEditingProfile, {
        provider: nextProviderId,
        model: savedModel,
        baseUrl: draft.baseUrl.trim(),
      })
        ? editingProfileId
        : buildProfileId({
          provider: nextProviderId,
          model: savedModel,
          baseUrl: draft.baseUrl.trim(),
          existingProfiles: props.models.modelProfiles,
        });
      const nextProfile = {
        id: profileId,
        name: friendlyProfileName(currentSourceType, savedModel, providerCatalog),
        provider: nextProviderId,
        sourceType: currentSourceType,
        authMode: currentProvider.authModeToStore,
        model: savedModel,
        ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
        ...(ref ? { secretRef: ref } : {}),
        maxTokens: health.contextWindow ?? DEFAULT_MAX_CONTEXT,
        ...(health.agentRole ? { agentRole: health.agentRole } : {}),
        ...(typeof health.supportsTools === "boolean" ? { supportsTools: health.supportsTools } : {}),
        ...(typeof health.supportsVision === "boolean" ? { supportsVision: health.supportsVision } : {}),
        lastHealthCheckAt: new Date().toISOString(),
        lastHealthStatus: health.ok ? "ready" : "warning",
        lastHealthSummary: health.message,
        ...(currentProvider.settingsConfig ? { settingsConfig: currentProvider.settingsConfig } : {}),
      };
      const nextProfiles = [
        ...props.models.modelProfiles.filter((item) => item.id !== profileId),
        nextProfile,
      ];
      const roleAssignments = asAuxiliary
        ? props.models.roleAssignments ?? {}
        : {
            ...(props.models.roleAssignments ?? {}),
            ...(currentProvider.roleCapabilities.includes("coding_plan") && health.roleCompatibility?.coding_plan?.ok ? { coding_plan: profileId } : {}),
            ...(health.roleCompatibility?.chat?.ok || health.agentRole === "primary_agent" ? { chat: profileId } : {}),
          };
      const nextDefaultProfileId = asAuxiliary
        ? props.models.defaultProfileId
        : (roleAssignments.chat ?? props.models.defaultProfileId);
      await window.workbenchClient.updateModelConfig({
        defaultProfileId: nextDefaultProfileId,
        modelRoleAssignments: roleAssignments,
        modelProfiles: nextProfiles,
      });
      await props.onRefresh();
      setEditingProfileId(profileId);
      const savedMessage = asAuxiliary
        ? "模型已保存为辅助模型"
        : health.agentRole === "primary_agent"
          ? "模型已保存，并设为默认"
          : "模型已保存为辅助/待确认来源，未自动设为默认";
      setOperationNotice({
        tone: asAuxiliary ? "info" : health.agentRole === "primary_agent" ? "success" : "warning",
        title: asAuxiliary ? "已保存为辅助模型" : health.agentRole === "primary_agent" ? "保存完成" : "已保存，暂未设为默认",
        message: savedMessage,
      });
      props.onSaved(savedMessage);
    } catch (error) {
      const failure = connectionFailureFromError(error, sourceType);
      setTestResult(failure);
      setOperationNotice({
        tone: "error",
        title: "保存没有完成",
        message: failure.recommendedFix ?? failure.message,
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function setDefaultProfile(profileId: string) {
    const profile = props.models.modelProfiles.find((item) => item.id === profileId);
    if (!profileId?.trim()) {
      setTestResult(connectionFailure("这个模型缺少稳定 ID，无法设为默认。请先重新保存一次模型配置。", "点击编辑并保存模型，系统会补齐稳定 ID。", "legacy"));
      return;
    }
    if (!profile) {
      setTestResult(connectionFailure("模型列表里没有找到这个配置，无法设为默认。", "请重新检测配置或重新导入旧配置。", "legacy"));
      return;
    }
    const result = await window.workbenchClient.setDefaultModel(profileId);
    if (!result.success) {
      setTestResult(connectionFailure(
        result.message ?? "默认模型切换失败。",
        result.code === "HERMES_SYNC_FAILED" ? "配置已保存但 Hermes 同步失败，请重新检测环境或重启 Gateway。" : "请重新检测配置后再试。",
        profile.sourceType ?? inferSourceType(profile.provider, profile.baseUrl),
        profileId,
      ));
      return;
    }
    await props.onRefresh();
    props.onSaved(result.message ?? "默认模型已切换");
  }

  async function setModelRole(role: "chat" | "coding_plan", profileId: string) {
    const result = await window.workbenchClient.setModelRole({ role, profileId });
    if (!result.success) {
      const profile = props.models.modelProfiles.find((item) => item.id === profileId);
      setTestResult(connectionFailure(
        result.message ?? "模型用途切换失败。",
        "请确认这个 Provider 已声明运行态兼容，并重新测试连接。",
        profile?.sourceType ?? "legacy",
        profileId,
      ));
      return;
    }
    await props.onRefresh();
    props.onSaved(result.message ?? (role === "coding_plan" ? "Coding Plan 模型已切换" : "主模型已切换"));
  }

  async function deleteProfile(profileId: string) {
    const nextProfiles = props.models.modelProfiles.filter((item) => item.id !== profileId);
    await window.workbenchClient.updateModelConfig({
      defaultProfileId: props.models.defaultProfileId === profileId ? nextProfiles[0]?.id : props.models.defaultProfileId,
      modelProfiles: nextProfiles,
    });
    await props.onRefresh();
    if (editingProfileId === profileId) {
      const fallback = nextProfiles.find((item) => item.id === props.models.defaultProfileId) ?? nextProfiles[0];
      if (fallback) editProfile(fallback.id);
      else createNewProfile("openai_compatible");
    }
    props.onSaved("模型已删除");
  }

  async function ensureSecretIfNeeded(targetSource: ModelSourceType) {
    const draft = draftRef.current;
    const nextRef = draft.secretRef.trim() || defaultSecretRefForSource(targetSource);
    if (targetSource === "baidu_wenxin_api_key") {
      const key = draft.apiKey.trim();
      const secret = draft.apiSecret.trim();
      if (key && secret) {
        await window.workbenchClient.saveSecret({ ref: nextRef, plainText: JSON.stringify({ apiKey: key, secretKey: secret }) });
        setSecretRef(nextRef);
        return nextRef;
      }
    } else if (draft.apiKey.trim()) {
      await window.workbenchClient.saveSecret({ ref: nextRef, plainText: draft.apiKey.trim() });
      setSecretRef(nextRef);
      return nextRef;
    }
    if (!sourceNeedsKey(targetSource, providerCatalog) && !hasStoredSecret) return undefined;
    return nextRef || undefined;
  }

  return (
    <div ref={wizardTopRef} className="mx-auto max-w-3xl space-y-5">
      <ProviderSelector sourceType={sourceType} models={props.models} secrets={props.secrets} providers={providerCatalog} onChange={updateSource} />
      <ModelConfigForm
        key={`${sourceType}-${editingProfileId ?? "new"}-${draftNonce}`}
        draft={{
          sourceType,
          provider,
          baseUrl,
          model,
          apiKey,
          apiSecret,
          secretRef,
          hasStoredSecret,
          modelOptions,
          discovery,
          testResult,
        }}
        busyAction={busyAction}
        canTestConnection={canTestConnection}
        canSaveModel={canSaveModel}
        canSaveAsAuxiliary={canSaveAsAuxiliary}
        testPassed={connectionTestPassedInSession}
        willCreateNewProfile={willCreateNewProfile}
        formBlockingHint={formBlockingHint}
        onModelChange={updateModel}
        onApiKeyChange={updateApiKey}
        onApiSecretChange={updateApiSecret}
        onBaseUrlChange={updateBaseUrl}
        onSecretRefChange={setSecretRef}
        onTest={testConnection}
        onSave={saveModel}
        onSaveAsAuxiliary={() => saveModel(true)}
        onDiscover={discoverLocal}
        onCreateDraft={() => createNewProfile(sourceType)}
        onApplyDiscovery={(candidate) => {
          updateBaseUrl(candidate.baseUrl);
          if (candidate.availableModels[0]) updateModel(candidate.availableModels[0]);
        }}
      />

      <div ref={feedbackPanelRef}>
        <ConnectionTestResult busyAction={busyAction} notice={operationNotice} testResult={testResult} formBlockingHint={formBlockingHint} />
      </div>

      <details className="overflow-hidden rounded-[24px] bg-white shadow-[0_18px_60px_rgba(15,23,42,0.045)] ring-1 ring-slate-200/55">
        <summary className="cursor-pointer px-5 py-4 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-50/70">已保存模型</summary>
        <SavedModelList
          models={props.models}
          secrets={props.secrets}
          providers={providerCatalog}
          editingProfileId={editingProfileId}
          onCreate={() => createNewProfile(sourceType)}
          onEdit={editProfile}
          onDelete={deleteProfile}
          onSetDefault={setDefaultProfile}
          onSetRole={setModelRole}
        />
      </details>
    </div>
  );
}

function connectionFailureFromError(error: unknown, sourceType: ModelSourceType): ModelConnectionTestResult {
  const message = error instanceof Error ? error.message : String(error || "未知错误");
  return connectionFailure("模型配置操作没有完成。", message, sourceType);
}

function connectionFailure(message: string, recommendedFix: string, sourceType: ModelSourceType, profileId?: string): ModelConnectionTestResult {
  return {
    ok: false,
    profileId,
    sourceType,
    message,
    failureCategory: "unknown",
    recommendedFix,
    healthChecks: [
      {
        id: "agent_capability",
        label: "agent_capability",
        ok: false,
        message: "测试或保存过程中发生异常。",
        detail: recommendedFix,
      },
    ],
  };
}

function buildProfileId(input: { provider: ReturnType<typeof providerIdForSource>; model: string; baseUrl?: string; existingProfiles: OverviewModels["modelProfiles"] }) {
  const base = stableModelProfileId({ provider: input.provider, model: input.model, baseUrl: input.baseUrl });
  if (!input.existingProfiles.some((item) => item.id === base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!input.existingProfiles.some((item) => item.id === candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
