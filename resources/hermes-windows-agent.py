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
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path


EVENT_START = "__FORGE_EVENT__"
EVENT_END = "__FORGE_EVENT_END__"


def emit(event_type: str, payload: dict) -> None:
    """向 Forge 发送结构化事件。"""
    event = {
        "type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **payload,
    }
    line = json.dumps(event, ensure_ascii=False)
    print(f"{EVENT_START}{line}{EVENT_END}", flush=True)


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


def _prepare_user_message(query: str, image_path: str | None):
    if not image_path:
        return query
    path = Path(image_path)
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return [
        {"type": "text", "text": query},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}},
    ]


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


def _load_session_history(session_db, session_id: str | None) -> list[dict]:
    if not session_db or not session_id:
        return []
    try:
        resolved = session_db.resolve_resume_session_id(session_id)
    except Exception:
        resolved = session_id
    try:
        messages = session_db.get_messages_as_conversation(resolved, include_ancestors=True)
    except Exception as exc:
        emit("diagnostic", {
            "severity": "warning",
            "message": f"无法从 Hermes state.db 读取历史，将使用 Forge 缓存历史：{exc}",
            "session_id": session_id,
        })
        return []
    return [
        {"role": item.get("role"), "content": item.get("content")}
        for item in messages
        if item.get("role") in ("user", "assistant") and isinstance(item.get("content"), str) and item.get("content").strip()
    ]


