import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapter } from "../adapters/engine-adapter";
import type { AppPaths } from "./app-paths";
import type { RuntimeEnvResolver } from "./runtime-env-resolver";
import type { EngineEvent, EngineRunRequest, HermesSystemAuditStep, RuntimeConfig } from "../shared/types";
import { HermesSystemAuditService } from "./hermes-system-audit-service";

afterEach(() => vi.unstubAllEnvs());

describe("HermesSystemAuditService", () => {
  it("returns a failed preflight result instead of throwing when runtime resolution fails", async () => {
    const service = new HermesSystemAuditService(
      {} as AppPaths,
      {} as EngineAdapter,
      {
        resolve: vi.fn(async () => {
          throw new Error("missing model runtime");
        }),
      } as unknown as RuntimeEnvResolver,
      async () => ({ modelProfiles: [], updateSources: {}, enginePaths: {} } as RuntimeConfig),
    );

    const result = await service.test();

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: "preflight",
        status: "failed",
        message: "missing model runtime",
      }),
    ]);
  });

  it("keeps ordinary diagnostics at four model calls and does not resolve another profile", async () => {
    vi.stubEnv("HERMES_FORGE_RELEASE_AUDIT", "0");
    const fixture = releaseFixture();
    const result = await fixture.service.test();
    expect(result.ok).toBe(true);
    expect(fixture.ordinaryCase).toHaveBeenCalledTimes(4);
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.resolve).toHaveBeenCalledTimes(1);
    expect(result.steps.map((step) => step.id)).not.toContain("session-restart-resume");
  });

  it("resumes only the official ID after the previous run stops, then selects the other profile without mutating defaults", async () => {
    const fixture = releaseFixture();
    const before = structuredClone(fixture.config);
    const result = await fixture.service.test({ releaseAudit: true });
    expect(result.ok).toBe(true);
    expect(result.steps.filter((step) => /session-restart|model-profile/.test(step.id)).map((step) => step.status)).toEqual(["passed", "passed"]);
    expect(fixture.requests).toHaveLength(3);
    const [seed, resumed, switched] = fixture.requests;
    expect(resumed.conversationId).toBe(fixture.officialId);
    expect(resumed.userInput).not.toContain(fixture.phrase());
    expect(resumed.conversationHistory).toBeUndefined();
    expect(resumed.selectedFiles).toEqual([]);
    expect(resumed.attachments).toEqual([]);
    expect(seed.sessionId).not.toBe(resumed.sessionId);
    expect(fixture.timeline).toEqual([
      `run:${seed.sessionId}`, `end:${seed.sessionId}`, `stop:${seed.sessionId}`,
      `run:${resumed.sessionId}`, `end:${resumed.sessionId}`, `stop:${resumed.sessionId}`,
      `run:${switched.sessionId}`, `end:${switched.sessionId}`, `stop:${switched.sessionId}`,
    ]);
    expect(switched.modelProfileId).toBe("mimo");
    expect(switched.runtimeEnv?.model).toBe("mimo-v2.5-pro");
    expect(switched.conversationId).not.toBe(resumed.conversationId);
    expect(seed.runtimeEnv?.env.HERMES_HOME).toContain("release-hermes-home");
    expect(resumed.runtimeEnv?.env.HERMES_HOME).toBe(seed.runtimeEnv?.env.HERMES_HOME);
    expect(seed.runtimeEnv?.env.HERMES_IGNORE_RULES).toBe("1");
    expect(seed.permissions?.memoryRead).toBe(false);
    expect(fixture.config).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("private-runtime-credential");
  });

  it("enables the additional acceptance steps through the packaged audit environment flag", async () => {
    vi.stubEnv("HERMES_FORGE_RELEASE_AUDIT", "1");
    const fixture = releaseFixture();
    expect((await fixture.service.test()).ok).toBe(true);
    expect(fixture.requests).toHaveLength(3);
  });

  it.each(["missing-session", "wrong-session", "unchanged-count", "failed-result", "cancelled-result", "stdout-only"] as const)("rejects an unproven session restore: %s", async (failure) => {
    const fixture = releaseFixture(failure);
    const result = await fixture.service.test({ releaseAudit: true });
    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.id === "session-restart-resume")?.status).toBe("failed");
  });

  it("rejects a correct switch marker when the official session reports the previous model", async () => {
    const fixture = releaseFixture("wrong-model");
    const result = await fixture.service.test({ releaseAudit: true });
    expect(result.steps.find((step) => step.id === "session-restart-resume")?.status).toBe("passed");
    expect(result.steps.find((step) => step.id === "model-profile-switch")).toMatchObject({ status: "failed", message: expect.stringContaining("模型与选择不一致") });
  });

  it("fails rather than claiming a model switch when no alternate configured model exists", async () => {
    const fixture = releaseFixture();
    fixture.config.modelProfiles = fixture.config.modelProfiles.slice(0, 1);
    const result = await fixture.service.test({ releaseAudit: true });
    expect(result.steps.find((step) => step.id === "model-profile-switch")).toMatchObject({ status: "failed", message: expect.stringContaining("另一个已配置") });
    expect(fixture.requests).toHaveLength(2);
  });

  it("redacts configured credentials from failed subprocess output", async () => {
    const fixture = releaseFixture("secret-error");
    const result = await fixture.service.test({ releaseAudit: true });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-runtime-credential");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });
});

