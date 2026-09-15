import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../shared/types";
import { DEFAULT_PINNED_HERMES_SOURCE, resolveInstallSource, resolveInstallSourceFromOption } from "./install-source";

function configuration(source: NonNullable<NonNullable<RuntimeConfig["hermesRuntime"]>["installSource"]>): RuntimeConfig {
  return { modelProfiles: [], updateSources: {}, hermesRuntime: { mode: "windows", installSource: source } };
}

describe("Hermes install source migration", () => {
  it.each(["official", "mirror"] as const)("advances legacy %s main, empty ref and date tags to the audited stable commit", (sourceLabel) => {
    for (const branch of ["main", " main ", "", undefined, "v2026.8.17"]) {
      expect(resolveInstallSource(configuration({ repoUrl: DEFAULT_PINNED_HERMES_SOURCE.repoUrl, sourceLabel, branch })))
        .toEqual({ ...DEFAULT_PINNED_HERMES_SOURCE, sourceLabel });
    }
  });

  it("preserves explicitly customized main and pinned commits", () => {
    const custom = { repoUrl: DEFAULT_PINNED_HERMES_SOURCE.repoUrl, sourceLabel: "custom" as const, branch: "main" };
    const pinned = { repoUrl: DEFAULT_PINNED_HERMES_SOURCE.repoUrl, sourceLabel: "official" as const, branch: "v2026.8.17", commit: "a".repeat(40) };
    expect(resolveInstallSource(configuration(custom))).toEqual(custom);
    expect(resolveInstallSource(configuration(pinned))).toEqual(pinned);
  });

  it("records a newly requested advanced branch so later updates preserve that selection", () => {
    const source = resolveInstallSourceFromOption({ modelProfiles: [], updateSources: {} }, { kind: "official", branch: "main" });
    expect(source).toEqual({ repoUrl: DEFAULT_PINNED_HERMES_SOURCE.repoUrl, sourceLabel: "custom", branch: "main", commit: undefined });
    expect(resolveInstallSource(configuration(source))).toEqual(source);
  });

  it("uses the audited tag and commit for the normal official installation option", () => {
    expect(resolveInstallSourceFromOption({ modelProfiles: [], updateSources: {} }, { kind: "official" })).toEqual(DEFAULT_PINNED_HERMES_SOURCE);
  });
});
