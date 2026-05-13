from __future__ import annotations

import os

import httpx

DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_TIMEOUT_SECONDS = 60.0


class OllamaError(RuntimeError):
    """Raised when the local Ollama service cannot fulfill a request."""


def chat(*, model: str, system_prompt: str, user_prompt: str) -> str:
    base_url = os.getenv("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL).rstrip("/")
    timeout = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": user_prompt,
            },
        ],
    }

    try:
        response = httpx.post(
            f"{base_url}/api/chat",
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise OllamaError(f"Could not reach Ollama at {base_url}: {exc}") from exc

    data = response.json()
    message = data.get("message", {})
    content = message.get("content", "").strip()
    if not content:
        raise OllamaError("Ollama returned an empty chat response.")

    return content

