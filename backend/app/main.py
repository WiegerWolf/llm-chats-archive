from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .adapters import ImportParseError, derive_kimi_model, fallback_assistant_model, flatten_claude_message, parse_export
from .db import (
    BLOBS_DIR,
    RAW_DIR,
    STATIC_DIR,
    connect,
    dumps_json,
    get_setting,
    init_db,
    touch_fts_title,
    upsert_setting,
    utcnow,
)
from .security import (
    MIN_PASSWORD_LENGTH,
    SESSION_COOKIE,
    SESSION_TTL_DAYS,
    hash_password,
    issue_session_id,
    session_expiry,
    valid_password,
    verify_password,
)

app = FastAPI(title="Unified Chat Archive")

origin_env = [item.strip() for item in os.getenv("ARCHIVE_CORS_ORIGINS", "").split(",") if item.strip()]
if origin_env:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origin_env,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


class PasswordPayload(BaseModel):
    password: str


class ChangePasswordPayload(BaseModel):
    current_password: str
    new_password: str


@app.on_event("startup")
def startup() -> None:
    init_db()
    backfill_message_models()
    backfill_claude_message_text()


def json_or_none(value: str | None) -> object:
    if not value:
        return None
    return json.loads(value)


def provider_filter_values(request: Request, provider: str | None) -> list[str]:
    raw_values = request.query_params.getlist("provider")
    if not raw_values and provider:
        raw_values = [provider]

    providers: list[str] = []
    for raw_value in raw_values:
        for item in raw_value.split(","):
            normalized = item.strip().lower()
            if normalized and normalized not in providers:
                providers.append(normalized)
    return providers


def backfill_message_models() -> None:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT m.id, c.provider, m.role, m.model, m.content_json, m.metadata_json
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.role = 'assistant' AND (m.model IS NULL OR TRIM(m.model) = '')
            """
        ).fetchall()

        updates: list[tuple[str, int]] = []
        for row in rows:
            provider = str(row["provider"] or "").strip().lower()
            model = derive_missing_message_model(
                provider,
                str(row["role"] or "").strip().lower(),
                row["content_json"],
                row["metadata_json"],
            )
            if model:
                updates.append((model, int(row["id"])))

        if updates:
            conn.executemany("UPDATE messages SET model = ? WHERE id = ?", updates)
            conn.commit()


def backfill_claude_message_text() -> None:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT m.id, m.text, m.content_json, m.metadata_json
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.provider = 'claude'
            """
        ).fetchall()

        message_updates: list[tuple[str, str, int]] = []
        fts_updates: list[tuple[str, int]] = []
        for row in rows:
            content = json_or_none(row["content_json"])
            metadata = json_or_none(row["metadata_json"])
            content_dict = content if isinstance(content, dict) else {}
            metadata_dict = metadata if isinstance(metadata, dict) else {}

            visible_text = derive_claude_visible_text(content_dict)
            normalized_metadata = normalize_claude_metadata(metadata_dict, content_dict)
            metadata_json = dumps_json(normalized_metadata)

            if row["text"] != visible_text or row["metadata_json"] != metadata_json:
                message_updates.append((visible_text, metadata_json, int(row["id"])))
            if row["text"] != visible_text:
                fts_updates.append((visible_text, int(row["id"])))

        if message_updates:
            conn.executemany("UPDATE messages SET text = ?, metadata_json = ? WHERE id = ?", message_updates)
        if fts_updates:
            conn.executemany("UPDATE messages_fts SET text = ? WHERE rowid = ?", fts_updates)
        if message_updates or fts_updates:
            conn.commit()


def derive_missing_message_model(provider: str, role: str, content_json: str | None, metadata_json: str | None) -> str | None:
    if role != "assistant":
        return None

    content = json_or_none(content_json) if content_json else None
    metadata = json_or_none(metadata_json) if metadata_json else None
    content_dict = content if isinstance(content, dict) else {}
    metadata_dict = metadata if isinstance(metadata, dict) else {}

    if provider == "claude":
        return fallback_assistant_model(provider, role)
    if provider == "kimi":
        return derive_kimi_model(content_dict, metadata_dict, role, content_dict)
    return None


