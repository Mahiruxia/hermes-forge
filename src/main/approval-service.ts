import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type { AppPaths } from "./app-paths";
import type { ApprovalChoice, ApprovalRequest, EngineEvent } from "../shared/types";
import { atomicWriteText } from "./hermes-config-files";

const DEFAULT_TIMEOUT_MS = 60_000;
const now = () => new Date().toISOString();

type ApprovalPublish = (event: EngineEvent) => Promise<void>;

type PersistentPolicy = {
  patternKeys: string[];
};

const persistentPolicySchema = z.object({
  patternKeys: z.array(z.string().trim().min(1).max(500)).default([]),
});

type ApprovalPending = {
  request: ApprovalRequest;
  publish: ApprovalPublish;
  resolve: (value: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  managePolicies: boolean;
  removeAbortListener?: () => void;
};

export type ApprovalDecision = {
  approved: boolean;
  choice: ApprovalChoice;
  editedCommand?: string;
};

export type ApprovalRequestInput = {
  taskRunId: string;
  title: string;
  command?: string;
  path?: string;
  patternKey: string;
  scopeKey?: string;
  actionKind: ApprovalRequest["actionKind"];
  details?: string;
  risk: ApprovalRequest["risk"];
  timeoutMs?: number;
  allowedChoices?: ApprovalChoice[];
  allowEdit?: boolean;
  managePolicies?: boolean;
  signal?: AbortSignal;
};

export class ApprovalService {
  private readonly pending = new Map<string, ApprovalPending>();
  private readonly sessionApproved = new Set<string>();
  private persistentApproved = new Set<string>();
  private loadPromise?: Promise<void>;

  constructor(
    private readonly appPaths: AppPaths,
  ) {}

  async request(input: ApprovalRequestInput, publish: ApprovalPublish): Promise<ApprovalDecision> {
    await this.ensureLoaded();
    if (input.signal?.aborted) return { approved: false, choice: "deny" };
    const scopedPattern = `${input.scopeKey ?? input.taskRunId}\0${input.patternKey}`;
    const sessionAllowed = input.allowedChoices?.includes("session") ?? true;
    const alwaysAllowed = input.allowedChoices?.includes("always") ?? true;
    const useSessionRule = sessionAllowed && this.sessionApproved.has(scopedPattern);
    const usePersistentRule = alwaysAllowed && this.persistentApproved.has(input.patternKey);
    if (input.managePolicies !== false && (useSessionRule || usePersistentRule)) {
      const status = useSessionRule ? "已按本次会话规则自动批准。" : "已按永久规则自动批准。";
      const request = this.createRequest(input, "approved");
      await publish({
        type: "approval",
        request,
        outcome: "auto_approved",
        choice: useSessionRule ? "session" : "always",
        message: status,
        at: now(),
      });
      return {
        approved: true,
        choice: useSessionRule ? "session" : "always",
        editedCommand: input.command,
      };
    }

    const request = this.createRequest(input, "pending");
    const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        void this.expire(request.id);
      }, timeoutMs);
      this.pending.set(request.id, {
        request,
        publish,
        resolve,
        timer,
        managePolicies: input.managePolicies !== false,
      });
      if (input.signal) {
        const abort = () => { void this.expire(request.id); };
        input.signal.addEventListener("abort", abort, { once: true });
        this.pending.get(request.id)!.removeAbortListener = () => input.signal!.removeEventListener("abort", abort);
        if (input.signal.aborted) abort();
      }
    });
    try {
      if (!input.signal?.aborted) await publish({ type: "approval", request, outcome: "requested", message: "检测到高风险操作，等待用户批准。", at: now() });
    } catch (error) {
      const pending = this.pending.get(request.id);
      if (pending) {
        clearTimeout(pending.timer);
        pending.removeAbortListener?.();
        this.pending.delete(request.id);
        pending.resolve({ approved: false, choice: "deny" });
      }
      throw error;
    }
    return decision;
  }

  async respond(input: { id: string; choice: ApprovalChoice; editedCommand?: string }) {
    const pending = this.pending.get(input.id);
    if (!pending) {
      return { ok: false, id: input.id, approved: false, message: "审批请求不存在或已结束。" };
    }
    if (!["once", "session", "always", "deny"].includes(input.choice) || (pending.request.allowedChoices && !pending.request.allowedChoices.includes(input.choice))) {
      return { ok: false, id: input.id, approved: false, message: "此操作不允许该授权范围。" };
    }
    if (pending.request.allowEdit === false && input.editedCommand !== undefined && input.editedCommand !== pending.request.command) {
      return { ok: false, id: input.id, approved: false, message: "此请求的命令不能在审批时修改。" };
    }
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    this.pending.delete(input.id);

    const approved = input.choice !== "deny";
    let decision: ApprovalDecision = { approved: false, choice: "deny" };
    const addedPersistent = pending.managePolicies && input.choice === "always" && !this.persistentApproved.has(pending.request.patternKey);
    try {
      if (addedPersistent) {
        this.persistentApproved.add(pending.request.patternKey);
        await this.persist();
      }
      const request: ApprovalRequest = { ...pending.request, status: approved ? "approved" : "denied" };
      await pending.publish({
        type: "approval", request, outcome: approved ? "approved" : "denied", choice: input.choice,
        message: approved ? "用户已批准高风险操作。" : "用户已拒绝高风险操作。", at: now(),
      });
      if (pending.managePolicies && input.choice === "session") {
        this.sessionApproved.add(`${pending.request.scopeKey}\0${pending.request.patternKey}`);
      }
      decision = { approved, choice: input.choice, editedCommand: input.editedCommand };
      return { ok: true, id: input.id, approved, message: approved ? "已批准高风险操作。" : "已拒绝高风险操作。" };
    } catch (error) {
      // A failed policy write or event publication must never strand the tool,
      // or leave a newly saved rule active after this operation was denied.
      if (addedPersistent) {
        this.persistentApproved.delete(pending.request.patternKey);
        await this.persist().catch((rollbackError) => console.warn("[Hermes Forge] Failed to roll back approval policy:", rollbackError));
      }
      console.warn("[Hermes Forge] Failed to complete approval; denying the operation:", error);
      return { ok: false, id: input.id, approved: false, message: "无法保存审批结果，本次操作已拒绝。" };
    } finally {
      pending.resolve(decision);
    }
  }

  private async expire(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    const request: ApprovalRequest = {
      ...pending.request,
      status: "expired",
    };
    try {
      await pending.publish({
        type: "approval", request, outcome: "expired", choice: "deny",
        message: "审批已结束，操作已自动拒绝。", at: now(),
      });
    } catch (error) {
      console.warn("[Hermes Forge] Failed to publish expired approval:", error);
    } finally {
      pending.resolve({ approved: false, choice: "deny", editedCommand: pending.request.command });
    }
  }

  private createRequest(input: ApprovalRequestInput, status: ApprovalRequest["status"]): ApprovalRequest {
    const createdAt = now();
    return {
      id: crypto.randomUUID(),
      taskRunId: input.taskRunId,
      title: input.title,
      command: input.command,
      path: input.path,
      patternKey: input.patternKey,
      scopeKey: input.scopeKey ?? input.taskRunId,
      actionKind: input.actionKind,
      details: input.details,
      risk: input.risk,
      status,
      createdAt,
      expiresAt: new Date(Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS)).toISOString(),
      allowedChoices: input.allowedChoices,
      allowEdit: input.allowEdit,
    };
  }

  private async ensureLoaded() {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  private async load() {
    const raw = await fs.readFile(this.policyPath(), "utf8").catch(() => "");
    if (!raw) return;
    try {
      const parsed = persistentPolicySchema.parse(JSON.parse(raw));
      this.persistentApproved = new Set(parsed.patternKeys);
    } catch {
      await quarantineInvalidJson(this.policyPath());
      this.persistentApproved = new Set();
    }
  }

  private async persist() {
    const payload: PersistentPolicy = {
      patternKeys: [...this.persistentApproved].sort(),
    };
    await fs.mkdir(path.dirname(this.policyPath()), { recursive: true });
    await atomicWriteText(this.policyPath(), JSON.stringify(payload, null, 2));
  }

  private policyPath() {
    return path.join(this.appPaths.baseDir(), "approval-policy.json");
  }
}

async function quarantineInvalidJson(filePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.rename(filePath, `${filePath}.invalid.${timestamp}`).catch(() => undefined);
}
