import { describe, expect, it, vi } from "vitest";
import { createResilientStorage } from "./resilientStorage";

describe("preference storage fallback", () => {
  it("ignores invalid JSON and inaccessible storage", () => {
    const corrupt = createResilientStorage(() => ({ getItem: () => "{broken" }) as unknown as Storage);
    expect(corrupt.getItem("preferences")).toBeNull();
    const denied = createResilientStorage(() => { throw new Error("denied"); });
    expect(denied.getItem("preferences")).toBeNull();
    const value = { state: { firstLaunch: false }, version: 0 };
    expect(() => denied.setItem("preferences", value)).not.toThrow();
    expect(denied.getItem("preferences")).toEqual(value);
    denied.removeItem("preferences");
    expect(denied.getItem("preferences")).toBeNull();
  });

  it("retains current preferences in memory while full and resumes writes after recovery", () => {
    const disk = new Map<string, string>();
    const setItem = vi.fn((name: string, value: string) => { disk.set(name, value); });
    const storage = createResilientStorage(() => ({ getItem: (name: string) => disk.get(name) ?? null, setItem }) as unknown as Storage);
    const first = { state: { firstLaunch: true } };
    storage.setItem("ui", first);
    setItem.mockImplementationOnce(() => { throw new DOMException("full", "QuotaExceededError"); });
    const current = { state: { firstLaunch: false } };
    expect(() => storage.setItem("ui", current)).not.toThrow();
    expect(storage.getItem("ui")).toEqual(current);
    expect(JSON.parse(disk.get("ui")!)).toEqual(first);
    storage.setItem("ui", current);
    expect(JSON.parse(disk.get("ui")!)).toEqual(current);
  });
});
