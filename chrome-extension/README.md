# AskDocs Chrome Extension

Load this directory as an unpacked Chrome extension.

The extension:

- opens a side panel UI,
- crawls the current docs origin through the browser session,
- sends pages to the local AskDocs backend for indexing,
- asks grounded questions through the backend,
- renders answers with sources.

Expected local backend default: `http://127.0.0.1:8000`
