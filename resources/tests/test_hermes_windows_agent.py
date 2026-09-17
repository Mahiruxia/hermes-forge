"""Exercise the desktop bridge without importing or changing a Hermes installation."""
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch


RUNNER = Path(__file__).resolve().parents[1] / "hermes-windows-agent.py"
spec = importlib.util.spec_from_file_location("forge_windows_agent", RUNNER)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class InteractionTests(unittest.TestCase):
    def setUp(self):
        self.requests = queue.Queue()
        self.control = bridge.ForgeInteractionControl("task-1", 0.5, lambda kind, payload: self.requests.put(payload))
        self.addCleanup(self.control.close)

    def call(self, callback, *args, **kwargs):
        answers = queue.Queue()
        thread = threading.Thread(target=lambda: answers.put(callback(*args, **kwargs)))
        thread.start()
        self.addCleanup(thread.join, 1)
        request = self.requests.get(timeout=1)
        return request, answers

    def reply(self, request, **answer):
        return self.control.accept({"type": "interaction_response", "requestId": request["requestId"],
                                    "taskRunId": "task-1", "kind": request["kind"], **answer})

    def test_concurrent_replies_do_not_cross_tool_calls(self):
        first, first_answer = self.call(self.control.approval, "first", "first")
        second, second_answer = self.call(self.control.approval, "second", "second")
        self.assertFalse(self.reply(first, choice="once", taskRunId="other-task"))
        self.assertFalse(self.reply(first, choice="once", kind="clarify"))
        self.assertTrue(self.reply(second, choice="deny"))
        self.assertTrue(self.reply(first, choice="once"))
        self.assertEqual(second_answer.get(timeout=1), "deny")
        self.assertEqual(first_answer.get(timeout=1), "once")
        self.assertFalse(self.reply(first, choice="always"))

    def test_forbidden_approval_scope_is_denied(self):
        request, answer = self.call(self.control.approval, "cmd", "description", allow_permanent=False)
        self.assertFalse(request["allowPermanent"])
        self.reply(request, choice="always")
        self.assertEqual(answer.get(timeout=1), "deny")

    def test_batch_clarification_preserves_official_qids(self):
        questions = [{"qid": "q1", "id": "display-name", "question": "Where?", "choices": ["A", "B"]},
                     {"qid": "q2", "question": "Which?", "multi_select": True, "choices": ["X", "Y"]}]
        request, answer = self.call(self.control.clarify, "Questions", [], questions=questions)
        self.assertEqual([item["id"] for item in request["questions"]], ["q1", "q2"])
        self.reply(request, answers={"q1": "A", "q2": ["X", "Y"]})
        self.assertEqual(answer.get(timeout=1), {"answers": {"q1": "A", "q2": ["X", "Y"]}})

    def test_cancel_unblocks_waiter_and_interrupts_agent_once(self):
        agent = Mock()
        self.control.attach_agent(agent)
        request, answer = self.call(self.control.approval, "cmd", "description")
        self.control.cancel()
        self.control.cancel()
        self.assertEqual(answer.get(timeout=1), "deny")
        agent.hard_interrupt.assert_called_once()
        self.assertFalse(self.reply(request, choice="once"))

    def test_timeout_and_input_eof_fail_closed(self):
        self.control.timeout_seconds = 0.01
        self.assertEqual(self.control.approval("cmd", "description"), "timeout")
        with patch.object(bridge.os, "read", return_value=b""), patch.object(bridge.sys, "stdin", Mock()):
            self.control._read_stdin()
        self.assertTrue(self.control.cancelled.is_set())
        self.assertEqual(self.control.approval("cmd", "description"), "deny")

    def test_close_unblocks_clarification(self):
        _request, answer = self.call(self.control.clarify, "Question", [])
        self.control.close()
        self.assertIsNone(answer.get(timeout=1))

    def test_history_retains_tool_pairing_and_read_failures_are_visible(self):
        messages = [{"role": "assistant", "content": None, "tool_calls": [{"id": "call-1"}]},
                    {"role": "tool", "tool_call_id": "call-1", "content": "ok"}]
        db = Mock()
        db.resolve_resume_session_id.return_value = "child-session"
        db.get_messages_as_conversation.return_value = messages
        self.assertIs(bridge._load_session_history(db, "parent-session"), messages)
        db.get_messages_as_conversation.assert_called_once_with("child-session", include_ancestors=False, repair_alternation=True)
        db.get_messages_as_conversation.side_effect = RuntimeError("database unavailable")
        with self.assertRaises(RuntimeError):
            bridge._load_session_history(db, "parent-session")

    def test_official_result_outcomes(self):
        self.assertEqual(bridge._result_outcome({"failed": True}), "failed")
        self.assertEqual(bridge._result_outcome({"interrupted": True, "failed": True}), "cancelled")
        self.assertEqual(bridge._result_outcome({"messages": []}, True), "cancelled")
        self.assertEqual(bridge._result_outcome({"messages": []}), "completed")


