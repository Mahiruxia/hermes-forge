import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clipboard, desktopCapturer, shell } from "electron";
import { runCommand, type CommandResult } from "../process/command-runner";
import type {
  AutoHotkeyStatus,
  EnginePermissionPolicy,
  EngineEvent,
  WindowsToolCall,
  WindowsToolExecutionResult,
  WindowsToolName,
} from "../shared/types";
import type { AutoHotkeyService } from "./autohotkey-service";

const MAX_TEXT_BYTES = 200 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

export const WINDOWS_TOOL_MANIFEST: Array<{
  name: WindowsToolName;
  description: string;
  input: Record<string, string>;
}> = [
  { name: "windows.files.listDir", description: "List a Windows directory.", input: { path: "Windows directory path" } },
  { name: "windows.files.readText", description: "Read a UTF-8 text file from Windows.", input: { path: "Windows file path" } },
  { name: "windows.files.writeText", description: "Create or overwrite a UTF-8 text file on Windows.", input: { path: "Windows file path", content: "Text content" } },
  { name: "windows.files.exists", description: "Check whether a Windows path exists.", input: { path: "Windows path" } },
  { name: "windows.files.delete", description: "Delete a Windows file or directory.", input: { path: "Windows path", recursive: "true for recursive directory delete" } },
  { name: "windows.shell.openPath", description: "Open a Windows file or folder with the default shell.", input: { path: "Windows file or folder path" } },
  { name: "windows.clipboard.read", description: "Read Windows clipboard text.", input: {} },
  { name: "windows.clipboard.write", description: "Write Windows clipboard text.", input: { text: "Clipboard text" } },
  { name: "windows.powershell.run", description: "Run a PowerShell script on native Windows.", input: { script: "PowerShell script", timeoutMs: "Optional timeout in milliseconds" } },
  { name: "windows.screenshot.capture", description: "Capture the primary Windows screen.", input: {} },
  { name: "windows.windows.list", description: "List visible Windows desktop windows.", input: {} },
  { name: "windows.windows.focus", description: "Focus a window by title using AutoHotkey.", input: { title: "Window title substring" } },
  { name: "windows.windows.close", description: "Close a window by title using AutoHotkey.", input: { title: "Window title substring" } },
  { name: "windows.keyboard.type", description: "Type text into the active Windows window using AutoHotkey.", input: { text: "Text to type" } },
  { name: "windows.keyboard.pressHotkey", description: "Send a hotkey to Windows using AutoHotkey syntax.", input: { hotkey: "AutoHotkey hotkey string, for example ^s" } },
  { name: "windows.mouse.click", description: "Click Windows screen coordinates.", input: { x: "Screen x coordinate", y: "Screen y coordinate" } },
  { name: "windows.mouse.move", description: "Move the Windows mouse pointer.", input: { x: "Screen x coordinate", y: "Screen y coordinate" } },
  { name: "windows.ahk.runScript", description: "Run an AutoHotkey v2 script.", input: { script: "AutoHotkey v2 script" } },
  { name: "windows.system.getDesktopPath", description: "Return the current Windows desktop path.", input: {} },
  { name: "windows.system.getKnownFolders", description: "Return common Windows known folders.", input: {} },
];

export class WindowsToolExecutor {
  constructor(
    private readonly getPermissions: () => Promise<EnginePermissionPolicy>,
    private readonly autoHotkeyService: AutoHotkeyService,
    private readonly commandRunner = runCommand,
    private readonly requestApproval?: (input: {
      taskRunId: string;
      title: string;
      command?: string;
      path?: string;
      patternKey: string;
      actionKind: "file_write" | "file_delete" | "command_run" | "window_control" | "keyboard_input" | "mouse_input" | "automation";
      details?: string;
      risk: "low" | "medium" | "high";
      publish: (event: EngineEvent) => Promise<void>;
    }) => Promise<{ approved: boolean; editedCommand?: string }>,
  ) {}

