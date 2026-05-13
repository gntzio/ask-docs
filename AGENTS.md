# AGENTS.md

## Mission

AskDocs is a local-first documentation assistant for public and private Read the Docs sites. Users should be able to crawl docs pages from their own browser session, index that content locally, and ask grounded questions answered by a local Ollama model.

## Current repo state

Today this repository only contains the local Ollama development stack:

- `start-local.sh` starts Ollama, optionally enables NVIDIA GPU mode, and can also start Open WebUI.
- `stop-local.sh` stops the local stack.
- `gpu-info.sh` helps diagnose local NVIDIA issues.
- `ollama/compose.yaml` defines the base local services.
- `ollama/compose.gpu.yaml` enables Docker GPU access for Ollama.

The backend service and Chrome extension are planned but not yet scaffolded here.

## Planned architecture

### 1. Chrome extension

- Crawl docs pages using the user's existing browser session.
- Extract page content and metadata.
- Send crawled content to the backend for ingestion.
- Provide a side panel UI for crawl status, asking questions, and showing answers with sources.

### 2. AskDocs backend

- Accept crawled pages from the extension.
- Clean, chunk, and index content for retrieval.
- Retrieve relevant chunks for each user query.
- Build grounded prompts and call the local Ollama API.
- Return answers plus supporting sources to the extension.

### 3. Local Ollama service

- Run fully on the user's machine.
- Serve local generation through `http://127.0.0.1:11434`.
- Remain the default answer-generation path for local and private documentation.

## Engineering guidance

- Prefer simple, explicit interfaces between components, especially JSON HTTP APIs between the extension and backend.
- Preserve the local-first model. Do not introduce hosted LLM dependencies as the default path.
- Keep configuration explicit and safe. Use `.env.example` for documented settings and never commit secrets.
- Favor small, separable modules so crawling, indexing, retrieval, and answer generation can evolve independently.
- When adding new top-level components, include a short README in that directory.
- Keep startup scripts friendly for local development on Linux first; broader platform support is welcome if it does not complicate the default path.


## Working assumption for agents

If a design decision is unclear, choose the option that best preserves local privacy, grounded answers, and a simple local developer experience. Do not hesitate to ask follow up questions.
