import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncHermesWindowsMcpConfig, testOnly } from "./hermes-native-mcp-config";

describe("Hermes native MCP config helpers", () => {
  it("inserts the Windows bridge server under a new mcp_servers section", () => {
    const result = testOnly.upsertMcpServer("model:\n  provider: \"custom\"\n", "  windows_control_bridge:\n    command: \"python\"");

    expect(result).toContain("mcp_servers:\n  windows_control_bridge:");
    expect(result).toContain("command: \"python\"");
  });

  it("removes the managed Windows bridge server without touching other servers", () => {
    const result = testOnly.removeManagedServer([
      "model:",
      "  provider: \"custom\"",
      "mcp_servers:",
      "  windows_control_bridge:",
      "    command: \"python\"",
      "    args:",
      "      - \"bridge.py\"",
      "  github:",
      "    command: \"npx\"",
      "",
    ].join("\n"));

    expect(result).not.toContain("windows_control_bridge:");
    expect(result).toContain("github:");
    expect(result).toContain("command: \"npx\"");
  });

  it("replaces only the managed .env block", () => {
    const result = testOnly.removeManagedEnvBlock([
      "OPENAI_BASE_URL=http://127.0.0.1:8081/v1",
      "# >>> hermes-workbench-windows-bridge >>>",
      "HERMES_WINDOWS_BRIDGE_URL=\"http://127.0.0.1:1\"",
      "# <<< hermes-workbench-windows-bridge <<<",
      "CUSTOM_KEEP=1",
      "",
    ].join("\n"));

    expect(result).toContain("OPENAI_BASE_URL=http://127.0.0.1:8081/v1");
    expect(result).toContain("CUSTOM_KEEP=1");
    expect(result).not.toContain("HERMES_WINDOWS_BRIDGE_URL");
  });

  it("writes bridge config into the supplied Hermes home", async () => {
    const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    try {
      const result = await syncHermesWindowsMcpConfig({
        runtime: { mode: "windows", pythonCommand: "python3", windowsAgentMode: "hermes_native" },
        hermesHome,
        bridge: {
          url: "http://127.0.0.1:12345",
          token: "test-token",
          capabilities: "tool,manifest",
        },
      });

      expect(result.configPath).toBe(path.join(hermesHome, "config.yaml"));
      expect(result.envPath).toBe(path.join(hermesHome, ".env"));
      await expect(fs.readFile(path.join(hermesHome, "config.yaml"), "utf8")).resolves.toContain("windows_control_bridge:");
      await expect(fs.readFile(path.join(hermesHome, ".env"), "utf8")).resolves.toContain("HERMES_WINDOWS_BRIDGE_URL");
    } finally {
      await fs.rm(hermesHome, { recursive: true, force: true });
    }
  });

  it("uses the configured Windows Python command for the MCP server", async () => {
    const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-"));
    try {
      await syncHermesWindowsMcpConfig({
        runtime: { mode: "windows", pythonCommand: "C:\\Python\\python.exe", windowsAgentMode: "hermes_native" },
        hermesHome,
        bridge: {
          url: "http://127.0.0.1:12345",
          token: "test-token",
          capabilities: "tool,manifest",
        },
      });

      const config = await fs.readFile(path.join(hermesHome, "config.yaml"), "utf8");
      expect(config).toContain('command: "C:\\\\Python\\\\python.exe"');
      expect(config).not.toContain('- "-3"');
    } finally {
      await fs.rm(hermesHome, { recursive: true, force: true });
    }
  });
});
