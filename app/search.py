from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from app.db import get_connection

MIN_CHUNK_WORDS = 300
TARGET_CHUNK_WORDS = 500
MAX_CHUNK_WORDS = 800

WORD_RE = re.compile(r"\b[\w'-]+\b")
MARKDOWN_HEADING_RE = re.compile(r"^\s{0,3}#{2,3}\s+(?P<heading>.+?)\s*$")
STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "can",
    "do",
    "does",
    "for",
    "from",
    "how",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "using",
    "what",
    "when",
    "where",
    "with",
}


@dataclass(slots=True)
class ChunkDraft:
    heading: str | None
    body: str


def chunk_page(*, title: str | None, headings: list[str], body: str) -> list[dict[str, str | None]]:
    del title  # Title is stored with each chunk but does not affect splitting today.

    normalized_body = _normalize_text(body)
    if not normalized_body:
        return []

    sections = _split_sections(normalized_body, headings)
    if not sections:
        sections = [(None, normalized_body)]

    chunks: list[dict[str, str | None]] = []
    for heading, section_text in sections:
        for chunk_text in _chunk_text(section_text):
            chunks.append(
                {
                    "heading": heading,
                    "body": chunk_text,
                }
            )

    return chunks


def search_chunks(
    *,
    site: str,
    query: str,
    top_k: int,
    current_page_url: str | None = None,
) -> list[dict[str, str | int | None]]:
    search_terms = _extract_search_terms(query)
    if not search_terms:
        return []

    rows = _run_search_query(
        site=site,
        fts_query=_build_match_query(search_terms, operator="AND"),
        current_page_url=current_page_url,
        top_k=top_k,
    )
    if not rows and len(search_terms) > 1:
        rows = _run_search_query(
            site=site,
            fts_query=_build_match_query(search_terms, operator="OR"),
            current_page_url=current_page_url,
            top_k=top_k,
        )

    return [
        {
            "chunk_id": int(row["chunk_id"]),
            "url": row["url"],
            "title": row["title"],
            "heading": row["heading"],
            "body": row["body"],
        }
        for row in rows
    ]


def _normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    normalized_lines = [
        re.sub(r"\s+", " ", line).strip() if line.strip() else ""
        for line in text.split("\n")
    ]
    normalized = "\n".join(normalized_lines)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def _split_sections(text: str, headings: Iterable[str]) -> list[tuple[str | None, str]]:
    markdown_sections = _split_sections_by_markdown_headings(text)
    if markdown_sections:
        return markdown_sections

    named_sections = _split_sections_by_named_headings(text, headings)
    if named_sections:
        return named_sections

    return []


def _split_sections_by_markdown_headings(text: str) -> list[tuple[str | None, str]]:
    lines = text.split("\n")
    sections: list[tuple[str | None, str]] = []
    current_heading: str | None = None
    current_lines: list[str] = []
    found_heading = False

    for raw_line in lines:
        match = MARKDOWN_HEADING_RE.match(raw_line)
        if match:
            found_heading = True
            section_text = _join_nonempty(current_lines)
            if section_text:
                sections.append((current_heading, section_text))
            current_heading = match.group("heading").strip()
            current_lines = []
            continue

        current_lines.append(raw_line)

    if not found_heading:
        return []

    section_text = _join_nonempty(current_lines)
    if section_text:
        sections.append((current_heading, section_text))

    return sections


def _split_sections_by_named_headings(
    text: str,
    headings: Iterable[str],
) -> list[tuple[str | None, str]]:
    candidate_map = {
        cleaned.casefold(): cleaned
        for cleaned in (_clean_heading_candidate(heading) for heading in headings)
        if cleaned
    }
    if not candidate_map:
        return []

    lines = text.split("\n")
    sections: list[tuple[str | None, str]] = []
    current_heading: str | None = None
    current_lines: list[str] = []
    found_heading = False

    for index, raw_line in enumerate(lines):
        line = raw_line.strip()
        matched_heading = candidate_map.get(line.casefold())
        if matched_heading and _looks_like_section_heading(lines, index):
            found_heading = True
            section_text = _join_nonempty(current_lines)
            if section_text:
                sections.append((current_heading, section_text))
            current_heading = matched_heading
            current_lines = []
            continue

        current_lines.append(raw_line)

    if not found_heading:
        return []

    section_text = _join_nonempty(current_lines)
    if section_text:
        sections.append((current_heading, section_text))

    return sections


def _clean_heading_candidate(heading: str) -> str | None:
    cleaned = re.sub(r"\s+", " ", heading).strip()
    if not cleaned:
        return None
    if len(cleaned) > 120:
        return None
    if len(cleaned.split()) > 10:
        return None
    return cleaned


def _looks_like_section_heading(lines: list[str], index: int) -> bool:
    current = lines[index].strip()
    if not current:
        return False

    prev_blank = index == 0 or not lines[index - 1].strip()
    next_has_text = any(
        candidate.strip() for candidate in lines[index + 1 : min(len(lines), index + 4)]
    )
    return prev_blank and next_has_text


