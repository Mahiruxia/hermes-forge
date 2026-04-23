import { runCommand, type CommandResult } from "../process/command-runner";
import {
  resolveEnginePermissions,
  type BridgeTestStep,
  type BridgeTestStepId,
  type BridgeTestStepStatus,
  type HermesRuntimeConfig,
  type HermesWindowsBridgeTestResult,
  type RuntimeConfig,
} from "../shared/types";
import type { WindowsControlBridge } from "./windows-control-bridge";
import type { WindowsToolExecutor } from "./windows-tool-executor";

const DEFAULT_RUNTIME: HermesRuntimeConfig = { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" };
const WSL_TIMEOUT_MS = 8000;
const POWERSHELL_SMOKE_SCRIPT = "$PSVersionTable.PSVersion.ToString()";

type CommandRunner = typeof runCommand;
type Fetcher = typeof fetch;

export class HermesWindowsBridgeTestService {
  constructor(
    private readonly bridge: WindowsControlBridge,
    private readonly readConfig: () => Promise<RuntimeConfig>,
    private readonly appFetch: Fetcher = fetch,
    private readonly run: CommandRunner = runCommand,
    private readonly windowsToolExecutor?: WindowsToolExecutor,
  ) {}

  async test(): Promise<HermesWindowsBridgeTestResult> {
    await this.bridge.start();
    const config = await this.readConfig();
    const runtime = config.hermesRuntime ?? DEFAULT_RUNTIME;
    const permissions = resolveEnginePermissions(config, "hermes");
    const steps: BridgeTestStep[] = [];

    const localAccess = this.bridge.accessForHost("127.0.0.1");
    const bridgeStatus = this.bridge.status();
    steps.push(makeStep({
      id: "bridge-running",
      label: "Windows Control Bridge 已启动",
      status: bridgeStatus.running && localAccess ? "passed" : "failed",
      message: bridgeStatus.running && localAccess
        ? `Bridge 正在监听端口 ${bridgeStatus.port ?? "unknown"}。`
        : "Bridge 未启动。请重启应用，或检查主进程启动日志。",
      detail: bridgeStatus.message,
    }));

    if (!localAccess) {
      steps.push(...skippedAfterBridge(runtime.mode));
      return buildBridgeTestResult(runtime.mode, undefined, steps);
    }

    steps.push(await this.testLocalHealth(localAccess.url, localAccess.token));

    if (runtime.mode !== "wsl") {
      steps.push(
        makeStep({
          id: "wsl-available",
          label: "WSL 可用性",
          status: "skipped",
          message: "当前 Hermes 运行位置是 Windows，WSL 专属诊断已跳过。",
        }),
        makeStep({
          id: "wsl-host-resolved",
          label: "WSL 内 Windows Host 解析",
          status: "skipped",
          message: "当前未启用 WSL 模式，不需要解析 Windows host。",
        }),
        makeStep({
          id: "bridge-health-from-wsl",
          label: "WSL 访问 Bridge health",
          status: "skipped",
          message: "当前未启用 WSL 模式，不需要从 WSL 访问 Bridge。",
        }),
        makeStep({
          id: "powershell-smoke",
          label: "PowerShell smoke test",
          status: "skipped",
          message: "当前未启用 WSL 模式，PowerShell smoke 已跳过。",
        }),
      );
      steps.push(...await this.agentCapabilitySteps(permissions.commandRun, permissions.fileWrite));
      return buildBridgeTestResult(runtime.mode, localAccess.url, steps);
    }

    const wslArgs = wslDistroArgs(runtime);
    const available = await timedStep("wsl-available", "WSL 可用性", async () => {
      const result = await this.run("wsl.exe", [...wslArgs, "sh", "-lc", "uname -a"], {
        cwd: process.cwd(),
        timeoutMs: WSL_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return failed("WSL 不可用或发行版名称不正确。请检查 WSL 是否启用，以及 distro 名称是否正确。", commandDetail(result));
      }
      return passed("WSL 命令可执行。", result.stdout.trim().slice(0, 300));
    });
    steps.push(available);

    if (available.status === "failed") {
      steps.push(
        makeStep({
          id: "wsl-host-resolved",
          label: "WSL 内 Windows Host 解析",
          status: "skipped",
          message: "WSL 不可用，跳过 host 解析。",
        }),
        makeStep({
          id: "bridge-health-from-wsl",
          label: "WSL 访问 Bridge health",
          status: "skipped",
          message: "WSL 不可用，跳过 Bridge health。",
        }),
        makeStep({
          id: "powershell-smoke",
          label: "PowerShell smoke test",
          status: "skipped",
          message: "WSL 不可用，跳过 PowerShell smoke。",
        }),
      );
      return buildBridgeTestResult(runtime.mode, localAccess.url, steps);
    }

    const hostStepResult = await this.resolveWslHost(wslArgs);
    steps.push(hostStepResult.step);
    const wslAccess = this.bridge.accessForHost(hostStepResult.host);
    if (!wslAccess) {
      steps.push(
        makeStep({
          id: "bridge-health-from-wsl",
          label: "WSL 访问 Bridge health",
          status: "failed",
          message: "Bridge access 信息不可用。请重启应用后重试。",
        }),
        makeStep({
          id: "powershell-smoke",
          label: "PowerShell smoke test",
          status: "skipped",
          message: "Bridge access 信息不可用，PowerShell smoke 已跳过。",
        }),
      );
      return buildBridgeTestResult(runtime.mode, localAccess.url, steps);
    }

    const wslHealth = await this.testFromWsl(
      "bridge-health-from-wsl",
      "WSL 访问 Bridge health",
      wslArgs,
      bridgeRequestScript(wslAccess.url, wslAccess.token, "/v1/health"),
      "WSL 可以访问 Windows Control Bridge。",
      "WSL 无法访问 Windows Control Bridge。请允许当前 Electron 应用通过 Windows 防火墙的专用网络访问。",
    );
    steps.push(wslHealth);

    if (!permissions.commandRun) {
      steps.push(makeStep({
        id: "powershell-smoke",
        label: "PowerShell smoke test",
        status: "skipped",
        message: "commandRun=false，PowerShell smoke 按预期跳过。",
      }));
      steps.push(...await this.agentCapabilitySteps(false, permissions.fileWrite));
      return buildBridgeTestResult(runtime.mode, wslAccess.url, steps);
    }

    steps.push(await this.testFromWsl(
      "powershell-smoke",
      "PowerShell smoke test",
      wslArgs,
      bridgeRequestScript(wslAccess.url, wslAccess.token, "/v1/powershell", "POST", {
        script: POWERSHELL_SMOKE_SCRIPT,
      }),
      "WSL 已通过 Bridge 成功调用 PowerShell。",
      "WSL 调用 PowerShell 失败。若返回 403，请检查 contextBridge/commandRun 权限；若连接失败，请检查 Windows 防火墙。",
    ));
    steps.push(...await this.agentCapabilitySteps(true, permissions.fileWrite));

    return buildBridgeTestResult(runtime.mode, wslAccess.url, steps);
  }

  private async agentCapabilitySteps(commandRun: boolean, fileWrite: boolean) {
    if (!this.windowsToolExecutor) {
      return [];
    }
    const steps: BridgeTestStep[] = [];
    steps.push(await timedStep("files-write-smoke", "文件写入 smoke", async () => {
      if (!fileWrite) return { status: "skipped" as const, message: "fileWrite=false，文件写入 smoke 已跳过。" };
      const targetPath = `${process.env.TEMP ?? process.cwd()}\\hermes-agent-smoke-${Date.now()}.txt`;
      const result = await this.windowsToolExecutor!.execute({ type: "tool_call", tool: "windows.files.writeText", input: { path: targetPath, content: "ok" } });
      return result.ok ? passed("Windows 文件写入工具可用。", targetPath) : failed(result.message);
    }));
    steps.push(await timedStep("clipboard-smoke", "剪贴板 smoke", async () => {
      const result = await this.windowsToolExecutor!.execute({ type: "tool_call", tool: "windows.clipboard.read", input: {} });
      return result.ok ? passed("剪贴板读取工具可用。") : failed(result.message);
    }));
    steps.push(await timedStep("screenshot-smoke", "截图 smoke", async () => {
      if (!commandRun) return { status: "skipped" as const, message: "commandRun=false，截图 smoke 已跳过。" };
      const result = await this.windowsToolExecutor!.execute({ type: "tool_call", tool: "windows.screenshot.capture", input: {} });
      return result.ok ? passed("截图工具可用。") : failed(result.message);
    }));
    steps.push(await timedStep("autohotkey-detected", "AutoHotkey 探测", async () => {
      const status = await this.windowsToolExecutor!.autoHotkeyStatus();
      return status.available ? passed(status.message, status.executablePath) : failed(status.message);
    }));
    steps.push(await timedStep("windows-list-smoke", "窗口列表 smoke", async () => {
      if (!commandRun) return { status: "skipped" as const, message: "commandRun=false，窗口列表 smoke 已跳过。" };
      const result = await this.windowsToolExecutor!.execute({ type: "tool_call", tool: "windows.windows.list", input: {} });
      return result.ok ? passed("窗口列表工具可用。") : failed(result.message);
    }));
    steps.push(makeStep({
      id: "keyboard-dry-smoke",
      label: "键鼠 dry smoke",
      status: commandRun ? "passed" : "skipped",
      message: commandRun ? "键鼠工具已注册；为避免诊断时误输入，本步骤只做 dry smoke。" : "commandRun=false，键鼠 dry smoke 已跳过。",
    }));
    return steps;
  }

  private async testLocalHealth(url: string, token: string) {
    return timedStep("bridge-health-local", "本机 Bridge health", async () => {
      try {
        const response = await this.appFetch(`${url}/v1/health`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(WSL_TIMEOUT_MS),
        });
        const text = await response.text();
        if (!response.ok) {
          return failed(httpFailureMessage(response.status), text.slice(0, 500));
        }
        return passed("本机可以访问 Bridge health。", text.slice(0, 500));
      } catch (error) {
        return failed("本机 Bridge health 失败。请检查 Bridge token/端口或本机服务状态。", errorMessage(error));
      }
    });
  }

  private async resolveWslHost(wslArgs: string[]) {
    const step = await timedStep("wsl-host-resolved", "WSL 内 Windows Host 解析", async () => {
      const result = await this.run("wsl.exe", [...wslArgs, "ip", "route", "show", "default"], {
        cwd: process.cwd(),
        timeoutMs: WSL_TIMEOUT_MS,
      });
      const parsed = parseWslNameserver(result.stdout);
      if (result.exitCode === 0 && parsed) {
        return passed(`已解析 Windows host：${parsed}`, result.stdout.trim());
      }
      return passed("未能从 WSL 默认路由解析 Windows host，已 fallback 到 127.0.0.1。", commandDetail(result));
    });
    const host = parseHostFromStep(step) ?? "127.0.0.1";
    return { host, step };
  }

  private async testFromWsl(
    id: BridgeTestStepId,
    label: string,
    wslArgs: string[],
    script: string,
    successMessage: string,
    failureMessage: string,
  ) {
    return timedStep(id, label, async () => {
      const result = await this.run("wsl.exe", [...wslArgs, "sh", "-lc", script], {
        cwd: process.cwd(),
        timeoutMs: WSL_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return failed(failureMessage, commandDetail(result));
      }
      if (/"ok"\s*:\s*false/.test(result.stdout)) {
        return failed(failureMessage, commandDetail(result));
      }
      return passed(successMessage, result.stdout.trim().slice(0, 500));
    });
  }
}

export function buildBridgeTestResult(
  mode: HermesRuntimeConfig["mode"],
  bridgeUrl: string | undefined,
  steps: BridgeTestStep[],
): HermesWindowsBridgeTestResult {
  const failedStep = steps.find((step) => step.status === "failed");
  return {
    ok: !failedStep,
    mode,
    bridgeUrl,
    steps,
    message: failedStep
      ? `诊断未通过：${failedStep.label}。${failedStep.message}`
      : "WSL + Windows Bridge 诊断通过。",
  };
}

export function wslDistroArgs(runtime: HermesRuntimeConfig) {
  return runtime.distro?.trim() ? ["-d", runtime.distro.trim()] : [];
}

export function parseWslNameserver(stdout: string) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) => line.includes(" via ")) ?? lines[0] ?? "";
  return first.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
}

