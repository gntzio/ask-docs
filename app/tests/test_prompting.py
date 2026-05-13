from __future__ import annotations

from app.main import _build_system_prompt, _build_user_prompt, _dedupe_sources


def test_build_user_prompt_includes_query_and_chunks() -> None:
    prompt = _build_user_prompt(
        query="How do I run it locally?",
        chunks=[
            {
                "chunk_id": 1,
                "url": "https://example.com/docs/install/",
                "title": "Install",
                "heading": "Docker",
                "body": "Run docker compose up.",
            },
            {
                "chunk_id": 2,
                "url": "https://example.com/docs/cli/",
                "title": "CLI",
                "heading": "Local setup",
                "body": "Run askdocs serve.",
            },
        ],
    )

    assert "Question: How do I run it locally?" in prompt
    assert "Documentation snippets:" in prompt
    assert "[1] URL: https://example.com/docs/install/" in prompt
    assert "[1] Heading: Docker" in prompt
    assert "[2] Content: Run askdocs serve." in prompt
    assert "Answer using only the snippets above." in prompt


def test_build_user_prompt_handles_empty_chunk_list() -> None:
    prompt = _build_user_prompt(query="What is this?", chunks=[])

    assert "Question: What is this?" in prompt
    assert "Documentation snippets:" in prompt
    assert "[1]" not in prompt
    assert "If they do not contain enough evidence, say so." in prompt


def test_system_prompt_mentions_grounding_expectations() -> None:
    prompt = _build_system_prompt()

    assert "Answer only from the provided documentation snippets." in prompt
    assert "Keep the answer concise." in prompt
    assert "square brackets like [1]" in prompt


def test_dedupe_sources_keeps_first_occurrence_order() -> None:
    sources = _dedupe_sources(
        [
            {
                "chunk_id": 1,
                "url": "https://example.com/docs/install/",
                "title": "Install",
                "heading": "Docker",
                "body": "A",
            },
            {
                "chunk_id": 2,
                "url": "https://example.com/docs/install/",
                "title": "Install",
                "heading": "Docker",
                "body": "B",
            },
            {
                "chunk_id": 3,
                "url": "https://example.com/docs/cli/",
                "title": "CLI",
                "heading": "Reference",
                "body": "C",
            },
        ]
    )

    assert sources == [
        {
            "url": "https://example.com/docs/install/",
            "title": "Install",
            "heading": "Docker",
        },
        {
            "url": "https://example.com/docs/cli/",
            "title": "CLI",
            "heading": "Reference",
        },
    ]
