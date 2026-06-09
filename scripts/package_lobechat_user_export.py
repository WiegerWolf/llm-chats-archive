#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile


TABLES = {"users", "sessions", "topics", "messages", "files", "messages_files", "documents"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Package one LobeChat user from a Postgres SQL dump and R2 backup.")
    parser.add_argument("--dump", required=True, help="Path to lobechat_full.sql")
    parser.add_argument("--blob-root", required=True, help="Path to the R2 bucket backup root, usually .../r2/lobe-chat-prod")
    parser.add_argument("--user-id", required=True, help="LobeChat user id to package")
    parser.add_argument("--output", required=True, help="Destination .zip path")
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


def parse_copy_tables(sql_path: Path) -> dict[str, list[dict[str, str | None]]]:
    rows_by_table: dict[str, list[dict[str, str | None]]] = {table: [] for table in TABLES}
    current_table: str | None = None
    current_columns: list[str] = []

    with sql_path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\n")
            if line.startswith("COPY public."):
                prefix, _sep, _suffix = line.partition(" FROM stdin;")
                table_part = prefix.split("COPY public.", 1)[1]
                table_name, column_blob = table_part.split(" (", 1)
                current_table = table_name if table_name in TABLES else None
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


def filter_user_rows(tables: dict[str, list[dict[str, str | None]]], user_id: str) -> dict[str, list[dict[str, str | None]]]:
    users = [row for row in tables["users"] if row.get("id") == user_id]
    if not users:
        raise SystemExit(f"User {user_id} was not found in the SQL dump.")

    topics = [row for row in tables["topics"] if row.get("user_id") == user_id and row.get("id")]
    topic_ids = {str(row["id"]) for row in topics if row.get("id")}
    messages = [row for row in tables["messages"] if row.get("user_id") == user_id and row.get("topic_id") in topic_ids]
    message_ids = {str(row["id"]) for row in messages if row.get("id")}

    sessions = [row for row in tables["sessions"] if row.get("user_id") == user_id]
    files = [row for row in tables["files"] if row.get("user_id") == user_id and row.get("id")]
    files_by_id = {str(row["id"]): row for row in files if row.get("id")}

    messages_files = [
        row
        for row in tables["messages_files"]
        if row.get("user_id") == user_id and row.get("message_id") in message_ids and row.get("file_id") in files_by_id
    ]
    referenced_file_ids = {str(row["file_id"]) for row in messages_files if row.get("file_id")}
    referenced_files = [row for row in files if row.get("id") in referenced_file_ids]
    documents = [row for row in tables["documents"] if row.get("user_id") == user_id and row.get("file_id") in referenced_file_ids]

    return {
        "users": users,
        "sessions": sessions,
        "topics": topics,
        "messages": messages,
        "files": referenced_files,
        "messages_files": messages_files,
        "documents": documents,
    }


def archive_blob_path(storage_path: str) -> str:
    return "blobs/" + storage_path.lstrip("/")


def package_export(sql_path: Path, blob_root: Path, output_path: Path, user_id: str) -> dict[str, Any]:
    tables = parse_copy_tables(sql_path)
    rows = filter_user_rows(tables, user_id)
    user = rows["users"][0]
    blob_paths: dict[str, str] = {}
    missing_blobs: list[str] = []
    written_archive_paths: set[str] = set()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output_path, "w", compression=ZIP_DEFLATED) as archive:
        for file_row in rows["files"]:
            file_id = str(file_row.get("id") or "")
            storage_path = str(file_row.get("url") or "").strip()
            if not file_id or not storage_path:
                continue
            source_path = (blob_root / storage_path).resolve()
            try:
                source_path.relative_to(blob_root.resolve())
            except ValueError:
                missing_blobs.append(storage_path)
                continue
            if not source_path.exists() or not source_path.is_file():
                missing_blobs.append(storage_path)
                continue
            packaged_path = archive_blob_path(storage_path)
            if packaged_path not in written_archive_paths:
                archive.write(source_path, packaged_path)
                written_archive_paths.add(packaged_path)
            blob_paths[file_id] = packaged_path

        manifest = {
            "format": "lobechat-user-export",
            "version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "user_id": user_id,
            "username": user.get("username"),
            "email": user.get("email"),
            "source": {
                "sql_dump": str(sql_path),
                "blob_root": str(blob_root),
            },
            "rows": rows,
            "blob_paths": blob_paths,
            "summary": {
                "topic_count": len(rows["topics"]),
                "message_count": len(rows["messages"]),
                "file_count": len(rows["files"]),
                "message_file_count": len(rows["messages_files"]),
                "document_count": len(rows["documents"]),
                "missing_blob_count": len(missing_blobs),
                "missing_blobs": missing_blobs,
            },
        }
        archive.writestr("lobechat_export.json", json.dumps(manifest, ensure_ascii=False, sort_keys=True))

    return manifest["summary"]


def main() -> None:
    args = parse_args()
    summary = package_export(
        Path(args.dump).expanduser().resolve(),
        Path(args.blob_root).expanduser().resolve(),
        Path(args.output).expanduser().resolve(),
        args.user_id,
    )
    print(json.dumps({"ok": True, "output": str(Path(args.output).expanduser().resolve()), "summary": summary}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
