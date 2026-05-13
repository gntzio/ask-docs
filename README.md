# AskDocs 📙

AskDocs lets you chat with public and private RTD sites.

It is a local-first documentation assistant built around three parts:

- A Chrome extension that uses your existing browser session to crawl docs pages, including private pages you can already access.
- An AskDocs backend that ingests crawled content, stores and indexes it, retrieves relevant chunks, and prepares grounded prompts.
- A local Ollama server that generates answers only from the retrieved documentation snippets.

This design keeps private content local while cleanly separating crawling, storage, retrieval, and generation.
