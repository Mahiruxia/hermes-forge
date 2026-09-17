"""Opt-in native Hermes feature probe: profile settings, skills, images, MCP,
memory, planning and a failed tool followed by recovery. All state is isolated.

Usage: python probe_native_agent.py --root <hermes> --python <managed-python>
"""
import argparse
import base64
import json
import os
import re
from pathlib import Path
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from probe_prompt_cache import run_bridge


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--python", required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="forge-native-probe-") as folder:
        workspace = Path(folder)
        home = workspace / "hermes-home"
        home.mkdir()
        (workspace / "sitecustomize.py").write_text(
            "import socket\nconnect=socket.socket.connect\nlookup=socket.getaddrinfo\n"
            "def guard(host):\n if host not in ('127.0.0.1','localhost','::1',None): raise OSError('External network disabled by native probe')\n"
            "def safeconnect(self,address):\n guard(address[0]); return connect(self,address)\n"
            "def safelookup(host,*a,**kw):\n guard(host); return lookup(host,*a,**kw)\n"
            "socket.socket.connect=safeconnect\nsocket.getaddrinfo=safelookup\n", encoding="utf-8")
        mcp_server = workspace / "fixture_mcp.py"
        mcp_server.write_text(
            "from mcp.server import MCPServer\nmcp=MCPServer('Forge Native Probe')\n"
            "@mcp.tool()\ndef probe_echo(message: str) -> str:\n return 'MCP_WIRE_OK: ' + message\n"
            "mcp.run()\n", encoding="utf-8")
        config = {
            "model": {"supports_vision": True},
            "agent": {"max_turns": 8, "system_prompt": "PROFILE_PERSONALITY_MARKER", "disabled_toolsets": ["web"]},
            "platform_toolsets": {"cli": ["file", "skills", "memory", "todo", "forge_probe"]},
            "checkpoints": {"enabled": True},
            "compression": {"enabled": False},
            "prefill_messages_file": "examples.json",
            "mcp_servers": {"forge_probe": {"command": args.python, "args": [str(mcp_server)], "enabled": True}},
            "auxiliary": {"title_generation": {"enabled": False}, "background_review": {"enabled": False}},
        }
        # JSON is a YAML subset; quoting Windows paths remains unambiguous.
        (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        (home / "examples.json").write_text(json.dumps([
            {"role": "user", "content": "PREFILL_USER_MARKER"},
            {"role": "assistant", "content": "PREFILL_ASSISTANT_MARKER"},
        ]), encoding="utf-8")
        (home / "memories").mkdir()
        (home / "memories" / "MEMORY.md").write_text("NATIVE_MEMORY_SEED", encoding="utf-8")
        (workspace / "AGENTS.md").write_text("PROJECT_RULES_MARKER: inspect only this fixture directory.", encoding="utf-8")
        skill = home / "skills" / "native-probe" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: native-probe\ndescription: Local integration fixture\n---\nNATIVE_SKILL_MARKER: follow the supplied task.\n", encoding="utf-8")
        # Two distinct files with valid PNG payloads; no external media.
        pixel = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=")
        images = [workspace / "first.png", workspace / "second.png"]
        for image in images:
            image.write_bytes(pixel)
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"gpt-4o","context_length":128000}]}')

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if not self.path.endswith("/chat/completions"):
                    self.send_response(404)
                    self.end_headers()
                    return
                requests.append(payload)
                names = [tool.get("function", {}).get("name", "") for tool in payload.get("tools", [])]
                deferred_names = re.findall(r'\b(mcp_[\w-]*probe_echo)\b', json.dumps(payload.get("messages", [])))
                mcp_name = next((name for name in names if "probe_echo" in name), next(iter(deferred_names), "missing_mcp_tool"))
                def invoke(name, arguments):
                    return (name, arguments) if name in names else ("tool_call", {"calls": [{"name": name, "arguments": arguments}]})
                steps = [
                    ("tool_search", {"queries": ["forge_probe probe_echo", "todo_list"], "limit": 5}),
                    invoke(mcp_name, {"message": "hello"}),
                    ("read_file", {"path": str(workspace / "nonexistent-file.txt")}),
                    ("read_file", {"path": str(workspace / "AGENTS.md")}),
                    ("memory", {"action": "add", "target": "memory", "content": "NATIVE_MEMORY_WRITTEN"}),
                    invoke("todo_list", {"todos": [{"id": "probe", "content": "Verify the native tool loop", "status": "completed"}]}),
                ]
                index = len(requests) - 1
                message = {"role": "assistant", "content": "NATIVE_PROBE_OK"}
                if index < len(steps):
                    name, tool_args = steps[index]
                    message = {"role": "assistant", "content": "I will perform the next native tool step and inspect its result. ",
                               "tool_calls": [{"id": f"native-call-{index}", "type": "function", "function": {"name": name, "arguments": json.dumps(tool_args)}}]}
                finish = "tool_calls" if index < len(steps) else "stop"
                usage = {"prompt_tokens": 2000, "completion_tokens": 20, "total_tokens": 2020}
                body = {"id": f"chatcmpl-{index}", "object": "chat.completion", "created": 1, "model": "gpt-4o",
                        "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": usage}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if payload.get("stream") else "application/json")
                self.end_headers()
                if payload.get("stream"):
                    delta = dict(message)
                    if "tool_calls" in delta:
                        delta["tool_calls"][0]["index"] = 0
                    body.update({"object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
                    self.wfile.write(f"data: {json.dumps(body)}\n\n".encode())
                    body["choices"] = [{"index": 0, "delta": {}, "finish_reason": finish}]
                    self.wfile.write(f"data: {json.dumps(body)}\n\ndata: [DONE]\n\n".encode())
                else:
                    self.wfile.write(json.dumps(body).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)"}}
        env.update({"HERMES_HOME": str(home), "HOME": str(workspace), "USERPROFILE": str(workspace),
                    "PYTHONPATH": str(workspace), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONNOUSERSITE": "1", "HERMES_DISABLE_LAZY_INSTALLS": "1", "HERMES_FORGE_CONTEXT_WINDOW": "64000",
                    "AI_MODEL": "gpt-4o", "OPENAI_MODEL": "gpt-4o", "HERMES_INFERENCE_PROVIDER": "custom",
                    "AI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1", "OPENAI_API_KEY": "native-fixture", "AI_API_KEY": "native-fixture",
                    "HERMES_YOLO_MODE": "0", "NO_COLOR": "1", "TERM": "dumb"})
        try:
            diagnostics = []
            events = run_bridge(args.python, args.root, workspace, env, "native-features", "/native-probe Verify images and native tools.",
                                skip_context=False, return_events=True, diagnostics=diagnostics,
                                extra_args=[part for image in images for part in ("--image-path", str(image))])
            assert len(requests) == 7, f"Unexpected model calls: {len(requests)}"
            first = requests[0]
            serialized = json.dumps(first)
            for marker in ("PROFILE_PERSONALITY_MARKER", "PREFILL_USER_MARKER", "NATIVE_SKILL_MARKER", "PROJECT_RULES_MARKER", "NATIVE_MEMORY_SEED"):
                assert marker in serialized, f"Missing native context: {marker}"
            image_count = sum(1 for msg in first["messages"] if isinstance(msg.get("content"), list)
                              for block in msg["content"] if block.get("type") == "image_url")
            assert image_count == 2, f"Expected both images, got {image_count}"
            names = [tool["function"]["name"] for tool in first.get("tools", [])]
            assert "probe_echo" in json.dumps(requests[1]["messages"]), f"Configured MCP server was not discoverable: {names}\n{''.join(diagnostics)[-7000:]}"
            assert not any(name in ("web_search", "web_extract") for name in names), "Disabled tools leaked into the model"
            results = [event for event in events if event["type"] == "tool_result"]
            assert any("probe_echo" in event["tool"] and "MCP_WIRE_OK" in event["output"] for event in results), f"{results}\n{''.join(diagnostics)[-7000:]}"
            assert any(event["tool"] == "read_file" and event["success"] is False for event in results), results
            assert any(event["tool"] == "read_file" and event["success"] is True and "PROJECT_RULES_MARKER" in event["output"] for event in results), results
            assert any(event["tool"] == "todo_list" and event["success"] is True for event in results), results
            assert "NATIVE_MEMORY_WRITTEN" in (home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
            final = next(event for event in reversed(events) if event["type"] == "result")
            assert final["content"] == "NATIVE_PROBE_OK" and final["is_final_response"]
            print(json.dumps({"ok": True, "modelCalls": len(requests), "imageCount": image_count, "skillLoaded": True, "deferredToolsDiscovered": True,
                              "profileContextLoaded": True, "mcpToolExecuted": True, "failedToolReported": True, "fileReadSucceeded": True,
                              "memoryPersisted": True, "todoExecuted": True, "officialFinalResponse": True}), flush=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)
            time.sleep(0.3)


if __name__ == "__main__":
    main()
