import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isSafeExternalUrl, isTrustedAppUrl } from "./navigation-security";

const builtEntryPath = path.resolve("dist/renderer/index.html");

describe("navigation security", () => {
  it("trusts only the packaged renderer entry for file URLs", () => {
    expect(isTrustedAppUrl(pathToFileURL(builtEntryPath).toString(), { builtEntryPath })).toBe(true);
    expect(isTrustedAppUrl(pathToFileURL(path.resolve("dist/renderer/other.html")).toString(), { builtEntryPath })).toBe(false);
  });

  it("trusts only the configured development origin", () => {
    const options = { builtEntryPath, devServerUrl: "http://127.0.0.1:5173" };
    expect(isTrustedAppUrl("http://127.0.0.1:5173/settings", options)).toBe(true);
    expect(isTrustedAppUrl("http://127.0.0.1.evil.example:5173/", options)).toBe(false);
    expect(isTrustedAppUrl("https://example.com/", options)).toBe(false);
  });

  it("allows only browser-safe external protocols", () => {
    expect(isSafeExternalUrl("https://example.com/help")).toBe(true);
    expect(isSafeExternalUrl("mailto:support@example.com")).toBe(true);
    expect(isSafeExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
