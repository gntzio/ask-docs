from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Sequence

DEFAULT_DB_PATH = "/data/askdocs.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL,
  site TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  heading TEXT,
  body TEXT NOT NULL,
  FOREIGN KEY(page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site);
CREATE INDEX IF NOT EXISTS idx_chunks_page_id ON chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_site ON chunks(site);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title,
  heading,
  body,
  content='chunks',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, title, heading, body)
  VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.heading, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, heading, body)
  VALUES ('delete', old.id, COALESCE(old.title, ''), COALESCE(old.heading, ''), old.body);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, title, heading, body)
  VALUES ('delete', old.id, COALESCE(old.title, ''), COALESCE(old.heading, ''), old.body);
  INSERT INTO chunks_fts(rowid, title, heading, body)
  VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.heading, ''), new.body);
END;
"""


def get_db_path() -> Path:
    return Path(os.getenv("ASKDOCS_DB_PATH", DEFAULT_DB_PATH))


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    db_path = get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")

    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(SCHEMA_SQL)
        conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")


def upsert_page_with_chunks(
    *,
    site: str,
    url: str,
    title: str | None,
    chunks: Sequence[dict[str, str | None]],
) -> tuple[int, int]:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO pages (site, url, title)
            VALUES (?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET
              site = excluded.site,
              title = excluded.title
            """,
            (site, url, title),
        )
        page_row = conn.execute(
            "SELECT id FROM pages WHERE url = ?",
            (url,),
        ).fetchone()
        if page_row is None:
            raise RuntimeError(f"Could not resolve page id for url {url!r}.")

        page_id = int(page_row["id"])
        conn.execute("DELETE FROM chunks WHERE page_id = ?", (page_id,))

        rows = [
            (page_id, site, url, title, chunk["heading"], chunk["body"])
            for chunk in chunks
        ]
        if rows:
            conn.executemany(
                """
                INSERT INTO chunks (page_id, site, url, title, heading, body)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

        return page_id, len(rows)


def delete_site(site: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM pages WHERE site = ?", (site,))

