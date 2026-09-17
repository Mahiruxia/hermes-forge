#!/usr/bin/env python3
"""
Hermes Windows Agent Runner for Forge

职责：在 Windows 侧启动 AIAgent，通过 JSON Lines stdout 与 Forge 实时通信。
不拼接 prompt、不管理 session、不处理 Windows 桥接 —— 这些全部是 Hermes 自己的职责。

事件协议（JSON Lines，每行一个事件，用 __FORGE_EVENT__...__FORGE_EVENT_END__ 包裹）：
  {"type": "lifecycle", "stage": "started", ...}
  {"type": "tool_call", "tool": "...", "input": {...}, ...}
  {"type": "tool_result", "tool": "...", "output": "...", ...}
  {"type": "message_chunk", "content": "...", ...}
  {"type": "usage", "input_tokens": 123, "output_tokens": 45, ...}
  {"type": "result", "success": true, "content": "...", ...}
  {"type": "error", "message": "...", "error_type": "...", ...}
"""

from __future__ import annotations

import argparse
import base64
import codecs
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import threading
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Patch subprocess.Popen early so that any downstream code (including
# run_agent) gets the fixed behaviour.  On Windows, child processes such as
# cmd.exe or git bash may emit GBK-encoded bytes even when Python's default
# encoding is UTF-8.  Without errors='replace', the internal _readerthread
# crashes with UnicodeDecodeError and the command output is lost.
if os.name == "nt":
    _original_popen_init = subprocess.Popen.__init__

    def _patched_popen_init(self, *args, **kwargs):
        # universal_newlines can be passed as the 9th positional arg (index 8).
        has_text = bool(kwargs.get("text") or kwargs.get("universal_newlines"))
        if not has_text and len(args) > 8 and args[8]:
            has_text = True
        if has_text and "errors" not in kwargs:
            kwargs = dict(kwargs)
            kwargs["errors"] = "replace"
        if "encoding" in kwargs and "errors" not in kwargs:
            kwargs = dict(kwargs)
            kwargs["errors"] = "replace"
        return _original_popen_init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _patched_popen_init

    # Last-resort safety net: suppress the unhandled _readerthread
    # UnicodeDecodeError so it doesn't spam stderr and wedge the gateway.
    _original_thread_excepthook = threading.excepthook

    def _patched_thread_excepthook(args):
        if (
            args.exc_type is UnicodeDecodeError
            and args.thread.name == "_readerthread"
            and "utf-8" in str(args.exc_value)
        ):
            # The reader thread died, but we can't recover its output here.
            # Log a short warning and swallow the exception so the main thread
            # (and communicate()) is not affected.
            print(
                f"Warning: subprocess reader thread dropped output due to "
                f"encoding mismatch ({args.exc_value}).",
                file=sys.stderr,
                flush=True,
            )
            return
        _original_thread_excepthook(args)

    threading.excepthook = _patched_thread_excepthook


EVENT_START = "__FORGE_EVENT__"
EVENT_END = "__FORGE_EVENT_END__"
_emit_lock = threading.Lock()


def emit(event_type: str, payload: dict) -> None:
    """向 Forge 发送结构化事件。"""
    event = {
        "type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    line = json.dumps(event, ensure_ascii=False)
    with _emit_lock:
        print(f"{EVENT_START}{line}{EVENT_END}", flush=True)


class ForgeInteractionControl:
    """One stdin reader dispatches replies to the exact waiting tool invocation."""

    def __init__(self, task_run_id: str, timeout_seconds: float = 300, emitter=emit):
        self.task_run_id = task_run_id
        self.timeout_seconds = max(0.01, min(timeout_seconds, 600))
        self.emit = emitter
        self.cancelled = threading.Event()
        self._closed = threading.Event()
        self._lock = threading.Lock()
        self._pending: dict[str, dict] = {}
        self._agent = None

    def start(self) -> None:
        # os.read avoids a daemon thread holding sys.stdin's buffered-reader lock
        # during Python finalization. Only this thread ever reads the control pipe.
        threading.Thread(target=self._read_stdin, name="forge-control", daemon=True).start()

    def _read_stdin(self) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("strict")
        buffer = ""
        try:
            while not self._closed.is_set():
                chunk = os.read(sys.stdin.fileno(), 4096)
                if not chunk:
                    self.cancel()
                    return
                buffer += decoder.decode(chunk)
                if len(buffer) > 1024 * 1024:
                    self.cancel()
                    return
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    try:
                        self.accept(json.loads(line))
                    except (json.JSONDecodeError, ValueError, TypeError):
                        continue
        except (OSError, ValueError, UnicodeError):
            self.cancel()

    def attach_agent(self, agent) -> None:
        self._agent = agent
        if self.cancelled.is_set():
            self._interrupt_agent()

    def _interrupt_agent(self) -> None:
        agent = self._agent
        if agent is not None:
            try:
                agent.hard_interrupt("Task cancelled by the desktop user.", tool_reason="user_cancelled")
            except Exception as exc:
                _stderr(f"Hermes cooperative cancellation failed: {type(exc).__name__}")

    def cancel(self) -> None:
        if self._closed.is_set():
            return
        first = not self.cancelled.is_set()
        self.cancelled.set()
        with self._lock:
            for pending in self._pending.values():
                pending["event"].set()
        if first:
            self._interrupt_agent()

    def close(self) -> None:
        self._closed.set()
        with self._lock:
            for pending in self._pending.values():
                pending["event"].set()
        self._agent = None

    def accept(self, message) -> bool:
        if not isinstance(message, dict) or message.get("taskRunId") != self.task_run_id or self._closed.is_set():
            return False
        if message.get("type") == "cancel":
            self.cancel()
            return True
        if message.get("type") != "interaction_response" or self.cancelled.is_set():
            return False
        request_id = message.get("requestId")
        if not isinstance(request_id, str):
            return False
        with self._lock:
            pending = self._pending.get(request_id)
            if pending is None or pending["response"] is not None or message.get("kind") != pending["kind"]:
                return False
            pending["response"] = message
            pending["event"].set()
        return True

    def request(self, kind: str, payload: dict) -> dict | None:
        request_id = uuid.uuid4().hex
        pending = {"event": threading.Event(), "kind": kind, "response": None}
        with self._lock:
            if self.cancelled.is_set() or self._closed.is_set():
                return None
            self._pending[request_id] = pending
        try:
            self.emit("interaction_request", {
                "requestId": request_id,
                "taskRunId": self.task_run_id,
                "timeoutMs": max(1, int(self.timeout_seconds * 1000)),
                "kind": kind,
                **payload,
            })
            pending["event"].wait(self.timeout_seconds)
            if self.cancelled.is_set() or self._closed.is_set():
                return None
            return pending["response"]
        except (BrokenPipeError, OSError):
            self.cancel()
            return None
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def approval(self, command, description, *, allow_permanent=True, allow_session=True, smart_denied=False):
        response = self.request("approval", {
            "command": str(command),
            "description": str(description),
            "allowSession": bool(allow_session) and not smart_denied,
            "allowPermanent": bool(allow_permanent) and not smart_denied,
            "smartDenied": bool(smart_denied),
        })
        if response is None:
            return "deny" if self.cancelled.is_set() or self._closed.is_set() else "timeout"
        choice = response.get("choice")
        if choice not in ("once", "session", "always", "deny", "timeout"):
            return "deny"
        if choice == "session" and (not allow_session or smart_denied):
            return "deny"
        if choice == "always" and (not allow_permanent or smart_denied):
            return "deny"
        return choice

    def clarify(self, question, choices, multi_select=False, questions=None):
        payload = {"question": str(question or ""), "multiSelect": bool(multi_select)}
        if choices:
            payload["choices"] = [str(choice) for choice in choices]
        if questions:
            # Official batch callbacks are keyed by qid. Keep that key in the
            # desktop request, not the optional user-supplied display id.
            payload["questions"] = [{
                "id": item["qid"], "question": item["question"],
                "multiSelect": bool(item.get("multi_select")),
                **({"choices": item["choices"]} if item.get("choices") else {}),
            } for item in questions]
        response = self.request("clarify", payload)
        if response is None or response.get("timedOut") is True:
            return {"answers": {}, "timed_out": True} if questions else None
        if questions:
            answers = response.get("answers")
            if not isinstance(answers, dict):
                return {"answers": {}}
            return {"answers": {
                item["qid"]: _interaction_answer(answers.get(item["qid"]), bool(item.get("multi_select")))
                for item in questions
            }}
        return _interaction_answer(response.get("answer"), bool(multi_select))


def _interaction_answer(value, multi_select=False):
    if multi_select and isinstance(value, list):
        return [item[:20000] for item in value[:20] if isinstance(item, str)]
    return value[:20000] if isinstance(value, str) else ""


def _result_outcome(result, cancelled=False) -> str:
    if cancelled or (isinstance(result, dict) and result.get("interrupted") is True):
        return "cancelled"
    if not isinstance(result, dict) or result.get("failed") is True:
        return "failed"
    return "completed"


def _stderr(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _provider_from_env() -> str:
    provider = (
        os.environ.get("HERMES_INFERENCE_PROVIDER")
        or os.environ.get("AI_PROVIDER")
        or ""
    ).strip().lower()
    return provider or "auto"


def _api_key_from_env() -> str:
    for key in (
        "AI_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_TOKEN",
        "DEEPSEEK_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "KIMI_API_KEY",
        "KIMI_CODING_API_KEY",
        "MINIMAX_API_KEY",
        "MINIMAX_CN_API_KEY",
        "XIAOMI_API_KEY",
        "MIMO_API_KEY",
    ):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


def _base_url_from_env() -> str:
    for key in (
        "AI_BASE_URL",
        "OPENAI_BASE_URL",
        "OPENROUTER_BASE_URL",
        "ANTHROPIC_BASE_URL",
        "DEEPSEEK_BASE_URL",
        "GOOGLE_BASE_URL",
        "GEMINI_BASE_URL",
        "KIMI_BASE_URL",
        "KIMI_CODING_BASE_URL",
        "MINIMAX_BASE_URL",
        "MINIMAX_CN_BASE_URL",
        "XIAOMI_BASE_URL",
        "MIMO_BASE_URL",
    ):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


def _model_from_env() -> str:
    return (os.environ.get("AI_MODEL") or os.environ.get("OPENAI_MODEL") or "").strip()


def _prepare_user_message(query: str, image_paths: list[str] | str | None):
    if not image_paths:
        return query
    paths = [image_paths] if isinstance(image_paths, str) else image_paths
    content = [{"type": "text", "text": query}]
    for image_path in dict.fromkeys(paths):
        path = Path(image_path)
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
    return content


def _load_agent_options(args) -> dict:
    """Inherit the official local-chat configuration without importing the TUI.

    Desktop model credentials, callbacks and session routing are applied by main;
    all other preferences remain owned by the active Hermes profile.
    """
    from hermes_cli.config import load_config, resolve_turn_limit
    from hermes_cli.personality import resolve_ephemeral_system_prompt
    from hermes_cli.fallback_config import get_fallback_chain
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_constants import resolve_reasoning_config, get_hermes_home
    from agent.skill_utils import parse_config_string_list

    config = load_config()
    agent_config = config.get("agent") or {}
    checkpoints = config.get("checkpoints") or {}
    if isinstance(checkpoints, bool):
        checkpoints = {"enabled": checkpoints}
    routing = config.get("provider_routing") or {}
    turn_limit = next((value for value in (args.max_turns, agent_config.get("max_turns"), config.get("max_turns"),
                                         os.environ.get("HERMES_MAX_ITERATIONS")) if value is not None), None)
    # Use a desktop-specific list when explicitly configured; otherwise match
    # `hermes tools` for the local CLI. Preserve [] (all tools disabled).
    tool_platform = args.source if args.source in (config.get("platform_toolsets") or {}) else "cli"
    options = {
        "max_iterations": resolve_turn_limit(turn_limit),
        "run_budget_seconds": agent_config.get("run_budget_seconds"),
        "enabled_toolsets": sorted(_get_platform_tools(config, tool_platform)),
        "disabled_toolsets": parse_config_string_list(agent_config.get("disabled_toolsets")),
        "ephemeral_system_prompt": args.system_prompt or os.environ.get("HERMES_EPHEMERAL_SYSTEM_PROMPT")
                                   or resolve_ephemeral_system_prompt(config) or None,
        "reasoning_config": resolve_reasoning_config(config, _model_from_env()),
        "fallback_model": get_fallback_chain(config) or None,
        "checkpoints_enabled": args.checkpoints or bool(checkpoints.get("enabled", False)),
        "checkpoint_max_snapshots": checkpoints.get("max_snapshots", 20),
        "checkpoint_max_total_size_mb": checkpoints.get("max_total_size_mb", 500),
        "checkpoint_max_file_size_mb": checkpoints.get("max_file_size_mb", 10),
        "providers_allowed": routing.get("only"),
        "providers_ignored": routing.get("ignore"),
        "providers_order": routing.get("order"),
        "provider_sort": routing.get("sort"),
        "provider_require_parameters": routing.get("require_parameters", False),
        "provider_data_collection": routing.get("data_collection"),
    }
    # Same aliases accepted by the CLI's persisted fast-mode preference.
    tier = str(agent_config.get("service_tier") or "").strip().lower()
    if tier in ("fast", "priority", "on"):
        options["service_tier"] = "priority"
    elif tier in ("auto", "cold"):
        options["service_tier"] = tier
    prefill = (os.environ.get("HERMES_PREFILL_MESSAGES_FILE", "").strip()
               or str(config.get("prefill_messages_file") or agent_config.get("prefill_messages_file") or "").strip())
    if prefill:
        prefill_path = Path(prefill).expanduser()
        if not prefill_path.is_absolute():
            prefill_path = get_hermes_home() / prefill_path
        try:
            messages = json.loads(prefill_path.read_text(encoding="utf-8"))
            if not isinstance(messages, list):
                raise ValueError("预置消息应为 JSON 数组")
            options["prefill_messages"] = messages
        except (OSError, ValueError) as exc:
            emit("diagnostic", {"category": "prefill", "message": f"无法读取 Hermes 预置消息，继续当前任务：{exc}"})
    return options


def _prepare_mcp_tools(options: dict) -> None:
    from hermes_cli.mcp_startup import ensure_mcp_discovery_before_agent_build, set_mcp_server_filter
    enabled = options.get("enabled_toolsets")
    if enabled == []:
        return
    # Each desktop turn owns a fresh process, like an official oneshot call.
    # Discover before AIAgent snapshots its schemas; use the official bounded wait.
    set_mcp_server_filter(enabled)
    ensure_mcp_discovery_before_agent_build(logger=logging.getLogger(__name__), single_query=True)


def _expand_skill_query(query: str, task_id: str) -> str:
    stripped = query.lstrip()
    if not stripped.startswith("/"):
        return query
    head, *tail = stripped.split(None, 1)
    if not re.fullmatch(r"/[\w-]+", head):
        return query
    from agent.skill_commands import (
        resolve_skill_command_key, build_skill_invocation_message,
        split_stacked_skill_commands, build_stacked_skill_invocation_message,
    )
    key = resolve_skill_command_key(head[1:])
    if key is None:
        raise ValueError(f"未找到技能命令 {head}。请在“技能与记忆”中检查已安装技能，或使用 /help 查看桌面命令。")
    rest = tail[0] if tail else ""
    extra, instruction = split_stacked_skill_commands(rest)
    if extra:
        built = build_stacked_skill_invocation_message([key, *extra], user_instruction=instruction, task_id=task_id)
        message = built[0] if built else None
        if built and built[2]:
            emit("diagnostic", {"category": "skill", "message": "部分技能未能加载：" + ", ".join(built[2])})
    else:
        message = build_skill_invocation_message(key, user_instruction=rest, task_id=task_id)
    if not message:
        raise ValueError(f"无法加载技能 {head}，请检查技能文件和启用状态。")
    emit("status", {"level": "info", "message": "已加载技能：" + " ".join([key, *extra])})
    return message


def _load_conversation_history(history_file: str | None) -> list[dict]:
    if not history_file:
        return []
    try:
        raw = Path(history_file).read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except Exception as exc:
        emit("diagnostic", {
            "severity": "warning",
            "message": f"无法读取会话历史，将以当前消息继续：{exc}",
        })
        return []
    if not isinstance(parsed, list):
        return []

    history: list[dict] = []
    for item in parsed[-48:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        history.append({"role": role, "content": content})
    return history


def _load_session_history(session_db, session_id: str | None) -> list[dict] | None:
    if not session_db or not session_id:
        return None
    try:
        resolved = session_db.resolve_resume_session_id(session_id)
    except Exception:
        resolved = session_id
    try:
        if session_db.get_session(resolved) is None:
            return None
        messages = session_db.get_messages_as_conversation(resolved, include_ancestors=False, repair_alternation=True)
    except Exception as exc:
        raise RuntimeError("无法读取 Hermes 会话历史，请先修复会话存储后重试。") from exc
    # Ancestors are DISPLAY history. Replaying them regrows the context that
    # Hermes already compressed and changes the cached prefix on every restart.
    # Keep the active tip verbatim, including api_content, reasoning and tool pairs.
    return messages


def _configure_context_window(agent) -> None:
    raw = os.environ.get("HERMES_FORGE_CONTEXT_WINDOW", "").strip()
    if not raw:
        return
    try:
        window = int(raw)
        if window <= 0:
            raise ValueError("context window must be positive")
        compressor = getattr(agent, "context_compressor", None)
        descriptor = getattr(type(compressor), "context_length", None)
        if not isinstance(descriptor, property) or descriptor.fset is None:
            # A third-party context engine owns its budgets. Do not create a
            # cosmetic attribute which its compaction policy may never read.
            return
        # The official setter invalidates derived thresholds/tail budgets while
        # retaining durable compression cooldowns. update_model() resets those
        # counters, which would re-arm ineffective compaction on every process.
        compressor.context_length = window
    except (TypeError, ValueError, AttributeError) as exc:
        emit("diagnostic", {"severity": "warning", "category": "context-window",
                            "message": f"无法应用模型上下文窗口，继续使用 Hermes 检测值：{exc}"})


def _estimate_tokens(text: str) -> int:
    ascii_count = 0
    non_ascii_count = 0
    for char in text or "":
        if char.isspace():
            continue
        if ord(char) <= 0x7F:
            ascii_count += 1
        else:
            non_ascii_count += 1
    return int((ascii_count / 4) + (non_ascii_count * 0.9) + 0.999)


def _message_tokens(message: dict) -> int:
    return _estimate_tokens(str(message.get("content") or "")) + 8










def _make_agent_callbacks(session_id: str | None, control: ForgeInteractionControl):
    def stream_delta(delta):
        if delta:
            emit("message_chunk", {"content": str(delta), "session_id": session_id})

    def reasoning_delta(delta):
        if delta:
            emit("reasoning", {"content": str(delta), "session_id": session_id})

    def tool_progress(*args, **kwargs):
        event = str(args[0]) if args else "tool.progress"
        name = str(args[1]) if len(args) > 1 else "unknown"
        preview = str(args[2]) if len(args) > 2 and args[2] is not None else ""
        emit("status", {
            "level": "warning" if kwargs.get("is_error") or event == "tool.output_risk" else "info",
            "message": f"{event}: {name} {preview}".strip(),
            "session_id": session_id,
        })

    def tool_start(call_id, name, args):
        emit("tool_call", {
            "tool": str(name or "unknown"),
            "input": args if isinstance(args, dict) else {"value": args},
            "call_id": str(call_id or ""),
            "session_id": session_id,
        })

    def tool_complete(call_id, name, args, result):
        from agent.display import _detect_tool_failure
        failed, _ = _detect_tool_failure(str(name or "unknown"), result)
        emit("tool_result", {
            "tool": str(name or "unknown"),
            "output": _safe_preview(result, 6000),
            "success": not failed,
            "call_id": str(call_id or ""),
            "session_id": session_id,
        })

    def status(kind, message=None):
        emit("status", {
            "level": "warning" if str(kind).lower() in ("warn", "warning", "error") else "info",
            "message": str(message if message is not None else kind),
            "session_id": session_id,
        })

    def step(step_index, tools):
        emit("progress", {
            "step": f"agent-step-{step_index}",
            "done": False,
            "message": f"Hermes step {step_index}",
            "tools": _safe_preview(tools, 500),
            "session_id": session_id,
        })

    return {
        "stream_delta_callback": stream_delta,
        "reasoning_callback": reasoning_delta,
        "tool_progress_callback": tool_progress,
        "tool_start_callback": tool_start,
        "tool_complete_callback": tool_complete,
        "status_callback": status,
        "step_callback": step,
        "clarify_callback": control.clarify,
    }




def _win_to_git_bash_path(value: str) -> str:
    if os.name != "nt" or not value:
        return value
    text = str(value)
    match = re.match(r"^([a-zA-Z]):[\\/](.*)$", text)
    if match:
        drive = match.group(1).lower()
        rest = match.group(2).replace("\\", "/")
        return f"/{drive}/{rest}"
    if text.startswith("\\\\"):
        return "//" + text.lstrip("\\").replace("\\", "/")
    return text


def _git_bash_to_win_path(value: str) -> str:
    if os.name != "nt" or not value:
        return value
    text = str(value)
    match = re.match(r"^/([a-zA-Z])(?:/(.*))?$", text)
    if match:
        drive = match.group(1).upper()
        rest = (match.group(2) or "").replace("/", "\\")
        return f"{drive}:\\" + rest if rest else f"{drive}:\\"
    if text.startswith("//"):
        return "\\\\" + text.lstrip("/").replace("/", "\\")
    return text


def _install_windows_git_bash_path_compat() -> None:
    """Bridge Windows paths to Git Bash paths for Hermes local file tools."""
    if os.name != "nt":
        return
    _ensure_git_bash_path()
    try:
        from tools.environments import base as env_base
        from tools.environments.local import LocalEnvironment
        from tools.file_operations import ShellFileOperations
    except Exception:
        return

    original_quote_cwd = env_base.BaseEnvironment._quote_cwd_for_cd
    original_extract_cwd = env_base.BaseEnvironment._extract_cwd_from_output
    original_update_cwd = LocalEnvironment._update_cwd
    original_escape_shell_arg = ShellFileOperations._escape_shell_arg

    def quote_cwd_for_cd(cwd: str) -> str:
        return original_quote_cwd(_win_to_git_bash_path(cwd))

    def extract_cwd_from_output(self, result: dict):
        original_extract_cwd(self, result)
        self.cwd = _git_bash_to_win_path(getattr(self, "cwd", ""))

    def update_cwd(self, result: dict):
        original_update_cwd(self, result)
        self.cwd = _git_bash_to_win_path(getattr(self, "cwd", ""))

    def escape_shell_arg(self, arg: str) -> str:
        return original_escape_shell_arg(self, _win_to_git_bash_path(arg))

    env_base.BaseEnvironment._quote_cwd_for_cd = staticmethod(quote_cwd_for_cd)
    env_base.BaseEnvironment._extract_cwd_from_output = extract_cwd_from_output
    # Hermes 0.21.3 handles Windows pipe draining, bounded output and cooperative
    # interruption itself. Keep that implementation and its keyword arguments.
    LocalEnvironment._update_cwd = update_cwd
    ShellFileOperations._escape_shell_arg = escape_shell_arg


def _ensure_git_bash_path() -> None:
    if os.environ.get("HERMES_GIT_BASH_PATH"):
        return
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    for candidate in (
        Path(local_app_data) / "hermes" / "git" / "bin" / "bash.exe",
        Path(local_app_data) / "hermes" / "git" / "usr" / "bin" / "bash.exe",
        Path(program_files) / "Git" / "bin" / "bash.exe",
        Path(program_files) / "Git" / "usr" / "bin" / "bash.exe",
        Path(local_app_data) / "Programs" / "Git" / "bin" / "bash.exe",
        Path(program_files_x86) / "Git" / "bin" / "bash.exe",
    ):
        if candidate.is_file():
            os.environ["HERMES_GIT_BASH_PATH"] = str(candidate)
            return








def _safe_preview(value, max_len: int = 500) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        if len(text) > max_len:
            return text[:max_len] + "..."
        return text
    except Exception:
        return str(value)[:max_len]


def _text_from_message_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                value = item.get("text") or item.get("content") or item.get("message")
                if isinstance(value, str):
                    parts.append(value)
        return "\n".join(part.strip() for part in parts if part and part.strip())
    if isinstance(content, dict):
        value = content.get("text") or content.get("content") or content.get("message")
        return value if isinstance(value, str) else ""
    return ""


def _extract_final_response(result) -> str:
    if isinstance(result, dict):
        for key in ("final_response", "response", "content", "message", "output", "text"):
            value = result.get(key)
            text = _text_from_message_content(value)
            if text.strip():
                return text
        messages = result.get("messages")
        if isinstance(messages, list):
            for item in reversed(messages):
                if not isinstance(item, dict):
                    continue
                if item.get("role") not in ("assistant", "agent", None):
                    continue
                text = _text_from_message_content(item.get("content") or item.get("message") or item.get("text"))
                if text.strip():
                    return text
        return ""
    for attr in ("final_response", "response", "content", "message", "output", "text"):
        value = getattr(result, attr, None)
        text = _text_from_message_content(value)
        if text.strip():
            return text
    return str(result or "")




def _int_value(value, default: int = 0) -> int:
    try:
        return int(float(value or default))
    except Exception:
        return default


def _float_value(value, default: float = 0.0) -> float:
    try:
        return float(value or default)
    except Exception:
        return default


def _agent_session_usage(agent) -> dict:
    def g(primary: str, fallback: str | None = None) -> int:
        value = _int_value(getattr(agent, primary, 0))
        if value or not fallback:
            return value
        return _int_value(getattr(agent, fallback, 0))

    cache_read = g("session_cache_read_tokens")
    cache_write = g("session_cache_write_tokens")
    # Hermes' session_input_tokens counts UNCACHED input. The desktop's input
    # denominator must include cache reads/writes for every provider protocol.
    prompt_tokens = g("session_prompt_tokens") or g("session_input_tokens") + cache_read + cache_write
    input_tokens = prompt_tokens
    output_tokens = g("session_output_tokens", "session_completion_tokens")
    completion_tokens = g("session_completion_tokens", "session_output_tokens")
    total_tokens = g("session_total_tokens")
    if not total_tokens:
        total_tokens = input_tokens + output_tokens
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": g("session_reasoning_tokens"),
        "api_calls": g("session_api_calls"),
        "estimated_cost_usd": _float_value(getattr(agent, "session_estimated_cost_usd", 0)),
        "cost_source": getattr(agent, "session_cost_source", None),
    }


def _normalize_usage(source: dict) -> dict:
    normalized = dict(source)
    # Fallback for runtimes returning provider usage directly instead of the
    # official session counters. Keep protocol-specific arithmetic here.
    detail = source.get("prompt_tokens_details") or source.get("input_tokens_details") or {}
    if not isinstance(detail, dict):
        detail = {}
    cache_read = _first_int_from_sources([source, detail], "cache_read_tokens", "cache_read_input_tokens",
                                         "prompt_cache_hit_tokens", "cached_tokens", "cachedContentTokenCount", default=None)
    cache_write = _first_int_from_sources([source, detail], "cache_write_tokens", "cache_creation_input_tokens", "cache_creation_tokens", default=None)
    prompt = _first_int_from_sources([source], "prompt_tokens", "promptTokenCount", default=None)
    input_tokens = _first_int_from_sources([source], "input_tokens", default=None)
    if prompt is None and input_tokens is not None:
        prompt = input_tokens
        if "cache_read_input_tokens" in source or "cache_creation_input_tokens" in source:
            prompt += (cache_read or 0) + (cache_write or 0)
    output = _first_int_from_sources([source], "output_tokens", "completion_tokens", "candidatesTokenCount", default=None)
    for key, value in (("input_tokens", prompt), ("prompt_tokens", prompt), ("output_tokens", output),
                       ("cache_read_tokens", cache_read), ("cache_write_tokens", cache_write)):
        if value is not None:
            normalized[key] = value
    return normalized


def _usage_sources(result, agent) -> list[dict]:
    sources: list[dict] = []
    if isinstance(result, dict):
        sources.append(result)
        for key in ("usage", "token_usage", "tokens", "metadata", "response_metadata", "usageMetadata"):
            value = result.get(key)
            if isinstance(value, dict):
                sources.append(value)
                nested = value.get("usage") or value.get("token_usage")
                if isinstance(nested, dict):
                    sources.append(nested)
    for attr in ("usage", "last_usage", "token_usage", "last_token_usage"):
        value = getattr(agent, attr, None)
        if isinstance(value, dict):
            sources.append(value)
    session_usage = _agent_session_usage(agent)
    if any(session_usage.get(key, 0) for key in ("input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens")):
        # These cover every tool-loop request, whereas last_usage may describe
        # only the final call. Never combine totals with one call's cache reads.
        sources.insert(0, session_usage)
    return [_normalize_usage(source) for source in sources]


def _agent_context_usage(agent, messages: list[dict] | None = None) -> dict:
    compressor = getattr(agent, "context_compressor", None)
    context_tokens = _int_value(getattr(compressor, "last_prompt_tokens", 0) if compressor else 0)
    context_window = _int_value(getattr(compressor, "context_length", 0) if compressor else 0)
    context_output_tokens = _int_value(getattr(compressor, "last_completion_tokens", 0) if compressor else 0)
    measured = context_tokens > 0 and not getattr(compressor, "awaiting_real_usage_after_compression", False)
    if context_tokens <= 0 and messages is not None:
        context_tokens = sum(_message_tokens(item) for item in messages if isinstance(item, dict))
        if not any(item.get("role") == "system" for item in messages if isinstance(item, dict)):
            context_tokens += _estimate_tokens(str(getattr(agent, "_cached_system_prompt", "") or ""))
        context_tokens += _estimate_tokens(json.dumps(getattr(agent, "tools", []) or [], ensure_ascii=False, default=str))
        context_output_tokens = 0  # Already included in the working messages.
    context_percent = 0
    if context_tokens and context_window:
        context_percent = max(0, min(100, round(((context_tokens + context_output_tokens) / context_window) * 100)))
    return {
        "context_tokens": context_tokens,
        "context_window": context_window,
        "context_output_tokens": context_output_tokens,
        "context_source": "actual" if measured else "estimated",
        "context_percent": context_percent,
        "api_calls": _int_value(getattr(agent, "session_api_calls", 0)),
    }


def _first_int_from_sources(sources: list[dict], *keys: str, default: int | None = 0) -> int | None:
    for source in sources:
        for key in keys:
            if key in source and source.get(key) is not None:
                value = _int_value(source.get(key))
                return max(0, value)
        for key, value in source.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            for wanted in keys:
                wanted_normalized = re.sub(r"[^a-z0-9]", "", wanted.lower())
                if normalized == wanted_normalized and value is not None:
                    parsed = _int_value(value)
                    return max(0, parsed)
    return default


def _first_float_from_sources(sources: list[dict], *keys: str, default: float = 0.0) -> float:
    for source in sources:
        for key in keys:
            if key in source and source.get(key) is not None:
                value = _float_value(source.get(key))
                if value:
                    return value
        for key, value in source.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            for wanted in keys:
                wanted_normalized = re.sub(r"[^a-z0-9]", "", wanted.lower())
                if normalized == wanted_normalized and value is not None:
                    parsed = _float_value(value)
                    if parsed:
                        return parsed
    return default


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root-path", required=True, help="Hermes 安装根目录")
    parser.add_argument("--query", required=True, help="用户查询")
    parser.add_argument("--system-prompt", default="", help="系统提示词")
    parser.add_argument("--session-id", help="会话 ID")
    parser.add_argument("--task-run-id", help="Forge 单次任务 ID，用于配对交互回复与取消")
    parser.add_argument("--interaction-timeout-seconds", type=float, default=300, help="审批和澄清等待上限")
    parser.add_argument("--workspace-path", help="当前工作区路径")
    parser.add_argument("--history-file", help="Forge 传入的同一对话窗口历史 JSON")
    parser.add_argument("--image-path", action="append", help="图片附件路径，可重复传入多张图片")
    parser.add_argument("--source", default="hermes-forge-desktop", help="调用来源标识")
    parser.add_argument("--max-turns", help="最大工具调用轮数，默认遵循 Hermes 配置")
    parser.add_argument("--checkpoints", action="store_true", help="启用文件修改前的自动检查点")
    parser.add_argument("--pass-session-id", action="store_true", help="在工具调用输出中附加 session ID")
    parser.add_argument("--skip-context-files", action="store_true", help="跳过自动注入 SOUL.md、AGENTS.md、.cursorrules")
    parser.add_argument("--skip-memory", action="store_true", help="跳过记忆加载")
    args = parser.parse_args()
    task_run_id = args.task_run_id or args.session_id or f"forge-run-{uuid.uuid4().hex}"

    # Respect HERMES_IGNORE_RULES env var (set by Hermes CLI --ignore-rules) as default for skip flags.
    if os.environ.get("HERMES_IGNORE_RULES") == "1":
        if not args.skip_context_files:
            args.skip_context_files = True
        if not args.skip_memory:
            args.skip_memory = True

    if args.workspace_path:
        os.environ["TERMINAL_CWD"] = str(Path(args.workspace_path).resolve())

    root = Path(args.root_path).resolve()
    sys.path.insert(0, str(root))
    os.environ["PYTHONPATH"] = os.pathsep.join([
        str(root),
        os.environ.get("PYTHONPATH", ""),
    ]).strip(os.pathsep)

    logging.disable(logging.CRITICAL)

    try:
        from run_agent import AIAgent
    except ImportError as e:
        emit("error", {
            "message": f"无法从 {root} 导入 run_agent.AIAgent: {e}",
            "error_type": "ImportError",
            "session_id": args.session_id,
        })
        return 1
    try:
        from hermes_state import SessionDB
    except ImportError as exc:
        emit("error", {"message": f"Hermes 会话存储不可用：{exc}", "error_type": "ImportError", "session_id": args.session_id})
        return 1

    _install_windows_git_bash_path_compat()

    emit("lifecycle", {"stage": "started", "session_id": args.session_id})

    agent = None
    session_db = None
    control = ForgeInteractionControl(task_run_id, args.interaction_timeout_seconds)
    approval_context = None
    terminal_tool = None
    interactive_token = session_token = None
    try:
        from tools import terminal_tool
        from tools import approval_context

        # These are official per-thread APIs, propagated by Hermes to tool workers.
        interactive_token = approval_context.set_hermes_interactive_context(True)
        terminal_tool.set_approval_callback(control.approval)
        control.start()
        session_db = SessionDB()
        active_session_id = session_db.resolve_resume_session_id(args.session_id) if args.session_id else None
        active_session_id = active_session_id or args.session_id
        session_token = approval_context.set_current_session_key(active_session_id or task_run_id)

        callbacks = _make_agent_callbacks(active_session_id, control)
        options = _load_agent_options(args)
        _prepare_mcp_tools(options)
        agent = AIAgent(
            base_url=_base_url_from_env(),
            api_key=_api_key_from_env(),
            provider=_provider_from_env(),
            model=_model_from_env(),
            quiet_mode=True,
            session_id=active_session_id,
            platform=args.source,
            session_db=session_db,
            skip_context_files=args.skip_context_files,
            skip_memory=args.skip_memory,
            pass_session_id=args.pass_session_id,
            **options,
            **callbacks,
        )
        _configure_context_window(agent)
        control.attach_agent(agent)

        user_message = _prepare_user_message(_expand_skill_query(args.query, task_run_id), args.image_path)
        db_history = _load_session_history(session_db, active_session_id)
        # An intentionally empty official history (clear/reset) is authoritative;
        # never resurrect the renderer's older display transcript in that case.
        conversation_history = db_history if db_history is not None else _load_conversation_history(args.history_file)
        prompt_estimate = sum(_message_tokens(item) for item in conversation_history) + _estimate_tokens(str(user_message)) + 16
        emit("usage", {
            "source": "estimated",
            "input_tokens": prompt_estimate,
            "output_tokens": 0,
            "total_tokens": prompt_estimate,
            "session_id": args.session_id,
        })
        result = {"interrupted": True, "messages": []} if control.cancelled.is_set() else agent.run_conversation(
            user_message, conversation_history=conversation_history, task_id=task_run_id,
        )

        final_response = _extract_final_response(result)
        outcome = _result_outcome(result, control.cancelled.is_set())

        final_messages = result.get("messages", []) if isinstance(result, dict) else []
        usage_sources = _usage_sources(result, agent)
        if usage_sources:
            input_tokens = _first_int_from_sources(usage_sources, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "promptTokenCount", "input", "prompt")
            output_tokens = _first_int_from_sources(usage_sources, "output_tokens", "outputTokens", "completion_tokens", "completionTokens", "completionTokenCount", "output", "completion")
            total_tokens = _first_int_from_sources(usage_sources, "total_tokens", "totalTokens", "totalTokenCount", "total", default=input_tokens + output_tokens)
            if input_tokens or output_tokens or total_tokens:
                context_usage = _agent_context_usage(agent, final_messages)
                emit("usage", {
                    "source": "actual",
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "prompt_tokens": _first_int_from_sources(usage_sources, "prompt_tokens", "promptTokens", "promptTokenCount"),
                    "completion_tokens": _first_int_from_sources(usage_sources, "completion_tokens", "completionTokens", "completionTokenCount"),
                    "cache_read_tokens": _first_int_from_sources(usage_sources, "cache_read_tokens", "cacheReadTokens", "cache_read", default=None),
                    "cache_write_tokens": _first_int_from_sources(usage_sources, "cache_write_tokens", "cacheWriteTokens", "cache_write", default=None),
                    "reasoning_tokens": _first_int_from_sources(usage_sources, "reasoning_tokens", "reasoningTokens", "reasoning"),
                    **context_usage,
                    "model": getattr(agent, "model", None) or _model_from_env(),
                    "model_profile_id": os.environ.get("HERMES_FORGE_MODEL_PROFILE_ID") or None,
                    "estimated_cost_usd": _first_float_from_sources(usage_sources, "estimated_cost_usd", "cost_usd", "cost"),
                    "cost_source": next((source.get("cost_source") for source in usage_sources if source.get("cost_source")), None),
                    "session_id": args.session_id,
                })
        actual_session_id = getattr(agent, "session_id", None) or args.session_id
        session_meta = {}
        if session_db and actual_session_id:
            try:
                session_meta = session_db.get_session(actual_session_id) or {}
            except Exception:
                session_meta = {}

        emit("session_update", {
            "session_id": actual_session_id,
            "previous_session_id": args.session_id if actual_session_id != args.session_id else None,
            "title": session_meta.get("title"),
            "message_count": session_meta.get("message_count") or len(final_messages or []),
            "model": session_meta.get("model") or _model_from_env(),
        })

        emit("result", {
            "success": outcome == "completed",
            "outcome": outcome,
            "interrupted": outcome == "cancelled",
            "content": final_response,
            "is_final_response": isinstance(result, dict) and bool(result.get("final_response")),
            "session_id": args.session_id,
            "taskRunId": task_run_id,
        })
        return 0 if outcome == "completed" else 130 if outcome == "cancelled" else 1

    except Exception as exc:
        _stderr(f"Hermes windows agent runner failed: {exc}")
        _stderr(traceback.format_exc())
        emit("error", {
            "message": str(exc),
            "error_type": type(exc).__name__,
            "traceback": traceback.format_exc(),
            "session_id": args.session_id,
        })
        return 1
    finally:
        control.close()
        # AIAgent only closes DBs it created. This wrapper owns the injected DB.
        if agent is not None:
            try:
                agent.close()
            except Exception as exc:
                _stderr(f"Hermes agent cleanup failed: {type(exc).__name__}")
        if session_db is not None:
            try:
                session_db.close()
            except Exception as exc:
                _stderr(f"Hermes session cleanup failed: {type(exc).__name__}")
        if terminal_tool is not None:
            terminal_tool.set_approval_callback(None)
        if approval_context is not None:
            if session_token is not None:
                approval_context.reset_current_session_key(session_token)
            if interactive_token is not None:
                approval_context.reset_hermes_interactive_context(interactive_token)


if __name__ == "__main__":
    raise SystemExit(main())
