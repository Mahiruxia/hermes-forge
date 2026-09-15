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
        db.get_messages_as_conversation.assert_called_once_with("child-session", include_ancestors=True, repair_alternation=True)
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
                "  assert value == 'official-child' and include_ancestors and repair_alternation\n"
                "  return [{'role':'assistant','tool_calls':[{'id':'call-1'}]}, {'role':'tool','tool_call_id':'call-1','content':'ok'}]\n"
                " def get_session(self, value): return {'model':'fake-model'}\n"
                " def close(self): print('DB_CLOSED',flush=True)\n", encoding="utf-8")
            (root / "run_agent.py").write_text(
                "from tools import terminal_tool, approval_context\n"
                "class AIAgent:\n"
                " def __init__(self, **kwargs):\n"
                "  self.kwargs=kwargs\n  self.session_id=kwargs['session_id']\n"
                "  assert self.session_id == 'official-child'\n"
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


if __name__ == "__main__":
    unittest.main()
