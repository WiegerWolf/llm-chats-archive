from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("ARCHIVE_DATA_DIR", PROJECT_ROOT / "data"))
DB_PATH = DATA_DIR / "app.db"
RAW_DIR = DATA_DIR / "raw"
BLOBS_DIR = DATA_DIR / "blobs"
TMP_DIR = DATA_DIR / "tmp"
LOCAL_STATIC_DIR = PROJECT_ROOT / "frontend" / "dist"
EMBEDDED_STATIC_DIR = PROJECT_ROOT / "backend" / "app" / "static"
STATIC_DIR = LOCAL_STATIC_DIR if LOCAL_STATIC_DIR.exists() else EMBEDDED_STATIC_DIR


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def dumps_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    BLOBS_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                ip_address TEXT,
                user_agent TEXT
            );

            CREATE TABLE IF NOT EXISTS imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                provider TEXT NOT NULL DEFAULT 'unknown',
                parser_version TEXT,
                status TEXT NOT NULL,
                warning_count INTEGER NOT NULL DEFAULT 0,
                warnings_json TEXT NOT NULL DEFAULT '[]',
                summary_json TEXT NOT NULL DEFAULT '{}',
                error TEXT,
                created_at TEXT NOT NULL,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                sha256 TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL,
                provider_conversation_id TEXT,
                title TEXT NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                source_import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
                created_record_at TEXT NOT NULL,
                updated_record_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_provider_source
            ON conversations(provider, provider_conversation_id)
            WHERE provider_conversation_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                provider_message_id TEXT,
                role TEXT NOT NULL,
                author_name TEXT,
                model TEXT,
                created_at TEXT,
                sequence INTEGER NOT NULL,
                text TEXT NOT NULL,
                content_json TEXT NOT NULL DEFAULT '{}',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                content_hash TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_source
            ON messages(conversation_id, provider_message_id)
            WHERE provider_message_id IS NOT NULL;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe
            ON messages(conversation_id, sequence, content_hash);

            CREATE TABLE IF NOT EXISTS attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                mime_type TEXT,
                blob_path TEXT,
                sha256 TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                message_id UNINDEXED,
                conversation_id UNINDEXED,
                title,
                text,
                provider,
                author_name
            )
            """
        )


def upsert_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO app_settings(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (key, value, utcnow()),
    )


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def touch_fts_title(conn: sqlite3.Connection, conversation_id: int, title: str) -> None:
    conn.execute(
        "UPDATE messages_fts SET title = ? WHERE conversation_id = ?",
        (title, conversation_id),
    )
