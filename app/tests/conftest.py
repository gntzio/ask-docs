from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.db import get_connection, init_db


@pytest.fixture
def temp_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[str]:
    db_path = tmp_path / "askdocs-test.db"
    monkeypatch.setenv("ASKDOCS_DB_PATH", str(db_path))
    init_db()
    yield str(db_path)


@pytest.fixture
def db_connection(temp_db: str) -> Iterator[sqlite3.Connection]:
    del temp_db
    with get_connection() as conn:
        yield conn
