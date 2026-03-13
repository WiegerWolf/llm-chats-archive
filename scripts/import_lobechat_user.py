#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.app.db import BLOBS_DIR, connect, dumps_json, init_db, utcnow


PROVIDER = "lobechat"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import one LobeChat user from a PostgreSQL SQL dump into the local archive.")
    parser.add_argument("--dump", required=True, help="Path to lobechat_full.sql")
    parser.add_argument("--blob-root", required=True, help="Path to restored R2 bucket root (contains files/)")
    parser.add_argument("--user-id", required=True, help="LobeChat user id to import")
    parser.add_argument("--label", default="", help="Human-readable label for the import record")
    return parser.parse_args()


def decode_copy_field(value: str) -> str | None:
    if value == r"\N":
        return None

    out: list[str] = []
    i = 0
    while i < len(value):
        ch = value[i]
        if ch != "\\":
            out.append(ch)
            i += 1
            continue

        i += 1
        if i >= len(value):
            out.append("\\")
            break

        esc = value[i]
        i += 1
        if esc == "b":
            out.append("\b")
        elif esc == "f":
            out.append("\f")
        elif esc == "n":
            out.append("\n")
        elif esc == "r":
            out.append("\r")
        elif esc == "t":
            out.append("\t")
        elif esc == "v":
            out.append("\v")
        elif esc == "\\":
            out.append("\\")
        elif esc.isdigit():
            oct_digits = esc
            for _ in range(2):
                if i < len(value) and value[i].isdigit():
                    oct_digits += value[i]
                    i += 1
                else:
                    break
            out.append(chr(int(oct_digits, 8)))
        elif esc == "x":
            hex_digits = value[i:i + 2]
            if len(hex_digits) == 2:
                out.append(chr(int(hex_digits, 16)))
                i += 2
            else:
                out.append("x")
        else:
            out.append(esc)
    return "".join(out)


def parse_json_field(value: str | None) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def parse_copy_tables(sql_path: Path, wanted_tables: set[str]) -> dict[str, list[dict[str, str | None]]]:
    rows_by_table: dict[str, list[dict[str, str | None]]] = {table: [] for table in wanted_tables}
    current_table: str | None = None
    current_columns: list[str] = []

    with sql_path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\n")
            if line.startswith("COPY public."):
                prefix, _sep, _suffix = line.partition(" FROM stdin;")
                table_part = prefix.split("COPY public.", 1)[1]
                table_name, column_blob = table_part.split(" (", 1)
                current_table = table_name if table_name in wanted_tables else None
                if current_table:
                    current_columns = [item.strip() for item in column_blob[:-1].split(",")]
                continue

            if current_table and line == r"\.":
                current_table = None
                current_columns = []
                continue

            if not current_table:
                continue

            values = [decode_copy_field(item) for item in line.split("\t")]
            rows_by_table[current_table].append(dict(zip(current_columns, values)))

    return rows_by_table


def import_filename(sql_path: Path, user_label: str) -> str:
    stem = sql_path.stem
    suffix = f"-{user_label}" if user_label else ""
    return f"{stem}{suffix}-lobechat-import.json"


def compute_import_sha(sql_path: Path, user_id: str) -> str:
    stat = sql_path.stat()
    payload = f"{sql_path.resolve()}::{stat.st_size}::{stat.st_mtime_ns}::{user_id}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def content_hash_for_message(role: str, created_at: str | None, text: str) -> str:
    payload = dumps_json({"role": role, "created_at": created_at, "text": text}).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def message_text(row: dict[str, str | None]) -> str:
    return (row.get("content") or "").strip()


def safe_filename(name: str) -> str:
    cleaned = []
    for char in name:
        if char.isalnum() or char in {".", "_", "-", " "}:
            cleaned.append(char)
        else:
            cleaned.append("-")
    value = "".join(cleaned).strip(" .-")
    return value or "attachment.bin"


def unique_blob_path(user_id: str, file_id: str, filename: str) -> str:
    return f"lobechat/{user_id}/{file_id}-{safe_filename(filename)}"


