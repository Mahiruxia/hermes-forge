import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Dirent } from "node:fs";
import { runCommand, type CommandResult } from "../process/command-runner";
import type { EngineEvent, EngineRunRequest } from "../shared/types";

const now = () => new Date().toISOString();

export type WindowsNativeIntentResult = {
  handled: true;
  events: EngineEvent[];
};

export class WindowsNativeIntentService {
  constructor(
    private readonly getDesktopPaths: () => string[] = defaultDesktopPaths,
    private readonly requestApproval?: (input: {
      taskRunId: string;
      title: string;
      command?: string;
      path?: string;
      patternKey: string;
      actionKind: "file_write";
      details?: string;
      risk: "low" | "medium" | "high";
      publish: (event: EngineEvent) => Promise<void>;
    }) => Promise<{ approved: boolean }>,
    private readonly commandRunner: typeof runCommand = runCommand,
  ) {}

  async tryHandle(
    request: EngineRunRequest,
    publish?: (event: EngineEvent) => Promise<void>,
  ): Promise<WindowsNativeIntentResult | undefined> {
    const text = normalizeText(request.userInput);
    if (!this.isWindowsDesktopIntent(text)) {
      return undefined;
    }
    if (this.isCreateTextFileIntent(text)) {
      return this.createDesktopTextFile(request, publish);
    }
    if (this.isCountDesktopItemsIntent(text)) {
      return this.countDesktopItems(request);
    }
    if (this.isOpenDesktopEdgeIntent(text)) {
      return this.openDesktopEdge(request);
    }
    return undefined;
  }

  private async createDesktopTextFile(
    request: EngineRunRequest,
    publish?: (event: EngineEvent) => Promise<void>,
  ): Promise<WindowsNativeIntentResult> {
    const blocked = this.permissionBlocked(request, "fileWrite");
    if (blocked) {
      return resultOnly(false, "Windows 原生操作被权限关闭", blocked);
    }

    const desktopPath = this.primaryDesktopPath();
    const fileName = sanitizeTextFileName(extractRequestedFileName(request.userInput) ?? "新建文本文档.txt");
    const targetPath = await uniqueFilePath(path.join(desktopPath, fileName));
    const content = extractRequestedContent(request.userInput) ?? "";

    if (publish && this.requestApproval) {
      const decision = await this.requestApproval({
        taskRunId: request.sessionId,
        title: "允许在 Windows 桌面创建文本文件",
        command: targetPath,
        path: targetPath,
        patternKey: `native:file_write:${targetPath.toLowerCase()}`,
        actionKind: "file_write",
        details: "该操作会绕过模型推理，直接在 Windows 桌面写入文件。",
        risk: "high",
        publish,
      });
      if (!decision.approved) {
        return resultOnly(false, "用户拒绝批准", "用户拒绝批准该 Windows 原生文件写入操作。");
      }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");

    return {
      handled: true,
      events: [
        { type: "tool_call", toolName: "windows.writeTextFile", argsPreview: targetPath, at: now() },
        { type: "file_change", changeType: "create", path: targetPath, at: now() },
        {
          type: "result",
          success: true,
          title: "已在 Windows 桌面创建文本文件",
          detail: content
            ? `文件已创建：${targetPath}\n已写入内容：${content}`
            : `文件已创建：${targetPath}`,
          at: now(),
        },
      ],
    };
  }

  private async countDesktopItems(request: EngineRunRequest): Promise<WindowsNativeIntentResult> {
    const blocked = this.permissionBlocked(request, "workspaceRead");
    if (blocked) {
      return resultOnly(false, "Windows 原生操作被权限关闭", blocked);
    }

    const desktopPaths = this.getDesktopPaths();
    const collected = new Map<string, { name: string; source: string; kind: "folder" | "file" }>();
    for (const desktopPath of desktopPaths) {
      const entries = await fs.readdir(desktopPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!isVisibleDesktopEntry(entry)) continue;
        const key = entry.name.toLocaleLowerCase();
        if (!collected.has(key)) {
          collected.set(key, {
            name: entry.name,
            source: desktopPath,
            kind: entry.isDirectory() ? "folder" : "file",
          });
        }
      }
    }

    const items = [...collected.values()];
    const folderCount = items.filter((item) => item.kind === "folder").length;
    const fileCount = items.length - folderCount;
    const sample = items.slice(0, 12).map((item) => item.name).join("、");
    return {
      handled: true,
      events: [
        {
          type: "tool_call",
          toolName: "windows.countDesktopItems",
          argsPreview: desktopPaths.join("; "),
          at: now(),
        },
        {
          type: "result",
          success: true,
          title: "已读取 Windows 桌面项目数量",
          detail: [
            `当前 Windows 桌面物理项目共有 ${items.length} 个。`,
            `其中 ${folderCount} 个文件夹，${fileCount} 个文件/快捷方式。`,
            sample ? `前几个项目：${sample}` : "桌面目录里没有可见项目。",
            "说明：这里统计的是用户桌面和公共桌面目录中的可见文件/文件夹，不包含系统虚拟图标。",
          ].join("\n"),
          at: now(),
        },
      ],
    };
  }

