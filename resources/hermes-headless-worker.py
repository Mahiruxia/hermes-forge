#!/usr/bin/env python3
"""Persistent Hermes headless worker for the desktop app."""

from __future__ import annotations

import base64
import contextlib
import io
import json
import logging
import mimetypes
import os
from pathlib import Path
import sys
import traceback


def _provider_from_env() -> str:
    provider = (os.environ.get("HERMES_INFERENCE_PROVIDER") or os.environ.get("AI_PROVIDER") or "").strip().lower()
    if provider == "openai":
        return "openrouter"
    return provider or "auto"


def _api_key_from_env() -> str:
    for key in (
        "AI_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_TOKEN",
    ):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


def _base_url_from_env() -> str:
    for key in ("AI_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL", "ANTHROPIC_BASE_URL"):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return ""


def _model_from_env() -> str:
    return (os.environ.get("AI_MODEL") or os.environ.get("OPENAI_MODEL") or "").strip()


def _image_content(query: str, image_path: str):
    path = Path(image_path)
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return [
        {"type": "text", "text": query},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}},
    ]


def _apply_env(env_payload: dict[str, str] | None):
    previous: dict[str, str | None] = {}
    for key, value in (env_payload or {}).items():
        previous[key] = os.environ.get(key)
        os.environ[key] = value
    return previous


def _restore_env(previous: dict[str, str | None]):
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _handle_request(payload: dict[str, object]) -> dict[str, object]:
    root = Path(str(payload["rootPath"])).resolve()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    query = str(payload.get("query") or "")
    system_prompt = str(payload.get("systemPrompt") or "")
    image_path = str(payload.get("imagePath") or "").strip() or None
    session_id = str(payload.get("sessionId") or "").strip() or None
    source = str(payload.get("source") or "hermes-forge-worker")
    max_turns = int(payload.get("maxTurns") or 90)
    env_payload = payload.get("env") if isinstance(payload.get("env"), dict) else None
    previous_env = _apply_env(env_payload)

    try:
        from run_agent import AIAgent

        logging.disable(logging.CRITICAL)
        user_message = _image_content(query, image_path) if image_path else query
        with contextlib.redirect_stdout(io.StringIO()):
            agent = AIAgent(
                base_url=_base_url_from_env(),
                api_key=_api_key_from_env(),
                provider=_provider_from_env(),
                model=_model_from_env(),
                max_iterations=max_turns,
                quiet_mode=True,
                ephemeral_system_prompt=system_prompt or None,
                session_id=session_id,
                platform=source,
                skip_context_files=True,
            )
            result = agent.run_conversation(user_message)

        final_response = ""
        if isinstance(result, dict):
            final_response = str(result.get("final_response") or "")
        else:
            final_response = str(result or "")
        return {"ok": True, "finalResponse": final_response}
    finally:
        _restore_env(previous_env)


def main() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        request_id = ""
        try:
            payload = json.loads(line)
            request_id = str(payload.get("id") or "")
            response = _handle_request(payload)
            print(json.dumps({"id": request_id, **response}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({
                "id": request_id,
                "ok": False,
                "error": f"Hermes headless worker failed: {exc}",
                "traceback": traceback.format_exc(),
            }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
