"""Opt-in cache/context integration check against the pinned, unmodified Hermes.

Uses an isolated home and localhost OpenAI/Anthropic fixtures, never cloud keys.
Usage: python probe_prompt_cache.py --root <hermes> --python <managed-python>
"""
import argparse
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from probe_pinned_hermes import contain_windows_process

RUNNER = Path(__file__).resolve().parents[1] / "hermes-windows-agent.py"


def strip_cache_markers(value):
    if isinstance(value, dict):
        return {key: strip_cache_markers(item) for key, item in value.items() if key != "cache_control"}
    if isinstance(value, list):
        return [strip_cache_markers(item) for item in value]
    return value


def first_difference(left, right, pointer="messages"):
    if type(left) is not type(right):
        return f"{pointer}: {type(left).__name__} != {type(right).__name__}"
    if isinstance(left, dict):
        for key in dict.fromkeys([*left, *right]):
            if left.get(key) != right.get(key):
                return first_difference(left.get(key), right.get(key), f"{pointer}.{key}")
    elif isinstance(left, list):
        if len(left) != len(right):
            return f"{pointer}: lengths {len(left)} != {len(right)}"
        for index, (a, b) in enumerate(zip(left, right)):
            if a != b:
                return first_difference(a, b, f"{pointer}[{index}]")
    return f"{pointer}: {repr(left)[-180:]} != {repr(right)[-180:]}"


def check_state(root):
    sys.path.insert(0, str(root))
    from hermes_state import SessionDB
    from agent.context_compressor import ContextCompressor
    spec = importlib.util.spec_from_file_location("forge_cache_bridge", RUNNER)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    with SessionDB() as db:
        db.create_session("compression-parent", "cache-probe", model="fixture-model")
        db.append_message("compression-parent", "user", "OLD_CONTEXT_DO_NOT_REPLAY " * 4000)
        db.append_message("compression-parent", "assistant", "old answer")
        db.end_session("compression-parent", "compression")
        db.create_session("compression-tip", "cache-probe", model="fixture-model", parent_session_id="compression-parent")
        db.append_message("compression-tip", "user", "Summary: keep the user's original constraints.", _compressed_summary=True)
        db.append_message("compression-tip", "assistant", "Summary acknowledged.")
        db.append_message("compression-tip", "user", "Continue with the current task.")
        old = db.get_messages_as_conversation("compression-tip", include_ancestors=True, repair_alternation=True)
        current = bridge._load_session_history(db, "compression-parent")
        assert len(current) == 3 and current[0].get("_compressed_summary")
        assert "OLD_CONTEXT_DO_NOT_REPLAY" not in json.dumps(current)
        assert "OLD_CONTEXT_DO_NOT_REPLAY" in json.dumps(old)
        db.create_session("empty-session", "cache-probe")
        assert bridge._load_session_history(db, "empty-session") == []

    compressor = ContextCompressor(model="fixture-model", config_context_length=128000, max_tokens=4000, quiet_mode=True)
    before = compressor.threshold_tokens
    compressor._summary_failure_cooldown_until = 987654321
    bridge._configure_context_window(type("Agent", (), {"context_compressor": compressor})())
    assert compressor.context_length == 64000 and compressor.threshold_tokens < before
    assert compressor._summary_failure_cooldown_until == 987654321
    print(json.dumps({"phase": "compressed-history", "ok": True, "previousCharacters": len(json.dumps(old)),
                      "activeCharacters": len(json.dumps(current)), "contextWindow": compressor.context_length,
                      "compressionThreshold": compressor.threshold_tokens}), flush=True)


