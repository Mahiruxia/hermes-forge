import crypto from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { runCommand } from "../process/command-runner";
import { resolveActiveHermesHome } from "./hermes-home";
import { defaultWindowsHermesCliPath, resolveWindowsHermesCliPathSync } from "../runtime/hermes-cli-paths";
import type { AppPaths } from "./app-paths";

type PythonJsonResult<T> = {
  ok: boolean;
  data?: T;
  message?: string;
  stderr?: string;
};

export type HermesCoreSession = {
  id: string;
  title?: string;
  source?: string;
  parentSessionId?: string;
  model?: string;
  messageCount?: number;
  startedAt?: number;
  endedAt?: number;
  lastActive?: number;
};

export type HermesCoreCommandResult = {
  ok: boolean;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export class HermesCoreBridgeService {
  constructor(
    private readonly appPaths: AppPaths,
    private readonly resolveHermesRoot: () => Promise<string>,
  ) {}

  async createSession(input: { sessionId?: string; title?: string; source?: string; model?: string; parentSessionId?: string } = {}) {
    const sessionId = input.sessionId?.trim() || `forge-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const result = await this.runPythonJson<{ session: HermesCoreSession }>(`
from hermes_state import SessionDB
db = SessionDB()
sid = ARGS.get("sessionId")
db.create_session(
    session_id=sid,
    source=ARGS.get("source") or "zhenghebao-client",
    model=ARGS.get("model") or None,
    parent_session_id=ARGS.get("parentSessionId") or None,
)
title = ARGS.get("title")
if title:
    try:
        db.set_session_title(sid, title)
    except Exception:
        pass
session = db.get_session(sid) or {"id": sid}
RESULT = {"session": normalize_session(session)}
`, { ...input, sessionId });
    if (!result.ok) {
      return { id: sessionId, title: input.title, source: input.source ?? "zhenghebao-client" };
    }
    return result.data?.session ?? { id: sessionId, title: input.title, source: input.source ?? "zhenghebao-client" };
  }

  async readSession(sessionId: string) {
    const result = await this.runPythonJson<{ session?: HermesCoreSession; messages: Array<{ role: "user" | "assistant"; content: string }> }>(`
from hermes_state import SessionDB
db = SessionDB()
sid = ARGS.get("sessionId")
session = db.get_session(sid)
messages = db.get_messages_as_conversation(sid, include_ancestors=True) if session else []
RESULT = {
    "session": normalize_session(session) if session else None,
    "messages": [
        {"role": m.get("role"), "content": m.get("content")}
        for m in messages
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
    ],
}
`, { sessionId });
    if (!result.ok) return undefined;
    return result.data;
  }

  async renameSession(sessionId: string, title: string) {
    const result = await this.runPythonJson<{ ok: boolean; session?: HermesCoreSession }>(`
from hermes_state import SessionDB
db = SessionDB()
sid = ARGS.get("sessionId")
ok = db.set_session_title(sid, ARGS.get("title") or "")
session = db.get_session(sid)
RESULT = {"ok": bool(ok), "session": normalize_session(session) if session else None}
`, { sessionId, title });
    return result.ok && result.data?.ok;
  }

  async deleteSession(sessionId: string) {
    const result = await this.runPythonJson<{ ok: boolean }>(`
from hermes_state import SessionDB
from hermes_constants import get_hermes_home
db = SessionDB()
ok = db.delete_session(ARGS.get("sessionId"), sessions_dir=get_hermes_home() / "sessions")
RESULT = {"ok": bool(ok)}
`, { sessionId });
    return Boolean(result.ok && result.data?.ok);
  }

  async listSessions(limit = 80) {
    const result = await this.runPythonJson<{ sessions: HermesCoreSession[] }>(`
from hermes_state import SessionDB
db = SessionDB()
RESULT = {"sessions": [normalize_session(s) for s in db.search_sessions(limit=int(ARGS.get("limit") or 80))]}
`, { limit });
    return result.ok ? result.data?.sessions ?? [] : [];
  }

  async memoryStatus() {
    return this.runOfficialCommand(["memory", "status"], 20000);
  }

  async skillsList() {
    return this.runOfficialCommand(["skills", "list"], 30000);
  }

  async skillsCheck() {
    return this.runOfficialCommand(["skills", "check"], 60000);
  }

  async logsRead(input: { logName?: string; lines?: number; sessionId?: string } = {}) {
    const args = ["logs", input.logName ?? "agent", "-n", String(Math.max(1, Math.min(input.lines ?? 80, 1000)))];
    if (input.sessionId) args.push("--session", input.sessionId);
    return this.runOfficialCommand(args, 20000);
  }

  async doctor(fix = false) {
    return this.runOfficialCommand(["doctor", ...(fix ? ["--fix"] : [])], fix ? 120000 : 60000);
  }

  async gatewayStatus() {
    return this.runOfficialCommand(["gateway", "status"], 20000);
  }

  private async runOfficialCommand(args: string[], timeoutMs: number): Promise<HermesCoreCommandResult> {
    const root = await this.resolveHermesRoot();
    const cliPath = resolveWindowsHermesCliPathSync(root) ?? defaultWindowsHermesCliPath(root);
    const hermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
    const python = cliPath.toLowerCase().endsWith(".exe") ? undefined : await this.resolvePython(root);
    const command = cliPath.toLowerCase().endsWith(".exe") ? cliPath : python!.command;
    const finalArgs = cliPath.toLowerCase().endsWith(".exe") ? args : [...python!.args, cliPath, ...args];
    const result = await runCommand(command, finalArgs, {
      cwd: root,
      timeoutMs,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        HERMES_HOME: hermesHome,
        PYTHONPATH: `${root}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
      },
    });
    return {
      ok: result.exitCode === 0,
      command,
      args: finalArgs,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private async runPythonJson<T>(code: string, args: Record<string, unknown>): Promise<PythonJsonResult<T>> {
    const root = await this.resolveHermesRoot();
    const python = await this.resolvePython(root);
    const hermesHome = await resolveActiveHermesHome(this.appPaths.hermesDir());
    const script = `
import json, os, sys
from pathlib import Path
root = Path(${JSON.stringify(root)})
sys.path.insert(0, str(root))
os.environ["PYTHONPATH"] = os.pathsep.join([str(root), os.environ.get("PYTHONPATH", "")]).strip(os.pathsep)
ARGS = json.loads(${JSON.stringify(JSON.stringify(args))})
RESULT = None
def normalize_session(session):
    if not session:
        return None
    return {
        "id": session.get("id"),
        "title": session.get("title"),
        "source": session.get("source"),
        "parentSessionId": session.get("parent_session_id"),
        "model": session.get("model"),
        "messageCount": session.get("message_count"),
        "startedAt": session.get("started_at"),
        "endedAt": session.get("ended_at"),
        "lastActive": session.get("last_active") or session.get("started_at"),
    }
${code}
print(json.dumps({"ok": True, "data": RESULT}, ensure_ascii=False))
`;
    const result = await runCommand(python.command, [...python.args, "-c", script], {
      cwd: root,
      timeoutMs: 20000,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        HERMES_HOME: hermesHome,
        PYTHONPATH: `${root}${path.delimiter}${process.env.PYTHONPATH ?? ""}`,
      },
    });
    const text = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    try {
      return JSON.parse(text) as PythonJsonResult<T>;
    } catch {
      return { ok: false, message: text || result.stderr || `Hermes core bridge exited ${result.exitCode}`, stderr: result.stderr };
    }
  }

  private async resolvePython(root: string): Promise<{ command: string; args: string[] }> {
    const venvPython = path.join(root, "venv", "Scripts", "python.exe");
    const dotVenvPython = path.join(root, ".venv", "Scripts", "python.exe");
    const cliPath = resolveWindowsHermesCliPathSync(root) ?? defaultWindowsHermesCliPath(root);
    if (cliPath.toLowerCase().endsWith(".exe") && fsSync.existsSync(venvPython)) {
      return { command: venvPython, args: [] };
    }
    if (fsSync.existsSync(venvPython)) {
      return { command: venvPython, args: [] };
    }
    if (fsSync.existsSync(dotVenvPython)) {
      return { command: dotVenvPython, args: [] };
    }
    const configuredPython = process.env.HERMES_FORGE_PYTHON?.trim();
    if (configuredPython) {
      return { command: configuredPython, args: [] };
    }
    if (process.platform === "win32") {
      return { command: "py", args: ["-3"] };
    }
    return { command: "python", args: [] };
  }
}