  async execute(
    call: WindowsToolCall,
    context?: { taskRunId?: string; publish?: (event: EngineEvent) => Promise<void> },
  ): Promise<WindowsToolExecutionResult> {
    const startedAt = Date.now();
    try {
      const permissions = await this.getPermissions();
      this.requireBridge(permissions);
      await this.ensureApproved(call, permissions, context);
      const result = await this.route(call, permissions);
      return this.wrap(call.tool, true, result.message, startedAt, result.result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.wrap(call.tool, false, message, startedAt);
    }
  }

  async autoHotkeyStatus(): Promise<AutoHotkeyStatus> {
    return this.autoHotkeyService.status();
  }

  private async route(call: WindowsToolCall, permissions: EnginePermissionPolicy): Promise<{ message: string; result?: Record<string, unknown> }> {
    const input = call.input ?? {};
    switch (call.tool) {
      case "windows.files.listDir":
        return this.listDir(this.string(input, "path", 1000));
      case "windows.files.readText":
        return this.readText(this.string(input, "path", 1000));
      case "windows.files.writeText":
        this.requireFileWrite(permissions);
        return this.writeText(this.string(input, "path", 1000), this.optionalString(input, "content", 500_000) ?? "");
      case "windows.files.exists":
        return this.exists(this.string(input, "path", 1000));
      case "windows.files.delete":
        this.requireFileWrite(permissions);
        return this.deletePath(this.string(input, "path", 1000), this.boolean(input, "recursive", false));
      case "windows.shell.openPath":
        return this.openPath(this.string(input, "path", 1000));
      case "windows.clipboard.read":
        return { message: "Clipboard read.", result: { text: clipboard.readText() } };
      case "windows.clipboard.write":
        clipboard.writeText(this.string(input, "text", 500_000));
        return { message: "Clipboard written.", result: { ok: true } };
      case "windows.powershell.run":
        this.requireCommandRun(permissions);
        return this.powershell(this.string(input, "script", 40_000), this.timeout(input.timeoutMs));
      case "windows.screenshot.capture":
        this.requireCommandRun(permissions);
        return this.screenshot();
      case "windows.windows.list":
        this.requireCommandRun(permissions);
        return this.windowList();
      case "windows.windows.focus":
        this.requireCommandRun(permissions);
        return this.ahk(`SetTitleMatchMode 2\nWinActivate ${quoteAhk(this.string(input, "title", 300))}\n`, "Window focused.");
      case "windows.windows.close":
        this.requireCommandRun(permissions);
        return this.ahk(`SetTitleMatchMode 2\nWinClose ${quoteAhk(this.string(input, "title", 300))}\n`, "Window close requested.");
      case "windows.keyboard.type":
        this.requireCommandRun(permissions);
        return this.ahk(`SendText ${quoteAhk(this.string(input, "text", 5000))}\n`, "Text typed.");
      case "windows.keyboard.pressHotkey":
        this.requireCommandRun(permissions);
        return this.ahk(`Send ${quoteAhk(this.string(input, "hotkey", 200))}\n`, "Hotkey sent.");
      case "windows.mouse.click":
        this.requireCommandRun(permissions);
        return this.ahk(`Click ${this.number(input, "x")}, ${this.number(input, "y")}\n`, "Mouse clicked.");
      case "windows.mouse.move":
        this.requireCommandRun(permissions);
        return this.ahk(`MouseMove ${this.number(input, "x")}, ${this.number(input, "y")}, 0\n`, "Mouse moved.");
      case "windows.ahk.runScript":
        this.requireCommandRun(permissions);
        return this.ahk(this.string(input, "script", 40_000), "AutoHotkey script executed.");
      case "windows.system.getDesktopPath":
        return { message: "Desktop path resolved.", result: { path: path.join(os.homedir(), "Desktop") } };
      case "windows.system.getKnownFolders":
        return this.knownFolders();
      default:
        return assertNeverTool(call.tool);
    }
  }

  private async listDir(dirPath: string) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return {
      message: `Listed directory: ${dirPath}`,
      result: {
        path: dirPath,
        entries: entries.slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })),
        truncated: entries.length > 500,
      },
    };
  }

  private async readText(filePath: string) {
    const raw = await fs.readFile(filePath);
    return {
      message: `Read text file: ${filePath}`,
      result: { path: filePath, text: truncate(raw.toString("utf8")) },
    };
  }

  private async writeText(filePath: string, content: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return { message: `Wrote text file: ${filePath}`, result: { path: filePath } };
  }

  private async exists(targetPath: string) {
    const ok = await fs.access(targetPath).then(() => true).catch(() => false);
    return { message: ok ? "Path exists." : "Path does not exist.", result: { path: targetPath, exists: ok } };
  }

  private async deletePath(targetPath: string, recursive: boolean) {
    await fs.rm(targetPath, { recursive, force: false });
    return { message: `Deleted path: ${targetPath}`, result: { path: targetPath } };
  }

  private async openPath(targetPath: string) {
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
    return { message: `Opened path: ${targetPath}`, result: { path: targetPath } };
  }

  private async powershell(script: string, timeoutMs: number) {
    const result = await this.commandRunner("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: process.cwd(),
      timeoutMs,
    });
    return {
      message: result.exitCode === 0 ? "PowerShell completed." : `PowerShell failed with exit code ${result.exitCode ?? "unknown"}.`,
      result: {
        exitCode: result.exitCode,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
      },
    };
  }

  private async screenshot() {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const source = sources[0];
    if (!source) throw new Error("No screen source is available.");
    return {
      message: "Screenshot captured.",
      result: { imageBase64: source.thumbnail.toPNG().toString("base64"), mimeType: "image/png" },
    };
  }

  private async windowList() {
    const script = "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";
    const result = await this.commandRunner("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    return {
      message: result.exitCode === 0 ? "Windows listed." : "Window list failed.",
      result: { exitCode: result.exitCode, windowsJson: truncate(result.stdout), stderr: truncate(result.stderr) },
    };
  }

  private async ahk(script: string, successMessage: string) {
    const result: CommandResult = await this.autoHotkeyService.runScript(script);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "AutoHotkey script failed.");
    }
    return { message: successMessage, result: { stdout: truncate(result.stdout), stderr: truncate(result.stderr) } };
  }

  private knownFolders() {
    const home = os.homedir();
    return {
      message: "Known folders resolved.",
      result: {
        home,
        desktop: path.join(home, "Desktop"),
        documents: path.join(home, "Documents"),
        downloads: path.join(home, "Downloads"),
        publicDesktop: process.env.PUBLIC ? path.join(process.env.PUBLIC, "Desktop") : undefined,
      },
    };
  }

  private requireBridge(permissions: EnginePermissionPolicy) {
    if (!permissions.enabled || !permissions.contextBridge) throw new Error("Windows tools are disabled by permissions.");
  }

  private requireFileWrite(permissions: EnginePermissionPolicy) {
    if (!permissions.fileWrite) throw new Error("File writing is disabled by Hermes permissions.");
  }

  private requireCommandRun(permissions: EnginePermissionPolicy) {
    if (!permissions.commandRun) throw new Error("Command execution is disabled by Hermes permissions.");
  }

  private wrap(tool: WindowsToolName, ok: boolean, message: string, startedAt: number, result?: Record<string, unknown>): WindowsToolExecutionResult {
    console.info("[Windows Tool]", { at: new Date().toISOString(), tool, ok, durationMs: Date.now() - startedAt, message: message.slice(0, 160) });
    return { ok, tool, message, result: redactToolResult(tool, result), durationMs: Date.now() - startedAt };
  }

  private string(input: Record<string, unknown>, key: string, maxLength: number) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Missing required string field: ${key}`);
    if (value.length > maxLength) throw new Error(`Field ${key} is too long.`);
    return value;
  }

  private optionalString(input: Record<string, unknown>, key: string, maxLength: number) {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`Field ${key} must be a string.`);
    if (value.length > maxLength) throw new Error(`Field ${key} is too long.`);
    return value;
  }

  private boolean(input: Record<string, unknown>, key: string, fallback: boolean) {
    return typeof input[key] === "boolean" ? input[key] : fallback;
  }

  private number(input: Record<string, unknown>, key: string) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Missing required number field: ${key}`);
    return Math.round(value);
  }

  private timeout(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
    return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
  }

  private async ensureApproved(
    call: WindowsToolCall,
    permissions: EnginePermissionPolicy,
    context?: { taskRunId?: string; publish?: (event: EngineEvent) => Promise<void> },
  ) {
    const approval = approvalForCall(call);
    if (!approval || !context?.taskRunId || !context.publish || !this.requestApproval) return;
    if ((approval.actionKind === "file_write" || approval.actionKind === "file_delete") && !permissions.fileWrite) return;
    if ((approval.actionKind === "command_run" || approval.actionKind === "window_control" || approval.actionKind === "keyboard_input" || approval.actionKind === "mouse_input" || approval.actionKind === "automation") && !permissions.commandRun) return;
    const decision = await this.requestApproval({
      taskRunId: context.taskRunId,
      title: approval.title,
      command: approval.command,
      path: approval.path,
      patternKey: approval.patternKey,
      actionKind: approval.actionKind,
      details: approval.details,
      risk: approval.risk,
      publish: context.publish,
    });
    if (!decision.approved) {
      throw new Error("用户拒绝批准此高风险 Windows 操作。");
    }
  }
}

