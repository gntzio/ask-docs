from __future__ import annotations

from unittest.mock import Mock

import httpx
import pytest

from app.ollama_client import OllamaError, build_chat_payload, chat, parse_chat_response


class FakeResponse:
    def __init__(
        self,
        *,
        json_data: object | None = None,
        json_error: Exception | None = None,
        raise_for_status_error: Exception | None = None,
    ) -> None:
        self._json_data = json_data
        self._json_error = json_error
        self._raise_for_status_error = raise_for_status_error

    def raise_for_status(self) -> None:
        if self._raise_for_status_error is not None:
            raise self._raise_for_status_error

    def json(self) -> object:
        if self._json_error is not None:
            raise self._json_error
        return self._json_data


def test_build_chat_payload_constructs_expected_request() -> None:
    payload = build_chat_payload(
        model="llama3.2:3b",
        system_prompt="System",
        user_prompt="User",
    )

    assert payload == {
        "model": "llama3.2:3b",
        "stream": False,
        "messages": [
            {"role": "system", "content": "System"},
            {"role": "user", "content": "User"},
        ],
    }


def test_parse_chat_response_returns_trimmed_content() -> None:
    content = parse_chat_response({"message": {"content": "  Hello from Ollama.  "}})

    assert content == "Hello from Ollama."


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"message": None},
        {"message": {}},
        {"message": {"content": None}},
    ],
)
def test_parse_chat_response_rejects_malformed_payload(payload: object) -> None:
    with pytest.raises(OllamaError, match="malformed|empty"):
        parse_chat_response(payload)


def test_chat_posts_expected_payload_and_parses_response(monkeypatch: pytest.MonkeyPatch) -> None:
    post = Mock(
        return_value=FakeResponse(
            json_data={"message": {"content": " Grounded answer. "}},
        )
    )
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.local:11434")
    monkeypatch.setenv("OLLAMA_TIMEOUT_SECONDS", "12")
    monkeypatch.setattr(httpx, "post", post)

    answer = chat(
        model="llama3.2:3b",
        system_prompt="Use snippets only.",
        user_prompt="How do I install it?",
    )

    assert answer == "Grounded answer."
    post.assert_called_once_with(
        "http://ollama.local:11434/api/chat",
        json={
            "model": "llama3.2:3b",
            "stream": False,
            "messages": [
                {"role": "system", "content": "Use snippets only."},
                {"role": "user", "content": "How do I install it?"},
            ],
        },
        timeout=12.0,
    )


def test_chat_handles_timeout_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise_timeout(*args, **kwargs):
        del args, kwargs
        raise httpx.TimeoutException("timed out")

    monkeypatch.setattr(httpx, "post", _raise_timeout)

    with pytest.raises(OllamaError, match="Could not reach Ollama"):
        chat(model="llama3.2:3b", system_prompt="System", user_prompt="User")


def test_chat_handles_malformed_json_response(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *args, **kwargs: FakeResponse(json_error=ValueError("bad json")),
    )

    with pytest.raises(OllamaError, match="malformed JSON response"):
        chat(model="llama3.2:3b", system_prompt="System", user_prompt="User")