  private async openDesktopEdge(request: EngineRunRequest): Promise<WindowsNativeIntentResult> {
    const blocked = this.permissionBlocked(request, "commandRun");
    if (blocked) {
      return resultOnly(false, "Windows 原生操作被权限关闭", blocked);
    }

    const desktopPaths = this.getDesktopPaths();
    const shortcut = await findDesktopEntry(desktopPaths, /(?:^|[^a-z])(?:microsoft\s*)?edge(?:\.lnk)?$/i);
    const target = shortcut ?? "microsoft-edge:";
    const result = await this.commandRunner("cmd.exe", ["/c", "start", "", target], {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    const ok = result.exitCode === 0 || result.exitCode === null;

    return {
      handled: true,
      events: [
        {
          type: "tool_call",
          toolName: "windows.shell.openPath",
          argsPreview: target,
          at: now(),
        },
        {
          type: "result",
          success: ok,
          title: ok ? "已打开 Microsoft Edge" : "打开 Microsoft Edge 失败",
          detail: ok
            ? shortcut
              ? `已通过桌面快捷方式打开：${shortcut}`
              : "未在桌面找到 Edge 快捷方式，已改用 microsoft-edge: 协议启动。"
            : `Windows shell 启动失败：${trimCommandFailure(result)}`,
          at: now(),
        },
      ],
    };
  }


  private isWindowsDesktopIntent(text: string) {
    return text.includes("桌面") || /desktop/i.test(text);
  }

  private isCreateTextFileIntent(text: string) {
    return /(创建|新建|添加|生成|建立).*(txt|文本|文本文档)|(?:txt|文本|文本文档).*(创建|新建|添加|生成|建立)/i.test(text);
  }

  private isCountDesktopItemsIntent(text: string) {
    return /(几个|多少|数量|count|how many).*(图标|文件|项目|快捷方式|应用|app)|(?:图标|文件|项目|快捷方式|应用|app).*(几个|多少|数量|count|how many)/i.test(text);
  }

  private isOpenDesktopEdgeIntent(text: string) {
    return /(打开|启动|运行|open|launch).*(edge|microsoft edge|浏览器)|(?:edge|microsoft edge|浏览器).*(打开|启动|运行|open|launch)/i.test(text);
  }

  private permissionBlocked(request: EngineRunRequest, operation: "fileWrite" | "workspaceRead" | "commandRun") {
    if (request.permissions?.contextBridge === false) {
      return "contextBridge=false，Windows 原生执行层被权限关闭。请到高级设置中开启 Hermes 的桥接上下文权限。";
    }
    if (operation === "fileWrite" && request.permissions?.fileWrite === false) {
      return "fileWrite=false，当前不允许写入 Windows 文件。请到高级设置中开启 Hermes 的文件写入权限。";
    }
    if (operation === "workspaceRead" && request.permissions?.workspaceRead === false) {
      return "workspaceRead=false，当前不允许读取 Windows 桌面目录。请到高级设置中开启 Hermes 的项目读取权限。";
    }
    if (operation === "commandRun" && request.permissions?.commandRun === false) {
      return "commandRun=false，当前不允许启动 Windows 程序。请到高级设置中开启 Hermes 的命令运行权限。";
    }
    return undefined;
  }

  private primaryDesktopPath() {
    return this.getDesktopPaths()[0] ?? path.join(os.homedir(), "Desktop");
  }
}

function resultOnly(success: boolean, title: string, detail: string): WindowsNativeIntentResult {
  return {
    handled: true,
    events: [{ type: "result", success, title, detail, at: now() }],
  };
}

function defaultDesktopPaths() {
  return [
    path.join(os.homedir(), "Desktop"),
    process.env.PUBLIC ? path.join(process.env.PUBLIC, "Desktop") : "",
  ].filter(Boolean);
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function extractRequestedFileName(text: string) {
  const explicit = text.match(/(?:文件名(?:叫|为|是)?|名字(?:叫|为|是)?|名称(?:叫|为|是)?|叫做|命名为|名为|叫)\s*[：:]?\s*["“]?([^"”\n，。,.]+?\.txt)/i);
  if (explicit?.[1]) {
    return explicit[1].trim();
  }
  const txtName = text.match(/["“]?([^"”\n，。,.\\/:*?<>|]+?\.txt)["”]?/i);
  return txtName?.[1]?.trim();
}

function extractRequestedContent(text: string) {
  const match = text.match(/(?:内容(?:写|为|是)?|写入|写上)\s*[：:]?\s*["“]?(.+?)["”]?\s*$/i);
  return match?.[1]?.trim();
}

function sanitizeTextFileName(fileName: string) {
  const safe = fileName.replace(/[\\/:*?"<>|]/g, "_").trim() || "新建文本文档.txt";
  return safe.toLocaleLowerCase().endsWith(".txt") ? safe : `${safe}.txt`;
}

async function uniqueFilePath(targetPath: string) {
  const parsed = path.parse(targetPath);
  let candidate = targetPath;
  let index = 2;
  while (await exists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isVisibleDesktopEntry(entry: Dirent) {
  return !entry.name.startsWith(".") && entry.name !== "desktop.ini";
}

async function findDesktopEntry(desktopPaths: string[], pattern: RegExp) {
  for (const desktopPath of desktopPaths) {
    const entries = await fs.readdir(desktopPath, { withFileTypes: true }).catch(() => []);
    const entry = entries.find((item) => isVisibleDesktopEntry(item) && item.isFile() && pattern.test(item.name));
    if (entry) {
      return path.join(desktopPath, entry.name);
    }
  }
  return undefined;
}

function trimCommandFailure(result: CommandResult) {
  return [result.stderr, result.stdout, `exit ${result.exitCode ?? "unknown"}`]
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, 500);
}
