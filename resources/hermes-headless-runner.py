#!/usr/bin/env python3
"""Headless Hermes runner for the desktop app.

This entry point intentionally bypasses the interactive Hermes CLI/TUI layer.
Electron GUI processes on Windows often have no real console screen buffer,
which can make prompt_toolkit crash before a non-interactive query runs.
"""

from __future__ import annotations

import argparse
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


RESULT_START = "__HERMES_FORGE_RESULT_START__"
RESULT_END = "__HERMES_FORGE_RESULT_END__"


def _stderr(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root-path", required=True)
    parser.add_argument("--query-file", required=True)
    parser.add_argument("--system-file")
    parser.add_argument("--image-path")
    parser.add_argument("--session-id")
    parser.add_argument("--source", default="hermes-forge")
    parser.add_argument("--max-turns", type=int, default=90)
    args = parser.parse_args()

    root = Path(args.root_path).resolve()
    sys.path.insert(0, str(root))
    os.environ["PYTHONPATH"] = os.pathsep.join([str(root), os.environ.get("PYTHONPATH", "")]).strip(os.pathsep)

    logging.disable(logging.CRITICAL)
    query = Path(args.query_file).read_text(encoding="utf-8")
    system_prompt = Path(args.system_file).read_text(encoding="utf-8") if args.system_file else ""
    user_message = _image_content(query, args.image_path) if args.image_path else query

    try:
        from run_agent import AIAgent

        with contextlib.redirect_stdout(io.StringIO()):
            agent = AIAgent(
                base_url=_base_url_from_env(),
                api_key=_api_key_from_env(),
                provider=_provider_from_env(),
                model=_model_from_env(),
                max_iterations=args.max_turns,
                quiet_mode=True,
                ephemeral_system_prompt=system_prompt or None,
                session_id=args.session_id,
                platform=args.source,
                skip_context_files=True,
            )
            result = agent.run_conversation(user_message)

        final_response = ""
        if isinstance(result, dict):
            final_response = str(result.get("final_response") or "")
        else:
            final_response = str(result or "")

        print(RESULT_START, flush=True)
        print(final_response, flush=True)
        print(RESULT_END, flush=True)
        return 0
    except Exception as exc:
        _stderr(f"Hermes headless runner failed: {exc}")
        _stderr(traceback.format_exc())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
