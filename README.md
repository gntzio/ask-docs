# AskDocs 📙

[![Backend Tests](https://github.com/gntzio/ask-docs/actions/workflows/backend-tests.yml/badge.svg?branch=main)](https://github.com/gntzio/ask-docs/actions/workflows/backend-tests.yml)

AskDocs lets you chat with public and private RTD sites.

AskDocs is a local-first docs assistant with three parts:

- A Chrome extension that uses your current browser session to crawl docs pages you can already access.
- A FastAPI backend that stores pages locally, chunks them, indexes them with SQLite FTS5, and retrieves relevant snippets.
- A local Ollama server that answers only from retrieved documentation context.

Private content stays local. The backend does not crawl sites itself, and the extension does not call Ollama directly.

## What is here

- `app/`: FastAPI backend and Ollama client
- `chrome-extension/`: Chrome MV3 side panel extension
- `docker-compose.yml`: backend container
- `ollama/`: local Ollama and optional Open WebUI compose files
- `start-local.sh` / `stop-local.sh`: start and stop the local stack

## Backend API

- `GET /health`
- `POST /ingest-page`
- `POST /search`
- `POST /ask`
- `POST /reindex-site`

The SQLite database lives at `./data/askdocs.db` on the host and is mounted into the backend container at `/data/askdocs.db`.

## Quick start

Start the local stack:

```bash
bash ./start-local.sh
```

This starts:

- Ollama on `http://127.0.0.1:11434`
- AskDocs backend on `http://127.0.0.1:8000`
- Open WebUI on `http://127.0.0.1:3000` when enabled

Then load the extension:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select `./chrome-extension`

Open a docs page, open the AskDocs side panel, grant access if needed, index the site, then ask a question.

Run backend unit tests with:

```bash
uv venv
uv pip install --python .venv/bin/python -r requirements-dev.txt
uv run --python .venv/bin/python -m pytest app/tests
```

## Notes

- The extension crawls same-origin pages and prefers the docs sidebar link graph when available.
- Answers are grounded in retrieved snippets and returned with sources.
- If you run the backend outside `start-local.sh`, set `OLLAMA_BASE_URL` as needed. The standalone backend compose file defaults to `http://host.docker.internal:11434`.

## Potential improvements

- Use a vector-based database and embedding-driven RAG instead of SQLite FTS-only retrieval.
- Add model selection so the user can choose among available local Ollama models.
- Add hybrid retrieval and reranking so keyword search and semantic search can work together.
- Support true full-sync indexing that removes pages no longer seen during a crawl.
- Improve site scoping for shared-origin docs hosts so separate RTD spaces do not get mixed together.
- Add better source citations, such as snippet-level references and direct links back to the matching section.
- Add incremental recrawls and change detection so large docs sites do not need a full refresh every time.
