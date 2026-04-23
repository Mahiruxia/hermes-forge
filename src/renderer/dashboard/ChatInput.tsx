import { Command, Mic, MicOff, Paperclip, Plus, Send, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, ReactNode } from "react";
import { useAppStore } from "../store";
import { cn } from "./DashboardPrimitives";

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
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const permissions = store.runtimeConfig?.enginePermissions?.hermes;
  const permissionsLabel = permissions
    ? `读${permissions.workspaceRead === false ? "关" : "开"} 写${permissions.fileWrite === false ? "关" : "开"} 命令${permissions.commandRun === false ? "关" : "开"}`
    : "权限默认开启";
  const currentModelProfile = store.runtimeConfig?.modelProfiles.find((profile) => profile.id === store.runtimeConfig?.defaultModelProfileId)
    ?? store.runtimeConfig?.modelProfiles[0];
  const currentModelLabel = currentModelProfile?.model || currentModelProfile?.name || currentModelProfile?.id || "未配置模型";
  const statusTone = props.sendBlockTarget ? "action" : props.sendBlockReason ? "blocked" : "ready";
  const statusText = props.sendBlockReason
    ? props.sendBlockReason
    : `${currentModelLabel} · ${store.workspacePath ? shortPath(store.workspacePath) : "无工作区"} · ${permissionsLabel}${props.locked ? " · 工作区占用中" : ""}`;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.floor(window.innerHeight * 0.35))}px`;
  }, [store.userInput]);

  useEffect(() => {
    return () => {
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

  function initRecognition() {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
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
    if (isListening) {
      stopVoiceInput();
      return;
    }
    const hasPermission = await requestMicrophonePermission();
    if (!hasPermission) {
      store.error("麦克风权限被拒绝", "请在系统设置中允许麦克风权限");
      return;
    }
    startVoiceInput();
  }

  function startVoiceInput() {
    const recognition = initRecognition();
    if (!recognition) return;

    recognition.onstart = () => {
      setIsListening(true);
      store.info("语音输入已启动", "正在监听你的语音");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        } else {
          store.setUserInput(`${store.userInput.trimEnd()} ${event.results[i][0].transcript}`.trim());
          return;
        }
      }
      if (transcript) {
        const currentInput = store.userInput.trim();
        store.setUserInput(currentInput ? `${currentInput} ${transcript}` : transcript);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);
      recognitionRef.current = null;
      if (event.error === "not-allowed") {
        store.error("语音输入失败", "麦克风权限未授予");
      } else if (event.error === "audio-capture") {
        store.error("麦克风不可用", "未检测到麦克风设备");
      } else {
        store.error("语音识别错误", `错误类型：${event.error}`);
      }
    };

    recognition.onend = () => {
      if (isListening) {
        recognition.start();
      } else {
        recognitionRef.current = null;
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopVoiceInput() {
    setIsListening(false);
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    store.info("语音输入已停止", "已完成语音转文字");
  }

  function handleSubmit() {
    if (store.userInput.trim().startsWith("/")) {
      void dispatchSlashCommand(store.userInput.trim());
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

        <div
          className={cn(
            "relative overflow-hidden rounded-[28px] border border-[var(--hermes-card-border)] bg-white shadow-[0_20px_60px_rgba(15,23,42,0.08)] focus-within:hermes-purple-focus",
            isDraggingAttachment && "ring-2 ring-[var(--hermes-primary-border)]",
          )}
          onDragEnter={handleAttachmentDragEnter}
          onDragOver={handleAttachmentDragOver}
          onDragLeave={handleAttachmentDragLeave}
          onDrop={handleAttachmentDrop}
        >
          {isDraggingAttachment ? (
            <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-slate-50/90">
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
            className="max-h-[28vh] min-h-[64px] w-full resize-none bg-transparent px-5 pt-5 text-[15px] leading-7 text-slate-800 outline-none placeholder:text-slate-400"
            placeholder="给 Hermes 发送消息… 需要附件、语音、@ 提及或命令时，点左下角的 +"
          />

          <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative" ref={plusMenuRef}>
                <button
                  className="grid h-10 w-10 place-items-center rounded-full border border-[var(--hermes-primary-border)] text-[var(--hermes-primary)] transition hover:bg-[var(--hermes-primary-soft)]"
                  onClick={() => setPlusMenuOpen((value) => !value)}
                  aria-label="打开更多输入入口"
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
                className="grid h-10 w-10 place-items-center rounded-full border border-[var(--hermes-primary-border)] text-[var(--hermes-primary)] transition hover:bg-[var(--hermes-primary-soft)]"
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
                  className="inline-flex h-10 max-w-[220px] items-center rounded-full border border-[var(--hermes-primary-border)] bg-[var(--hermes-primary-soft)] px-3 text-[12px] font-medium text-[var(--hermes-primary)] transition hover:bg-white"
                  onClick={() => setModelMenuOpen((value) => !value)}
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

            <div className="flex shrink-0 items-center gap-2">
              {store.runningTaskRunId ? (
                <button
                  className="grid h-10 w-10 place-items-center rounded-full border border-rose-200 bg-rose-50 text-rose-600 transition hover:bg-rose-100"
                  onClick={props.onCancelTask}
                  aria-label="停止 Hermes"
                  type="button"
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  className="grid h-10 w-10 place-items-center rounded-full bg-[var(--hermes-primary)] text-white shadow-[0_12px_28px_rgba(91,77,255,0.26)] transition hover:bg-[var(--hermes-primary-strong)] disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
                  aria-label="发送"
                  title={props.sendBlockReason ?? "发送"}
                  onClick={handleSubmit}
                  disabled={!props.canStart}
                  type="button"
                >
                  <Send size={15} />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[11px]">
          <button
            className={cn(
              "min-w-0 truncate text-left transition",
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
          <span className="shrink-0 text-slate-400">
            {store.attachments.length ? `${store.attachments.length} 个附件` : "仅显示关键信息"}
          </span>
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
