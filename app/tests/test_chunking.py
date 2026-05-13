from __future__ import annotations

from app.search import chunk_page


def _words(count: int, *, prefix: str = "word") -> str:
    return " ".join(f"{prefix}{index}" for index in range(count))


def test_chunk_page_handles_empty_body() -> None:
    chunks = chunk_page(title="Install", headings=["Docker"], body="   \n\n  ")

    assert chunks == []


def test_chunk_page_keeps_small_body_as_single_chunk_with_metadata() -> None:
    body = "## Docker\n\n" + _words(80, prefix="docker")

    chunks = chunk_page(title="Install", headings=["Docker"], body=body)

    assert len(chunks) == 1
    assert chunks[0]["title"] == "Install"
    assert chunks[0]["heading"] == "Docker"
    assert chunks[0]["body"] == _words(80, prefix="docker")


def test_chunk_page_splits_large_body_into_multiple_chunks() -> None:
    body = _words(1200, prefix="alpha")

    chunks = chunk_page(title="Reference", headings=[], body=body)

    assert len(chunks) >= 2
    assert all(chunk["body"] for chunk in chunks)
    assert all(len((chunk["body"] or "").split()) <= 800 for chunk in chunks)
