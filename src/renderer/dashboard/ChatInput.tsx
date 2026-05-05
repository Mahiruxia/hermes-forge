import { Command, DownloadCloud, Gauge, Mic, MicOff, Paperclip, Plus, Send, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClipboardEvent, DragEvent, ReactNode } from "react";
import type { EngineEvent, EngineUpdateStatus, ModelProfile, SessionAgentInsightUsage } from "../../shared/types";
import { useAppStore } from "../store";
import { cn } from "./DashboardPrimitives";
import { buildPreflightState, preflightChipsForUser, preflightDetailForUser, preflightSummaryForUser } from "./permissionModel";

type FixTarget = "model" | "hermes" | "health" | "diagnostics" | "workspace";

export function ChatInput(props: {
  onStartTask: () => void;
  onCancelTask: () => void;
  onPickWorkspace?: () => void;
  onCreateSession?: () => void;
  onClearSession?: () => void;
  onRestoreSnapshot: () => void;
  onOpenFix?: (target: FixTarget) => void;
  canStart: boolean;
  sendBlockReason?: string;
  sendBlockTarget?: FixTarget;
  latestSnapshotAvailable: boolean;
  locked: boolean;
}) {
  const store = useAppStore();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submittingRef = useRef(false);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [isImportingAttachment, setIsImportingAttachment] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const listeningRef = useRef(false);
  const stoppingVoiceRef = useRef(false);
  const voiceRestartTimerRef = useRef<number | null>(null);
  const voiceBaseInputRef = useRef("");
  const voiceFinalResultsRef = useRef<Record<number, string>>({});
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const preflight = buildPreflightState({
    runtimeConfig: store.runtimeConfig,
    events: store.events,
    locked: props.locked,
    overview: store.permissionOverview,
  });
  const permissions = store.runtimeConfig?.enginePermissions?.hermes;
  const permissionsLabel = permissions
    ? `读${permissions.workspaceRead === false ? "关" : "开"} 写${permissions.fileWrite === false ? "关" : "开"} 命令${permissions.commandRun === false ? "关" : "开"}`
    : "权限默认开启";
  const currentModelProfile = store.runtimeConfig?.modelProfiles.find((profile) => profile.id === store.runtimeConfig?.defaultModelProfileId)
    ?? store.runtimeConfig?.modelProfiles[0];
  const currentModelLabel = currentModelProfile?.model || currentModelProfile?.name || currentModelProfile?.id || "未配置模型";
  const currentContextWindow = resolveComposerContextWindow(store, currentModelProfile, currentModelLabel);
  const contextMeter = useMemo(
    () => buildContextMeter({
      activeSessionId: store.activeSessionId,
      userInput: store.userInput,
      projections: store.taskRunProjectionsById,
      runOrder: store.taskRunOrderBySession,
      taskEventsByRunId: store.taskEventsByRunId,
      sessionInsightUsage: store.sessionAgentInsight?.usage,
      conversationMessages: store.conversationMessages,
      contextWindow: currentContextWindow,
      attachmentCount: store.attachments.length,
    }),
    [
      currentContextWindow,
      store.activeSessionId,
      store.attachments.length,
      store.conversationMessages,
      store.sessionAgentInsight?.usage,
      store.taskEventsByRunId,
      store.taskRunOrderBySession,
      store.taskRunProjectionsById,
      store.userInput,
    ],
  );
  const statusTone = props.sendBlockTarget ? "action" : props.sendBlockReason ? "blocked" : "ready";
  const statusText = props.sendBlockReason
    ? props.sendBlockReason
    : `${currentModelLabel} · ${store.workspacePath ? shortPath(store.workspacePath) : "无工作区"} · ${permissionsLabel}${props.locked ? " · 工作区占用中" : ""}`;
  const hermesUpdate = store.hermesStatus?.update;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.floor(window.innerHeight * 0.24))}px`;
  }, [store.userInput]);

  useEffect(() => {
    return () => {
      listeningRef.current = false;
      stoppingVoiceRef.current = true;
      if (voiceRestartTimerRef.current) {
        window.clearTimeout(voiceRestartTimerRef.current);
        voiceRestartTimerRef.current = null;
      }
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!plusMenuOpen) return undefined;
    function handleClickOutside(event: MouseEvent) {
      if (plusMenuRef.current && !plusMenuRef.current.contains(event.target as Node)) {
        setPlusMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [plusMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    function handleClickOutside(event: MouseEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelMenuOpen]);

  async function requestMicrophonePermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch (error) {
      console.error("麦克风权限请求失败:", error);
      return false;
    }
  }

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
  }

  function initRecognition() {
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      store.error("语音识别不可用", "当前环境不支持语音输入");
      return null;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "zh-CN";
    recognition.maxAlternatives = 1;
    return recognition;
  }

  async function toggleVoiceInput() {
    if (listeningRef.current || isListening) {
      stopVoiceInput();
      return;
    }
    if (!getSpeechRecognitionCtor()) {
      store.error("语音识别不可用", "当前环境不支持语音输入");
      return;
    }
    const hasPermission = await requestMicrophonePermission();
    if (!hasPermission) {
      store.error("麦克风权限被拒绝", "请在系统设置中允许麦克风权限");
      return;
    }
    setPlusMenuOpen(false);
    startVoiceInput();
  }

  function startVoiceInput() {
    if (recognitionRef.current) return;
    const recognition = initRecognition();
    if (!recognition) return;
    listeningRef.current = true;
    stoppingVoiceRef.current = false;
    voiceBaseInputRef.current = useAppStore.getState().userInput.trim();
    voiceFinalResultsRef.current = {};
    setIsListening(true);

    recognition.onstart = () => {
      listeningRef.current = true;
      setIsListening(true);
      store.info("语音输入已启动", "正在监听你的语音");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript?.trim() ?? "";
        if (!transcript) continue;
        if (result.isFinal) {
          voiceFinalResultsRef.current[i] = transcript;
        } else {
          interimTranscript = joinVoiceText(interimTranscript, transcript);
        }
      }
      const finalTranscript = Object.keys(voiceFinalResultsRef.current)
        .map(Number)
        .sort((left, right) => left - right)
        .map((index) => voiceFinalResultsRef.current[index])
        .join(" ");
      useAppStore.getState().setUserInput(joinVoiceText(voiceBaseInputRef.current, finalTranscript, interimTranscript));
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "aborted" && stoppingVoiceRef.current) return;
      listeningRef.current = false;
      stoppingVoiceRef.current = false;
      setIsListening(false);
      recognitionRef.current = null;
      if (event.error === "not-allowed") {
        store.error("语音输入失败", "麦克风权限未授予");
      } else if (event.error === "audio-capture") {
        store.error("麦克风不可用", "未检测到麦克风设备");
      } else if (event.error === "no-speech") {
        store.warning("没有听到语音", "可以再点一次麦克风重新开始");
      } else {
        store.error("语音识别错误", `错误类型：${event.error}`);
      }
    };

    recognition.onend = () => {
      if (!listeningRef.current || stoppingVoiceRef.current) {
        stoppingVoiceRef.current = false;
        recognitionRef.current = null;
        setIsListening(false);
        return;
      }
      voiceRestartTimerRef.current = window.setTimeout(() => {
        if (!listeningRef.current || recognitionRef.current !== recognition) return;
        try {
          recognition.start();
        } catch (error) {
          listeningRef.current = false;
          recognitionRef.current = null;
          setIsListening(false);
          store.error("语音输入已停止", error instanceof Error ? error.message : "无法重新开始监听");
        }
      }, 180);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (error) {
      listeningRef.current = false;
      recognitionRef.current = null;
      setIsListening(false);
      store.error("语音输入启动失败", error instanceof Error ? error.message : "无法开始监听");
    }
  }

  function stopVoiceInput() {
    const wasListening = listeningRef.current || Boolean(recognitionRef.current);
    listeningRef.current = false;
    stoppingVoiceRef.current = true;
    if (voiceRestartTimerRef.current) {
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = null;
    }
    setIsListening(false);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // The recognizer may already be stopped by Chromium.
      }
      recognitionRef.current = null;
    }
    if (wasListening) store.info("语音输入已停止", "已完成语音转文字");
  }

  function handleSubmit() {
    if (store.userInput.trim().startsWith("/")) {
      void dispatchSlashCommand(store.userInput.trim());
      return;
    }
    if (preflight.blocked) {
      store.error(preflight.summary, preflight.block?.fixHint ?? preflight.detail);
      return;
    }
    if (!props.canStart || submittingRef.current) return;
    submittingRef.current = true;
    try {
      props.onStartTask();
      setPlusMenuOpen(false);
    } finally {
      window.setTimeout(() => {
        submittingRef.current = false;
      }, 0);
    }
  }

  async function pickAttachments() {
    if (!window.workbenchClient || typeof window.workbenchClient.pickSessionAttachments !== "function") {
      store.warning("附件不可用", "客户端未就绪，无法选择附件");
      return;
    }
    const sessionPath = currentSessionPath(store.sessionFilesPath, store.activeSessionId);
    const attachments = await window.workbenchClient.pickSessionAttachments(sessionPath).catch((error: unknown) => {
      store.pushEvent({
        taskRunId: "attachment",
        workSessionId: store.activeSessionId,
        sessionId: "attachment",
        engineId: "hermes",
        event: {
          type: "status",
          level: "error",
          message: error instanceof Error ? error.message : "附件选择失败。",
          at: new Date().toISOString(),
        },
      });
      return [];
    });
    if (attachments.length) store.addAttachments(attachments);
    setPlusMenuOpen(false);
  }

  async function importDroppedAttachments(filePaths: string[]) {
    if (!window.workbenchClient || typeof window.workbenchClient.importSessionAttachments !== "function") {
      store.warning("拖拽上传不可用", "客户端未就绪，无法导入附件");
      return;
    }
    if (store.runningTaskRunId) {
      store.warning("任务运行中", "请等待当前 Hermes 任务结束后再添加附件");
      return;
    }
    const uniquePaths = Array.from(new Set(filePaths.filter(Boolean))).slice(0, 12);
    if (!uniquePaths.length) {
      store.warning("没有可用文件路径", "请从资源管理器拖入本机文件或图片");
      return;
    }
    setIsImportingAttachment(true);
    try {
      const attachments = await window.workbenchClient.importSessionAttachments(
        currentSessionPath(store.sessionFilesPath, store.activeSessionId),
        uniquePaths,
      );
      if (attachments.length) {
        store.addAttachments(attachments);
        store.success("附件已添加", `已导入 ${attachments.length} 个文件，可直接发送给 Hermes`);
      } else {
        store.warning("未导入附件", "拖入的内容不是可读取的文件，文件夹暂不作为附件上传");
      }
    } catch (error) {
      store.error("附件导入失败", error instanceof Error ? error.message : "拖拽上传失败");
    } finally {
      setIsImportingAttachment(false);
    }
  }

  async function importClipboardImage() {
    if (!window.workbenchClient || typeof window.workbenchClient.importClipboardImageAttachment !== "function") {
      store.warning("剪贴板图片不可用", "客户端未就绪，无法导入剪贴板图片");
      return;
    }
    if (store.runningTaskRunId) {
      store.warning("任务运行中", "请等待当前 Hermes 任务结束后再添加图片");
      return;
    }
    setIsImportingAttachment(true);
    try {
      const attachments = await window.workbenchClient.importClipboardImageAttachment(
        currentSessionPath(store.sessionFilesPath, store.activeSessionId),
      );
      if (attachments.length) {
        store.addAttachments(attachments);
        store.success("图片已添加", "已从剪贴板导入图片，可直接发送给 Hermes");
      }
    } catch (error) {
      store.error("剪贴板图片导入失败", error instanceof Error ? error.message : "无法从剪贴板导入图片");
    } finally {
      setIsImportingAttachment(false);
    }
  }

  async function switchDefaultModel(profileId: string) {
    if (!store.runtimeConfig) {
      store.error("切换失败", "运行时配置未加载");
      return;
    }
    const target = store.runtimeConfig.modelProfiles.find((profile) => profile.id === profileId);
    if (!target) {
      store.warning("模型不存在", "找不到要切换的模型");
      return;
    }
    try {
      const nextConfig = { ...store.runtimeConfig, defaultModelProfileId: profileId };
      const saved = await window.workbenchClient.saveRuntimeConfig(nextConfig);
      store.setRuntimeConfig(saved);
      store.success("模型已切换", `当前使用：${target.name ?? target.model}`);
      setModelMenuOpen(false);
    } catch (error) {
      store.error("切换失败", error instanceof Error ? error.message : "无法保存模型配置");
    }
  }

  function handleAttachmentDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingAttachment(true);
  }

  function handleAttachmentDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = store.runningTaskRunId ? "none" : "copy";
    setIsDraggingAttachment(true);
  }

  function handleAttachmentDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDraggingAttachment(false);
  }

  function handleAttachmentDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingAttachment(false);
    const filePaths = Array.from(event.dataTransfer.files)
      .map((file) => file.path)
      .filter((filePath): filePath is string => Boolean(filePath));
    void importDroppedAttachments(filePaths);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const types = Array.from(event.clipboardData.items ?? []);
    if (!types.some((item) => item.type.startsWith("image/"))) {
      return;
    }
    event.preventDefault();
    void importClipboardImage();
  }

  const commandQuery = store.userInput.startsWith("/") ? store.userInput.trim().toLowerCase() : "";
  const commands = useMemo(() => {
    if (!commandQuery) return [];
    return (store.webUiOverview?.slashCommands ?? []).filter((command) => command.name.toLowerCase().startsWith(commandQuery)).slice(0, 8);
  }, [commandQuery, store.webUiOverview?.slashCommands]);

  async function dispatchSlashCommand(raw: string) {
    const [name, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    if (name === "/help") {
      store.upsertClarifyCard({ id: `help-${Date.now()}`, question: "可用命令：/help /clear /compact /model /workspace /new /usage /theme", status: "pending", createdAt: new Date().toISOString() });
      store.setUserInput("");
      return;
    }
    if (name === "/clear") {
      props.onClearSession?.();
      store.setUserInput("");
      return;
    }
    if (name === "/new") {
      props.onCreateSession?.();
      store.setUserInput("");
      return;
    }
    if (name === "/usage") {
      void window.workbenchClient.saveWebUiSettings({ showUsage: !store.webUiOverview?.settings.showUsage }).then((settings) => {
        store.setWebUiOverview(store.webUiOverview ? { ...store.webUiOverview, settings } : undefined);
      });
      store.setUserInput("");
      return;
    }
    if (name === "/theme") {
      const theme = (["green-light", "light", "slate", "oled"].includes(arg) ? arg : "green-light") as "green-light" | "light" | "slate" | "oled";
      const settings = await window.workbenchClient.saveWebUiSettings({ theme });
      store.setWebUiOverview(store.webUiOverview ? { ...store.webUiOverview, settings } : {
        settings,
        projects: [],
        spaces: [],
        skills: [],
        memory: [],
        crons: [],
        profiles: [],
        slashCommands: [],
      });
      store.setUserInput("");
      return;
    }
    if (name === "/workspace") {
      const match = store.webUiOverview?.spaces.find((space) => space.name === arg || space.path === arg);
      if (match) store.setWorkspacePath(match.path);
      else props.onPickWorkspace?.();
      store.setUserInput("");
      return;
    }
    if (name === "/model") {
      if (!arg) {
        props.onOpenFix?.("model");
        store.info("模型设置入口已打开", "请在模型提供商里测试并保存默认模型。");
        store.setUserInput("");
        return;
      }
      const profiles = store.runtimeConfig?.modelProfiles ?? [];
      const matchedProfile = profiles.find(
        (profile) => profile.id.toLowerCase() === arg.toLowerCase() || (profile.name ?? profile.id).toLowerCase() === arg.toLowerCase(),
      );
      if (matchedProfile) {
        if (!store.runtimeConfig) {
          store.error("配置错误", "运行时配置未加载");
          store.setUserInput("");
          return;
        }
        const updatedConfig = { ...store.runtimeConfig, defaultModelProfileId: matchedProfile.id };
        void window.workbenchClient.saveRuntimeConfig(updatedConfig).then((config) => {
          store.setRuntimeConfig(config);
          store.success("模型已切换", `当前使用：${matchedProfile.name ?? matchedProfile.id}`);
        }).catch(() => {
          store.error("切换失败", "无法保存模型配置");
        });
      } else {
        const availableModels = profiles.map((profile) => profile.name ?? profile.id).join(", ");
        store.warning("模型不存在", `未找到模型 "${arg}"。可用模型：${availableModels || "无"}`);
      }
      store.setUserInput("");
      return;
    }
    if (name === "/compact") {
      const sessionMessages = store.conversationMessages.filter((message) => message.sessionId === store.activeSessionId);
      if (sessionMessages.length <= 2) {
        store.info("无需压缩", "当前会话消息较少，无需压缩。");
        store.setUserInput("");
        return;
      }
      const compactedSummary = compactMessages(sessionMessages, arg);
      store.pushSessionMessage({
        id: `compact-${Date.now()}`,
        sessionId: store.activeSessionId || "",
        role: "system",
        content: `上下文已压缩。${compactedSummary}`,
        status: "complete",
        createdAt: new Date().toISOString(),
        visibleInChat: true,
      });
      store.setUserInput(arg ? `请基于压缩后的上下文继续，重点关注：${arg}` : "请基于压缩后的上下文继续对话。");
      store.success("上下文已压缩", `保留了 ${sessionMessages.length} 条消息的关键信息`);
      return;
    }
    store.warning("未知命令", `未知命令：${name}`);
    store.setUserInput("");
  }

  function applyCommand(name: string) {
    void dispatchSlashCommand(name);
  }

  function fillInput(prefix: string) {
    const nextValue = store.userInput.trim().startsWith(prefix) ? store.userInput : `${prefix}${store.userInput}`.trimStart();
    store.setUserInput(nextValue);
    setPlusMenuOpen(false);
    textareaRef.current?.focus();
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pb-5 pt-4 2xl:max-w-[1240px]" data-testid="chat-input-shell">
      <div className="relative">
        {commands.length ? (
          <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-full overflow-hidden rounded-2xl border border-[var(--hermes-card-border)] bg-white shadow-[0_18px_45px_rgba(15,23,42,0.12)]">
            {commands.map((command, index) => (
              <button
                key={command.name}
                className={cn("flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[12px]", index === commandIndex ? "bg-[var(--hermes-primary-soft)] text-[var(--hermes-primary)]" : "text-slate-600 hover:bg-[var(--hermes-primary-soft)]")}
                onMouseEnter={() => setCommandIndex(index)}
                onClick={() => applyCommand(command.name)}
                type="button"
              >
                <span className="font-semibold">{command.name}</span>
                <span className="min-w-0 flex-1 truncate text-slate-400">{command.description}</span>
                <span className="text-[11px] text-slate-400">{command.usage}</span>
              </button>
            ))}
          </div>
        ) : null}

        {hermesUpdate?.updateAvailable ? (
          <HermesUpdateBanner update={hermesUpdate} onOpenSettings={() => props.onOpenFix?.("hermes")} />
        ) : null}
        <div
          className={cn(
            "hermes-composer-card relative overflow-visible rounded-[28px] border border-white/80 bg-white/85 shadow-[0_10px_34px_rgba(15,23,42,0.045)] ring-1 ring-slate-900/[0.03] backdrop-blur-xl focus-within:hermes-purple-focus",
            isDraggingAttachment && "ring-2 ring-[var(--hermes-primary-border)]",
          )}
          onDragEnter={handleAttachmentDragEnter}
          onDragOver={handleAttachmentDragOver}
          onDragLeave={handleAttachmentDragLeave}
          onDrop={handleAttachmentDrop}
        >
          {isDraggingAttachment ? (
            <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-[28px] bg-slate-50/90">
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-3 text-center shadow-sm">
                <p className="text-sm font-semibold text-slate-800">{store.runningTaskRunId ? "当前任务运行中" : "松开即可添加附件"}</p>
                <p className="mt-1 text-xs text-slate-500">{store.runningTaskRunId ? "请等 Hermes 完成后再上传文件" : "支持图片和常见文档，最多一次 12 个"}</p>
              </div>
            </div>
          ) : null}

          <textarea
            aria-label="给 Hermes 发送消息"
            ref={textareaRef}
            value={store.userInput}
            onChange={(event) => store.setUserInput(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (commands.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setCommandIndex((current) => {
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  return (current + delta + commands.length) % commands.length;
                });
                return;
              }
              if (commands.length && event.key === "Tab") {
                event.preventDefault();
                applyCommand(commands[commandIndex]?.name ?? commands[0].name);
                return;
              }
              if (commands.length && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                applyCommand(commands[commandIndex]?.name ?? commands[0].name);
                return;
              }
              const sendKey = store.webUiOverview?.settings.sendKey ?? "enter";
              const wantsSend = sendKey === "mod-enter" ? (event.metaKey || event.ctrlKey) : !event.shiftKey;
              if (event.key === "Enter" && wantsSend && !event.nativeEvent.isComposing) {
                event.preventDefault();
                handleSubmit();
              }
            }}
            className="max-h-[24vh] min-h-[46px] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[15px] leading-6 text-slate-800 outline-none placeholder:text-slate-400"
            placeholder="写给 Hermes…"
          />

          <div className="flex items-center justify-between gap-2.5 px-3.5 pb-2.5 pt-0">
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative" ref={plusMenuRef}>
                <button
                  className="grid h-9 w-9 place-items-center rounded-full border border-[var(--hermes-primary-border)] text-[var(--hermes-primary)] transition hover:bg-[var(--hermes-primary-soft)]"
                  onClick={() => {
                    if (isListening) {
                      stopVoiceInput();
                      return;
                    }
                    setPlusMenuOpen((value) => !value);
                  }}
                  aria-label={isListening ? "停止语音输入" : "打开更多输入入口"}
                  title={isListening ? "停止语音输入" : "打开更多输入入口"}
                  type="button"
                >
                  {isListening ? <MicOff size={16} /> : <Plus size={16} />}
                </button>

                {plusMenuOpen ? (
                  <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 w-56 overflow-hidden rounded-2xl border border-[var(--hermes-card-border)] bg-white p-1.5 shadow-[0_18px_45px_rgba(15,23,42,0.12)]">
                    <MenuItem icon={Paperclip} label={isImportingAttachment ? "正在导入附件" : "附件"} onClick={() => void pickAttachments()} disabled={Boolean(store.runningTaskRunId) || isImportingAttachment} />
                    <MenuItem icon={isListening ? MicOff : Mic} label={isListening ? "停止语音输入" : "语音输入"} onClick={() => void toggleVoiceInput()} />
                    <MenuItem icon={Plus} label="@ 提及" onClick={() => fillInput("@Hermes ")} />
                    <MenuItem icon={Command} label="插入命令" onClick={() => fillInput("/")} />
                  </div>
                ) : null}
              </div>

              <button
                className="grid h-9 w-9 place-items-center rounded-full border border-[var(--hermes-primary-border)] text-[var(--hermes-primary)] transition hover:bg-[var(--hermes-primary-soft)]"
                onClick={() => void pickAttachments()}
                aria-label="添加附件"
                title="添加附件"
                type="button"
                disabled={Boolean(store.runningTaskRunId) || isImportingAttachment}
              >
                <Paperclip size={16} />
              </button>

              <div className="relative" ref={modelMenuRef}>
                <button
                  className="inline-flex h-9 max-w-[176px] items-center rounded-full border border-[var(--hermes-primary-border)] bg-[var(--hermes-primary-soft)] px-3 text-[12px] font-medium text-[var(--hermes-primary)] transition hover:bg-white"
                  onClick={() => setModelMenuOpen((value) => !value)}
                  title={currentModelLabel}
                  type="button"
                >
                  <span className="truncate">{currentModelLabel}</span>
                </button>
                {modelMenuOpen ? (
                  <div className="absolute bottom-[calc(100%+10px)] left-0 z-20 max-h-72 w-72 overflow-auto rounded-2xl border border-[var(--hermes-card-border)] bg-white p-1.5 shadow-[0_18px_45px_rgba(15,23,42,0.12)]">
                    {(store.runtimeConfig?.modelProfiles ?? []).length ? (
                      (store.runtimeConfig?.modelProfiles ?? []).map((profile) => {
                        const active = profile.id === store.runtimeConfig?.defaultModelProfileId || (!store.runtimeConfig?.defaultModelProfileId && profile.id === currentModelProfile?.id);
                        return (
                          <button
                            key={profile.id}
                            className={cn("flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left text-[12px] transition", active ? "bg-[var(--hermes-primary-soft)] text-[var(--hermes-primary)]" : "text-slate-600 hover:bg-slate-50")}
                            onClick={() => void switchDefaultModel(profile.id)}
                            type="button"
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-semibold">{profile.name ?? profile.model}</span>
                              <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-400">{profile.model}</span>
                            </span>
                            {active ? <span className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold text-[var(--hermes-primary)]">默认</span> : null}
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-3 py-3 text-[12px] text-slate-500">还没有已保存模型</div>
                    )}
                    <button
                      className="mt-1 flex w-full items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
                      onClick={() => {
                        props.onOpenFix?.("model");
                        setModelMenuOpen(false);
                      }}
                      type="button"
                    >
                      打开模型设置
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <ContextMeterPill meter={contextMeter} />
              {store.runningTaskRunId ? (
                <button
                  className="grid h-9 w-9 place-items-center rounded-full border border-rose-200 bg-rose-50 text-rose-600 transition hover:bg-rose-100"
                  onClick={props.onCancelTask}
                  aria-label="停止 Hermes"
                  type="button"
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  className="grid h-9 w-9 place-items-center rounded-full bg-[var(--hermes-primary)] text-white shadow-[0_10px_24px_rgba(91,77,255,0.24)] transition hover:bg-[var(--hermes-primary-strong)] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                  aria-label="发送"
                  title={props.sendBlockReason ?? "发送"}
                  onClick={handleSubmit}
                  disabled={!props.canStart || preflight.blocked}
                  type="button"
                >
                  <Send size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-1.5 flex items-start justify-between gap-3 px-1 text-[10px] leading-4">
          <button
            className={cn(
              "min-w-0 shrink truncate text-left transition",
              statusTone === "ready" && "text-slate-400",
              statusTone === "blocked" && "text-slate-400",
              statusTone === "action" && "text-slate-500 underline decoration-slate-300 underline-offset-4",
            )}
            disabled={!props.sendBlockTarget}
            onClick={() => props.sendBlockTarget && props.onOpenFix?.(props.sendBlockTarget)}
            type="button"
          >
            {statusText}
            {props.sendBlockTarget ? " · 点击修复" : ""}
          </button>
          <PreflightStrip
            preflight={preflight}
            onOpenFix={props.onOpenFix}
            sendBlockTarget={props.sendBlockTarget}
            attachmentText={store.attachments.length ? `${store.attachments.length} 个附件 · 文件内容另计` : "仅显示关键信息"}
          />
        </div>

        {store.attachments.length > 0 ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {store.attachments.map((attachment) => (
              <div key={attachment.id} className="group flex min-w-0 items-center gap-2 rounded-2xl border border-slate-200/70 bg-white px-3 py-3">
                {attachment.kind === "image" ? (
                  <img src={toFileUrl(attachment.path)} alt={attachment.name} className="h-10 w-10 shrink-0 rounded-xl object-cover" />
                ) : (
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
                    <Paperclip size={16} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-slate-700">{attachment.name}</span>
                  <span className="block text-[11px] text-slate-400">{attachment.kind === "image" ? "图片" : "文件"} · {formatBytes(attachment.size)}</span>
                </span>
                <button className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-rose-600" onClick={() => store.removeAttachment(attachment.id)} title="移除附件" type="button">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MenuItem(props: { icon: typeof Plus; label: string; disabled?: boolean; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] text-slate-600 transition hover:bg-[var(--hermes-primary-soft)] hover:text-[var(--hermes-primary)] disabled:cursor-not-allowed disabled:opacity-40"
      onClick={props.onClick}
      disabled={props.disabled}
      type="button"
    >
      <Icon size={15} />
      {props.label}
    </button>
  );
}

function HermesUpdateBanner(props: { update: EngineUpdateStatus; onOpenSettings?: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpenSettings}
      className="group mb-2 flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-left shadow-[0_12px_34px_rgba(245,158,11,0.18)] transition hover:border-amber-400 hover:bg-amber-100"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500 text-white shadow-sm">
          <DownloadCloud size={17} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-bold text-amber-950">Hermes Agent 有新版本可更新</span>
          <span className="mt-0.5 block truncate text-xs font-medium text-amber-800">{props.update.message}</span>
        </span>
      </span>
      <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-amber-700 ring-1 ring-amber-200 transition group-hover:bg-amber-600 group-hover:text-white">
        去更新
      </span>
    </button>
  );
}

type ContextMeter = {
  displayTokens: number;
  draftTokens: number;
  contextWindow?: number;
  percent?: number;
  tone: "slate" | "emerald" | "amber" | "rose";
  attachmentCount: number;
  source: "actual" | "estimated" | "draft";
  outputTokens?: number;
  measuredAt?: string;
};

function ContextMeterPill(props: { meter: ContextMeter }) {
  const { meter } = props;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPosition, setPanelPosition] = useState({ right: 16, bottom: 120, width: 264 });
  const sourceLabel = meter.source === "actual" ? "实测" : meter.source === "estimated" ? "估算" : "草稿约";
  const compactSourceLabel = meter.source === "actual" ? "实测上下文" : meter.source === "estimated" ? "估算上下文" : "草稿上下文";
  const percentLabel = typeof meter.percent === "number"
    ? meter.percent === 0 && meter.displayTokens > 0
      ? "<1%"
      : `${meter.percent}%`
    : undefined;
  const showCompactPercent = typeof meter.percent === "number" && meter.percent >= 1;
  const visualPercent = typeof meter.percent === "number"
    ? Math.max(meter.percent, meter.displayTokens > 0 ? 2 : 0)
    : undefined;
  const displayTokenLabel = formatExactTokenCount(meter.displayTokens);
  const contextWindowLabel = meter.contextWindow ? `${formatExactTokenCount(meter.contextWindow)} tokens` : "未知";
  const title = meter.contextWindow
    ? `${sourceLabel}已用上下文：${displayTokenLabel} input tokens；模型窗口上限：${contextWindowLabel}${percentLabel ? `；占用 ${percentLabel}` : ""}${meter.outputTokens ? `；最近输出 ${meter.outputTokens.toLocaleString()} tokens` : ""}${meter.draftTokens ? `；当前草稿约增加 ${meter.draftTokens.toLocaleString()} tokens` : ""}${meter.attachmentCount ? "；附件正文会在发送时另行计入" : ""}${meter.measuredAt ? `；实测时间 ${meter.measuredAt}` : ""}`
    : `${sourceLabel}已用上下文：${displayTokenLabel} input tokens${meter.outputTokens ? `；最近输出 ${meter.outputTokens.toLocaleString()} tokens` : ""}${meter.draftTokens ? `；当前草稿约增加 ${meter.draftTokens.toLocaleString()} tokens` : ""}${meter.attachmentCount ? "；附件正文会在发送时另行计入" : ""}${meter.measuredAt ? `；实测时间 ${meter.measuredAt}` : ""}`;
  const meterClass = meter.tone === "rose"
    ? "border-rose-200/80 bg-rose-50/80 text-rose-700 shadow-rose-100/80"
    : meter.tone === "amber"
      ? "border-amber-200/80 bg-amber-50/80 text-amber-700 shadow-amber-100/80"
      : meter.tone === "emerald"
        ? "border-emerald-200/80 bg-emerald-50/75 text-emerald-700 shadow-emerald-100/80"
        : "border-slate-200/80 bg-white/70 text-slate-500 shadow-slate-200/70";
  const barClass = meter.tone === "rose"
    ? "bg-rose-500"
    : meter.tone === "amber"
      ? "bg-amber-500"
      : meter.tone === "emerald"
        ? "bg-emerald-500"
        : "bg-slate-400";

  useEffect(() => {
    if (!open) return undefined;
    function updatePanelPosition() {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const width = Math.min(264, Math.max(232, viewportWidth - 32));
      const desiredRight = viewportWidth - rect.right;
      const maxRight = Math.max(16, viewportWidth - width - 16);
      setPanelPosition({
        right: Math.min(Math.max(desiredRight, 16), maxRight),
        bottom: Math.max(16, viewportHeight - rect.top + 10),
        width,
      });
    }
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const detailPanel = open && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={panelRef}
          className="fixed z-[60] max-h-[min(320px,calc(100vh-96px))] overflow-auto rounded-[20px] border border-white/80 bg-white/90 p-3 text-[12px] text-slate-600 shadow-[0_24px_70px_rgba(15,23,42,0.16)] backdrop-blur-2xl ring-1 ring-slate-900/5"
          style={{ right: panelPosition.right, bottom: panelPosition.bottom, width: panelPosition.width }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[13px] font-semibold text-slate-950">{meter.source === "actual" ? "真实上下文" : "等待真实上下文"}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{meter.source === "actual" ? "来自 Hermes usage 的 input tokens" : "发送完成后会替换为 Hermes 实测值"}</p>
            </div>
            <span className={cn("rounded-full px-2 py-1 text-[10px] font-semibold", meter.source === "actual" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
              {sourceLabel}
            </span>
          </div>
          <div className="mt-3 space-y-1.5">
            <ContextDetailRow label={meter.source === "actual" ? "实测输入上下文" : "当前输入上下文"} value={`${displayTokenLabel} tokens`} />
            {typeof meter.outputTokens === "number" ? <ContextDetailRow label="最近输出" value={`${meter.outputTokens.toLocaleString()} tokens`} /> : null}
            <ContextDetailRow label="当前草稿" value={`约 +${meter.draftTokens.toLocaleString()} tokens`} />
            <ContextDetailRow label="模型窗口上限" value={contextWindowLabel} />
          </div>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">窗口上限来自模型配置或服务返回，只用来判断余量；主数值显示当前对话真实/估算已用上下文。</p>
          {typeof meter.percent === "number" ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                <span>占用比例</span>
                <span>{percentLabel}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100 shadow-inner">
                <div className={cn("h-full rounded-full transition-all duration-500", barClass)} style={{ width: `${visualPercent}%` }} />
              </div>
            </div>
          ) : null}
          {meter.attachmentCount ? <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">附件正文会在发送时由 Hermes 读取，可能额外增加上下文。</p> : null}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        className={cn(
          "group inline-flex h-8 max-w-[144px] items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-medium shadow-[0_8px_20px_rgba(15,23,42,0.045)] backdrop-blur-xl transition duration-200 hover:-translate-y-0.5 hover:bg-white/90 hover:shadow-[0_12px_28px_rgba(15,23,42,0.075)] active:translate-y-0 max-sm:max-w-[108px]",
          meterClass,
        )}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-white/75 shadow-inner ring-1 ring-white/80">
          <Gauge size={10} />
        </span>
        <span className="min-w-0 truncate">
          {compactSourceLabel} {displayTokenLabel}
          {showCompactPercent && percentLabel ? ` · ${percentLabel}` : ""}
        </span>
        {typeof meter.percent === "number" ? (
          <span className="h-1 w-6 shrink-0 overflow-hidden rounded-full bg-white/75 ring-1 ring-black/5 max-sm:hidden">
            <span className={cn("block h-full rounded-full transition-all duration-500", barClass)} style={{ width: `${visualPercent}%` }} />
          </span>
        ) : null}
      </button>
      {detailPanel}
    </div>
  );
}

function ContextDetailRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50/75 px-3 py-2">
      <span className="text-slate-400">{props.label}</span>
      <span className="font-mono font-semibold text-slate-700">{props.value}</span>
    </div>
  );
}

function PreflightStrip(props: {
  preflight: ReturnType<typeof buildPreflightState>;
  onOpenFix?: (target: FixTarget) => void;
  sendBlockTarget?: FixTarget;
  attachmentText: string;
}) {
  const toneClass = props.preflight.tone === "green"
    ? "text-slate-400"
    : props.preflight.tone === "yellow"
      ? "text-slate-400"
      : "text-rose-600";
  const dotClass = props.preflight.tone === "green"
    ? "bg-emerald-400"
    : props.preflight.tone === "yellow"
      ? "bg-amber-300"
      : "bg-rose-400";
  const chipClass = props.preflight.tone === "red"
    ? "text-rose-500"
    : props.preflight.tone === "yellow"
      ? "text-slate-400"
      : "text-slate-400";
  const chips = preflightChipsForUser(props.preflight).slice(0, 2);
  const summary = preflightSummaryForUser(props.preflight);
  const displaySummary = props.preflight.tone === "yellow"
    ? summary.replace("可以发送，但", "可发送 · ").replace("命令会自动放行", "命令自动放行")
    : summary;
  const detail = preflightDetailForUser(props.preflight);
  const blockCode = props.preflight.block?.code;

  function inferFixTarget(): FixTarget | undefined {
    if (props.sendBlockTarget) return props.sendBlockTarget;
    if (blockCode === "policy_not_enforceable" || blockCode === "unsupported_runtime_enforcement") return "health";
    if (blockCode === "manual_configuration_required" || blockCode === "unsupported_cli_version" || blockCode === "unsupported_cli_capability") return "hermes";
    return undefined;
  }

  const fixTarget = inferFixTarget();

  return (
    <div className={cn("min-w-0 max-w-[60%] text-right text-[10px] leading-4", toneClass)}>
      <div className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
        <span className="shrink-0 text-slate-300">{props.attachmentText}</span>
        <span className="text-slate-300">·</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full shadow-[0_0_0_2px_rgba(148,163,184,0.10)]", dotClass)} />
          <span className="truncate">{displaySummary}</span>
        </span>
        {chips.map((chip) => (
          <span
            key={chip}
            className={cn("hidden rounded-full font-medium sm:inline", chipClass)}
          >
            {chip}
          </span>
        ))}
      </div>
      {props.preflight.block ? (
        <details className="group mt-0.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-0.5 font-medium text-rose-500 outline-none transition hover:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-200">
            <span>为什么会这样 / 怎么修</span>
            <span className="opacity-55 transition-opacity group-hover:opacity-100">展开</span>
          </summary>
          <div className="ml-auto mt-1 max-w-xl space-y-1 rounded-xl bg-white/80 px-3 py-2 text-left text-[11px] leading-5 text-rose-700 ring-1 ring-rose-100">
            <p className="leading-5">{detail}</p>
            <p className="font-medium">{props.preflight.block.fixHint}</p>
            {fixTarget ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  props.onOpenFix?.(fixTarget);
                }}
                className="mt-1 inline-flex items-center gap-1 rounded-md bg-white/80 px-2 py-1 text-[11px] font-semibold text-rose-700 shadow-sm ring-1 ring-rose-200 transition hover:bg-white"
              >
                去修复 →
              </button>
            ) : null}
          </div>
        </details>
      ) : props.preflight.tone === "yellow" ? (
        <details className="group mt-0.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-0.5 text-[10px] font-medium text-slate-300 outline-none transition hover:bg-slate-50 hover:text-slate-500 focus-visible:ring-2 focus-visible:ring-slate-200">
            <span>运行说明</span>
            <span className="opacity-60 transition-opacity group-open:rotate-180 group-hover:opacity-100">⌄</span>
          </summary>
          <p className="ml-auto mt-1 max-w-xl rounded-xl bg-white/80 px-3 py-2 text-left text-[11px] leading-5 text-slate-500 ring-1 ring-slate-100">{detail}</p>
        </details>
      ) : null}
    </div>
  );
}

function buildContextMeter(input: {
  activeSessionId?: string;
  userInput: string;
  projections: ReturnType<typeof useAppStore.getState>["taskRunProjectionsById"];
  runOrder: ReturnType<typeof useAppStore.getState>["taskRunOrderBySession"];
  taskEventsByRunId: ReturnType<typeof useAppStore.getState>["taskEventsByRunId"];
  sessionInsightUsage?: SessionAgentInsightUsage;
  conversationMessages: ReturnType<typeof useAppStore.getState>["conversationMessages"];
  contextWindow?: number;
  attachmentCount: number;
}): ContextMeter {
  const latestUsage = latestUsageForSession(input.activeSessionId, input.taskEventsByRunId, input.sessionInsightUsage);
  const historyText = contextTextFromProjections(input.activeSessionId, input.projections, input.runOrder)
    || contextTextFromMessages(input.activeSessionId, input.conversationMessages);
  const attachmentOverhead = input.attachmentCount * 48;
  const draftTokens = Math.max(0, estimateTokens(input.userInput) + attachmentOverhead);
  const fallbackTokens = Math.max(0, estimateTokens(`${historyText}\n${input.userInput}`) + attachmentOverhead);
  const displayTokens = latestUsage?.inputTokens ?? fallbackTokens;
  const source = latestUsage?.source ?? "draft";
  const percent = input.contextWindow && input.contextWindow > 0
    ? Math.min(100, Math.round((displayTokens / input.contextWindow) * 100))
    : undefined;
  const tone = typeof percent !== "number"
    ? "slate"
    : percent >= 90
      ? "rose"
      : percent >= 70
        ? "amber"
        : percent > 0
          ? "emerald"
          : "slate";
  return {
    displayTokens,
    draftTokens,
    contextWindow: input.contextWindow,
    percent,
    tone,
    attachmentCount: input.attachmentCount,
    source,
    outputTokens: latestUsage?.outputTokens,
    measuredAt: latestUsage?.at,
  };
}

function resolveComposerContextWindow(
  store: ReturnType<typeof useAppStore.getState>,
  modelProfile: ModelProfile | undefined,
  modelLabel: string,
) {
  if (store.sessionAgentInsight?.latestRuntime?.contextWindow) return store.sessionAgentInsight.latestRuntime.contextWindow;
  const providerProfiles = store.runtimeConfig?.providerProfiles ?? store.providerProfiles;
  const matchedModel = providerProfiles
    .flatMap((profile) => profile.models)
    .find((model) => model.id === modelLabel || model.label === modelLabel || model.id === modelProfile?.model || model.label === modelProfile?.model);
  return matchedModel?.contextWindow ?? modelProfile?.maxTokens;
}

function latestUsageForSession(
  activeSessionId: string | undefined,
  eventsByRunId: ReturnType<typeof useAppStore.getState>["taskEventsByRunId"],
  insightUsage?: SessionAgentInsightUsage,
): { inputTokens: number; outputTokens: number; source: "actual" | "estimated"; at?: string } | undefined {
  const usageEvents = Object.values(eventsByRunId)
    .flat()
    .filter((event) => (!activeSessionId || event.workSessionId === activeSessionId) && event.event.type === "usage")
    .map((event) => event.event as Extract<EngineEvent, { type: "usage" }>);
  const actualEvents = usageEvents.filter((event) => event.source === "actual");
  const preferred = latestByTimestamp(actualEvents.length ? actualEvents : usageEvents);
  if (preferred) {
    return {
      inputTokens: preferred.inputTokens,
      outputTokens: preferred.outputTokens,
      source: preferred.source === "actual" ? "actual" : "estimated",
      at: preferred.at,
    };
  }
  if (!insightUsage) return undefined;
  return {
    inputTokens: insightUsage.latestInputTokens,
    outputTokens: insightUsage.latestOutputTokens,
    source: insightUsage.source === "actual" ? "actual" : "estimated",
  };
}

function latestByTimestamp<T extends { at: string }>(events: T[]) {
  return events.reduce<T | undefined>((latest, event) => (!latest || event.at >= latest.at ? event : latest), undefined);
}

function contextTextFromProjections(
  activeSessionId: string | undefined,
  projections: ReturnType<typeof useAppStore.getState>["taskRunProjectionsById"],
  runOrder: ReturnType<typeof useAppStore.getState>["taskRunOrderBySession"],
) {
  const projectionList = activeSessionId && runOrder[activeSessionId]?.length
    ? runOrder[activeSessionId].map((id) => projections[id]).filter(Boolean)
    : Object.values(projections).filter((projection) => !activeSessionId || projection.workSessionId === activeSessionId);
  return projectionList
    .map((projection) => [
      projection.userMessage?.content,
      projection.assistantMessage.content,
      ...projection.toolEvents.map((tool) => tool.summary ?? tool.command ?? tool.path ?? ""),
    ].filter(Boolean).join("\n"))
    .join("\n");
}

function contextTextFromMessages(
  activeSessionId: string | undefined,
  messages: ReturnType<typeof useAppStore.getState>["conversationMessages"],
) {
  return messages
    .filter((message) => message.visibleInChat !== false)
    .filter((message) => !activeSessionId || message.sessionId === activeSessionId)
    .map((message) => message.content)
    .join("\n");
}

function estimateTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (/\s/.test(char)) continue;
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii * 0.9);
}

function formatExactTokenCount(value: number) {
  return Math.round(value).toLocaleString();
}

function joinVoiceText(...parts: Array<string | undefined>) {
  return parts.map((part) => part?.trim()).filter(Boolean).join(" ");
}

function toFileUrl(filePath: string) {
  return encodeURI(`file:///${filePath.replace(/\\/g, "/").replace(/^\/+/, "")}`);
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function currentSessionPath(sessionFilesPath: string, activeSessionId?: string) {
  return sessionFilesPath || activeSessionId || "default";
}