class MainContractTests(unittest.TestCase):
    def test_real_control_pipe_and_owned_resource_cleanup(self):
        """A fake official package checks constructor/callback/history/cleanup wiring."""
        with tempfile.TemporaryDirectory(prefix="forge-runner-contract-") as folder:
            root = Path(folder)
            config_modules = {
                "hermes_cli/__init__.py": "",
                "hermes_cli/config.py": "def load_config(): return {'agent': {'max_turns': 7}}\ndef resolve_turn_limit(value): return int(value or 99)\n",
                "hermes_cli/personality.py": "def resolve_ephemeral_system_prompt(cfg): return 'Configured personality'\n",
                "hermes_cli/fallback_config.py": "def get_fallback_chain(cfg): return []\n",
                "hermes_cli/tools_config.py": "def _get_platform_tools(cfg, platform): return {'terminal'}\n",
                "hermes_cli/mcp_startup.py": "def set_mcp_server_filter(names): pass\ndef ensure_mcp_discovery_before_agent_build(**kwargs): print('MCP_READY',flush=True)\n",
                "hermes_constants.py": "from pathlib import Path\ndef get_hermes_home(): return Path('.')\ndef resolve_reasoning_config(cfg, model): return {'effort':'low'}\n",
                "agent/__init__.py": "",
                "agent/skill_utils.py": "def parse_config_string_list(value): return value or []\n",
            }
            for relative, content in config_modules.items():
                module_path = root / relative
                module_path.parent.mkdir(exist_ok=True)
                module_path.write_text(content, encoding="utf-8")
            (root / "tools").mkdir()
            (root / "tools" / "__init__.py").write_text("", encoding="utf-8")
            (root / "tools" / "terminal_tool.py").write_text("callback = None\ndef set_approval_callback(value):\n global callback\n callback = value\n", encoding="utf-8")
            (root / "tools" / "approval_context.py").write_text(
                "from contextvars import ContextVar\ninteractive=ContextVar('interactive',default=False)\nsession=ContextVar('session',default=None)\n"
                "def set_hermes_interactive_context(value): return interactive.set(value)\n"
                "def reset_hermes_interactive_context(token): interactive.reset(token)\n"
                "def set_current_session_key(value): return session.set(value)\n"
                "def reset_current_session_key(token): session.reset(token)\n", encoding="utf-8")
            (root / "hermes_state.py").write_text(
                "class SessionDB:\n"
                " def resolve_resume_session_id(self, value): return 'official-child'\n"
                " def get_messages_as_conversation(self, value, *, include_ancestors, repair_alternation):\n"
                "  assert value == 'official-child' and not include_ancestors and repair_alternation\n"
                "  return [{'role':'assistant','tool_calls':[{'id':'call-1'}]}, {'role':'tool','tool_call_id':'call-1','content':'ok'}]\n"
                " def get_session(self, value): return {'model':'fake-model'}\n"
                " def close(self): print('DB_CLOSED',flush=True)\n", encoding="utf-8")
            (root / "run_agent.py").write_text(
                "from tools import terminal_tool, approval_context\n"
                "class AIAgent:\n"
                " def __init__(self, **kwargs):\n"
                "  self.kwargs=kwargs\n  self.session_id=kwargs['session_id']\n"
                "  assert self.session_id == 'official-child'\n"
                "  assert kwargs['max_iterations'] == 7 and kwargs['enabled_toolsets'] == ['terminal']\n"
                "  assert kwargs['ephemeral_system_prompt'] == 'Configured personality' and kwargs['reasoning_config']['effort'] == 'low'\n"
                "  assert approval_context.interactive.get() and approval_context.session.get() == self.session_id\n"
                " def run_conversation(self, message, *, conversation_history, task_id):\n"
                "  assert task_id == 'task-contract' and conversation_history[1]['role'] == 'tool'\n"
                "  assert terminal_tool.callback('echo ok','approval',allow_permanent=False) == 'once'\n"
                "  assert self.kwargs['clarify_callback']('Choose',['A','B']) == 'B'\n"
                "  return {'final_response':'done','messages':conversation_history}\n"
                " def hard_interrupt(self, *args, **kwargs): pass\n"
                " def close(self): print('AGENT_CLOSED',flush=True)\n", encoding="utf-8")
            env = {**os.environ, "HERMES_HOME": str(root / "isolated-home"), "PYTHONDONTWRITEBYTECODE": "1"}
            proc = subprocess.Popen([sys.executable, "-B", str(RUNNER), "--root-path", str(root), "--query", "test",
                                     "--session-id", "parent", "--task-run-id", "task-contract", "--interaction-timeout-seconds", "2"],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env)
            timer = threading.Timer(8, proc.kill)
            timer.start()
            lines, events = [], []
            try:
                for line in proc.stdout:
                    lines.append(line)
                    if not line.startswith(bridge.EVENT_START):
                        continue
                    event = json.loads(line.strip()[len(bridge.EVENT_START):-len(bridge.EVENT_END)])
                    events.append(event)
                    if event["type"] == "interaction_request":
                        response = {"type": "interaction_response", "taskRunId": event["taskRunId"], "requestId": event["requestId"], "kind": event["kind"]}
                        response.update({"choice": "once"} if event["kind"] == "approval" else {"answer": "B"})
                        proc.stdin.write(json.dumps(response) + "\n")
                        proc.stdin.flush()
                proc.wait(timeout=2)
                errors = proc.stderr.read()
                self.assertEqual(proc.returncode, 0, errors)
                self.assertIn("AGENT_CLOSED\n", lines)
                self.assertIn("MCP_READY\n", lines)
                self.assertIn("DB_CLOSED\n", lines)
                self.assertEqual([event["kind"] for event in events if event["type"] == "interaction_request"], ["approval", "clarify"])
                self.assertTrue(next(event for event in events if event["type"] == "result")["success"])
            finally:
                timer.cancel()
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=2)
                proc.stdin.close()
                proc.stdout.close()
                proc.stderr.close()


