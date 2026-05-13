# AskDocs 📙

AskDocs lets you chat with public and private RTD sites.

It is a local-first documentation assistant built around three parts:

- A Chrome extension that uses your existing browser session to crawl docs pages, including private pages you can already access.
- An AskDocs backend that ingests crawled content, stores and indexes it, retrieves relevant chunks, and prepares grounded prompts.
- A local Ollama server that generates answers only from the retrieved documentation snippets.

This design keeps private content local while cleanly separating crawling, storage, retrieval, and generation.

## Backend

This repository now includes the first AskDocs backend draft built with:

- Python 3.12
- FastAPI
- SQLite + FTS5
- `httpx` for local Ollama calls

The backend accepts crawled pages from the Chrome extension, chunks and indexes them locally, searches relevant chunks per site, and asks Ollama grounded questions using only retrieved snippets.

## Chrome extension

This repository also includes a Chrome MV3 extension in [`chrome-extension/`](./chrome-extension) with:

- a side panel UI,
- current-site access and status checks,
- same-origin crawling through inactive tabs,
- page extraction and backend ingestion,
- grounded `/ask` integration with sources.

## API

- `GET /health`
- `POST /ingest-page`
- `POST /search`
- `POST /ask`
- `POST /reindex-site`

The SQLite database is stored at `./data/askdocs.db` on the host and mounted into the container at `/data/askdocs.db`.

## Local run

Start the full local stack:

```bash
bash ./start-local.sh
```

This starts:

- Ollama on `http://127.0.0.1:11434`
- AskDocs backend on `http://127.0.0.1:8000`
- Open WebUI on `http://127.0.0.1:3000` when enabled

The backend and Ollama run in the same Docker Compose project, and the backend talks to Ollama over the internal service URL `http://ollama:11434`.

Stop the full stack with:

```bash
bash ./stop-local.sh
```

The SQLite database is stored on the host at `./data/askdocs.db`.

If you run only the backend container outside `start-local.sh`, set `OLLAMA_BASE_URL` as needed. The standalone `docker-compose.yml` defaults to `http://host.docker.internal:11434`.

## Load the extension

1. Start the local stack with `bash ./start-local.sh`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked and select `./chrome-extension`.
5. Open a docs page, click the AskDocs action, and use the side panel.

For custom or private docs hosts, use the side panel's `Grant access` button to request runtime permission for the current origin.

## Notes

- The backend does not crawl websites itself. Crawling is expected to happen in the Chrome extension.
- The extension does not index locally and does not call Ollama directly.
- `POST /ask` searches local chunks first, then calls Ollama's chat API with `stream: false`.
- `POST /reindex-site` clears all indexed pages and chunks for one site before a fresh crawl.