def _make_agent_callbacks(session_id: str | None):
    def stream_delta(delta):
        if delta:
            emit("message_chunk", {"content": str(delta), "session_id": session_id})

    def reasoning_delta(delta):
        if delta:
            emit("reasoning", {"content": str(delta), "session_id": session_id})

    def tool_progress(*args):
        event = str(args[0]) if args else "tool.progress"
        name = str(args[1]) if len(args) > 1 else "unknown"
        preview = str(args[2]) if len(args) > 2 and args[2] is not None else ""
        emit("status", {
            "level": "info",
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
        emit("tool_result", {
            "tool": str(name or "unknown"),
            "output": _safe_preview(result, 1200),
            "success": True,
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
    }


def _try_install_stream_hooks() -> None:
    """
    尝试 monkey-patch Hermes 内部来捕获工具调用事件。
    如果 Hermes 的 AIAgent 本身不支持流式回调，这是 Plan B。
    由于我们不知道 Hermes 内部结构，这里先预留扩展点。
    后续可以通过 inspect run_agent 模块来找到可 patch 的目标。
    """
    try:
        import run_agent as ra
        # 尝试找到 Agent 类中的工具执行方法
        agent_cls = getattr(ra, "AIAgent", None)
        if agent_cls is None:
            return

        # 如果 AIAgent 有 run_conversation_generator 或类似方法，优先使用
        if hasattr(agent_cls, "run_conversation_stream"):
            # 原生支持流式，不需要 patch
            return

        # 尝试 patch 工具调用
        original_run_conversation = getattr(agent_cls, "run_conversation", None)
        if original_run_conversation is None:
            return

        # 尝试找到工具执行相关的内部方法
        # Hermes AIAgent 中实际的方法名：_invoke_tool / _execute_tool_calls / _execute_tool_calls_concurrent
        for attr_name in ("_invoke_tool", "_execute_tool", "execute_tool", "_run_tool", "run_tool", "_call_tool", "call_tool"):
            if hasattr(agent_cls, attr_name):
                _patch_tool_method(agent_cls, attr_name)
                break
    except Exception:
        # Patch 失败不影响主流程
        pass


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
    original_wait_for_process = env_base.BaseEnvironment._wait_for_process
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

    def wait_for_process(self, proc, timeout: int = 120):
        try:
            output, _ = proc.communicate(timeout=timeout)
            return {"output": output or "", "returncode": proc.returncode}
        except subprocess.TimeoutExpired:
            try:
                self._kill_process(proc)
            finally:
                try:
                    output, _ = proc.communicate(timeout=2)
                except Exception:
                    output = ""
            return {
                "output": ((output or "") + f"\n[Command timed out after {timeout}s]").strip(),
                "returncode": 124,
            }
        except Exception:
            return original_wait_for_process(self, proc, timeout)

    env_base.BaseEnvironment._quote_cwd_for_cd = staticmethod(quote_cwd_for_cd)
    env_base.BaseEnvironment._extract_cwd_from_output = extract_cwd_from_output
    env_base.BaseEnvironment._wait_for_process = wait_for_process
    LocalEnvironment._update_cwd = update_cwd
    ShellFileOperations._escape_shell_arg = escape_shell_arg


def _ensure_git_bash_path() -> None:
    if os.environ.get("HERMES_GIT_BASH_PATH"):
        return
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    for candidate in (
        Path(program_files) / "Git" / "bin" / "bash.exe",
        Path(program_files) / "Git" / "usr" / "bin" / "bash.exe",
        Path(local_app_data) / "Programs" / "Git" / "bin" / "bash.exe",
        Path(program_files_x86) / "Git" / "bin" / "bash.exe",
    ):
        if candidate.is_file():
            os.environ["HERMES_GIT_BASH_PATH"] = str(candidate)
            return


def _patch_tool_method(agent_cls, method_name: str) -> None:
    """Patch AIAgent 的工具执行方法来 emit 事件。"""
    original = getattr(agent_cls, method_name)

    def patched(self, *args, **kwargs):
        # 尝试提取 tool_name 和 input
        tool_name = _extract_tool_name(args, kwargs)
        tool_input = _extract_tool_input(args, kwargs)

        session_id = getattr(self, "session_id", None)
        emit("tool_call", {"tool": tool_name, "input": tool_input, "session_id": session_id})

        try:
            result = original(self, *args, **kwargs)
            emit("tool_result", {
                "tool": tool_name,
                "output": _safe_preview(result),
                "session_id": session_id,
            })
            return result
        except Exception as e:
            emit("tool_result", {
                "tool": tool_name,
                "output": f"Error: {e}",
                "success": False,
                "session_id": session_id,
            })
            raise

    setattr(agent_cls, method_name, patched)


def _extract_tool_name(args, kwargs) -> str:
    # 常见的参数顺序：(self, tool_name, input_data) 或 (self, tool_name, **input_data)
    if len(args) >= 2 and isinstance(args[1], str):
        return args[1]
    return kwargs.get("tool_name") or kwargs.get("tool") or "unknown"


def _extract_tool_input(args, kwargs) -> dict:
    if len(args) >= 3 and isinstance(args[2], dict):
        return args[2]
    return {k: v for k, v in kwargs.items() if k not in ("tool_name", "tool")}


def _safe_preview(value, max_len: int = 500) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        if len(text) > max_len:
            return text[:max_len] + "..."
        return text
    except Exception:
        return str(value)[:max_len]


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


def _usage_sources(result, agent) -> list[dict]:
    sources: list[dict] = []
    if isinstance(result, dict):
        sources.append(result)
        for key in ("usage", "token_usage", "tokens", "metadata", "response_metadata"):
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
    return sources


def _first_int_from_sources(sources: list[dict], *keys: str, default: int = 0) -> int:
    for source in sources:
        for key in keys:
            if key in source and source.get(key) is not None:
                value = _int_value(source.get(key))
                if value:
                    return value
    return default


def _first_float_from_sources(sources: list[dict], *keys: str, default: float = 0.0) -> float:
    for source in sources:
        for key in keys:
            if key in source and source.get(key) is not None:
                value = _float_value(source.get(key))
                if value:
                    return value
    return default


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root-path", required=True, help="Hermes 安装根目录")
    parser.add_argument("--query", required=True, help="用户查询")
    parser.add_argument("--system-prompt", default="", help="系统提示词")
    parser.add_argument("--session-id", help="会话 ID")
    parser.add_argument("--workspace-path", help="当前工作区路径")
    parser.add_argument("--history-file", help="Forge 传入的同一对话窗口历史 JSON")
    parser.add_argument("--image-path", help="图片附件路径")
    parser.add_argument("--source", default="hermes-forge-desktop", help="调用来源标识")
    parser.add_argument("--max-turns", type=int, default=90, help="最大对话轮数")
    args = parser.parse_args()

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
    except ImportError:
        SessionDB = None

    _install_windows_git_bash_path_compat()

    emit("lifecycle", {"stage": "started", "session_id": args.session_id})

    try:
        session_db = None
        if SessionDB is not None:
            try:
                session_db = SessionDB()
            except Exception as exc:
                emit("diagnostic", {
                    "severity": "warning",
                    "message": f"Hermes state.db 初始化失败，会话仍可运行但不会完整索引：{exc}",
                    "session_id": args.session_id,
                })

        callbacks = _make_agent_callbacks(args.session_id)
        agent = AIAgent(
            base_url=_base_url_from_env(),
            api_key=_api_key_from_env(),
            provider=_provider_from_env(),
            model=_model_from_env(),
            max_iterations=args.max_turns,
            quiet_mode=True,
            ephemeral_system_prompt=args.system_prompt or None,
            session_id=args.session_id,
            platform=args.source,
            session_db=session_db,
            skip_context_files=False,
            **callbacks,
        )

        user_message = _prepare_user_message(args.query, args.image_path)
        db_history = _load_session_history(session_db, args.session_id)
        conversation_history = db_history or _load_conversation_history(args.history_file)
        result = agent.run_conversation(
            user_message,
            conversation_history=conversation_history,
            task_id=args.session_id,
        )

        final_response = ""
        if isinstance(result, dict):
            final_response = str(result.get("final_response") or "")
        else:
            final_response = str(result or "")

        final_messages = result.get("messages", []) if isinstance(result, dict) else []
        usage_sources = _usage_sources(result, agent)
        if usage_sources:
            input_tokens = _first_int_from_sources(usage_sources, "input_tokens", "prompt_tokens", "input", "prompt")
            output_tokens = _first_int_from_sources(usage_sources, "output_tokens", "completion_tokens", "output", "completion")
            total_tokens = _first_int_from_sources(usage_sources, "total_tokens", "total", default=input_tokens + output_tokens)
            if input_tokens or output_tokens or total_tokens:
                emit("usage", {
                    "source": "actual",
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "prompt_tokens": _first_int_from_sources(usage_sources, "prompt_tokens"),
                    "completion_tokens": _first_int_from_sources(usage_sources, "completion_tokens"),
                    "cache_read_tokens": _first_int_from_sources(usage_sources, "cache_read_tokens", "cache_read"),
                    "cache_write_tokens": _first_int_from_sources(usage_sources, "cache_write_tokens", "cache_write"),
                    "reasoning_tokens": _first_int_from_sources(usage_sources, "reasoning_tokens", "reasoning"),
                    "estimated_cost_usd": _first_float_from_sources(usage_sources, "estimated_cost_usd", "cost_usd", "cost"),
                    "cost_source": usage_sources[0].get("cost_source"),
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
            "success": True,
            "content": final_response,
            "session_id": args.session_id,
        })
        return 0

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


if __name__ == "__main__":
    raise SystemExit(main())
