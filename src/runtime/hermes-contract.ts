// This contract mirrors resources/hermes-windows-agent.py's actual invocation,
// including callbacks and the official approval/session APIs.
export const HERMES_FORGE_CONTRACT_PROBE = `
import inspect, json
try:
    from run_agent import AIAgent
    import hermes_logging
    from hermes_state import SessionDB
    from tools import terminal_tool, approval_context
    missing = []
    def require_parameters(label, fn, names):
        params = inspect.signature(fn).parameters
        if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
            return
        missing.extend(label + "." + name for name in names if name not in params)
    require_parameters("AIAgent", AIAgent.__init__, [
        "base_url", "api_key", "provider", "model", "max_iterations",
        "quiet_mode", "ephemeral_system_prompt", "session_id", "platform",
        "session_db", "skip_context_files", "skip_memory", "checkpoints_enabled",
        "pass_session_id", "stream_delta_callback", "reasoning_callback",
        "tool_progress_callback", "tool_start_callback", "tool_complete_callback",
        "status_callback", "step_callback", "clarify_callback",
    ])
    require_parameters("run_conversation", AIAgent.run_conversation, ["conversation_history", "task_id"])
    require_parameters("hard_interrupt", AIAgent.hard_interrupt, ["tool_reason"])
    require_parameters("get_messages_as_conversation", SessionDB.get_messages_as_conversation, ["include_ancestors", "repair_alternation"])
    for owner, names in [
        (AIAgent, ["run_conversation", "hard_interrupt", "close"]),
        (SessionDB, ["resolve_resume_session_id", "get_messages_as_conversation", "get_session", "search_sessions", "close", "__enter__", "__exit__"]),
        (terminal_tool, ["set_approval_callback"]),
        (approval_context, ["set_hermes_interactive_context", "reset_hermes_interactive_context", "set_current_session_key", "reset_current_session_key"]),
    ]:
        for name in names:
            if not callable(getattr(owner, name, None)):
                missing.append(getattr(owner, "__name__", "api") + "." + name)
    print(json.dumps({"compatible": not missing, "missing": missing}))
except Exception as error:
    print(json.dumps({"compatible": False, "error": str(error)}))
`;

// Optional extensions import their own SDKs only when a gateway is requested.
export const HERMES_GATEWAY_CONTRACT_PROBE = `
import inspect, json
try:
    from gateway import run as gateway_run
    from cron import scheduler_provider
    missing = []
    for owner, names in [
        (gateway_run, ["load_gateway_config_for_runner"]),
        (scheduler_provider, ["resolve_cron_scheduler", "scheduler_for_profile_mode"]),
        (scheduler_provider.InProcessCronScheduler, ["start", "stop"]),
    ]:
        for name in names:
            if not callable(getattr(owner, name, None)):
                missing.append(name)
    if not missing:
        try:
            inspect.signature(scheduler_provider.InProcessCronScheduler.start).bind(None, None, adapters=None, loop=None)
        except TypeError:
            missing.append("InProcessCronScheduler.start")
    print(json.dumps({"compatible": not missing, "missing": missing}))
except Exception as error:
    print(json.dumps({"compatible": False, "error": str(error)}))
`;