def _chunk_text(text: str) -> list[str]:
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", text) if part.strip()]
    if not paragraphs:
        paragraphs = [line.strip() for line in text.split("\n") if line.strip()]
    if not paragraphs:
        return []

    units: list[str] = []
    for paragraph in paragraphs:
        if _word_count(paragraph) > MAX_CHUNK_WORDS:
            units.extend(_split_long_text(paragraph))
        else:
            units.append(paragraph)

    chunks: list[str] = []
    current_units: list[str] = []
    current_words = 0

    for unit in units:
        unit_words = _word_count(unit)
        would_exceed_target = current_words >= MIN_CHUNK_WORDS and (
            current_words + unit_words > TARGET_CHUNK_WORDS
        )
        would_exceed_max = current_words + unit_words > MAX_CHUNK_WORDS

        if current_units and (would_exceed_target or would_exceed_max):
            chunks.append("\n\n".join(current_units).strip())
            current_units = [unit]
            current_words = unit_words
            continue

        current_units.append(unit)
        current_words += unit_words

    if current_units:
        final_chunk = "\n\n".join(current_units).strip()
        if chunks and _word_count(final_chunk) < MIN_CHUNK_WORDS:
            merged = f"{chunks[-1]}\n\n{final_chunk}".strip()
            if _word_count(merged) <= MAX_CHUNK_WORDS:
                chunks[-1] = merged
            else:
                chunks.append(final_chunk)
        else:
            chunks.append(final_chunk)

    return [chunk for chunk in chunks if chunk]


def _split_long_text(text: str) -> list[str]:
    sentences = [sentence.strip() for sentence in re.split(r"(?<=[.!?])\s+", text) if sentence.strip()]
    if len(sentences) <= 1:
        return _split_by_words(text, MAX_CHUNK_WORDS)

    chunks: list[str] = []
    current_sentences: list[str] = []
    current_words = 0

    for sentence in sentences:
        sentence_words = _word_count(sentence)
        if sentence_words > MAX_CHUNK_WORDS:
            if current_sentences:
                chunks.append(" ".join(current_sentences).strip())
                current_sentences = []
                current_words = 0
            chunks.extend(_split_by_words(sentence, MAX_CHUNK_WORDS))
            continue

        if current_sentences and current_words + sentence_words > MAX_CHUNK_WORDS:
            chunks.append(" ".join(current_sentences).strip())
            current_sentences = [sentence]
            current_words = sentence_words
            continue

        current_sentences.append(sentence)
        current_words += sentence_words

    if current_sentences:
        chunks.append(" ".join(current_sentences).strip())

    return chunks


def _split_by_words(text: str, max_words: int) -> list[str]:
    words = text.split()
    return [" ".join(words[index : index + max_words]) for index in range(0, len(words), max_words)]


def _join_nonempty(lines: list[str]) -> str:
    joined = "\n".join(lines).strip()
    return re.sub(r"\n{3,}", "\n\n", joined)


def _word_count(text: str) -> int:
    return len(WORD_RE.findall(text))


def _run_search_query(
    *,
    site: str,
    fts_query: str,
    current_page_url: str | None,
    top_k: int,
):
    with get_connection() as conn:
        return conn.execute(
            """
            SELECT
              chunks.id AS chunk_id,
              chunks.url,
              chunks.title,
              chunks.heading,
              chunks.body,
              bm25(chunks_fts, 1.0, 2.0, 4.0) AS score
            FROM chunks_fts
            JOIN chunks ON chunks.id = chunks_fts.rowid
            WHERE chunks.site = ?
              AND chunks_fts MATCH ?
            ORDER BY score ASC,
                     CASE WHEN chunks.url = ? THEN 0 ELSE 1 END ASC,
                     chunks.id ASC
            LIMIT ?
            """,
            (site, fts_query, current_page_url or "", top_k),
        ).fetchall()


def _extract_search_terms(query: str) -> list[str]:
    raw_terms = [match.group(0).lower() for match in re.finditer(r"[a-zA-Z0-9]+", query)]
    normalized_terms: list[str] = []

    for raw_term in raw_terms:
        if raw_term in STOP_WORDS:
            continue
        term = _stem_term(raw_term)
        if len(term) < 2:
            continue
        if term not in normalized_terms:
            normalized_terms.append(term)

    if not normalized_terms:
        for raw_term in raw_terms:
            if raw_term not in normalized_terms:
                normalized_terms.append(raw_term)

    return normalized_terms


def _build_match_query(terms: list[str], operator: str) -> str:
    return f" {operator} ".join(f"{term}*" for term in terms)


def _stem_term(term: str) -> str:
    for suffix, minimum_length in (
        ("ingly", 7),
        ("edly", 6),
        ("ing", 6),
        ("ly", 5),
        ("ed", 5),
        ("es", 5),
        ("s", 5),
    ):
        if term.endswith(suffix) and len(term) >= minimum_length:
            return term[: -len(suffix)]
    return term
