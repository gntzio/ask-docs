# AGENTS.md

## Mission

AskDocs is a local-first documentation assistant for public and private docs sites. It should let users crawl docs through their own browser session, index content locally, and ask grounded questions answered by a local Ollama model.

## System overview

AskDocs has three parts:

1. **Chrome extension**
   - Crawls docs pages using the user’s existing browser session
   - Extracts page content and metadata
   - Sends crawled content to the backend
   - Provides the side panel UI for crawl status, search, and answers

2. **AskDocs backend**
   - Accepts crawled pages from the extension
   - Cleans, chunks, stores, and indexes content locally
   - Retrieves relevant chunks for each user query
   - Calls the local Ollama API with grounded context
   - Returns answers with supporting sources

3. **Local Ollama service**
   - Runs fully on the user’s machine
   - Serves local answer generation
   - Remains the default inference path

## Core principles

- **Local first**: keep content, indexing, retrieval, and inference local by default
- **Privacy first**: do not introduce hosted LLM dependencies as the default path
- **Grounded answers**: answers should come from retrieved documentation snippets, not free-form guessing
- **Clear boundaries**: keep crawling, storage, retrieval, and generation separated
- **Simple developer experience**: favor explicit configuration and easy local startup

## Engineering guidance

- Prefer simple JSON HTTP APIs between components
- Keep modules small and separable
- Favor predictable, debuggable behavior over clever abstractions
- When adding new top-level components, include a short README
- Use documented local configuration and never commit secrets
- Keep Linux local development as the default happy path

## Current repository scope

This repository contains:
- local Ollama development and Docker setup
- AskDocs backend service
- Chrome MV3 extension for crawling and QA
- supporting scripts and local data directory

## Decision rule for agents

If a design decision is unclear, choose the option that best preserves:
1. local privacy,
2. grounded retrieval-based answers,
3. a simple local developer workflow.