function skippedAfterBridge(mode: HermesRuntimeConfig["mode"]) {
  const labels: Array<[BridgeTestStepId, string]> = [
    ["bridge-health-local", "本机 Bridge health"],
    ["wsl-available", "WSL 可用性"],
    ["wsl-host-resolved", "WSL 内 Windows Host 解析"],
    ["bridge-health-from-wsl", "WSL 访问 Bridge health"],
    ["powershell-smoke", "PowerShell smoke test"],
  ];
  return labels.map(([id, label]) => makeStep({
    id,
    label,
    status: "skipped",
    message: mode === "wsl" ? "Bridge 未启动，后续诊断已跳过。" : "Bridge 未启动，后续诊断已跳过。",
  }));
}

function bridgeRequestScript(
  url: string,
  token: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
) {
  const bodyJson = body ? JSON.stringify(body) : "";
  const curlBody = body ? ` --data ${shellQuote(bodyJson)}` : "";
  const pythonBody = body ? shellQuote(bodyJson) : "None";
  return [
    `BRIDGE_URL=${shellQuote(url)}`,
    `BRIDGE_TOKEN=${shellQuote(token)}`,
    `REQUEST_PATH=${shellQuote(path)}`,
    `REQUEST_METHOD=${shellQuote(method)}`,
    `REQUEST_BODY=${body ? shellQuote(bodyJson) : "''"}`,
    "if command -v curl >/dev/null 2>&1; then",
    `  curl -sS --fail --max-time 8 -X "$REQUEST_METHOD" "$BRIDGE_URL$REQUEST_PATH" -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json"${curlBody}`,
    "else",
    `  python3 -c ${shellQuote(pythonRequestSource())} "$BRIDGE_URL$REQUEST_PATH" "$BRIDGE_TOKEN" "$REQUEST_METHOD" ${pythonBody}`,
    "fi",
  ].join("\n");
}

