# AskDocs Agents

## Mission

Help build AskDocs as a local-first docs assistant for public and private RTD-style sites.

## System

- `chrome-extension/`: side panel UI, site access flow, crawling, backend integration
- `app/`: backend ingestion, chunking, search, and grounded QA orchestration
- `ollama/`: local inference service

## Guardrails

- Keep crawling in the Chrome extension, not in the backend.
- Keep indexing and inference local by default.
- Keep answers grounded in retrieved documentation snippets and return sources.
- Do not make the extension call Ollama directly.
- Prefer predictable, debuggable behavior over clever abstractions.

## Crawl expectations

- Use the user’s existing browser session.
- Stay same-origin unless the product is explicitly redesigned.
- Prefer docs sidebar navigation when it exists instead of broad body-link crawling.
- Avoid widening crawl scope just because multiple docs sets share one host.

## Repo expectations

- Keep setup simple on Linux and in Docker.
- Document behavior changes briefly in `README.md` when they affect local workflow.
- Do not commit secrets or machine-specific credentials.