def derive_claude_visible_text(content: dict[str, Any]) -> str:
    if not content:
        return ""
    return flatten_claude_message(
        {
            "text": content.get("text"),
            "content": content.get("blocks") or [],
        }
    )


def normalize_claude_metadata(metadata: dict[str, Any], content: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(metadata)
    existing = normalized.get("thinking")
    if not isinstance(existing, list) or not existing:
        thoughts: list[dict[str, Any]] = []
        for block in content.get("blocks") or []:
            if not isinstance(block, dict):
                continue
            if str(block.get("type") or "").strip().lower() != "thinking":
                continue
            text = str(block.get("thinking") or "").strip()
            if not text:
                continue
            thoughts.append(
                {
                    "text": text,
                    "created_at": block.get("start_timestamp") or block.get("stop_timestamp"),
                    "summaries": [
                        str(summary.get("summary") or "").strip()
                        for summary in block.get("summaries") or []
                        if isinstance(summary, dict) and str(summary.get("summary") or "").strip()
                    ],
                }
            )
        if thoughts:
            normalized["thinking"] = thoughts
    return normalized


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name or "upload")
    return cleaned.strip("-.") or "upload.bin"


def message_row_id(cursor: sqlite3.Cursor) -> int:
    row_id = cursor.lastrowid
    if row_id is None:
        raise RuntimeError("Database insert did not return a row id.")
    return int(row_id)


def fts_query(text: str) -> str:
    tokens = re.findall(r"[A-Za-z0-9_]+", text)
    return " ".join(tokens)


def create_session(conn: sqlite3.Connection, request: Request) -> tuple[str, str]:
    session_id = issue_session_id()
    expires_at = session_expiry()
    conn.execute(
        """
        INSERT INTO sessions(id, created_at, expires_at, last_seen_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            utcnow(),
            expires_at,
            utcnow(),
            request.client.host if request.client else None,
            request.headers.get("user-agent"),
        ),
    )
    return session_id, expires_at


def apply_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        session_id,
        httponly=True,
        samesite="lax",
        max_age=SESSION_TTL_DAYS * 24 * 60 * 60,
        secure=False,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def fetch_session(conn: sqlite3.Connection, request: Request) -> sqlite3.Row | None:
    session_id = request.cookies.get(SESSION_COOKIE)
    if not session_id:
        return None
    row = conn.execute(
        "SELECT * FROM sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    if not row:
        return None
    if row["expires_at"] <= utcnow():
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        conn.commit()
        return None
    conn.execute(
        "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
        (utcnow(), session_id),
    )
    conn.commit()
    return row


def require_auth(request: Request) -> None:
    with connect() as conn:
        password_hash = get_setting(conn, "password_hash")
        if not password_hash:
            raise HTTPException(status_code=428, detail="Application setup is incomplete.")
        session = fetch_session(conn, request)
        if not session:
            raise HTTPException(status_code=401, detail="Authentication required.")


def upsert_conversation(conn: sqlite3.Connection, conversation: dict, import_id: int) -> int:
    now = utcnow()
    provider_id = conversation.get("provider_conversation_id")
    row = None
    if provider_id:
        row = conn.execute(
            "SELECT id FROM conversations WHERE provider = ? AND provider_conversation_id = ?",
            (conversation["provider"], provider_id),
        ).fetchone()
    if row:
        conn.execute(
            """
            UPDATE conversations
            SET title = ?, created_at = COALESCE(created_at, ?), updated_at = ?, metadata_json = ?,
                source_import_id = ?, updated_record_at = ?
            WHERE id = ?
            """,
            (
                conversation["title"],
                conversation.get("created_at"),
                conversation.get("updated_at"),
                dumps_json(conversation.get("metadata") or {}),
                import_id,
                now,
                row["id"],
            ),
        )
        touch_fts_title(conn, row["id"], conversation["title"])
        return int(row["id"])

    cursor = conn.execute(
        """
        INSERT INTO conversations(
            provider, provider_conversation_id, title, created_at, updated_at,
            metadata_json, source_import_id, created_record_at, updated_record_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            conversation["provider"],
            provider_id,
            conversation["title"],
            conversation.get("created_at"),
            conversation.get("updated_at"),
            dumps_json(conversation.get("metadata") or {}),
            import_id,
            now,
            now,
        ),
    )
    return message_row_id(cursor)


