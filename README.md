# Unified Chat Archive

Self-hosted single-user archive for AI chat exports. It uses a React SPA, a FastAPI backend, SQLite with FTS5 for search, and filesystem storage for raw uploads and extracted artifacts.

## What it does

- first-run setup screen for a single app password
- password-based login with server-side sessions
- browser upload for export files
- normalized archive for conversations and messages
- full-text search across imported chats
- archive-style conversation viewer with provenance metadata
- initial adapters for ChatGPT, Claude, Gemini, Google AI Studio, Kimi capture bundles, and Pi exports

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

- ChatGPT exports containing `conversations.json` directly or via sharded `conversations-*.json` files referenced by `export_manifest.json`
- Claude exports from Anthropic containing `users.json`, `projects.json`, and `conversations.json`
- Gemini-style JSON exports where conversation/message structure can be inferred from JSON files
- Google AI Studio exports containing structured conversation files plus companion assets inside the exported zip
- Kimi browser capture bundles created by `scripts/kimi-export.user.js`
- Pi history JSON exports containing `user_data.details` and `user_data.messages`

The importer preserves the original uploaded file, normalizes supported conversations/messages into SQLite, and keeps warnings for anything it cannot parse cleanly.

## Kimi capture workflow

Kimi does not currently expose a native export flow, so this project ships a browser-side collector.

1. Install `scripts/kimi-export.user.js` in a userscript manager such as Tampermonkey or Violentmonkey.
2. Open `https://www.kimi.com/chat/history` while logged in.
3. Click the `Export Kimi` button added by the script.
4. Wait for it to download a `kimi-export-...json` bundle.
5. Upload that JSON file in the archive app Imports page.

The userscript runs inside your authenticated browser session, captures chat metadata plus message API responses, and downloads a sanitized JSON bundle without storing your Kimi auth token inside the archive app.