function shortPath(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || value;
}

function compactMessages(messages: Array<{ role: string; content: string }>, focus?: string): string {
  const userMessages = messages.filter((message) => message.role === "user");
  const agentMessages = messages.filter((message) => message.role === "agent");

  const userPoints: string[] = [];
  for (const msg of userMessages) {
    const trimmed = msg.content.trim();
    if (trimmed.length > 0) {
      const lines = trimmed.split(/\n/).filter((line) => line.trim()).slice(0, 2);
      userPoints.push(...lines);
    }
  }

  const agentActions: string[] = [];
  for (const msg of agentMessages) {
    const trimmed = msg.content.trim();
    if (trimmed.length > 0) {
      const lines = trimmed.split(/\n/).filter((line) => line.trim()).slice(0, 2);
      agentActions.push(...lines);
    }
  }

  const summaryParts: string[] = [];
  if (userPoints.length > 0) {
    const userSummary = userPoints.slice(-4).join(" ");
    summaryParts.push(`用户需求：${userSummary.slice(0, 120)}${userSummary.length > 120 ? "..." : ""}`);
  }
  if (agentActions.length > 0) {
    const agentSummary = agentActions.slice(-3).join(" ");
    summaryParts.push(`已完成：${agentSummary.slice(0, 100)}${agentSummary.length > 100 ? "..." : ""}`);
  }
  if (focus) {
    summaryParts.push(`重点关注：${focus}`);
  }

  return summaryParts.join("；");
}
