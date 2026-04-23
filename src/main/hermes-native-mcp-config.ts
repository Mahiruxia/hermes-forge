import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HermesRuntimeConfig } from "../shared/types";
import { toWslPath } from "../adapters/hermes/hermes-cli-adapter";

type BridgeAccess = {
  url: string;
  token: string;
  capabilities: string;
};

type SyncInput = {
  runtime: HermesRuntimeConfig;
  bridge?: BridgeAccess;
  hermesHome?: string;
};

const SERVER_NAME = "windows_control_bridge";
const DEFAULT_CONFIG = "model:\n  provider: \"auto\"\n";

export async function syncHermesWindowsMcpConfig(input: SyncInput) {
  const hermesHome = input.hermesHome?.trim() || path.join(os.homedir(), ".hermes");
  const configPath = path.join(hermesHome, "config.yaml");
  const envPath = path.join(hermesHome, ".env");
  const existing = await fs.readFile(configPath, "utf8").catch(() => DEFAULT_CONFIG);
  const withoutServer = removeManagedServer(existing);
  const bridge = input.runtime.windowsAgentMode !== "disabled" ? input.bridge : undefined;
  const next = bridge ? upsertMcpServer(withoutServer, await buildServerBlock(input.runtime, bridge)) : withoutServer;
  if (next !== existing) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, next, "utf8");
  }
  await syncHermesWindowsEnv(envPath, bridge);
  return {
    configPath,
    envPath,
    enabled: Boolean(bridge),
    serverName: SERVER_NAME,
  };
}

async function buildServerBlock(runtime: HermesRuntimeConfig, bridge: BridgeAccess) {
  const scriptPath = await mcpServerScriptPath(runtime);
  const configuredPython = runtime.pythonCommand?.trim();
  const command = runtime.mode === "wsl" ? configuredPython || "python3" : configuredPython || "python";
  const args = [scriptPath];
  return [
    `  ${SERVER_NAME}:`,
    `    command: ${yamlString(command)}`,
    "    args:",
    ...args.map((arg) => `      - ${yamlString(arg)}`),
    "    env:",
    `      HERMES_WINDOWS_BRIDGE_URL: ${yamlString(bridge.url)}`,
    `      HERMES_WINDOWS_BRIDGE_TOKEN: ${yamlString(bridge.token)}`,
    `      HERMES_WINDOWS_BRIDGE_CAPABILITIES: ${yamlString(bridge.capabilities)}`,
    "    timeout: 120",
    "    connect_timeout: 15",
  ].join("\n");
}

async function mcpServerScriptPath(runtime: HermesRuntimeConfig) {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };
  const packagedPath = processWithResources.resourcesPath
    ? path.join(processWithResources.resourcesPath, "hermes-windows-mcp-server.py")
    : undefined;
  const devPath = path.resolve(process.cwd(), "resources", "hermes-windows-mcp-server.py");
  const scriptPath = packagedPath && await exists(packagedPath) ? packagedPath : devPath;
  return runtime.mode === "wsl" ? toWslPath(scriptPath) : scriptPath;
}

async function exists(filePath: string) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function removeManagedServer(content: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const next: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{2}windows_control_bridge:\s*$/.test(line)) {
      index += 1;
      while (index < lines.length && (/^\s{4,}\S/.test(lines[index]) || /^\s*$/.test(lines[index]))) {
        index += 1;
      }
      index -= 1;
      continue;
    }
    next.push(line);
  }
  return trimTrailingBlankLines(next).join("\n") + "\n";
}

function upsertMcpServer(content: string, serverBlock: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const mcpIndex = lines.findIndex((line) => /^mcp_servers:\s*$/.test(line));
  if (mcpIndex === -1) {
    return `${trimTrailingBlankLines(lines).join("\n")}\n\nmcp_servers:\n${serverBlock}\n`;
  }
  const next = [...lines];
  next.splice(mcpIndex + 1, 0, serverBlock);
  return trimTrailingBlankLines(next).join("\n") + "\n";
}

async function syncHermesWindowsEnv(envPath: string, bridge: BridgeAccess | undefined) {
  const existing = await fs.readFile(envPath, "utf8").catch(() => "");
  const withoutBlock = removeManagedEnvBlock(existing);
  const next = bridge ? `${withoutBlock}${withoutBlock.endsWith("\n") || !withoutBlock ? "" : "\n"}${buildEnvBlock(bridge)}` : withoutBlock;
  if (next !== existing) {
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(envPath, next, "utf8");
  }
}

function buildEnvBlock(bridge: BridgeAccess) {
  return [
    "# >>> hermes-workbench-windows-bridge >>>",
    `HERMES_WINDOWS_BRIDGE_URL=${quoteEnv(bridge.url)}`,
    `HERMES_WINDOWS_BRIDGE_TOKEN=${quoteEnv(bridge.token)}`,
    `HERMES_WINDOWS_BRIDGE_CAPABILITIES=${quoteEnv(bridge.capabilities)}`,
    `HERMES_WINDOWS_TOOL_MANIFEST_URL=${quoteEnv(`${bridge.url}/v1/manifest`)}`,
    "HERMES_WINDOWS_AGENT_MODE=hermes_native",
    "# <<< hermes-workbench-windows-bridge <<<",
    "",
  ].join("\n");
}

function removeManagedEnvBlock(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/# >>> hermes-workbench-windows-bridge >>>\n[\s\S]*?# <<< hermes-workbench-windows-bridge <<<\n?/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function trimTrailingBlankLines(lines: string[]) {
  const next = [...lines];
  while (next.length && next[next.length - 1].trim() === "") {
    next.pop();
  }
  return next;
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function quoteEnv(value: string) {
  return JSON.stringify(value);
}

export const testOnly = {
  removeManagedServer,
  upsertMcpServer,
  removeManagedEnvBlock,
  buildEnvBlock,
};
