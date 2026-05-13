from __future__ import annotations

import os

import httpx

DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_TIMEOUT_SECONDS = 60.0


class OllamaError(RuntimeError):
    """Raised when the local Ollama service cannot fulfill a request."""


def build_chat_payload(*, model: str, system_prompt: str, user_prompt: str) -> dict[str, object]:
    return {
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


def parse_chat_response(data: object) -> str:
    if not isinstance(data, dict):
        raise OllamaError("Ollama returned a malformed chat response.")

    message = data.get("message")
    if not isinstance(message, dict):
        raise OllamaError("Ollama returned a malformed chat response.")

    content = message.get("content")
    if not isinstance(content, str):
        raise OllamaError("Ollama returned a malformed chat response.")

    cleaned_content = content.strip()
    if not cleaned_content:
        raise OllamaError("Ollama returned an empty chat response.")

    return cleaned_content


def chat(*, model: str, system_prompt: str, user_prompt: str) -> str:
    base_url = os.getenv("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL).rstrip("/")
    timeout = float(os.getenv("OLLAMA_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
    payload = build_chat_payload(
        model=model,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )

    try:
        response = httpx.post(
            f"{base_url}/api/chat",
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise OllamaError(f"Could not reach Ollama at {base_url}: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise OllamaError("Ollama returned a malformed JSON response.") from exc

    return parse_chat_response(data)
