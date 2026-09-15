"""Opt-in end-to-end probe of an installed Hermes using an isolated home and local fake model.

Usage: python probe_pinned_hermes.py --root <checkout> --python <venv-python>
No real credentials, user configuration, model service, or saved jobs are used.
"""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time


def contain_windows_process(proc):
    """The opt-in probe owns all helpers spawned by the isolated agent."""
    if os.name != "nt":
        return lambda: None
    import ctypes
    from ctypes import wintypes
    class BasicLimit(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong), ("flags", wintypes.DWORD),
                    ("min_working", ctypes.c_size_t), ("max_working", ctypes.c_size_t), ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
    class ExtendedLimit(ctypes.Structure):
        _fields_ = [("basic", BasicLimit), ("io", ctypes.c_ulonglong * 6), ("process_memory", ctypes.c_size_t),
                    ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimit()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, wintypes.HANDLE(proc._handle)):
        proc.kill()
        if job:
            kernel.CloseHandle(job)
        raise ctypes.WinError(ctypes.get_last_error())
    return lambda: kernel.CloseHandle(job)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--python", required=True)
    args = parser.parse_args()
    runner = Path(__file__).resolve().parents[1] / "hermes-windows-agent.py"
    gateway = runner.with_name("hermes-forge-gateway.py")
    with tempfile.TemporaryDirectory(prefix="forge-pinned-contract-") as folder:
        isolated = Path(folder)
        requests = []
        blocked_network = isolated / "blocked-network.log"
        # Fail closed before DNS or sockets can reach an external address.
        (isolated / "sitecustomize.py").write_text(
            "import socket, os, faulthandler\nfrom pathlib import Path\nfaulthandler.dump_traceback_later(20,repeat=True)\n"
            "connect=socket.socket.connect\nlookup=socket.getaddrinfo\n"
            "def allowed(host): return host in ('127.0.0.1','localhost','::1',None)\n"
            "def guard(host):\n"
            " if not allowed(host):\n"
            "  with open(os.environ['FORGE_NETWORK_LOG'],'a',encoding='utf-8') as f: f.write(str(host)+'\\n')\n"
            "  raise OSError('External network disabled by isolated contract probe')\n"
            "def safeconnect(self,address):\n guard(address[0]); return connect(self,address)\n"
            "def safelookup(host,*args,**kwargs):\n guard(host); return lookup(host,*args,**kwargs)\n"
            "socket.socket.connect=safeconnect\nsocket.getaddrinfo=safelookup\n", encoding="utf-8")

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                body = json.dumps({"object": "list", "data": [{"id": "forge-contract-model", "object": "model", "context_length": 128000}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(request)
                def is_conversation(item):
                    return bool(item.get("tools")) and any("Run the isolated contract" in str(message.get("content", "")) for message in item.get("messages", []))
                index = sum(is_conversation(item) for item in requests) if is_conversation(request) else 0
                if index == 1:
                    command = "rm -rf " + (isolated / "never-created").as_posix()
                    name, arguments = "terminal", {"command": command}
                elif index == 2:
                    name, arguments = "clarify", {"question": "Probe question", "questions": [{"id": "display", "question": "Choose", "choices": ["A", "B"]}, {"question": "Select", "choices": ["X", "Y"], "multi_select": True}]}
                else:
                    name, arguments = None, None
                message = {"role": "assistant", "content": "Official contract completed" if name is None else None}
                if name:
                    message["tool_calls"] = [{"id": f"call-{index}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]
                finish = "tool_calls" if name else "stop"
                self.send_response(200)
                if request.get("stream"):
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    delta = dict(message)
                    if name:
                        delta["tool_calls"][0]["index"] = 0
                    payload = {"id": f"chatcmpl-{index}", "object": "chat.completion.chunk", "created": 1, "model": "forge-contract-model", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
                    self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())
                    payload["choices"] = [{"index": 0, "delta": {}, "finish_reason": finish}]
                    self.wfile.write(("data: " + json.dumps(payload) + "\n\ndata: [DONE]\n\n").encode())
                else:
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"id": f"chatcmpl-{index}", "object": "chat.completion", "created": 1, "model": "forge-contract-model", "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base_url = f"http://127.0.0.1:{server.server_port}/v1"
        env = {key: value for key, value in os.environ.items() if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)"}}
        env.update({"HERMES_HOME": str(isolated / "hermes-home"), "HOME": str(isolated), "USERPROFILE": str(isolated),
                    "PYTHONPATH": str(isolated), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1",
                    "AI_BASE_URL": base_url, "OPENAI_BASE_URL": base_url, "AI_API_KEY": "test-not-real", "OPENAI_API_KEY": "test-not-real",
                    "HERMES_INFERENCE_PROVIDER": "custom", "AI_MODEL": "forge-contract-model", "OPENAI_MODEL": "forge-contract-model",
                    "HERMES_YOLO_MODE": "0", "HERMES_SINGLE_QUERY_SESSION": "0", "HERMES_CRON_SESSION": "0", "HERMES_GATEWAY_SESSION": "0",
                    "HERMES_DISABLE_LAZY_INSTALLS": "1", "PYTHONNOUSERSITE": "1",
                    "FORGE_NETWORK_LOG": str(blocked_network), "NO_COLOR": "1", "TERM": "dumb"})
        proc = subprocess.Popen([args.python, "-B", str(runner), "--root-path", args.root, "--query", "Run the isolated contract",
                                 "--session-id", "forge-probe-session", "--task-run-id", "forge-probe-task", "--workspace-path", str(isolated),
                                 "--skip-context-files", "--skip-memory", "--max-turns", "6", "--interaction-timeout-seconds", "4"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=isolated,
                                text=True, encoding="utf-8", env=env)
        close_process_job = contain_windows_process(proc)
        def terminate_tree():
            if os.name == "nt":
                subprocess.run(["taskkill", "/pid", str(proc.pid), "/t", "/f"], capture_output=True, timeout=5)
            elif proc.poll() is None:
                proc.kill()
        timer = threading.Timer(55, terminate_tree)
        timer.start()
        stderr = []
        reader = threading.Thread(target=lambda: stderr.extend(proc.stderr.readlines()), daemon=True)
        reader.start()
        events, lines = [], []
        try:
            for line in proc.stdout:
                lines.append(line.rstrip())
                if not line.startswith("__FORGE_EVENT__"):
                    continue
                event = json.loads(line.strip()[15:-19])
                events.append(event)
                if event["type"] == "interaction_request":
                    reply = {"type": "interaction_response", "kind": event["kind"], "requestId": event["requestId"], "taskRunId": event["taskRunId"]}
                    reply.update({"choice": "deny"} if event["kind"] == "approval" else {"answers": {question["id"]: ["X", "Y"] if question.get("multiSelect") else "B" for question in event["questions"]}})
                    proc.stdin.write(json.dumps(reply) + "\n")
                    proc.stdin.flush()
            proc.wait(timeout=2)
            reader.join(2)
            interactions = [event for event in events if event["type"] == "interaction_request"]
            results = [event for event in events if event["type"] == "result"]
            if proc.returncode or not results or not results[-1].get("success") or {event["kind"] for event in interactions} != {"approval", "clarify"}:
                raise RuntimeError(json.dumps({"exit": proc.returncode, "calls": len(requests), "requests": [{"stream": item.get("stream"), "tools": [tool.get("function", {}).get("name") for tool in item.get("tools", [])], "tail": [{"role": message.get("role"), "content": str(message.get("content"))[:700], "tool_calls": message.get("tool_calls")} for message in item.get("messages", [])[-3:]]} for item in requests], "events": events[-12:], "stderr": "".join(stderr)[-6000:]}, ensure_ascii=False))
            gateway_code = "import sys,importlib.util;sys.path.insert(0,sys.argv[1]);from gateway import run;from cron import scheduler_provider;s=importlib.util.spec_from_file_location('probe_gateway',sys.argv[2]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.validate_extension_contract(run,scheduler_provider);print('GATEWAY_CONTRACT_OK')"
            check = subprocess.run([args.python, "-B", "-c", gateway_code, args.root, str(gateway)], cwd=isolated, env=env, capture_output=True, text=True, encoding="utf-8", timeout=45)
            if check.returncode or "GATEWAY_CONTRACT_OK" not in check.stdout:
                raise RuntimeError(check.stdout + check.stderr)
            print(json.dumps({"ok": True, "modelCalls": len(requests), "interactionKinds": [event["kind"] for event in interactions], "gatewayContract": True,
                              "externalAttemptsBlocked": len(blocked_network.read_text().splitlines()) if blocked_network.exists() else 0,
                              "result": results[-1]["content"]}, ensure_ascii=False))
        finally:
            timer.cancel()
            if proc.poll() is None:
                terminate_tree()
                proc.wait(timeout=2)
            close_process_job()
            proc.stdin.close()
            proc.stdout.close()
            proc.stderr.close()
            server.shutdown()
            server.server_close()
            time.sleep(0.2)


if __name__ == "__main__":
    main()
