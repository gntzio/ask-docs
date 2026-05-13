from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.db import delete_site, init_db, upsert_page_with_chunks
from app.ollama_client import OllamaError, chat
from app.search import chunk_page, search_chunks

INSUFFICIENT_EVIDENCE_ANSWER = (
    "I do not have enough evidence in the indexed documentation to answer that."
)


def _cors_origins() -> list[str]:
    raw_value = os.getenv("ASKDOCS_CORS_ORIGINS", "*").strip()
    if raw_value == "*":
        return ["*"]
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="AskDocs Backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class IngestPageRequest(BaseModel):
    site: str = Field(min_length=1)
    url: str = Field(min_length=1)
    title: str | None = None
    headings: list[str] = Field(default_factory=list)
    body: str = Field(min_length=1)


class SearchRequest(BaseModel):
    site: str = Field(min_length=1)
    query: str = Field(min_length=1)
    current_page_url: str | None = None
    top_k: int = Field(default=5, ge=1, le=20)


class AskRequest(SearchRequest):
    model: str = Field(default="llama3.2:3b", min_length=1)


class ReindexSiteRequest(BaseModel):
    site: str = Field(min_length=1)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ingest-page")
def ingest_page(request: IngestPageRequest) -> dict[str, int | str]:
    site = _clean_required_text(request.site, "site")
    url = _clean_required_text(request.url, "url")
    title = _clean_optional_text(request.title)
    headings = [_clean_optional_text(heading) for heading in request.headings]
    headings = [heading for heading in headings if heading]
    body = _clean_required_text(request.body, "body")

    chunks = chunk_page(title=title, headings=headings, body=body)
    if not chunks:
        raise HTTPException(status_code=422, detail="Page body did not produce any chunks.")

    page_id, chunks_created = upsert_page_with_chunks(
        site=site,
        url=url,
        title=title,
        chunks=chunks,
    )
    return {
        "status": "ok",
        "page_id": page_id,
        "chunks_created": chunks_created,
    }


@app.post("/search")
def search(request: SearchRequest) -> dict[str, list[dict[str, str | int | None]]]:
    site = _clean_required_text(request.site, "site")
    query = _clean_required_text(request.query, "query")
    current_page_url = _clean_optional_text(request.current_page_url)

    chunks = search_chunks(
        site=site,
        query=query,
        current_page_url=current_page_url,
        top_k=request.top_k,
    )
    return {"chunks": chunks}


@app.post("/ask")
def ask(request: AskRequest) -> dict[str, object]:
    site = _clean_required_text(request.site, "site")
    query = _clean_required_text(request.query, "query")
    current_page_url = _clean_optional_text(request.current_page_url)
    model = _clean_required_text(request.model, "model")

    chunks = search_chunks(
        site=site,
        query=query,
        current_page_url=current_page_url,
        top_k=request.top_k,
    )
    if not chunks:
        return {
            "answer": INSUFFICIENT_EVIDENCE_ANSWER,
            "sources": [],
            "chunks_used": 0,
        }

    try:
        answer = chat(
            model=model,
            system_prompt=_build_system_prompt(),
            user_prompt=_build_user_prompt(query=query, chunks=chunks),
        )
    except OllamaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "answer": answer,
        "sources": _dedupe_sources(chunks),
        "chunks_used": len(chunks),
    }


@app.post("/reindex-site")
def reindex_site(request: ReindexSiteRequest) -> dict[str, str]:
    site = _clean_required_text(request.site, "site")
    delete_site(site)
    return {"status": "ok"}


def _build_system_prompt() -> str:
    return (
        "You are AskDocs, a local documentation assistant. "
        "Answer only from the provided documentation snippets. "
        "If the evidence is insufficient, say so clearly. "
        "Keep the answer concise. "
        "Cite supporting snippets inline using square brackets like [1] or [2][3]."
    )


def _build_user_prompt(*, query: str, chunks: list[dict[str, str | int | None]]) -> str:
    lines = [
        f"Question: {query}",
        "",
        "Documentation snippets:",
        "",
    ]
    for index, chunk in enumerate(chunks, start=1):
        lines.extend(
            [
                f"[{index}] URL: {chunk['url']}",
                f"[{index}] Title: {chunk['title'] or ''}",
                f"[{index}] Heading: {chunk['heading'] or ''}",
                f"[{index}] Content: {chunk['body']}",
                "",
            ]
        )

    lines.append(
        "Answer using only the snippets above. If they do not contain enough evidence, say so."
    )
    return "\n".join(lines)


def _dedupe_sources(
    chunks: list[dict[str, str | int | None]],
) -> list[dict[str, str | None]]:
    seen: set[tuple[str | None, str | None, str | None]] = set()
    sources: list[dict[str, str | None]] = []

    for chunk in chunks:
        key = (
            chunk["url"] if isinstance(chunk["url"], str) else None,
            chunk["title"] if isinstance(chunk["title"], str) else None,
            chunk["heading"] if isinstance(chunk["heading"], str) else None,
        )
        if key in seen:
            continue
        seen.add(key)
        sources.append(
            {
                "url": key[0],
                "title": key[1],
                "heading": key[2],
            }
        )

    return sources


def _clean_required_text(value: str, field_name: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail=f"{field_name} must not be empty.")
    return cleaned


def _clean_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None