type Failure = "missing-session" | "wrong-session" | "unchanged-count" | "failed-result" | "cancelled-result" | "stdout-only" | "wrong-model" | "secret-error";

function releaseFixture(failure?: Failure) {
  const config: RuntimeConfig = {
    defaultModelProfileId: "kimi",
    modelProfiles: [
      { id: "kimi", provider: "custom", sourceType: "kimi_coding_api_key", model: "kimi-for-coding" },
      { id: "mimo", provider: "custom", sourceType: "mimo_api_key", model: "mimo-v2.5-pro" },
    ],
    updateSources: {},
  };
  const requests: EngineRunRequest[] = [];
  const timeline: string[] = [];
  const officialId = "official-session-from-child";
  let phrase = "";
  const resolve = vi.fn(async (id: string) => {
    const profile = config.modelProfiles.find((item) => item.id === id)!;
    return { profileId: profile.id, provider: profile.provider, model: profile.model, sourceType: profile.sourceType, env: { AI_API_KEY: "private-runtime-credential" } };
  });
  const hermes = {
    prepareContextBundle: vi.fn(async () => undefined),
    stop: vi.fn(async (id: string) => { timeline.push(`stop:${id}`); }),
    async *run(request: EngineRunRequest): AsyncGenerator<EngineEvent> {
      const index = requests.push(request) - 1;
      timeline.push(`run:${request.sessionId}`);
      if (index === 0) phrase = request.userInput.match(/随机口令：([a-f0-9]{36})/)![1];
      if (failure === "secret-error") throw new Error("request rejected private-runtime-credential");
      const at = new Date().toISOString();
      if (!(failure === "missing-session" && index === 1)) {
        yield {
          type: "session_update", at,
          hermesSessionId: index === 2 ? "official-other-model-session" : failure === "wrong-session" && index === 1 ? "unexpected-session" : officialId,
          messageCount: index === 1 && failure !== "unchanged-count" ? 4 : 2,
          model: failure === "wrong-model" && index === 2 ? "kimi-for-coding" : request.runtimeEnv?.model,
        };
      }
      const response = index === 0 ? "AUDIT_SESSION_STORED" : index === 1 ? phrase : request.userInput.match(/AUDIT_MODEL_SWITCH_[a-f0-9]+/)![0];
      if (failure === "stdout-only" && index === 1) yield { type: "stdout", line: phrase, at };
      yield {
        type: "result", at, title: "Hermes",
        detail: failure === "stdout-only" && index === 1 ? "UNKNOWN" : response,
        success: !(failure === "failed-result" && index === 1),
        outcome: failure === "cancelled-result" && index === 1 ? "cancelled" : "completed",
      };
      timeline.push(`end:${request.sessionId}`);
    },
  } as unknown as EngineAdapter;
  const service = new HermesSystemAuditService(
    { ensureWorkspaceLayout: vi.fn(async () => "audit-workspace") } as unknown as AppPaths,
    hermes, { resolve } as unknown as RuntimeEnvResolver, async () => config,
  );
  // Ordinary capability cases are already covered by their own integration
  // audit. Keep this suite focused on the additional process/session contract.
  const internals = service as unknown as {
    runCase(input: { id: HermesSystemAuditStep["id"]; label: string }): Promise<HermesSystemAuditStep>;
    createNastyPathFile(): Promise<{ path: string; expectedLine: string }>;
    createLargeLogFile(): Promise<{ path: string; tailLine: string; size: number }>;
  };
  const ordinaryCase = vi.spyOn(internals, "runCase").mockImplementation(async ({ id, label }) => ({ id, label, status: "passed", message: "verified" }));
  vi.spyOn(internals, "createNastyPathFile").mockResolvedValue({ path: "unused", expectedLine: "unused" });
  vi.spyOn(internals, "createLargeLogFile").mockResolvedValue({ path: "unused", tailLine: "unused", size: 1 });
  return { service, config, requests, timeline, resolve, ordinaryCase, officialId, phrase: () => phrase };
}
