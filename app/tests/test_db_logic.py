from __future__ import annotations

from app.db import delete_site, upsert_page_with_chunks


def test_upsert_page_with_chunks_creates_page_and_chunks(db_connection) -> None:
    page_id, chunks_created = upsert_page_with_chunks(
        site="https://example.com",
        url="https://example.com/docs/install/",
        title="Install",
        chunks=[
            {"title": "Install", "heading": "Docker", "body": "Run with Docker."},
            {"title": "Install", "heading": "Local setup", "body": "Run locally."},
        ],
    )

    page = db_connection.execute("SELECT id, site, url, title FROM pages WHERE id = ?", (page_id,)).fetchone()
    chunks = db_connection.execute(
        "SELECT title, heading, body FROM chunks WHERE page_id = ? ORDER BY id ASC",
        (page_id,),
    ).fetchall()

    assert chunks_created == 2
    assert page is not None
    assert page["site"] == "https://example.com"
    assert page["url"] == "https://example.com/docs/install/"
    assert page["title"] == "Install"
    assert [row["heading"] for row in chunks] == ["Docker", "Local setup"]


def test_upsert_same_url_replaces_old_chunks_without_touching_other_pages(db_connection) -> None:
    first_page_id, _ = upsert_page_with_chunks(
        site="https://example.com",
        url="https://example.com/docs/install/",
        title="Install",
        chunks=[
            {"title": "Install", "heading": "Docker", "body": "Original Docker setup."},
            {"title": "Install", "heading": "Local setup", "body": "Original local setup."},
        ],
    )
    second_page_id, _ = upsert_page_with_chunks(
        site="https://example.com",
        url="https://example.com/docs/reference/",
        title="Reference",
        chunks=[
            {"title": "Reference", "heading": "CLI", "body": "CLI reference."},
        ],
    )

    updated_page_id, chunks_created = upsert_page_with_chunks(
        site="https://example.com",
        url="https://example.com/docs/install/",
        title="Install updated",
        chunks=[
            {"title": "Install updated", "heading": "Docker", "body": "Updated Docker setup only."},
        ],
    )

    replaced_chunks = db_connection.execute(
        "SELECT title, heading, body FROM chunks WHERE page_id = ? ORDER BY id ASC",
        (first_page_id,),
    ).fetchall()
    untouched_chunks = db_connection.execute(
        "SELECT heading, body FROM chunks WHERE page_id = ? ORDER BY id ASC",
        (second_page_id,),
    ).fetchall()
    total_pages = db_connection.execute("SELECT COUNT(*) AS count FROM pages").fetchone()["count"]

    assert updated_page_id == first_page_id
    assert chunks_created == 1
    assert total_pages == 2
    assert len(replaced_chunks) == 1
    assert replaced_chunks[0]["title"] == "Install updated"
    assert replaced_chunks[0]["body"] == "Updated Docker setup only."
    assert len(untouched_chunks) == 1
    assert untouched_chunks[0]["body"] == "CLI reference."


def test_delete_site_removes_only_requested_site_data(db_connection) -> None:
    upsert_page_with_chunks(
        site="https://example.com",
        url="https://example.com/docs/install/",
        title="Install",
        chunks=[{"title": "Install", "heading": "Docker", "body": "Run with Docker."}],
    )
    upsert_page_with_chunks(
        site="https://other.example.com",
        url="https://other.example.com/docs/install/",
        title="Other install",
        chunks=[{"title": "Other install", "heading": "Docker", "body": "Other site body."}],
    )

    delete_site("https://example.com")

    remaining_pages = db_connection.execute(
        "SELECT site, url FROM pages ORDER BY site ASC, url ASC"
    ).fetchall()
    remaining_chunks = db_connection.execute(
        "SELECT site, url, body FROM chunks ORDER BY site ASC, url ASC"
    ).fetchall()

    assert [(row["site"], row["url"]) for row in remaining_pages] == [
        ("https://other.example.com", "https://other.example.com/docs/install/"),
    ]
    assert [(row["site"], row["url"], row["body"]) for row in remaining_chunks] == [
        (
            "https://other.example.com",
            "https://other.example.com/docs/install/",
            "Other site body.",
        ),
    ]
