# Unified Chat Archive

Self-hosted single-user archive for AI chat exports. It uses a React SPA, a FastAPI backend, SQLite with FTS5 for search, and filesystem storage for raw uploads and extracted artifacts.

## What it does

- first-run setup screen for a single app password
- password-based login with server-side sessions
- browser upload for export files
- normalized archive for conversations and messages
- full-text search across imported chats
- archive-style conversation viewer with provenance metadata
- initial adapters for ChatGPT exports and generic Gemini-style JSON exports
- initial adapters for ChatGPT, Claude, and generic Gemini-style JSON exports

## Project layout

- `frontend/` React + TypeScript + Vite SPA
- `backend/` FastAPI API and import pipeline
- `data/` SQLite DB, raw uploads, and extracted blobs

## Local development

Backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000`.

## Docker

```bash
docker compose up --build
```

The app is served on `http://localhost:8080` by default. Persistent data is stored in the `archive-data` volume mounted at `/data`.

## Supported imports in this MVP

- ChatGPT exports containing `conversations.json`
- Claude exports from Anthropic containing `users.json`, `projects.json`, and `conversations.json`
- Gemini-style JSON exports where conversation/message structure can be inferred from JSON files

The importer preserves the original uploaded file, normalizes supported conversations/messages into SQLite, and keeps warnings for anything it cannot parse cleanly.