class ContextAndUsageTests(unittest.TestCase):
    def test_missing_history_and_intentionally_empty_history_are_different(self):
        db = Mock()
        db.resolve_resume_session_id.return_value = "current"
        db.get_session.return_value = None
        self.assertIsNone(bridge._load_session_history(db, "current"))
        db.get_messages_as_conversation.assert_not_called()
        db.get_session.return_value = {"id": "current"}
        db.get_messages_as_conversation.return_value = []
        self.assertEqual(bridge._load_session_history(db, "current"), [])

    def test_resume_preserves_cache_sensitive_message_bytes(self):
        messages = [{"role": "user", "content": "summary", "_compressed_summary": True},
                    {"role": "assistant", "content": "", "reasoning_content": " thinking ",
                     "api_content": "  exact wire content\n", "tool_calls": [{"id": "stable-id", "function": {"name": "read_file"}}]},
                    {"role": "tool", "tool_call_id": "stable-id", "content": "data"}]
        db = Mock()
        db.resolve_resume_session_id.return_value = "compressed-tip"
        db.get_messages_as_conversation.return_value = messages
        self.assertIs(bridge._load_session_history(db, "root"), messages)
        db.get_messages_as_conversation.assert_called_once_with("compressed-tip", include_ancestors=False, repair_alternation=True)

    def test_normalizes_provider_cache_dialects_and_anthropic_input_buckets(self):
        cases = [
            {"prompt_tokens": 1000, "completion_tokens": 20, "prompt_tokens_details": {"cached_tokens": 800}},
            {"input_tokens": 1000, "output_tokens": 20, "input_tokens_details": {"cached_tokens": 800}},
            {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 800, "cache_creation_input_tokens": 100},
            {"prompt_tokens": 1000, "completion_tokens": 20, "prompt_cache_hit_tokens": 800, "prompt_cache_miss_tokens": 200},
            {"prompt_tokens": 1000, "completion_tokens": 20, "cached_tokens": 800},
            {"promptTokenCount": 1000, "candidatesTokenCount": 20, "cachedContentTokenCount": 800},
        ]
        for case in cases:
            with self.subTest(case=case):
                result = bridge._normalize_usage(case)
                self.assertEqual(result["input_tokens"], 1000)
                self.assertEqual(result["output_tokens"], 20)
                self.assertEqual(result["cache_read_tokens"], 800)

    def test_official_totals_win_over_a_single_last_response(self):
        agent = SimpleNamespace(session_input_tokens=3000, session_prompt_tokens=30000, session_cache_read_tokens=24000,
                                session_cache_write_tokens=3000, session_output_tokens=900, session_api_calls=3)
        sources = bridge._usage_sources({"usage": {"prompt_tokens": 10000, "completion_tokens": 100, "cached_tokens": 9500}}, agent)
        self.assertEqual(sources[0]["input_tokens"], 30000)
        self.assertEqual(sources[0]["cache_read_tokens"], 24000)
        self.assertEqual(sources[0]["cache_write_tokens"], 3000)
        self.assertEqual(sources[0]["total_tokens"], 30900)

    def test_zero_cache_hits_do_not_fall_through_to_stale_usage(self):
        self.assertEqual(bridge._first_int_from_sources([{"cache_read_tokens": 0}, {"cache_read_tokens": 900}], "cache_read_tokens"), 0)
        self.assertNotIn("cache_read_tokens", bridge._normalize_usage({"prompt_tokens": 1000}))

    def test_current_context_uses_last_call_not_cumulative_spend(self):
        agent = SimpleNamespace(session_prompt_tokens=900000, session_output_tokens=30000, session_api_calls=40,
                                context_compressor=SimpleNamespace(last_prompt_tokens=12000, last_completion_tokens=500, context_length=32000))
        usage = bridge._agent_context_usage(agent)
        self.assertEqual(usage["context_tokens"], 12000)
        self.assertEqual(usage["context_output_tokens"], 500)
        self.assertEqual(usage["context_source"], "actual")
        self.assertEqual(usage["context_percent"], 39)
        agent.context_compressor.awaiting_real_usage_after_compression = True
        self.assertEqual(bridge._agent_context_usage(agent)["context_source"], "estimated")

    def test_context_window_setter_retains_compression_cooldowns(self):
        class Compressor:
            def __init__(self):
                self.window = 128000
                self.cooldown = 3
            @property
            def context_length(self):
                return self.window
            @context_length.setter
            def context_length(self, value):
                self.window = value
            def update_model(self, **_kwargs):
                raise AssertionError("Updating the model would reset compression state")
        compressor = Compressor()
        with patch.dict(os.environ, {"HERMES_FORGE_CONTEXT_WINDOW": "32000"}):
            bridge._configure_context_window(SimpleNamespace(context_compressor=compressor))
        self.assertEqual(compressor.context_length, 32000)
        self.assertEqual(compressor.cooldown, 3)
        with patch.dict(os.environ, {"HERMES_FORGE_CONTEXT_WINDOW": "-1"}), patch.object(bridge, "emit") as emit:
            bridge._configure_context_window(SimpleNamespace(context_compressor=compressor))
            emit.assert_called_once()
        self.assertEqual(compressor.context_length, 32000)


