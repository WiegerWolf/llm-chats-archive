# Chat Archive

A self-hosted archive for AI conversations across ChatGPT, Claude, Gemini, Google AI Studio, Kimi, and Pi. Import your exports, search everything locally, and revisit old chats from one interface instead of leaving them scattered across providers.

Built with React, FastAPI, SQLite (FTS5), and filesystem blob storage.

## Why this exists

AI chat history becomes useful only after you can actually search it, compare it, and recover it later. Provider UIs are fragmented, exports are inconsistent, and old conversations disappear into different silos. This project turns those exports into one local archive with full-text search, attachments, and a usable viewer.

In practice, it gives you a way to keep your AI conversations locally searchable instead of leaving them trapped in a pile of provider-specific UIs and export formats.

<br>

<p align="center">
  <img src="docs/main_view.png" alt="Conversation viewer with split-pane layout" width="820" />
</p>

<p align="center">
  <em>Split-pane viewer — conversation list on the left, full thread on the right</em>
</p>

<br>

## Features

- **Unified viewer** for conversations across providers, with provider badges and per-message metadata
- **Full-text search** across all imported messages with highlighted snippets and in-conversation match navigation
- **Drag-and-drop import** with background processing, duplicate detection, and detailed import history
- **Rich content rendering** — Markdown, code blocks, Mermaid diagrams, Claude thinking traces, Kimi research reports, ChatGPT tool payloads
- **Attachments** — inline image/PDF/video/audio preview, extracted text display, source links
- **Single-password auth** with server-side sessions, designed for LAN-only use

<br>

<p align="center">
  <img src="docs/search_view.png" alt="Full-text search with highlighted results" width="820" />
</p>

<p align="center">
  <em>Full-text search with highlighted matches in the conversation list and detail view</em>
</p>

<br>

<p align="center">
  <img src="docs/importer_view.png" alt="Import drawer with upload and history" width="820" />
</p>

<p align="center">
  <em>Import drawer — upload exports and track processing status without leaving your current view</em>
</p>

<br>

## Supported imports

| Provider | Format | Notes |
|---|---|---|
| **ChatGPT** | `.zip` | Single-file or sharded (`export_manifest.json` + `conversations-*.json`) |
| **Claude** | `.zip` | Anthropic export with `users.json`, `projects.json`, `conversations.json` |
| **Gemini** | `.json` | Conversation/message structure inferred from JSON |
| **Google AI Studio** | `.zip` | Structured conversations plus companion assets |
| **Kimi** | `.json` | Browser capture bundle via `scripts/kimi-export.user.js` |
| **Pi** | `.json` | History export with `user_data.details` and `user_data.messages` |

The importer preserves the original upload, normalizes conversations and messages into SQLite, and logs warnings for anything it cannot parse cleanly.

## Getting started

### Docker (recommended)

```bash
docker compose up --build
```

The app serves on **http://localhost:8080**. Data persists in the `archive-data` volume mounted at `/data`.

### Local development

**Backend:**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload
```

**Frontend:**

```bash
cd frontend
bun install
bun run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000`.

## Project layout

```
frontend/    React + TypeScript + Vite SPA
backend/     FastAPI API and import pipeline
data/        SQLite DB, raw uploads, and extracted blobs
scripts/     Utility scripts (Kimi exporter, LobeChat importer)
docs/        Screenshots
```

## Kimi capture workflow

Kimi does not expose a native export, so this project ships a browser-side collector.

1. Install `scripts/kimi-export.user.js` in Tampermonkey or Violentmonkey.
2. Open `https://www.kimi.com/chat/history` while logged in.
3. Click the **Export Kimi** button injected by the script.
4. Wait for the `kimi-export-...json` bundle to download.
5. Upload it via the Import drawer in the archive app.

The userscript runs inside your authenticated browser session and downloads a sanitized JSON bundle — your Kimi auth token is never stored in the archive.
