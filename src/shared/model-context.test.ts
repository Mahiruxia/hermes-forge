import { describe, expect, it } from "vitest";
import { resolveModelContextWindow, resolveModelProviderProfile } from "./model-context";
import type { ModelProfile, ModelProviderProfile } from "./types";

const profile: ModelProfile = { id: "local-b", provider: "custom", model: "shared-model", baseUrl: "https://b.example/v1/", maxTokens: 16000 };
const provider = (id: string, baseUrl: string | undefined, contextWindow: number): ModelProviderProfile => ({
  id, provider: "custom", label: id, baseUrl, status: "ready", models: [{ id: "shared-model", label: "shared-model", contextWindow }],
});

describe("model context metadata", () => {
  it("scopes identical model IDs to the configured endpoint", () => {
    const providers = [provider("local-a", "https://a.example/v1", 1000000), provider("local-b", "https://b.example", 32000)];
    expect(resolveModelContextWindow(profile, providers)).toBe(32000);
    expect(resolveModelContextWindow(profile, [providers[0]])).toBe(16000);
  });

  it("does not silently borrow ambiguous endpoint metadata", () => {
    const providers = [provider("a", undefined, 1000000), provider("b", undefined, 32000)];
    expect(resolveModelProviderProfile(profile, providers)).toBeUndefined();
    expect(resolveModelContextWindow(profile, providers)).toBe(16000);
  });

  it("keeps support for a single legacy provider without a saved URL", () => {
    expect(resolveModelContextWindow(profile, [provider("legacy", undefined, 64000)])).toBe(64000);
  });

  it("does not let a stale matching ID override an explicitly changed endpoint", () => {
    expect(resolveModelContextWindow(profile, [provider("local-b", "https://old.example", 1000000)])).toBe(16000);
  });
});