def ensure_import_record(conn: sqlite3.Connection, filename: str, sha256: str) -> int:
    now = utcnow()
    row = conn.execute(
        "SELECT id FROM imports WHERE provider = ? AND sha256 = ? AND original_filename = ? ORDER BY id DESC LIMIT 1",
        (PROVIDER, sha256, filename),
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE imports SET status = ?, error = NULL, finished_at = NULL WHERE id = ?",
            ("processing", int(row["id"])),
        )
        return int(row["id"])

    cursor = conn.execute(
        """
        INSERT INTO imports(filename, original_filename, sha256, provider, parser_version, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (filename, filename, sha256, PROVIDER, "lobechat-user-import-v1", "processing", now),
    )
    row_id = cursor.lastrowid
    if row_id is None:
        raise RuntimeError("Failed to create import record")
    return int(row_id)


def upsert_conversation(conn: sqlite3.Connection, topic: dict[str, str | None], session: dict[str, str | None] | None, import_id: int) -> int:
    provider_topic_id = topic["id"]
    if provider_topic_id is None:
        raise RuntimeError("Topic missing id")

    title = (topic.get("title") or "").strip() or (session.get("title") if session else None) or "Untitled LobeChat conversation"
    created_at = topic.get("created_at")
    updated_at = topic.get("updated_at") or topic.get("accessed_at") or created_at
    metadata = {
        "source": PROVIDER,
        "lobe": {
            "topic_id": provider_topic_id,
            "session_id": topic.get("session_id"),
            "agent_id": topic.get("agent_id"),
            "group_id": topic.get("group_id"),
            "mode": topic.get("mode"),
            "trigger": topic.get("trigger"),
            "favorite": topic.get("favorite") == "t",
            "history_summary": topic.get("history_summary"),
            "metadata": parse_json_field(topic.get("metadata")),
            "editor_data": parse_json_field(topic.get("editor_data")),
            "session": session,
        },
    }
    now = utcnow()
    row = conn.execute(
        "SELECT id FROM conversations WHERE provider = ? AND provider_conversation_id = ?",
        (PROVIDER, provider_topic_id),
    ).fetchone()
    if row:
        conn.execute(
            """
            UPDATE conversations
            SET title = ?, created_at = COALESCE(created_at, ?), updated_at = ?, metadata_json = ?,
                source_import_id = ?, updated_record_at = ?
            WHERE id = ?
            """,
            (title, created_at, updated_at, dumps_json(metadata), import_id, now, int(row["id"])),
        )
        conn.execute("UPDATE messages_fts SET title = ? WHERE conversation_id = ?", (title, int(row["id"])))
        return int(row["id"])

    cursor = conn.execute(
        """
        INSERT INTO conversations(
            provider, provider_conversation_id, title, created_at, updated_at,
            metadata_json, source_import_id, created_record_at, updated_record_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (PROVIDER, provider_topic_id, title, created_at, updated_at, dumps_json(metadata), import_id, now, now),
    )
    row_id = cursor.lastrowid
    if row_id is None:
        raise RuntimeError("Failed to insert conversation")
    return int(row_id)


def insert_message(conn: sqlite3.Connection, conversation_id: int, title: str, row: dict[str, str | None], sequence: int, import_id: int) -> int | None:
    provider_message_id = row.get("id")
    role = (row.get("role") or "unknown").strip().lower() or "unknown"
    text = message_text(row)
    metadata = {
        "source": PROVIDER,
        "lobe": {
            "message_id": provider_message_id,
            "topic_id": row.get("topic_id"),
            "session_id": row.get("session_id"),
            "thread_id": row.get("thread_id"),
            "parent_id": row.get("parent_id"),
            "quota_id": row.get("quota_id"),
            "agent_id": row.get("agent_id"),
            "group_id": row.get("group_id"),
            "target_id": row.get("target_id"),
            "message_group_id": row.get("message_group_id"),
            "favorite": row.get("favorite") == "t",
            "provider": row.get("provider"),
            "error": parse_json_field(row.get("error")),
            "tools": parse_json_field(row.get("tools")),
            "reasoning": parse_json_field(row.get("reasoning")),
            "search": parse_json_field(row.get("search")),
            "metadata": parse_json_field(row.get("metadata")),
            "editor_data": parse_json_field(row.get("editor_data")),
            "summary": row.get("summary"),
        },
    }
    content = {
        "text": text,
        "source": PROVIDER,
        "lobe": {
            "provider": row.get("provider"),
            "model": row.get("model"),
            "trace_id": row.get("trace_id"),
            "observation_id": row.get("observation_id"),
        },
    }
    try:
        cursor = conn.execute(
            """
            INSERT INTO messages(
                conversation_id, provider_message_id, role, author_name, model,
                created_at, sequence, text, content_json, metadata_json, content_hash, source_import_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                conversation_id,
                provider_message_id,
                role,
                None,
                row.get("model"),
                row.get("created_at"),
                sequence,
                text,
                dumps_json(content),
                dumps_json(metadata),
                content_hash_for_message(role, row.get("created_at"), text),
                import_id,
            ),
        )
    except sqlite3.IntegrityError:
        return None

    row_id = cursor.lastrowid
    if row_id is None:
        raise RuntimeError("Failed to insert message")
    message_id = int(row_id)
    conn.execute(
        "INSERT INTO messages_fts(rowid, message_id, conversation_id, title, text, provider, author_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (message_id, message_id, conversation_id, title, text, PROVIDER, ""),
    )
    return message_id


def copy_blob(source_root: Path, relative_source: str, relative_dest: str) -> tuple[bool, str | None]:
    source = (source_root / relative_source).resolve()
    destination = (BLOBS_DIR / relative_dest).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        source.relative_to(source_root.resolve())
        destination.relative_to(BLOBS_DIR.resolve())
    except ValueError:
        return False, None

    if not source.exists() or not source.is_file():
        return False, None

    shutil.copy2(source, destination)
    sha256 = hashlib.sha256(destination.read_bytes()).hexdigest()
    return True, sha256


def insert_attachment(conn: sqlite3.Connection, message_id: int, filename: str, mime_type: str | None, blob_path: str | None, sha256: str | None, metadata: dict[str, Any], import_id: int) -> None:
    conn.execute(
        "INSERT INTO attachments(message_id, filename, mime_type, blob_path, sha256, metadata_json, source_import_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (message_id, filename, mime_type, blob_path, sha256, dumps_json(metadata), import_id),
    )


def insert_source(conn: sqlite3.Connection, import_id: int, kind: str, relative_path: str, sha256: str | None, metadata: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO sources(import_id, kind, relative_path, sha256, metadata_json) VALUES (?, ?, ?, ?, ?)",
        (import_id, kind, relative_path, sha256, dumps_json(metadata)),
    )


def main() -> None:
    args = parse_args()
    sql_path = Path(args.dump).expanduser().resolve()
    blob_root = Path(args.blob_root).expanduser().resolve()
    user_id = args.user_id

    init_db()

    wanted_tables = {"users", "sessions", "topics", "messages", "files", "messages_files", "documents"}
    tables = parse_copy_tables(sql_path, wanted_tables)

    user_row = next((row for row in tables["users"] if row.get("id") == user_id), None)
    if user_row is None:
        raise SystemExit(f"User {user_id} not found in {sql_path}")

    username = (user_row.get("username") or user_row.get("email") or user_id).strip()
    label = args.label.strip() or username
    filename = import_filename(sql_path, label)
    import_sha = compute_import_sha(sql_path, user_id)

    sessions_by_id = {row["id"]: row for row in tables["sessions"] if row.get("user_id") == user_id and row.get("id")}
    topics = [row for row in tables["topics"] if row.get("user_id") == user_id and row.get("id")]
    topics_by_id = {row["id"]: row for row in topics if row.get("id")}
    messages = [row for row in tables["messages"] if row.get("user_id") == user_id and row.get("topic_id") in topics_by_id]
    files_by_id = {row["id"]: row for row in tables["files"] if row.get("user_id") == user_id and row.get("id")}
    message_file_rows = [row for row in tables["messages_files"] if row.get("user_id") == user_id]
    documents_by_file_id = {
        row["file_id"]: row
        for row in tables["documents"]
        if row.get("user_id") == user_id and row.get("file_id")
    }

    attachments_by_message: dict[str, list[dict[str, str | None]]] = defaultdict(list)
    referenced_file_ids: set[str] = set()
    for row in message_file_rows:
        message_id = row.get("message_id")
        file_id = row.get("file_id")
        if not message_id or not file_id or file_id not in files_by_id:
            continue
        attachments_by_message[message_id].append(files_by_id[file_id])
        referenced_file_ids.add(file_id)

    messages_by_topic: dict[str, list[dict[str, str | None]]] = defaultdict(list)
    for row in messages:
        topic_id = row.get("topic_id")
        if topic_id:
            messages_by_topic[topic_id].append(row)

    topic_order = sorted(
        topics,
        key=lambda row: ((row.get("created_at") or ""), (row.get("updated_at") or ""), row.get("id") or ""),
    )
    for topic_rows in messages_by_topic.values():
        topic_rows.sort(key=lambda row: ((row.get("created_at") or ""), row.get("id") or ""))

    imported_conversations = 0
    inserted_messages = 0
    duplicate_messages = 0
    inserted_attachments = 0
    copied_blobs = 0
    missing_blobs = 0
    copied_blob_sources: set[str] = set()

    with connect() as conn:
        import_id = ensure_import_record(conn, filename, import_sha)
        conn.commit()

        for topic in topic_order:
            topic_id = topic.get("id")
            if not topic_id or topic_id not in messages_by_topic:
                continue
            session = sessions_by_id.get(topic.get("session_id")) if topic.get("session_id") else None
            conversation_id = upsert_conversation(conn, topic, session, import_id)
            imported_conversations += 1
            title = (topic.get("title") or "").strip() or (session.get("title") if session else None) or "Untitled LobeChat conversation"

            for sequence, message_row in enumerate(messages_by_topic[topic_id], start=1):
                archive_message_id = insert_message(conn, conversation_id, title, message_row, sequence, import_id)
                if archive_message_id is None:
                    duplicate_messages += 1
                    continue
                inserted_messages += 1

                for file_row in attachments_by_message.get(message_row.get("id") or "", []):
                    file_id = file_row.get("id")
                    filename_value = (file_row.get("name") or "attachment").strip() or "attachment"
                    blob_path = None
                    source_sha = None
                    size_value = file_row.get("size")
                    file_size = int(size_value) if size_value and str(size_value).isdigit() else None
                    metadata = {
                        "source": PROVIDER,
                        "file_type": file_row.get("file_type"),
                        "file_size": file_size,
                        "lobe_file_id": file_id,
                        "lobe_user_id": user_id,
                        "lobe_storage_path": file_row.get("url"),
                        "lobe_file_metadata": parse_json_field(file_row.get("metadata")),
                    }
                    document_row = documents_by_file_id.get(file_id) if file_id else None
                    if document_row:
                        metadata["extracted_content"] = document_row.get("content")
                        metadata["document_title"] = document_row.get("title")
                        metadata["document_description"] = document_row.get("description")
                        metadata["document_metadata"] = parse_json_field(document_row.get("metadata"))

                    source_relative = (file_row.get("url") or "").strip()
                    if file_id and source_relative:
                        blob_path = unique_blob_path(user_id, file_id, filename_value)
                        copied, source_sha = copy_blob(blob_root, source_relative, blob_path)
                        if copied:
                            copied_blobs += 1
                            if blob_path not in copied_blob_sources:
                                insert_source(
                                    conn,
                                    import_id,
                                    "blob",
                                    blob_path,
                                    source_sha,
                                    {
                                        "filename": filename_value,
                                        "mime_type": file_row.get("file_type"),
                                        "original_storage_path": source_relative,
                                        "lobe_file_id": file_id,
                                    },
                                )
                                copied_blob_sources.add(blob_path)
                        else:
                            blob_path = None
                            missing_blobs += 1

                    insert_attachment(
                        conn,
                        archive_message_id,
                        filename_value,
                        file_row.get("file_type"),
                        blob_path,
                        source_sha or file_row.get("file_hash"),
                        metadata,
                        import_id,
                    )
                    inserted_attachments += 1

        warnings: list[str] = []
        if missing_blobs:
            warnings.append(f"{missing_blobs} referenced blob(s) were not found in the backup storage tree.")

        summary = {
            "user_id": user_id,
            "username": username,
            "conversation_count": imported_conversations,
            "message_count": inserted_messages + duplicate_messages,
            "inserted_messages": inserted_messages,
            "duplicate_messages": duplicate_messages,
            "attachment_count": inserted_attachments,
            "inserted_attachments": inserted_attachments,
            "copied_blobs": copied_blobs,
            "missing_blobs": missing_blobs,
            "topics_in_dump": len(topics),
            "messages_in_dump": len(messages),
            "referenced_files": len(referenced_file_ids),
        }
        conn.execute(
            """
            UPDATE imports
            SET provider = ?, parser_version = ?, status = ?, warning_count = ?, warnings_json = ?, summary_json = ?, finished_at = ?, error = NULL
            WHERE id = ?
            """,
            (
                PROVIDER,
                "lobechat-user-import-v1",
                "completed",
                len(warnings),
                dumps_json(warnings),
                dumps_json(summary),
                utcnow(),
                import_id,
            ),
        )
        conn.commit()

    print(json.dumps(
        {
            "ok": True,
            "provider": PROVIDER,
            "user_id": user_id,
            "username": username,
            "topics": len(topics),
            "messages": len(messages),
            "referenced_files": len(referenced_file_ids),
            "imported_conversations": imported_conversations,
            "inserted_messages": inserted_messages,
            "duplicate_messages": duplicate_messages,
            "inserted_attachments": inserted_attachments,
            "copied_blobs": copied_blobs,
            "missing_blobs": missing_blobs,
        },
        indent=2,
    ))


if __name__ == "__main__":
    main()