function truncate(output: string) {
  const buffer = Buffer.from(output, "utf8");
  if (buffer.length <= MAX_TEXT_BYTES) return output;
  return `${buffer.subarray(0, MAX_TEXT_BYTES).toString("utf8")}\n...[truncated]`;
}

function redactToolResult(tool: WindowsToolName, result: Record<string, unknown> | undefined) {
  if (!result) return undefined;
  if (tool === "windows.clipboard.read" && typeof result.text === "string") {
    return { ...result, text: truncate(result.text) };
  }
  if (tool === "windows.screenshot.capture") {
    return { ...result, imageBase64: "[base64 omitted from chat log]" };
  }
  return result;
}

function quoteAhk(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function assertNeverTool(tool: never): never {
  throw new Error(`Unknown Windows tool: ${tool}`);
}

function approvalForCall(call: WindowsToolCall) {
  const input = call.input ?? {};
  switch (call.tool) {
    case "windows.files.writeText":
      return {
        title: "允许写入 Windows 文件",
        command: typeof input.path === "string" ? input.path : undefined,
        path: typeof input.path === "string" ? input.path : undefined,
        patternKey: `tool:${call.tool}:${typeof input.path === "string" ? input.path.toLowerCase() : "*"}`,
        actionKind: "file_write" as const,
        details: "该操作会在 Windows 上创建或覆盖文件。",
        risk: "high" as const,
      };
    case "windows.files.delete":
      return {
        title: "允许删除 Windows 路径",
        command: typeof input.path === "string" ? input.path : undefined,
        path: typeof input.path === "string" ? input.path : undefined,
        patternKey: `tool:${call.tool}:${typeof input.path === "string" ? input.path.toLowerCase() : "*"}`,
        actionKind: "file_delete" as const,
        details: "该操作会删除文件或目录。",
        risk: "high" as const,
      };
    case "windows.powershell.run":
      return {
        title: "允许执行 PowerShell",
        command: typeof input.script === "string" ? input.script : undefined,
        patternKey: `tool:${call.tool}`,
        actionKind: "command_run" as const,
        details: "该操作会在宿主 Windows 上运行 PowerShell 脚本。",
        risk: "high" as const,
      };
    case "windows.windows.focus":
    case "windows.windows.close":
      return {
        title: "允许控制 Windows 窗口",
        command: typeof input.title === "string" ? input.title : undefined,
        patternKey: `tool:${call.tool}`,
        actionKind: "window_control" as const,
        details: "该操作会激活或关闭桌面窗口。",
        risk: "medium" as const,
      };
    case "windows.keyboard.type":
    case "windows.keyboard.pressHotkey":
      return {
        title: "允许发送键盘输入",
        command: typeof input.text === "string" ? input.text : typeof input.hotkey === "string" ? input.hotkey : undefined,
        patternKey: `tool:${call.tool}`,
        actionKind: "keyboard_input" as const,
        details: "该操作会向当前活动窗口发送键盘输入。",
        risk: "high" as const,
      };
    case "windows.mouse.click":
    case "windows.mouse.move":
      return {
        title: "允许控制鼠标",
        command: JSON.stringify(input),
        patternKey: `tool:${call.tool}`,
        actionKind: "mouse_input" as const,
        details: "该操作会移动或点击宿主鼠标。",
        risk: "medium" as const,
      };
    case "windows.ahk.runScript":
      return {
        title: "允许执行 AutoHotkey 脚本",
        command: typeof input.script === "string" ? input.script : undefined,
        patternKey: `tool:${call.tool}`,
        actionKind: "automation" as const,
        details: "该操作会执行宿主 AutoHotkey 自动化脚本。",
        risk: "high" as const,
      };
    default:
      return undefined;
  }
}
