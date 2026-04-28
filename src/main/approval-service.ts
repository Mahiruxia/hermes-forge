import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type { AppPaths } from "./app-paths";
import type { ApprovalChoice, ApprovalRequest, EngineEvent } from "../shared/types";

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
    if (this.sessionApproved.has(input.patternKey) || this.persistentApproved.has(input.patternKey)) {
      const status = this.sessionApproved.has(input.patternKey) ? "已按本次会话规则自动批准。" : "已按永久规则自动批准。";
      const request = this.createRequest(input, "approved");
      await publish({
        type: "approval",
        request,
        outcome: "auto_approved",
        choice: this.sessionApproved.has(input.patternKey) ? "session" : "always",
        message: status,
        at: now(),
      });
      return {
        approved: true,
        choice: this.sessionApproved.has(input.patternKey) ? "session" : "always",
        editedCommand: input.command,
      };
    }

    const request = this.createRequest(input, "pending");
    const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await publish({
      type: "approval",
      request,
      outcome: "requested",
      message: "检测到高风险操作，等待用户批准。",
      at: now(),
    });

    return await new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        void this.expire(request.id);
      }, timeoutMs);
      this.pending.set(request.id, {
        request,
        publish,
        resolve,
        timer,
      });
    });
  }

  async respond(input: { id: string; choice: ApprovalChoice; editedCommand?: string }) {
    const pending = this.pending.get(input.id);
    if (!pending) {
      return { ok: false, id: input.id, approved: false, message: "审批请求不存在或已结束。" };
    }
    clearTimeout(pending.timer);
    this.pending.delete(input.id);

    const approved = input.choice !== "deny";
    if (input.choice === "session") {
      this.sessionApproved.add(pending.request.patternKey);
    }
    if (input.choice === "always") {
      this.persistentApproved.add(pending.request.patternKey);
      await this.persist();
    }

    const request: ApprovalRequest = {
      ...pending.request,
      status: approved ? "approved" : "denied",
    };
    await pending.publish({
      type: "approval",
      request,
      outcome: approved ? "approved" : "denied",
      choice: input.choice,
      message: approved ? "用户已批准高风险操作。" : "用户已拒绝高风险操作。",
      at: now(),
    });
    pending.resolve({
      approved,
      choice: input.choice,
      editedCommand: input.editedCommand,
    });
    return {
      ok: true,
      id: input.id,
      approved,
      message: approved ? "已批准高风险操作。" : "已拒绝高风险操作。",
    };
  }

  private async expire(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const request: ApprovalRequest = {
      ...pending.request,
      status: "expired",
    };
    await pending.publish({
      type: "approval",
      request,
      outcome: "expired",
      choice: "deny",
      message: "审批超时，已自动拒绝。",
      at: now(),
    });
    pending.resolve({
      approved: false,
      choice: "deny",
      editedCommand: pending.request.command,
    });
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
    await fs.writeFile(this.policyPath(), JSON.stringify(payload, null, 2), "utf8");
  }

  private policyPath() {
    return path.join(this.appPaths.baseDir(), "approval-policy.json");
  }
}

async function quarantineInvalidJson(filePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.rename(filePath, `${filePath}.invalid.${timestamp}`).catch(() => undefined);
}