def insert_attachment(conn: sqlite3.Connection, message_id: int, attachment: dict) -> None:
    conn.execute(
        """
        INSERT INTO attachments(message_id, filename, mime_type, blob_path, sha256, metadata_json, source_import_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message_id,
            attachment.get("filename") or "attachment",
            attachment.get("mime_type"),
            attachment.get("blob_path"),
            attachment.get("sha256"),
            dumps_json(attachment.get("metadata") or {}),
            attachment.get("source_import_id"),
        ),
    )


def insert_source(conn: sqlite3.Connection, import_id: int, source: dict) -> None:
    conn.execute(
        "INSERT INTO sources(import_id, kind, relative_path, sha256, metadata_json) VALUES (?, ?, ?, ?, ?)",
        (
            import_id,
            source.get("kind") or "blob",
            source.get("relative_path") or "",
            source.get("sha256"),
            dumps_json(source.get("metadata") or {}),
        ),
    )


def insert_message(conn: sqlite3.Connection, conversation_id: int, title: str, provider: str, message: dict, import_id: int) -> int | None:
    content_hash = hashlib.sha256(
        dumps_json(
            {
                "role": message.get("role"),
                "created_at": message.get("created_at"),
                "text": message.get("text"),
            }
        ).encode("utf-8")
    ).hexdigest()

    try:
        cursor = conn.execute(
            """
            INSERT INTO messages(
                conversation_id, provider_message_id, role, author_name, model,
                created_at, sequence, text, content_json, metadata_json, content_hash, source_import_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                conversation_id,
                message.get("provider_message_id"),
                message.get("role") or "unknown",
                message.get("author_name"),
                message.get("model"),
                message.get("created_at"),
                message.get("sequence"),
                message.get("text") or "",
                dumps_json(message.get("content") or {}),
                dumps_json(message.get("metadata") or {}),
                content_hash,
                import_id,
            ),
        )
    except sqlite3.IntegrityError:
        return None

    message_id = message_row_id(cursor)
    conn.execute(
        """
        INSERT INTO messages_fts(rowid, message_id, conversation_id, title, text, provider, author_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            message_id,
            message_id,
            conversation_id,
            title,
            message.get("text") or "",
            provider,
            message.get("author_name") or "",
        ),
    )
    inserted_attachments = 0
    for attachment in message.get("attachments") or []:
        if not isinstance(attachment, dict):
            continue
        attachment = dict(attachment)
        attachment["source_import_id"] = import_id
        insert_attachment(conn, message_id, attachment)
        inserted_attachments += 1
    return inserted_attachments


def source_file_path(kind: str, relative_path: str) -> Path | None:
    root = RAW_DIR if kind == "upload" else BLOBS_DIR if kind == "blob" else None
    if root is None:
        return None
    root_resolved = root.resolve()
    resolved = (root_resolved / relative_path).resolve()
    try:
        resolved.relative_to(root_resolved)
    except ValueError:
        return None
    return resolved


def refresh_conversation_sources(conn: sqlite3.Connection, conversation_ids: list[int]) -> None:
    for conversation_id in conversation_ids:
        row = conn.execute(
            """
            SELECT source_import_id
            FROM messages
            WHERE conversation_id = ? AND source_import_id IS NOT NULL
            ORDER BY COALESCE(created_at, '') DESC, id DESC
            LIMIT 1
            """,
            (conversation_id,),
        ).fetchone()
        conn.execute(
            "UPDATE conversations SET source_import_id = ?, updated_record_at = ? WHERE id = ?",
            (row["source_import_id"] if row else None, utcnow(), conversation_id),
        )


def delete_import_data(import_id: int) -> dict[str, Any]:
    file_paths: list[Path] = []
    deleted_counts = {
        "messages": 0,
        "attachments": 0,
        "conversations": 0,
        "sources": 0,
    }
    with connect() as conn:
        import_row = conn.execute("SELECT id, status FROM imports WHERE id = ?", (import_id,)).fetchone()
        if not import_row:
            raise HTTPException(status_code=404, detail="Import not found.")
        if import_row["status"] in {"queued", "processing"}:
            raise HTTPException(status_code=409, detail="Cannot delete an import while it is still processing.")

        source_rows = conn.execute(
            "SELECT kind, relative_path FROM sources WHERE import_id = ? ORDER BY id ASC",
            (import_id,),
        ).fetchall()
        for row in source_rows:
            path = source_file_path(str(row["kind"]), str(row["relative_path"]))
            if path is not None:
                file_paths.append(path)

        conversation_rows = conn.execute(
            "SELECT DISTINCT conversation_id FROM messages WHERE source_import_id = ?",
            (import_id,),
        ).fetchall()
        conversation_ids = [int(row["conversation_id"]) for row in conversation_rows]

        deleted_counts["attachments"] = conn.execute(
            "DELETE FROM attachments WHERE source_import_id = ?",
            (import_id,),
        ).rowcount
        conn.execute(
            "DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE source_import_id = ?)",
            (import_id,),
        )
        deleted_counts["messages"] = conn.execute(
            "DELETE FROM messages WHERE source_import_id = ?",
            (import_id,),
        ).rowcount

        if conversation_ids:
            refresh_conversation_sources(conn, conversation_ids)
            placeholders = ", ".join("?" for _ in conversation_ids)
            deleted_counts["conversations"] = conn.execute(
                f"DELETE FROM conversations WHERE id IN ({placeholders}) AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)",
                tuple(conversation_ids),
            ).rowcount

        deleted_counts["sources"] = conn.execute(
            "DELETE FROM sources WHERE import_id = ?",
            (import_id,),
        ).rowcount
        conn.execute("DELETE FROM imports WHERE id = ?", (import_id,))
        conn.commit()

    for path in file_paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    return {"ok": True, "deleted": deleted_counts}


def process_import(import_id: int, stored_path: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE imports SET status = ? WHERE id = ?", ("processing", import_id))
        conn.commit()

    try:
        result = parse_export(Path(stored_path))
        with connect() as conn:
            inserted_messages = 0
            duplicate_messages = 0
            inserted_attachments = 0
            inserted_sources = 0
            for source in result.get("sources") or []:
                if not isinstance(source, dict) or not source.get("relative_path"):
                    continue
                insert_source(conn, import_id, source)
                inserted_sources += 1
            for conversation in result["conversations"]:
                conversation_id = upsert_conversation(conn, conversation, import_id)
                for message in conversation["messages"]:
                    attachment_count = insert_message(conn, conversation_id, conversation["title"], conversation["provider"], message, import_id)
                    if attachment_count is not None:
                        inserted_messages += 1
                        inserted_attachments += attachment_count
                    else:
                        duplicate_messages += 1

            summary = dict(result.get("summary") or {})
            summary["inserted_messages"] = inserted_messages
            summary["duplicate_messages"] = duplicate_messages
            summary["inserted_attachments"] = inserted_attachments
            summary["inserted_sources"] = inserted_sources

            conn.execute(
                """
                UPDATE imports
                SET provider = ?, parser_version = ?, status = ?, warning_count = ?,
                    warnings_json = ?, summary_json = ?, finished_at = ?
                WHERE id = ?
                """,
                (
                    result["provider"],
                    result["parser_version"],
                    "completed",
                    len(result.get("warnings") or []),
                    dumps_json(result.get("warnings") or []),
                    dumps_json(summary),
                    utcnow(),
                    import_id,
                ),
            )
            conn.commit()
    except Exception as exc:  # noqa: BLE001
        with connect() as conn:
            status = "failed"
            detail = str(exc)
            if isinstance(exc, ImportParseError):
                detail = str(exc)
            conn.execute(
                "UPDATE imports SET status = ?, error = ?, finished_at = ? WHERE id = ?",
                (status, detail, utcnow(), import_id),
            )
            conn.commit()


@app.get("/api/auth/session")
def auth_session(request: Request) -> dict:
    with connect() as conn:
        password_hash = get_setting(conn, "password_hash")
        if not password_hash:
            return {"needs_setup": True, "authenticated": False}
        session = fetch_session(conn, request)
        return {
            "needs_setup": False,
            "authenticated": bool(session),
            "expires_at": session["expires_at"] if session else None,
        }


@app.post("/api/auth/setup")
def setup_auth(payload: PasswordPayload, request: Request, response: Response) -> dict:
    if not valid_password(payload.password):
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters.",
        )
    with connect() as conn:
        if get_setting(conn, "password_hash"):
            raise HTTPException(status_code=409, detail="Setup has already been completed.")
        upsert_setting(conn, "password_hash", hash_password(payload.password))
        session_id, expires_at = create_session(conn, request)
        conn.commit()
    apply_session_cookie(response, session_id)
    return {"ok": True, "expires_at": expires_at}


@app.post("/api/auth/login")
def login(payload: PasswordPayload, request: Request, response: Response) -> dict:
    with connect() as conn:
        password_hash = get_setting(conn, "password_hash")
        if not password_hash:
            raise HTTPException(status_code=428, detail="Application setup is incomplete.")
        if not verify_password(password_hash, payload.password):
            raise HTTPException(status_code=401, detail="Incorrect password.")
        session_id, expires_at = create_session(conn, request)
        conn.commit()
    apply_session_cookie(response, session_id)
    return {"ok": True, "expires_at": expires_at}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict:
    with connect() as conn:
        session_id = request.cookies.get(SESSION_COOKIE)
        if session_id:
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            conn.commit()
    clear_session_cookie(response)
    return {"ok": True}


@app.post("/api/auth/change-password")
def change_password(payload: ChangePasswordPayload, request: Request) -> dict:
    require_auth(request)
    if not valid_password(payload.new_password):
        raise HTTPException(
            status_code=400,
            detail=f"New password must be at least {MIN_PASSWORD_LENGTH} characters.",
        )
    with connect() as conn:
        password_hash = get_setting(conn, "password_hash")
        if not password_hash or not verify_password(password_hash, payload.current_password):
            raise HTTPException(status_code=401, detail="Current password is incorrect.")
        upsert_setting(conn, "password_hash", hash_password(payload.new_password))
        conn.commit()
    return {"ok": True}


@app.get("/api/dashboard")
def dashboard(request: Request) -> dict:
    require_auth(request)
    with connect() as conn:
        counts = {
            "conversation_count": conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0],
            "message_count": conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
            "import_count": conn.execute("SELECT COUNT(*) FROM imports").fetchone()[0],
        }
        providers = [
            dict(row)
            for row in conn.execute(
                "SELECT provider, COUNT(*) AS count FROM conversations GROUP BY provider ORDER BY count DESC"
            ).fetchall()
        ]
        recent_imports = [
            {
                **dict(row),
                "warnings": json_or_none(row["warnings_json"]),
                "summary": json_or_none(row["summary_json"]),
            }
            for row in conn.execute(
                "SELECT * FROM imports ORDER BY created_at DESC LIMIT 6"
            ).fetchall()
        ]
        recent_conversations = [
            dict(row)
            for row in conn.execute(
                """
                SELECT c.id, c.title, c.provider, c.updated_at, COUNT(m.id) AS message_count
                FROM conversations c
                LEFT JOIN messages m ON m.conversation_id = c.id
                GROUP BY c.id
                ORDER BY COALESCE(c.updated_at, c.created_at, c.updated_record_at) DESC
                LIMIT 6
                """
            ).fetchall()
        ]
    return {**counts, "providers": providers, "recent_imports": recent_imports, "recent_conversations": recent_conversations}


@app.get("/api/imports")
def list_imports(request: Request) -> dict:
    require_auth(request)
    with connect() as conn:
        rows = conn.execute("SELECT * FROM imports ORDER BY created_at DESC LIMIT 100").fetchall()
        items = []
        for row in rows:
            item = dict(row)
            item["warnings"] = json_or_none(item.pop("warnings_json")) or []
            item["summary"] = json_or_none(item.pop("summary_json")) or {}
            items.append(item)
    return {"items": items}


@app.get("/api/imports/{import_id}")
def get_import(import_id: int, request: Request) -> dict:
    require_auth(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM imports WHERE id = ?", (import_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Import not found.")
        item = dict(row)
        item["warnings"] = json_or_none(item.pop("warnings_json")) or []
        item["summary"] = json_or_none(item.pop("summary_json")) or {}
    return item


@app.get("/api/imports/{import_id}/sources")
def list_import_sources(import_id: int, request: Request) -> dict:
    require_auth(request)
    with connect() as conn:
        import_row = conn.execute("SELECT id FROM imports WHERE id = ?", (import_id,)).fetchone()
        if not import_row:
            raise HTTPException(status_code=404, detail="Import not found.")
        attached_hashes = {
            str(row["sha256"])
            for row in conn.execute(
                "SELECT DISTINCT sha256 FROM attachments WHERE source_import_id = ? AND sha256 IS NOT NULL AND sha256 != ''",
                (import_id,),
            ).fetchall()
        }
        rows = conn.execute(
            "SELECT id, kind, relative_path, sha256, metadata_json FROM sources WHERE import_id = ? ORDER BY id ASC",
            (import_id,),
        ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["metadata"] = json_or_none(item.pop("metadata_json")) or {}
        item["is_attached"] = bool(item.get("sha256") and str(item["sha256"]) in attached_hashes)
        items.append(item)
    return {"items": items}


@app.post("/api/imports")
def upload_import(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> dict:
    require_auth(request)
    original_name = file.filename or "upload.bin"
    stored_name = f"{utcnow().replace(':', '-')}-{sanitize_filename(original_name)}"
    destination = RAW_DIR / stored_name
    digest = hashlib.sha256()

    with destination.open("wb") as handle:
        while chunk := file.file.read(1024 * 1024):
            digest.update(chunk)
            handle.write(chunk)

    with connect() as conn:
        cursor = conn.execute(
            """
            INSERT INTO imports(filename, original_filename, sha256, status, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (destination.name, original_name, digest.hexdigest(), "queued", utcnow()),
        )
        import_id = message_row_id(cursor)
        conn.execute(
            "INSERT INTO sources(import_id, kind, relative_path, sha256, metadata_json) VALUES (?, ?, ?, ?, ?)",
            (import_id, "upload", destination.name, digest.hexdigest(), dumps_json({"original_filename": original_name})),
        )
        conn.commit()

    background_tasks.add_task(process_import, import_id, str(destination))
    return {"id": import_id, "status": "queued", "filename": original_name}


@app.delete("/api/imports/{import_id}")
def delete_import(import_id: int, request: Request) -> dict[str, Any]:
    require_auth(request)
    return delete_import_data(import_id)


@app.get("/api/conversations")
def list_conversations(request: Request, provider: str | None = None, limit: int = 50, offset: int = 0) -> dict:
    require_auth(request)
    limit = max(1, min(limit, 100))
    offset = max(offset, 0)
    providers = provider_filter_values(request, provider)
    provider_sql = ""
    params: list[Any] = []
    if providers:
        provider_sql = f"WHERE c.provider IN ({', '.join('?' for _ in providers)})"
        params.extend(providers)
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT c.id, c.title, c.provider, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count,
                   MAX(m.created_at) AS last_message_at
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            {provider_sql}
            GROUP BY c.id
            ORDER BY COALESCE(c.updated_at, c.created_at, c.updated_record_at) DESC
            LIMIT ? OFFSET ?
            """,
            tuple(params + [limit, offset]),
        ).fetchall()
    return {"items": [dict(row) for row in rows]}


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: int, request: Request) -> dict:
    require_auth(request)
    with connect() as conn:
        conversation = conn.execute(
            "SELECT * FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        messages = [
            {
                **dict(row),
                "content": json_or_none(row["content_json"]),
                "metadata": json_or_none(row["metadata_json"]),
                "attachments": [],
            }
            for row in conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence ASC, id ASC",
                (conversation_id,),
            ).fetchall()
        ]
        attachments_by_message: dict[int, list[dict]] = {}
        for row in conn.execute(
            """
            SELECT id, message_id, filename, mime_type, blob_path, sha256, metadata_json
            FROM attachments
            WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)
            ORDER BY id ASC
            """,
            (conversation_id,),
        ).fetchall():
            attachment = dict(row)
            attachment["metadata"] = json_or_none(attachment.pop("metadata_json"))
            attachments_by_message.setdefault(int(row["message_id"]), []).append(attachment)
        for message in messages:
            message["attachments"] = attachments_by_message.get(int(message["id"]), [])
        source = None
        if conversation["source_import_id"]:
            source_row = conn.execute(
                "SELECT id, original_filename, filename, provider, status, created_at FROM imports WHERE id = ?",
                (conversation["source_import_id"],),
            ).fetchone()
            if source_row:
                source = dict(source_row)
    return {
        **dict(conversation),
        "metadata": json_or_none(conversation["metadata_json"]),
        "messages": messages,
        "source_import": source,
    }


@app.get("/api/search")
def search(request: Request, q: str, provider: str | None = None, limit: int = 25) -> dict:
    require_auth(request)
    query = fts_query(q.strip())
    if not query:
        return {"items": []}
    limit = max(1, min(limit, 50))
    params: list[Any] = [query]
    provider_sql = ""
    providers = provider_filter_values(request, provider)
    if providers:
        provider_sql = f" AND c.provider IN ({', '.join('?' for _ in providers)})"
        params.extend(providers)
    sql = f"""
        SELECT c.id, c.title, c.provider, c.updated_at,
               (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count,
               snippet(messages_fts, 3, '[', ']', ' ... ', 18) AS snippet,
               messages_fts.author_name AS author_name,
               bm25(messages_fts) AS score
        FROM messages_fts
        JOIN conversations c ON c.id = messages_fts.conversation_id
        WHERE messages_fts MATCH ? {provider_sql}
        ORDER BY score
        LIMIT ?
    """
    params.append(limit * 3)
    with connect() as conn:
        rows = conn.execute(sql, tuple(params)).fetchall()

    seen: set[int] = set()
    items = []
    for row in rows:
        if row["id"] in seen:
            continue
        seen.add(row["id"])
        items.append(dict(row))
        if len(items) >= limit:
            break
    return {"items": items}


@app.get("/api/attachments/{attachment_id}")
def get_attachment(attachment_id: int, request: Request) -> JSONResponse:
    require_auth(request)
    with connect() as conn:
        row = conn.execute(
            "SELECT id, filename, mime_type, blob_path FROM attachments WHERE id = ?",
            (attachment_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    blob_path = str(row["blob_path"] or "").strip()
    if not blob_path:
        raise HTTPException(status_code=404, detail="Attachment file is not available.")

    resolved = (BLOBS_DIR.resolve() / blob_path).resolve()
    try:
        resolved.relative_to(BLOBS_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid attachment path.") from exc
    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail="Attachment file is missing.")

    media_type = str(row["mime_type"] or "").strip() or None
    return FileResponse(resolved, filename=str(row["filename"] or "attachment"), media_type=media_type)


@app.get("/api/sources/{source_id}")
def get_source_file(source_id: int, request: Request) -> JSONResponse:
    require_auth(request)
    with connect() as conn:
        row = conn.execute(
            "SELECT id, kind, relative_path, metadata_json FROM sources WHERE id = ?",
            (source_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Source file not found.")
    path = source_file_path(str(row["kind"]), str(row["relative_path"]))
    if path is None:
        raise HTTPException(status_code=400, detail="Invalid source path.")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Source file is missing.")
    raw_metadata = json_or_none(row["metadata_json"])
    metadata: dict[str, Any] = raw_metadata if isinstance(raw_metadata, dict) else {}
    filename = str(metadata.get("filename") or metadata.get("original_filename") or Path(path).name)
    media_type = None
    if isinstance(metadata, dict):
        media_type = str(metadata.get("mime_type") or "").strip() or None
    return FileResponse(path, filename=filename, media_type=media_type)


@app.get("/api/providers")
def providers(request: Request) -> dict:
    require_auth(request)
    return {
        "items": [
            {"provider": "chatgpt", "parser_version": "chatgpt:v2"},
            {"provider": "gemini", "parser_version": "gemini:v1"},
            {"provider": "claude", "parser_version": "claude:v1"},
            {"provider": "kimi", "parser_version": "kimi:v1"},
            {"provider": "pi", "parser_version": "pi:v1"},
            {"provider": "googleaistudio", "parser_version": "googleaistudio:v1"},
        ]
    }


if (STATIC_DIR / "assets").exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


@app.get("/{full_path:path}")
def spa(full_path: str) -> Response:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found.")
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse(
        {
            "detail": "Frontend has not been built yet. Run the Vite build or use the dev server.",
        },
        status_code=503,
    )
