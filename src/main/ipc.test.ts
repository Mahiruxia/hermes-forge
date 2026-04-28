import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: class {},
  clipboard: { writeText: vi.fn() },
  dialog: {},
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

import { testOnly } from "./ipc";

describe("ipc safety helpers", () => {
  it("rejects executable, UNC, and relative paths for generic openPath", () => {
    expect(testOnly.validateOpenablePath("\\\\evil\\share\\payload.exe").ok).toBe(false);
    expect(testOnly.validateOpenablePath("payload.txt").ok).toBe(false);
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Desktop\\payload.ps1").ok).toBe(false);
  });

  it("allows safe local document paths for generic openPath", () => {
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Desktop\\notes.md")).toMatchObject({ ok: true });
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Desktop\\report.pdf")).toMatchObject({ ok: true });
  });

  it("allows existing local directories after stat validation", () => {
    expect(testOnly.validateOpenablePath("C:\\Users\\xia\\Hermes Agent", { isDirectory: true })).toMatchObject({ ok: true });
  });

  it("rejects private model endpoints unless explicitly allowed", () => {
    expect(testOnly.validateOutboundModelBaseUrl("http://127.0.0.1:6379/v1").ok).toBe(false);
    expect(testOnly.validateOutboundModelBaseUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(testOnly.validateOutboundModelBaseUrl("http://redis:6379/v1").ok).toBe(false);
    expect(testOnly.validateOutboundModelBaseUrl("http://127.0.0.1:11434/v1", { allowPrivateNetwork: true }).ok).toBe(true);
  });
});