def run_bridge(python, root, workspace, env, session, query, *, extra_args=(), skip_context=True, return_events=False, diagnostics=None):
    proc = subprocess.Popen([python, "-B", str(RUNNER), "--root-path", str(root), "--query", query,
                             "--session-id", session, "--task-run-id", session + "-" + hashlib.sha256(query.encode()).hexdigest()[:10], "--workspace-path", str(workspace),
                             *(["--skip-memory", "--skip-context-files"] if skip_context else []), "--max-turns", "8", *extra_args],
                            cwd=workspace, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    close_job = contain_windows_process(proc)
    timer = threading.Timer(55, proc.kill)
    timer.start()
    errors = []
    reader = threading.Thread(target=lambda: errors.extend(proc.stderr.readlines()), daemon=True)
    reader.start()
    events = []
    try:
        for line in proc.stdout:
            if line.startswith("__FORGE_EVENT__"):
                events.append(json.loads(line.strip()[15:-19]))
            elif diagnostics is not None:
                diagnostics.append(line)
        proc.wait(timeout=3)
        reader.join(3)
        if diagnostics is not None:
            diagnostics.extend(errors)
        if proc.returncode or not any(event.get("type") == "result" and event.get("success") for event in events):
            raise RuntimeError(json.dumps({"exit": proc.returncode, "events": events[-5:], "stderr": "".join(errors)[-3500:]}, ensure_ascii=False))
        return events if return_events else next(event for event in reversed(events) if event.get("type") == "usage" and event.get("source") == "actual")
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)
        close_job()
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            pipe.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--check-state", action="store_true")
    args = parser.parse_args()
    if args.check_state:
        check_state(args.root)
        return
    with tempfile.TemporaryDirectory(prefix="forge-cache-probe-") as folder:
        workspace = Path(folder)
        guard = workspace / "sitecustomize.py"
        guard.write_text("import socket\n_original_connect=socket.socket.connect\n_original_lookup=socket.getaddrinfo\n"
                         "def guard(host):\n if host not in ('127.0.0.1','localhost','::1',None): raise OSError('External network disabled by cache probe')\n"
                         "def connect(self,address):\n guard(address[0]); return _original_connect(self,address)\n"
                         "def lookup(host,*a,**kw):\n guard(host); return _original_lookup(host,*a,**kw)\n"
                         "socket.socket.connect=connect\nsocket.getaddrinfo=lookup\n", encoding="utf-8")
        env = {key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)"}}
        env.update({"HOME": str(workspace), "USERPROFILE": str(workspace), "HERMES_HOME": str(workspace / "home"),
                    "PYTHONPATH": str(workspace), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONNOUSERSITE": "1", "HERMES_DISABLE_LAZY_INSTALLS": "1", "HERMES_FORGE_CONTEXT_WINDOW": "64000",
                    "AI_API_KEY": "public-cache-fixture", "OPENAI_API_KEY": "public-cache-fixture", "ANTHROPIC_API_KEY": "public-cache-fixture",
                    "HERMES_YOLO_MODE": "0", "NO_COLOR": "1", "TERM": "dumb"})
        home = Path(env["HERMES_HOME"])
        home.mkdir()
        (home / "config.yaml").write_text("compression:\n  enabled: false\nauxiliary:\n  title_generation:\n    enabled: false\n  background_review:\n    enabled: false\n", encoding="utf-8")
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"data": []}).encode())

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if not self.path.endswith(("/messages", "/chat/completions")):
                    # Local-endpoint capability probes (/api/show, etc.) are
                    # not model calls and must not affect the cache fixture.
                    self.send_response(404)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error":"not available in the cache fixture"}')
                    return
                requests.append(payload)
                anthropic = self.path.endswith("/messages")
                cached = 900 if len(requests) > 1 else 0
                usage = ({"input_tokens": 1000 - cached, "output_tokens": 12, "cache_read_input_tokens": cached, "cache_creation_input_tokens": 0}
                         if anthropic else {"prompt_tokens": 1000, "completion_tokens": 12, "total_tokens": 1012, "prompt_tokens_details": {"cached_tokens": cached}})
                body = ({"id": "msg_fixture", "type": "message", "role": "assistant", "model": payload["model"], "content": [{"type": "text", "text": "CACHE_PROBE_OK"}], "stop_reason": "end_turn", "stop_sequence": None, "usage": usage}
                        if anthropic else {"id": "chatcmpl-fixture", "object": "chat.completion", "created": 1, "model": payload["model"], "choices": [{"index": 0, "message": {"role": "assistant", "content": "CACHE_PROBE_OK"}, "finish_reason": "stop"}], "usage": usage})
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if payload.get("stream") else "application/json")
                self.end_headers()
                if not payload.get("stream"):
                    self.wfile.write(json.dumps(body).encode())
                elif anthropic:
                    events = [
                        ("message_start", {"type": "message_start", "message": {**body, "content": [], "stop_reason": None}}),
                        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "CACHE_PROBE_OK"}}),
                        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 12}}),
                        ("message_stop", {"type": "message_stop"}),
                    ]
                    for kind, event in events:
                        self.wfile.write(f"event: {kind}\ndata: {json.dumps(event)}\n\n".encode())
                else:
                    for delta, reason in (({"role": "assistant", "content": "CACHE_PROBE_OK"}, None), ({}, "stop")):
                        chunk = {**body, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
                        if reason is None:
                            chunk.pop("usage")
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            state = subprocess.run([args.python, "-B", str(Path(__file__).resolve()), "--root", str(args.root), "--check-state"], cwd=workspace, env=env, capture_output=True, text=True, encoding="utf-8", timeout=45)
            if state.returncode:
                raise RuntimeError(state.stdout + state.stderr)
            print(state.stdout.strip(), flush=True)
            for protocol, model in (("custom", "forge-cache-model"), ("anthropic", "claude-sonnet-4-5")):
                requests.clear()
                base = f"http://127.0.0.1:{server.server_port}" + ("/v1" if protocol == "custom" else "")
                env.update({"HERMES_INFERENCE_PROVIDER": protocol, "AI_MODEL": model, "OPENAI_MODEL": model,
                            "AI_BASE_URL": base, "OPENAI_BASE_URL": base, "ANTHROPIC_BASE_URL": base})
                session = "cache-probe-" + protocol
                first = run_bridge(args.python, args.root, workspace, env, session, ("Stable cache probe instructions. " * 200).rstrip())
                second = run_bridge(args.python, args.root, workspace, env, session, "Continue the same task.")
                assert len(requests) == 2, f"Unexpected auxiliary/retry calls: {len(requests)}"
                left, right = map(strip_cache_markers, requests)
                if protocol == "anthropic":
                    # Messages accepts a string as shorthand for one text block.
                    # A moving cache marker expands that shorthand on its current
                    # target; it does not change the model-visible text prefix.
                    for request in (left, right):
                        for message in request["messages"]:
                            if isinstance(message.get("content"), str):
                                message["content"] = [{"type": "text", "text": message["content"]}]
                assert left.get("tools") == right.get("tools"), "Tool prefix changed across processes"
                assert left.get("system") == right.get("system"), "System prefix changed across processes"
                prefix = right["messages"][:len(left["messages"])]
                assert left["messages"] == prefix, "Conversation prefix changed: " + first_difference(left["messages"], prefix)
                assert first["context_window"] == second["context_window"] == 64000
                assert second["input_tokens"] == 1000 and second["cache_read_tokens"] == 900
                assert second["context_output_tokens"] == 12
                if protocol == "anthropic":
                    assert '"cache_control"' in json.dumps(requests[0]), "Official Anthropic cache markers missing"
                else:
                    assert "prompt_cache_key" not in requests[0] and '"cache_control"' not in json.dumps(requests[0]), "Unsupported cache fields leaked to a generic endpoint"
                print(json.dumps({"phase": protocol, "ok": True, "processes": 2, "identicalPrefixMessages": len(left["messages"]),
                                  "contextWindow": second["context_window"], "fixtureCacheReadTokens": second["cache_read_tokens"]}), flush=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)
            # Windows job-object termination releases descendant cwd handles
            # asynchronously; let it finish before removing the isolated home.
            time.sleep(0.3)


if __name__ == "__main__":
    main()
