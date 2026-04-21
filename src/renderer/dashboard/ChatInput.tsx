import { AtSign, FileText, Mic, MicOff, Paperclip, Send, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { useAppStore } from "../store";
import { cn } from "./DashboardPrimitives";

export function ChatInput(props: {
  onStartTask: () => void;
  onCancelTask: () => void;
  onPickWorkspace?: () => void;
  onCreateSession?: () => void;
  onClearSession?: () => void;
  onRestoreSnapshot: () => void;
  canStart: boolean;
  latestSnapshotAvailable: boolean;
  locked: boolean;
}) {
  const store = useAppStore();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submittingRef = useRef(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [isListening, setIsListening] = useState(false);
  const [listenError, setListenError] = useState<string | undefined>();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [isImportingAttachment, setIsImportingAttachment] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const selectedFilesLabel = `${store.selectedFiles.length} files`;
  const attachmentsLabel = `${store.attachments.length} attachments`;
  const lockLabel = props.locked ? "工作区占用中" : "文件锁空闲";
  const permissions = store.runtimeConfig?.enginePermissions?.hermes;
  const permissionsLabel = permissions
    ? `读${permissions.workspaceRead === false ? "关" : "开"} 写${permissions.fileWrite === false ? "关" : "开"} 命令${permissions.commandRun === false ? "关" : "开"}`
    : "权限默认开启";
  const currentModelProfile = store.runtimeConfig?.modelProfiles.find((profile) => profile.id === store.runtimeConfig?.defaultModelProfileId)
    ?? store.runtimeConfig?.modelProfiles[0];
  const currentModelLabel = currentModelProfile?.model || currentModelProfile?.name || currentModelProfile?.id || "未配置模型";

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.floor(window.innerHeight * 0.4))}px`;
  }, [store.userInput]);

  useEffect(() => {
    if (listenError) {
      const timer = setTimeout(() => setListenError(undefined), 3000);
      return () => clearTimeout(timer);
    }
  }, [listenError]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      const profileButton = document.querySelector('[title="Profile"]');
      if (profileButton && !profileButton.contains(target)) {
        setProfileMenuOpen(false);
      }
    }
    if (profileMenuOpen) {
      document.addEventListener("click", handleClickOutside);
    }
    return () => {
      document.removeEventListener("click", handleClickOutside);
    };
  }, [profileMenuOpen]);

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
      store.error("语音识别不可用", "您的浏览器不支持语音识别功能");
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
      setListenError(undefined);
      store.info("语音输入已启动", "正在监听您的语音...");
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        } else {
          const currentInput = store.userInput;
          const interimTranscript = event.results[i][0].transcript;
          const lastSpaceIndex = currentInput.lastIndexOf(" ");
          const baseText = lastSpaceIndex >= 0 ? currentInput.substring(0, lastSpaceIndex + 1) : "";
          store.setUserInput(baseText + interimTranscript);
          return;
        }
      }
      if (transcript) {
        const currentInput = store.userInput.trim();
        const newInput = currentInput ? `${currentInput} ${transcript}` : transcript;
        store.setUserInput(newInput);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setIsListening(false);
      recognitionRef.current = null;
      if (event.error === "not-allowed") {
        store.error("语音输入失败", "麦克风权限未授予，请在系统设置中允许");
      } else if (event.error === "no-speech") {
        store.warning("未检测到语音", "请确保麦克风正常工作并清晰说话");
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
      store.setWebUiOverview(store.webUiOverview ? { ...store.webUiOverview, settings } : undefined);
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
        store.setControlCenterOpen(true);
        store.setActivePanel("settings");
        store.setLastWebUiError("模型设置入口已打开。");
        store.setUserInput("");
        return;
      }
      const profiles = store.runtimeConfig?.modelProfiles ?? [];
      const matchedProfile = profiles.find(
        (p) => p.id.toLowerCase() === arg.toLowerCase() || (p.name ?? p.id).toLowerCase() === arg.toLowerCase()
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
        const availableModels = profiles.map((p) => p.name ?? p.id).join(", ");
        store.warning("模型不存在", `未找到模型 "${arg}"。可用模型：${availableModels || "无"}`);
      }
      store.setUserInput("");
      return;
    }
    if (name === "/compact") {
      const sessionMessages = store.conversationMessages.filter((m) => m.sessionId === store.activeSessionId);
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

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-5">
      <div
        className={cn(
          "relative flex flex-col overflow-hidden rounded-2xl bg-white shadow-[0_8px_30px_rgb(0,0,0,0.04)] ring-1 ring-slate-100/70",
          isDraggingAttachment && "ring-2 ring-indigo-300",
        )}
        onDragEnter={handleAttachmentDragEnter}
        onDragOver={handleAttachmentDragOver}
        onDragLeave={handleAttachmentDragLeave}
        onDrop={handleAttachmentDrop}
      >
        {isDraggingAttachment ? (
          <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center bg-indigo-50/85 backdrop-blur-[1px]">
            <div className="rounded-2xl border border-dashed border-indigo-300 bg-white/90 px-5 py-3 text-center shadow-sm">
              <p className="text-sm font-semibold text-indigo-700">{store.runningTaskRunId ? "当前任务运行中" : "松开即可添加附件"}</p>
              <p className="mt-1 text-xs text-slate-500">{store.runningTaskRunId ? "请等 Hermes 完成后再上传文件" : "支持图片和常见文档，最多一次 12 个"}</p>
            </div>
          </div>
        ) : null}
        {commands.length ? (
          <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
            {commands.map((command, index) => (
              <button
                key={command.name}
                className={cn("flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px]", index === commandIndex ? "bg-indigo-100/50 text-indigo-700" : "text-slate-600 hover:bg-slate-50")}
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
        <textarea
          aria-label="给 Hermes 发送消息"
          ref={textareaRef}
          value={store.userInput}
          onChange={(event) => store.setUserInput(event.target.value)}
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
          className="max-h-[28vh] min-h-[76px] resize-none bg-white p-4 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400"
          placeholder="给赫尔墨斯发消息……也可以输入 / 使用命令"
        />
        <div className="flex items-center justify-between bg-white px-3 pb-3">
          <div className="flex shrink-0 items-center gap-1">
            <div className="relative">
              <IconAction title="Profile" onClick={() => setProfileMenuOpen(!profileMenuOpen)}>
                <AtSign size={15} strokeWidth={1.75} />
              </IconAction>
              {profileMenuOpen ? (
                <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                  {store.webUiOverview?.profiles?.map((profile) => (
                    <button
                      key={profile.id}
                      className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm", profile.active ? "bg-indigo-100/50 text-indigo-700" : "text-slate-600 hover:bg-slate-50")}
                      onClick={() => {
                        void window.workbenchClient.switchProfile(profile.name).then((result) => {
                          if (result.ok) {
                            store.setWebUiOverview(undefined);
                            void window.workbenchClient.getWebUiOverview().then(store.setWebUiOverview);
                            store.success("Profile 已切换", `当前使用：${result.active}`);
                          } else {
                            store.error("切换失败", "无法切换到指定的 Profile");
                          }
                        }).catch(() => {
                          store.error("切换失败", "网络错误或 Profile 不存在");
                        });
                        setProfileMenuOpen(false);
                      }}
                      type="button"
                    >
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", profile.active ? "bg-indigo-500" : "bg-slate-300")} />
                      <span className="flex-1 truncate">{profile.name}</span>
                      {profile.active ? <span className="text-[10px] text-slate-400">当前</span> : null}
                    </button>
                  ))}
                  <div className="border-t border-slate-100">
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
                      onClick={() => {
                        store.setControlCenterOpen(true);
                        setProfileMenuOpen(false);
                      }}
                      type="button"
                    >
                      <span>管理 Profile...</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <IconAction title={isImportingAttachment ? "正在导入附件" : "上传文件或图片"} onClick={() => void pickAttachments()} disabled={Boolean(store.runningTaskRunId) || isImportingAttachment}>
              <Paperclip size={15} strokeWidth={1.75} />
            </IconAction>
            <IconAction title={isListening ? "停止录音" : "语音输入"} onClick={toggleVoiceInput} tone={isListening ? "danger" : "normal"}>
              {isListening ? <MicOff size={14} strokeWidth={1.75} /> : <Mic size={14} strokeWidth={1.75} />}
            </IconAction>
            <span className="ml-2 hidden truncate text-[10px] text-slate-400 sm:inline">
              {currentModelLabel} · {store.workspacePath ? shortPath(store.workspacePath) : "没有工作区"} · {selectedFilesLabel} · {attachmentsLabel} · {permissionsLabel}{lockLabel !== "文件锁空闲" ? ` · ${lockLabel}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center">
            {store.runningTaskRunId ? (
              <IconAction title="停止 Hermes" onClick={props.onCancelTask} tone="danger">
                <Square size={14} strokeWidth={1.75} />
              </IconAction>
            ) : (
              <button className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-100/70 text-indigo-700 transition-colors hover:bg-indigo-200/70 disabled:cursor-not-allowed disabled:opacity-40" aria-label="发送" onClick={handleSubmit} disabled={!props.canStart} type="button">
                <Send size={15} strokeWidth={1.9} />
                <span className="sr-only">发送</span>
              </button>
            )}
          </div>
        </div>
        {store.attachments.length > 0 ? (
          <div className="grid gap-2 px-1 pt-2 sm:grid-cols-2">
            {store.attachments.map((attachment) => (
              <div key={attachment.id} className="group flex min-w-0 items-center gap-2 rounded-xl bg-slate-50/70 px-2.5 py-2">
                {attachment.kind === "image" ? (
                  <img src={toFileUrl(attachment.path)} alt={attachment.name} className="h-10 w-10 shrink-0 rounded-lg border border-white object-cover shadow-sm" />
                ) : (
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500">
                    <FileText size={17} strokeWidth={1.75} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-slate-700">{attachment.name}</span>
                  <span className="block text-[11px] text-slate-400">{attachment.kind === "image" ? "图片" : "文件"} · {formatBytes(attachment.size)}</span>
                </span>
                <button className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white hover:text-rose-600" onClick={() => store.removeAttachment(attachment.id)} title="移除附件" type="button">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
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
  const userMessages = messages.filter((m) => m.role === "user");
  const agentMessages = messages.filter((m) => m.role === "agent");
  
  const userPoints: string[] = [];
  for (const msg of userMessages) {
    const trimmed = msg.content.trim();
    if (trimmed.length > 0) {
      const lines = trimmed.split(/\n/).filter((l) => l.trim()).slice(0, 2);
      userPoints.push(...lines);
    }
  }
  
  const agentActions: string[] = [];
  for (const msg of agentMessages) {
    const trimmed = msg.content.trim();
    if (trimmed.length > 0) {
      const lines = trimmed.split(/\n/).filter((l) => l.trim()).slice(0, 2);
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

function IconAction(props: { children: ReactNode; title: string; disabled?: boolean; tone?: "normal" | "danger"; onClick?: () => void }) {
  return (
    <button
      className={cn(
        "grid h-8 w-8 place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40",
        props.tone === "danger" && "text-rose-500 hover:text-rose-600",
      )}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      type="button"
    >
      {props.children}
    </button>
  );
}