function pythonRequestSource() {
  return [
    "import sys, urllib.request",
    "url, token, method = sys.argv[1], sys.argv[2], sys.argv[3]",
    "body = None if len(sys.argv) < 5 or sys.argv[4] == 'None' else sys.argv[4].encode('utf-8')",
    "req = urllib.request.Request(url, data=body, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})",
    "with urllib.request.urlopen(req, timeout=8) as resp:",
    "    sys.stdout.write(resp.read().decode('utf-8'))",
  ].join("; ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function timedStep(
  id: BridgeTestStepId,
  label: string,
  execute: () => Promise<Pick<BridgeTestStep, "status" | "message" | "detail">>,
) {
  const startedAt = Date.now();
  try {
    return makeStep({ id, label, ...(await execute()), durationMs: Date.now() - startedAt });
  } catch (error) {
    return makeStep({
      id,
      label,
      status: "failed",
      message: "诊断步骤执行失败。",
      detail: errorMessage(error),
      durationMs: Date.now() - startedAt,
    });
  }
}

function makeStep(input: {
  id: BridgeTestStepId;
  label: string;
  status: BridgeTestStepStatus;
  message: string;
  durationMs?: number;
  detail?: string;
}): BridgeTestStep {
  return input;
}

function passed(message: string, detail?: string) {
  return { status: "passed" as const, message, detail };
}

function failed(message: string, detail?: string) {
  return { status: "failed" as const, message, detail };
}

function commandDetail(result: CommandResult) {
  return [
    `exitCode=${result.exitCode ?? "null"}`,
    result.stdout.trim() ? `stdout: ${result.stdout.trim().slice(0, 1000)}` : "",
    result.stderr.trim() ? `stderr: ${result.stderr.trim().slice(0, 1000)}` : "",
  ].filter(Boolean).join("\n");
}

function httpFailureMessage(status: number) {
  if (status === 401) return "Bridge 鉴权失败。请检查 token 注入/鉴权逻辑。";
  if (status === 403) return "Bridge 权限拒绝。请检查 contextBridge 或相关 Hermes 权限。";
  return `Bridge health 返回 HTTP ${status}。`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseHostFromStep(step: BridgeTestStep) {
  const match = step.message.match(/已解析 Windows host：(.+)$/);
  return match?.[1]?.trim();
}
