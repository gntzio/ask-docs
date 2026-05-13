from __future__ import annotations

from app.db import upsert_page_with_chunks
from app.search import search_chunks


def _insert_search_fixtures() -> None:
    upsert_page_with_chunks(
        site="https://alpha.example.com",
        url="https://alpha.example.com/docs/install/",
        title="Install",
        chunks=[
            {"title": "Install", "heading": "Docker", "body": "Docker local install quickstart guide."},
            {"title": "Install", "heading": "Local setup", "body": "Local setup using Docker compose."},
            {"title": "Install", "heading": "Remote", "body": "Remote cluster deployment steps."},
        ],
    )
    upsert_page_with_chunks(
        site="https://beta.example.com",
        url="https://beta.example.com/docs/install/",
        title="Install",
        chunks=[
            {"title": "Install", "heading": "Docker", "body": "Docker local install from the beta site."},
        ],
    )


def test_search_is_scoped_to_site_and_returns_relevant_chunks(temp_db: str) -> None:
    del temp_db
    _insert_search_fixtures()

    chunks = search_chunks(
        site="https://alpha.example.com",
        query="How do I install locally with Docker?",
        current_page_url=None,
        top_k=5,
    )

    assert chunks
    assert all(chunk["url"].startswith("https://alpha.example.com/") for chunk in chunks)
    assert any("Docker" == chunk["heading"] for chunk in chunks)


def test_search_respects_top_k_limit(temp_db: str) -> None:
    del temp_db
    _insert_search_fixtures()

    chunks = search_chunks(
        site="https://alpha.example.com",
        query="docker install",
        current_page_url=None,
        top_k=1,
    )

    assert len(chunks) == 1


def test_search_returns_empty_list_when_no_match(temp_db: str) -> None:
    del temp_db
    _insert_search_fixtures()

    chunks = search_chunks(
        site="https://alpha.example.com",
        query="quantum banana teleportation",
        current_page_url=None,
        top_k=5,
    )

    assert chunks == []