class NativeAgentBehaviorTests(unittest.TestCase):
    def test_windows_path_compat_preserves_native_bounded_interruptible_wait(self):
        wait = Mock()
        base = type("Base", (), {"_quote_cwd_for_cd": staticmethod(lambda cwd: cwd),
                                 "_extract_cwd_from_output": Mock(), "_wait_for_process": wait})
        local = type("Local", (), {"_update_cwd": Mock()})
        files = type("Files", (), {"_escape_shell_arg": lambda self, value: value})
        modules = {"tools.environments": SimpleNamespace(base=SimpleNamespace(BaseEnvironment=base)),
                   "tools.environments.local": SimpleNamespace(LocalEnvironment=local),
                   "tools.file_operations": SimpleNamespace(ShellFileOperations=files)}
        with patch.dict(sys.modules, modules), patch.object(bridge.os, "name", "nt"), patch.object(bridge, "_ensure_git_bash_path"):
            bridge._install_windows_git_bash_path_compat()
            self.assertIs(base._wait_for_process, wait)
            self.assertEqual(files()._escape_shell_arg("C:\\project\\file.txt"), "/c/project/file.txt")

    def test_multiple_images_reach_the_model_in_order(self):
        with tempfile.TemporaryDirectory() as folder:
            first, second = Path(folder) / "one.png", Path(folder) / "two.jpg"
            first.write_bytes(b"first image")
            second.write_bytes(b"second image")
            content = bridge._prepare_user_message("Compare these", [str(first), str(second), str(first)])
            self.assertEqual(content[0], {"type": "text", "text": "Compare these"})
            self.assertEqual(len(content), 3)
            self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))
            self.assertTrue(content[2]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
            self.assertEqual(bridge._prepare_user_message("text", None), "text")

    def test_tool_callbacks_follow_official_failure_detection_and_accept_metadata(self):
        detect = Mock(return_value=(True, " [exit 2]"))
        with patch.dict(sys.modules, {"agent.display": SimpleNamespace(_detect_tool_failure=detect)}), patch.object(bridge, "emit") as emit:
            callbacks = bridge._make_agent_callbacks("session", Mock())
            callbacks["tool_complete_callback"]("call-2", "terminal", {"command": "exit 2"}, '{"exit_code":2}')
            self.assertEqual(emit.call_args.args[0], "tool_result")
            self.assertFalse(emit.call_args.args[1]["success"])
            self.assertEqual(emit.call_args.args[1]["call_id"], "call-2")
            detect.assert_called_once_with("terminal", '{"exit_code":2}')
            callbacks["tool_progress_callback"]("tool.completed", "terminal", None, None, duration=0.5, is_error=True)
            self.assertEqual(emit.call_args.args[1]["level"], "warning")

    def test_profile_preferences_and_explicit_empty_tools_survive_construction(self):
        config = {"agent": {"max_turns": 23, "run_budget_seconds": 45, "disabled_toolsets": ["web"], "service_tier": "fast"},
                  "checkpoints": {"enabled": True, "max_snapshots": 4}, "provider_routing": {"only": ["chosen-provider"]},
                  "platform_toolsets": {"desktop": []}}
        get_tools = Mock(return_value=set())
        resolve_reasoning = Mock(return_value={"enabled": False})
        modules = {
            "hermes_cli.config": SimpleNamespace(load_config=lambda: config, resolve_turn_limit=lambda value: int(value)),
            "hermes_cli.personality": SimpleNamespace(resolve_ephemeral_system_prompt=lambda cfg: "Configured persona"),
            "hermes_cli.fallback_config": SimpleNamespace(get_fallback_chain=lambda cfg: [{"model": "backup"}]),
            "hermes_cli.tools_config": SimpleNamespace(_get_platform_tools=get_tools),
            "hermes_constants": SimpleNamespace(resolve_reasoning_config=resolve_reasoning, get_hermes_home=lambda: Path(".")),
            "agent.skill_utils": SimpleNamespace(parse_config_string_list=lambda value: value or []),
        }
        args = SimpleNamespace(max_turns=None, source="desktop", system_prompt="", checkpoints=False)
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"AI_MODEL": "selected", "HERMES_EPHEMERAL_SYSTEM_PROMPT": "", "HERMES_PREFILL_MESSAGES_FILE": ""}):
            options = bridge._load_agent_options(args)
            self.assertEqual(options["max_iterations"], 23)
            self.assertEqual(options["enabled_toolsets"], [])
            self.assertEqual(options["disabled_toolsets"], ["web"])
            self.assertEqual(options["ephemeral_system_prompt"], "Configured persona")
            self.assertEqual(options["reasoning_config"], {"enabled": False})
            self.assertTrue(options["checkpoints_enabled"])
            self.assertEqual(options["checkpoint_max_snapshots"], 4)
            self.assertEqual(options["service_tier"], "priority")
            self.assertEqual(options["run_budget_seconds"], 45)
            self.assertEqual(options["fallback_model"], [{"model": "backup"}])
            self.assertEqual(options["providers_allowed"], ["chosen-provider"])
            get_tools.assert_called_once_with(config, "desktop")
            resolve_reasoning.assert_called_once_with(config, "selected")
            args.max_turns = "3"
            args.system_prompt = "Explicit persona"
            overridden = bridge._load_agent_options(args)
            self.assertEqual(overridden["max_iterations"], 3)
            self.assertEqual(overridden["ephemeral_system_prompt"], "Explicit persona")

    def test_mcp_discovery_is_filtered_and_skipped_when_all_tools_are_disabled(self):
        discover, filter_servers = Mock(), Mock()
        with patch.dict(sys.modules, {"hermes_cli.mcp_startup": SimpleNamespace(
                ensure_mcp_discovery_before_agent_build=discover, set_mcp_server_filter=filter_servers)}):
            bridge._prepare_mcp_tools({"enabled_toolsets": []})
            discover.assert_not_called()
            bridge._prepare_mcp_tools({"enabled_toolsets": ["terminal", "my-server"]})
            filter_servers.assert_called_once_with(["terminal", "my-server"])
            self.assertTrue(discover.call_args.kwargs["single_query"])

    def test_skill_commands_use_the_native_loader_and_preserve_arguments(self):
        resolve = Mock(side_effect=lambda name: "/my-skill" if name == "my_skill" else None)
        build = Mock(return_value="Official skill instructions and user task")
        module = SimpleNamespace(resolve_skill_command_key=resolve, build_skill_invocation_message=build,
                                 split_stacked_skill_commands=lambda rest: ([], rest), build_stacked_skill_invocation_message=Mock())
        with patch.dict(sys.modules, {"agent.skill_commands": module}), patch.object(bridge, "emit"):
            self.assertEqual(bridge._expand_skill_query("/my_skill compare the files", "task-1"), "Official skill instructions and user task")
            build.assert_called_once_with("/my-skill", user_instruction="compare the files", task_id="task-1")
            with self.assertRaisesRegex(ValueError, "未找到技能命令"):
                bridge._expand_skill_query("/unknown task", "task-1")
        self.assertEqual(bridge._expand_skill_query("/tmp/project/file.md", "task-1"), "/tmp/project/file.md")
        self.assertEqual(bridge._expand_skill_query("", "task-1"), "")


if __name__ == "__main__":
    unittest.main()
