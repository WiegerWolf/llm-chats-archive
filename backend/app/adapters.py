from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zipfile import ZipFile


class ImportParseError(Exception):
    pass


def parse_export(export_path: Path) -> dict[str, Any]:
    provider = detect_provider(export_path)
    if provider == "kimi":
        return parse_kimi_capture_bundle(export_path)
    if provider == "claude":
        return parse_claude_export(export_path)
    if provider == "chatgpt":
        return parse_chatgpt_export(export_path)
    if provider == "gemini":
        return parse_gemini_export(export_path)
    raise ImportParseError("Could not recognize this export format.")


def detect_provider(export_path: Path) -> str:
    lower_name = export_path.name.lower()
    if export_path.suffix.lower() == ".zip":
        with ZipFile(export_path) as archive:
            names = [name.lower() for name in archive.namelist()]
            if all(name in names for name in ("users.json", "projects.json", "conversations.json")):
                document = load_named_json_from_zip(export_path, "conversations.json")
                if looks_like_claude(document):
                    return "claude"
            if any("gemini" in name or "bard" in name for name in names):
                return "gemini"
            documents = list(iter_json_documents(export_path))
            if any(looks_like_claude(doc) for _, doc in documents):
                return "claude"
            if any(looks_like_chatgpt(doc) for _, doc in documents):
                return "chatgpt"
            if any(looks_like_gemini(doc) for _, doc in documents):
                return "gemini"
    if export_path.suffix.lower() == ".json" or lower_name.endswith(".json"):
        document = load_json_file(export_path)
        if looks_like_kimi_capture_bundle(document):
            return "kimi"
        if looks_like_claude(document) or "claude" in lower_name or "anthropic" in lower_name:
            return "claude"
        if looks_like_chatgpt(document):
            return "chatgpt"
        if looks_like_gemini(document) or "gemini" in lower_name or "bard" in lower_name:
            return "gemini"
    return "unknown"


def parse_kimi_capture_bundle(export_path: Path) -> dict[str, Any]:
    payload = load_json_file(export_path)
    if not looks_like_kimi_capture_bundle(payload):
        raise ImportParseError("Kimi capture bundle is missing required fields.")

    history_index = build_kimi_history_index(payload)
    chats = payload.get("chats") or []
    if not isinstance(chats, list):
        raise ImportParseError("Kimi capture bundle did not contain a chat list.")

    normalized: list[dict[str, Any]] = []
    warnings: list[str] = []
    message_total = 0
    attachment_total = 0

    for index, chat_entry in enumerate(chats, start=1):
        if not isinstance(chat_entry, dict):
            warnings.append(f"Skipped Kimi chat #{index}: unsupported structure.")
            continue

        chat_id = str(chat_entry.get("chat_id") or "").strip()
        raw_history = chat_entry.get("history")
        history: dict[str, Any] = raw_history if isinstance(raw_history, dict) else history_index.get(chat_id, {})
        raw_messages = extract_kimi_capture_messages(chat_entry)

        messages: list[dict[str, Any]] = []
        for raw_message in raw_messages:
            if not isinstance(raw_message, dict):
                continue
            normalized_message = normalize_kimi_message(raw_message)
            if normalized_message is None:
                continue
            messages.append(normalized_message)

        messages.sort(key=lambda item: item.get("created_at") or "")
        for sequence, message in enumerate(messages, start=1):
            message["sequence"] = sequence

        if not messages:
            preview_text = str(history.get("preview_text") or "").strip()
            if preview_text:
                messages.append(
                    {
                        "provider_message_id": stable_hash(f"kimi-preview:{chat_id or index}"),
                        "role": "assistant",
                        "author_name": "Kimi",
                        "model": None,
                        "created_at": iso_timestamp(history.get("date_label")),
                        "text": preview_text,
                        "content": {"preview_text": preview_text},
                        "metadata": {"source": "kimi_history_preview"},
                        "attachments": normalize_kimi_history_attachments(history),
                        "sequence": 1,
                    }
                )
            else:
                warnings.append(f"Skipped Kimi chat {chat_id or index}: no messages found.")
                continue

        title = kimi_chat_title(chat_entry, history, index)
        created_at = kimi_chat_timestamp(chat_entry, history, ["created_at", "create_time", "created"])
        updated_at = kimi_chat_timestamp(chat_entry, history, ["updated_at", "update_time", "updated", "modified_at"])

        normalized.append(
            {
                "provider": "kimi",
                "provider_conversation_id": chat_id or stable_hash(f"kimi:{title}:{index}"),
                "title": title,
                "created_at": created_at or messages[0].get("created_at"),
                "updated_at": updated_at or messages[-1].get("created_at"),
                "metadata": {
                    "history_group": history.get("group_label"),
                    "history_date": history.get("date_label"),
                    "preview_text": history.get("preview_text"),
                    "source": "kimi",
                },
                "messages": messages,
            }
        )
        message_total += len(messages)
        attachment_total += sum(len(message.get("attachments") or []) for message in messages)

    if not normalized:
        raise ImportParseError("Kimi capture bundle was recognized, but no conversations could be parsed.")

    return {
        "provider": "kimi",
        "parser_version": "kimi:v1",
        "conversations": normalized,
        "warnings": warnings,
        "summary": {
            "conversation_count": len(normalized),
            "message_count": message_total,
            "attachment_count": attachment_total,
        },
    }


def parse_claude_export(export_path: Path) -> dict[str, Any]:
    conversations = load_claude_conversations(export_path)
    if not isinstance(conversations, list):
        raise ImportParseError("Claude export did not contain a conversation list.")

    normalized: list[dict[str, Any]] = []
    warnings: list[str] = []
    message_total = 0
    attachment_total = 0

    for index, conversation in enumerate(conversations, start=1):
        if not isinstance(conversation, dict):
            warnings.append(f"Skipped Claude conversation #{index}: unsupported structure.")
            continue

        raw_messages = conversation.get("chat_messages") or []
        if not isinstance(raw_messages, list):
            warnings.append(f"Skipped Claude conversation #{index}: missing chat_messages list.")
            continue

        messages: list[dict[str, Any]] = []
        for raw_message in raw_messages:
            if not isinstance(raw_message, dict):
                continue

            text = flatten_claude_message(raw_message)
            attachments = extract_claude_attachments(raw_message)
            if not text.strip() and not attachments:
                continue

            messages.append(
                {
                    "provider_message_id": raw_message.get("uuid"),
                    "role": normalize_role(raw_message.get("sender")),
                    "author_name": claude_author_name(raw_message.get("sender")),
                    "model": None,
                    "created_at": iso_timestamp(raw_message.get("created_at")),
                    "text": text.strip() or format_attachment_lines(attachments),
                    "content": {
                        "text": raw_message.get("text"),
                        "blocks": raw_message.get("content") or [],
                    },
                    "metadata": {
                        "sender": raw_message.get("sender"),
                        "updated_at": iso_timestamp(raw_message.get("updated_at")),
                    },
                    "attachments": attachments,
                }
            )

        messages.sort(key=lambda item: item.get("created_at") or "")
        for sequence, message in enumerate(messages, start=1):
            message["sequence"] = sequence

        if not messages:
            continue

        normalized.append(
            {
                "provider": "claude",
                "provider_conversation_id": conversation.get("uuid") or stable_hash(f"claude:{index}"),
                "title": normalize_claude_title(conversation, index),
                "created_at": iso_timestamp(conversation.get("created_at")) or messages[0].get("created_at"),
                "updated_at": iso_timestamp(conversation.get("updated_at")) or messages[-1].get("created_at"),
                "metadata": {
                    "account_uuid": extract_nested(conversation, ["account", "uuid"]),
                    "summary": conversation.get("summary") or "",
                    "source": "claude",
                },
                "messages": messages,
            }
        )
        message_total += len(messages)
        attachment_total += sum(len(message.get("attachments") or []) for message in messages)

    if not normalized:
        raise ImportParseError("Claude export was recognized, but no conversations could be parsed.")

    return {
        "provider": "claude",
        "parser_version": "claude:v1",
        "conversations": normalized,
        "warnings": warnings,
        "summary": {
            "conversation_count": len(normalized),
            "message_count": message_total,
            "attachment_count": attachment_total,
        },
    }


def parse_chatgpt_export(export_path: Path) -> dict[str, Any]:
    payload = load_chatgpt_payload(export_path)
    if isinstance(payload, dict):
        conversations = payload.get("conversations") or payload.get("items") or []
    else:
        conversations = payload
    if not isinstance(conversations, list):
        raise ImportParseError("ChatGPT export did not contain a conversation list.")

    normalized: list[dict[str, Any]] = []
    warnings: list[str] = []
    message_total = 0

    for index, conversation in enumerate(conversations, start=1):
        if not isinstance(conversation, dict):
            warnings.append(f"Skipped ChatGPT conversation #{index}: unsupported structure.")
            continue

        mapping = conversation.get("mapping") or {}
        if not isinstance(mapping, dict):
            warnings.append(f"Skipped ChatGPT conversation #{index}: missing mapping.")
            continue

        messages: list[dict[str, Any]] = []
        for node in mapping.values():
            if not isinstance(node, dict):
                continue
            message = node.get("message") or {}
            if not isinstance(message, dict):
                continue

            author = message.get("author") or {}
            content = message.get("content") or {}
            role = normalize_role(author.get("role") or author.get("name"))
            text = flatten_text(content)

            if not text.strip() and role not in {"system", "tool"}:
                continue

            metadata = message.get("metadata") or {}
            messages.append(
                {
                    "provider_message_id": message.get("id") or node.get("id"),
                    "role": role,
                    "author_name": author.get("name") if isinstance(author, dict) else None,
                    "model": metadata.get("model_slug") or metadata.get("default_model_slug"),
                    "created_at": iso_timestamp(message.get("create_time")),
                    "text": text.strip(),
                    "content": content,
                    "metadata": metadata,
                }
            )

        messages.sort(key=lambda item: item.get("created_at") or "")
        for sequence, message in enumerate(messages, start=1):
            message["sequence"] = sequence

        if not messages:
            continue

        normalized.append(
            {
                "provider": "chatgpt",
                "provider_conversation_id": conversation.get("id")
                or stable_hash(f"chatgpt:{conversation.get('title')}:{index}"),
                "title": (conversation.get("title") or "Untitled conversation").strip() or "Untitled conversation",
                "created_at": iso_timestamp(conversation.get("create_time")) or messages[0].get("created_at"),
                "updated_at": iso_timestamp(conversation.get("update_time")) or messages[-1].get("created_at"),
                "metadata": {
                    "conversation_template_id": conversation.get("conversation_template_id"),
                    "source": "chatgpt",
                },
                "messages": messages,
            }
        )
        message_total += len(messages)

    return {
        "provider": "chatgpt",
        "parser_version": "chatgpt:v1",
        "conversations": normalized,
        "warnings": warnings,
        "summary": {
            "conversation_count": len(normalized),
            "message_count": message_total,
        },
    }


def parse_gemini_export(export_path: Path) -> dict[str, Any]:
    normalized: list[dict[str, Any]] = []
    warnings: list[str] = []
    message_total = 0

    documents = list(iter_json_documents(export_path))
    if not documents and export_path.suffix.lower() == ".json":
        documents = [(export_path.name, load_json_file(export_path))]

    if not documents:
        raise ImportParseError("No JSON documents were found in this Gemini export.")

    for source_name, document in documents:
        for index, conversation in enumerate(extract_conversations(document, source_name), start=1):
            messages = parse_generic_messages(conversation)
            if not messages:
                continue
            for sequence, message in enumerate(messages, start=1):
                message["sequence"] = sequence

            title = (
                extract_first(conversation, ["title", "name", "label"])
                or title_from_filename(source_name)
            )
            normalized.append(
                {
                    "provider": "gemini",
                    "provider_conversation_id": extract_first(
                        conversation,
                        ["id", "conversation_id", "chat_id", "uuid"],
                    )
                    or stable_hash(f"gemini:{source_name}:{title}:{index}"),
                    "title": title,
                    "created_at": extract_timestamp(conversation, ["created_at", "create_time", "created", "ctime"])
                    or messages[0].get("created_at"),
                    "updated_at": extract_timestamp(
                        conversation,
                        ["updated_at", "update_time", "modified_at", "last_modified", "mtime"],
                    )
                    or messages[-1].get("created_at"),
                    "metadata": {"source_file": source_name, "source": "gemini"},
                    "messages": messages,
                }
            )
            message_total += len(messages)

    if not normalized:
        raise ImportParseError("Gemini export was recognized, but no conversation records could be parsed.")

    return {
        "provider": "gemini",
        "parser_version": "gemini:v1",
        "conversations": normalized,
        "warnings": warnings,
        "summary": {
            "conversation_count": len(normalized),
            "message_count": message_total,
        },
    }


def iter_json_documents(export_path: Path) -> list[tuple[str, Any]]:
    if export_path.suffix.lower() == ".json":
        return [(export_path.name, load_json_file(export_path))]

    documents: list[tuple[str, Any]] = []
    if export_path.suffix.lower() != ".zip":
        return documents

    with ZipFile(export_path) as archive:
        for name in archive.namelist():
            if not name.lower().endswith(".json"):
                continue
            with archive.open(name) as handle:
                documents.append((name, json.load(handle)))
    return documents


def load_chatgpt_payload(export_path: Path) -> Any:
    if export_path.suffix.lower() == ".zip":
        with ZipFile(export_path) as archive:
            for name in archive.namelist():
                if name.lower().endswith("conversations.json"):
                    with archive.open(name) as handle:
                        return json.load(handle)
        raise ImportParseError("ChatGPT export zip did not contain conversations.json.")
    return load_json_file(export_path)


def load_claude_conversations(export_path: Path) -> Any:
    if export_path.suffix.lower() == ".zip":
        return load_named_json_from_zip(export_path, "conversations.json")
    return load_json_file(export_path)


def load_named_json_from_zip(export_path: Path, target_name: str) -> Any:
    target_name = target_name.lower()
    with ZipFile(export_path) as archive:
        for name in archive.namelist():
            if name.lower().endswith(target_name):
                with archive.open(name) as handle:
                    return json.load(handle)
    raise ImportParseError(f"Export zip did not contain {target_name}.")


def load_json_file(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def looks_like_kimi_capture_bundle(document: Any) -> bool:
    return (
        isinstance(document, dict)
        and str(document.get("provider") or "").strip().lower() == "kimi"
        and isinstance(document.get("chats"), list)
    )


def build_kimi_history_index(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    history_groups = payload.get("history_groups")
    if not isinstance(history_groups, list):
        return index

    for group in history_groups:
        if not isinstance(group, dict):
            continue
        group_label = str(group.get("label") or "").strip()
        items = group.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            chat_id = str(item.get("chat_id") or "").strip()
            if not chat_id:
                continue
            indexed_item = dict(item)
            if group_label and not indexed_item.get("group_label"):
                indexed_item["group_label"] = group_label
            index[chat_id] = indexed_item
    return index


def extract_kimi_capture_messages(chat_entry: dict[str, Any]) -> list[dict[str, Any]]:
    direct_messages = chat_entry.get("messages")
    if isinstance(direct_messages, list) and any(isinstance(item, dict) for item in direct_messages):
        return [item for item in direct_messages if isinstance(item, dict)]

    pages = chat_entry.get("message_pages") or chat_entry.get("messages_pages") or chat_entry.get("list_messages_pages")
    if not isinstance(pages, list):
        return []

    candidates: list[dict[str, Any]] = []
    for page in pages:
        collect_kimi_message_candidates(page, candidates)

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(extract_first(candidate, ["message_id", "msg_id", "id", "uuid"]) or "").strip()
        if not key:
            key = stable_hash(dumps_json_safe(candidate))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def collect_kimi_message_candidates(value: Any, output: list[dict[str, Any]]) -> None:
    if isinstance(value, dict):
        if is_likely_kimi_message(value):
            output.append(value)
        for nested in value.values():
            collect_kimi_message_candidates(nested, output)
    elif isinstance(value, list):
        for item in value:
            collect_kimi_message_candidates(item, output)


def is_likely_kimi_message(candidate: dict[str, Any]) -> bool:
    keys = set(candidate.keys())
    if not keys:
        return False
    if {"file_name", "url"}.issubset(keys) or {"src", "alt"}.issubset(keys):
        return False
    if "chat_id" in keys and len(keys) <= 3:
        return False

    has_role = bool(keys & {"role", "sender", "sender_type", "message_type", "is_bot", "is_user"})
    has_text = bool(keys & {"text", "content", "contents", "parts", "segments", "answer", "query", "markdown", "display_content"})
    has_id = bool(keys & {"message_id", "msg_id", "id", "uuid"})
    has_time = bool(keys & {"created_at", "updated_at", "timestamp", "time"})
    return (has_role and has_text) or (has_id and has_text) or (has_id and has_time and has_role)


def normalize_kimi_message(raw_message: dict[str, Any]) -> dict[str, Any] | None:
    text = flatten_kimi_message_text(raw_message)
    attachments = extract_kimi_attachments(raw_message)
    if not text and not attachments:
        return None

    role = normalize_kimi_role(raw_message)
    author_name = "You" if role == "user" else "Kimi" if role == "assistant" else None
    metadata: dict[str, Any] = {}
    for key in ("updated_at", "status", "message_type", "sender", "sender_type"):
        value = raw_message.get(key)
        if value not in (None, ""):
            metadata[key] = value

    return {
        "provider_message_id": extract_first(raw_message, ["message_id", "msg_id", "id", "uuid"]),
        "role": role,
        "author_name": author_name,
        "model": extract_first(raw_message, ["model", "model_name"]),
        "created_at": extract_timestamp(raw_message, ["created_at", "create_time", "timestamp", "time", "updated_at"]),
        "text": text or format_attachment_lines(attachments),
        "content": raw_message,
        "metadata": metadata,
        "attachments": attachments,
    }


def normalize_kimi_role(raw_message: dict[str, Any]) -> str:
    if raw_message.get("is_user") is True:
        return "user"
    if raw_message.get("is_bot") is True:
        return "assistant"
    for key in ("role", "sender", "sender_type", "message_type"):
        value = raw_message.get(key)
        normalized = str(value or "").strip().lower()
        if normalized in {"user", "human", "prompt", "questioner"}:
            return "user"
        if normalized in {"assistant", "bot", "kimi", "model", "answer"}:
            return "assistant"
        if normalized in {"system", "developer"}:
            return "system"
        if normalized in {"tool", "function"}:
            return "tool"
    return "unknown"


def flatten_kimi_message_text(raw_message: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("text", "display_content", "markdown", "summary", "answer", "query"):
        value = raw_message.get(key)
        if value in (None, ""):
            continue
        rendered = flatten_kimi_value(value)
        if rendered:
            parts.append(rendered)

    for key in ("content", "contents", "parts", "segments", "message", "body"):
        value = raw_message.get(key)
        if value in (None, ""):
            continue
        rendered = flatten_kimi_value(value)
        if rendered:
            parts.append(rendered)

    unique_parts: list[str] = []
    seen: set[str] = set()
    for part in parts:
        if part not in seen:
            seen.add(part)
            unique_parts.append(part)
    return "\n\n".join(unique_parts).strip()


def flatten_kimi_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = [flatten_kimi_value(item) for item in value]
        return "\n\n".join(part for part in parts if part).strip()
    if isinstance(value, dict):
        value_type = str(value.get("type") or "").strip().lower()
        if value_type in {"image", "file", "audio", "video"}:
            label = str(value.get("filename") or value.get("name") or value.get("title") or "").strip()
            return label

        parts: list[str] = []
        for key in ("text", "markdown", "content", "display_content", "summary", "answer", "query", "body", "value"):
            nested = value.get(key)
            if nested in (None, ""):
                continue
            rendered = flatten_kimi_value(nested)
            if rendered:
                parts.append(rendered)
        for key in ("contents", "parts", "segments", "children"):
            nested = value.get(key)
            if nested in (None, ""):
                continue
            rendered = flatten_kimi_value(nested)
            if rendered:
                parts.append(rendered)

        unique_parts: list[str] = []
        seen: set[str] = set()
        for part in parts:
            if part not in seen:
                seen.add(part)
                unique_parts.append(part)
        return "\n\n".join(unique_parts).strip()
    return ""


def extract_kimi_attachments(raw_message: dict[str, Any]) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    seen: set[str] = set()

    direct_attachments = raw_message.get("attachments")
    if isinstance(direct_attachments, list):
        for attachment in direct_attachments:
            if not isinstance(attachment, dict):
                continue
            filename = str(attachment.get("filename") or attachment.get("file_name") or "attachment").strip() or "attachment"
            source_url = extract_nested(attachment, ["metadata", "source_url"]) or attachment.get("source_url")
            key = str(source_url or filename).strip()
            if key in seen:
                continue
            seen.add(key)
            metadata = attachment.get("metadata") if isinstance(attachment.get("metadata"), dict) else {}
            collected.append(
                {
                    "filename": filename,
                    "mime_type": attachment.get("mime_type"),
                    "blob_path": attachment.get("blob_path"),
                    "sha256": attachment.get("sha256"),
                    "metadata": metadata,
                }
            )

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            url = extract_first(value, ["url", "src", "image_url", "download_url", "file_url", "thumbnail_url", "thumb_url"])
            filename = extract_first(value, ["filename", "file_name", "name", "title"])
            mime_type = extract_first(value, ["mime_type", "content_type"])
            if isinstance(url, str) and url.strip():
                source_url = url.strip()
                attachment_key = source_url
                if attachment_key not in seen:
                    seen.add(attachment_key)
                    guessed_name = str(filename or source_url.rsplit("/", 1)[-1].split("?", 1)[0] or "attachment").strip()
                    collected.append(
                        {
                            "filename": guessed_name or "attachment",
                            "mime_type": str(mime_type).strip() if mime_type not in (None, "") else None,
                            "blob_path": None,
                            "sha256": None,
                            "metadata": {
                                "source": "kimi_remote_attachment",
                                "source_url": source_url,
                            },
                        }
                    )
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    attachment_lists = []
    for key in ("attachments", "files", "images"):
        nested = raw_message.get(key)
        if nested not in (None, ""):
            attachment_lists.append(nested)
    if not attachment_lists:
        attachment_lists.append(raw_message)
    for nested in attachment_lists:
        visit(nested)
    return collected


def normalize_kimi_history_attachments(history: dict[str, Any]) -> list[dict[str, Any]]:
    attachments = history.get("attachments")
    if not isinstance(attachments, list):
        return []

    normalized: list[dict[str, Any]] = []
    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        source_url = str(attachment.get("url") or "").strip()
        filename = str(attachment.get("filename") or attachment.get("type") or "attachment").strip() or "attachment"
        normalized.append(
            {
                "filename": filename,
                "mime_type": None,
                "blob_path": None,
                "sha256": None,
                "metadata": {
                    "source": "kimi_history_attachment",
                    "source_url": source_url or None,
                },
            }
        )
    return normalized


def kimi_chat_title(chat_entry: dict[str, Any], history: dict[str, Any], index: int) -> str:
    for candidate in (
        history.get("title"),
        chat_entry.get("title"),
        extract_first(chat_entry, ["name", "subject"]),
        extract_nested(chat_entry, ["chat", "title"]),
        extract_nested(chat_entry, ["chat", "name"]),
        extract_nested(chat_entry, ["get_chat", "title"]),
        extract_nested(chat_entry, ["get_chat", "name"]),
    ):
        title = str(candidate or "").strip()
        if title:
            return title
    return f"Kimi conversation {index}"


def kimi_chat_timestamp(chat_entry: dict[str, Any], history: dict[str, Any], keys: list[str]) -> str | None:
    raw_chat_payload = chat_entry.get("chat")
    raw_get_chat_payload = chat_entry.get("get_chat")
    chat_payload: dict[str, Any] = raw_chat_payload if isinstance(raw_chat_payload, dict) else {}
    get_chat_payload: dict[str, Any] = raw_get_chat_payload if isinstance(raw_get_chat_payload, dict) else {}
    for candidate in (
        extract_first(chat_entry, keys),
        extract_first(chat_payload, keys),
        extract_first(get_chat_payload, keys),
        extract_first(history, keys),
    ):
        timestamp = iso_timestamp(candidate)
        if timestamp:
            return timestamp
    return None


def dumps_json_safe(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def looks_like_chatgpt(document: Any) -> bool:
    if isinstance(document, list) and document:
        first = document[0]
        return isinstance(first, dict) and "mapping" in first
    if isinstance(document, dict):
        conversations = document.get("conversations")
        return isinstance(conversations, list) and bool(conversations) and isinstance(conversations[0], dict) and "mapping" in conversations[0]
    return False


def looks_like_claude(document: Any) -> bool:
    if isinstance(document, list) and document and isinstance(document[0], dict):
        first = document[0]
        return "chat_messages" in first and "uuid" in first and "created_at" in first
    return False


def looks_like_gemini(document: Any) -> bool:
    if isinstance(document, dict) and any(key in document for key in ("conversations", "chats", "threads", "messages", "turns")):
        return True
    if isinstance(document, list) and document and isinstance(document[0], dict):
        first = document[0]
        return any(key in first for key in ("messages", "turns", "entries", "contents", "author", "role"))
    return False


def extract_conversations(document: Any, source_name: str) -> list[dict[str, Any]]:
    if isinstance(document, dict):
        for key in ("conversations", "chats", "threads", "items"):
            value = document.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        if looks_like_conversation(document):
            return [document]
        for key in ("messages", "turns", "entries", "contents"):
            value = document.get(key)
            if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
                return [{"title": title_from_filename(source_name), key: value}]
    if isinstance(document, list) and document and all(isinstance(item, dict) for item in document):
        if any(looks_like_conversation(item) for item in document):
            return [item for item in document if isinstance(item, dict)]
        return [{"title": title_from_filename(source_name), "messages": document}]
    return []


def looks_like_conversation(candidate: Any) -> bool:
    return isinstance(candidate, dict) and any(
        key in candidate for key in ("messages", "turns", "entries", "contents", "events")
    )


def parse_generic_messages(conversation: dict[str, Any]) -> list[dict[str, Any]]:
    messages_raw = []
    for key in ("messages", "turns", "entries", "contents", "events"):
        value = conversation.get(key)
        if isinstance(value, list):
            messages_raw = [item for item in value if isinstance(item, dict)]
            if messages_raw:
                break

    messages: list[dict[str, Any]] = []
    for raw in messages_raw:
        role = normalize_role(
            extract_first(raw, ["role", "sender", "speaker"])
            or extract_nested(raw, ["author", "role"])
            or extract_nested(raw, ["author", "name"])
        )
        author_name = (
            extract_first(raw, ["name", "sender_name"])
            or extract_nested(raw, ["author", "name"])
        )
        text = flatten_text(
            extract_first(raw, ["text", "content", "message", "response", "value"])
            or raw.get("parts")
            or raw.get("segments")
        )
        if not text.strip():
            continue
        raw_metadata = raw.get("metadata")
        metadata: dict[str, Any] = raw_metadata if isinstance(raw_metadata, dict) else {}
        messages.append(
            {
                "provider_message_id": extract_first(raw, ["id", "message_id", "uuid"]),
                "role": role,
                "author_name": author_name,
                "model": extract_first(raw, ["model", "model_slug"]) or metadata.get("model"),
                "created_at": extract_timestamp(
                    raw,
                    ["created_at", "create_time", "timestamp", "time", "updated_at"],
                ),
                "text": text.strip(),
                "content": raw.get("content") if isinstance(raw.get("content"), dict) else {"raw": raw},
                "metadata": metadata,
            }
        )

    messages.sort(key=lambda item: item.get("created_at") or "")
    return messages


def extract_timestamp(candidate: dict[str, Any], keys: list[str]) -> str | None:
    return iso_timestamp(extract_first(candidate, keys))


def extract_first(candidate: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        value = candidate.get(key)
        if value not in (None, ""):
            return value
    return None


def extract_nested(candidate: dict[str, Any], path: list[str]) -> Any:
    current: Any = candidate
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [flatten_text(item).strip() for item in value]
        return "\n\n".join(part for part in parts if part)
    if isinstance(value, dict):
        if "parts" in value:
            return flatten_text(value["parts"])
        if "segments" in value:
            return flatten_text(value["segments"])
        for key in ("text", "result", "output_text", "content", "message", "value"):
            if key in value:
                return flatten_text(value[key])
        return json.dumps(value, ensure_ascii=True, sort_keys=True)
    return str(value)


def normalize_claude_title(conversation: dict[str, Any], index: int) -> str:
    title = str(conversation.get("name") or "").strip()
    if title:
        return title
    return f"Untitled conversation {index}"


def claude_author_name(sender: Any) -> str | None:
    normalized = normalize_role(sender)
    if normalized == "user":
        return "You"
    if normalized == "assistant":
        return "Claude"
    return None


def flatten_claude_message(message: dict[str, Any]) -> str:
    raw_blocks = message.get("content")
    blocks: list[Any] = raw_blocks if isinstance(raw_blocks, list) else []
    message_text = str(message.get("text") or "").strip()
    parts: list[str] = []

    if message_text:
        parts.append(message_text)

    include_text_blocks = not message_text
    for block in blocks:
        if not isinstance(block, dict):
            continue
        rendered = render_claude_block(block, include_text=include_text_blocks)
        if rendered:
            parts.append(rendered)

    if not parts:
        attachment_lines = format_attachment_lines(extract_claude_attachments(message))
        if attachment_lines:
            parts.append(attachment_lines)

    return "\n\n".join(part for part in parts if part).strip()


def render_claude_block(block: dict[str, Any], *, include_text: bool) -> str:
    block_type = str(block.get("type") or "").strip().lower()
    if block_type == "text":
        text = str(block.get("text") or "").strip()
        return text if include_text else ""
    if block_type == "voice_note":
        title = str(block.get("title") or "Voice note").strip()
        text = str(block.get("text") or "").strip()
        return f"{title}\n{text}".strip()
    if block_type == "tool_result":
        name = str(block.get("name") or "tool").strip()
        content = flatten_text(block.get("content")).strip()
        if content:
            return f"Tool result ({name})\n{content}".strip()
        return f"Tool result ({name})"
    if block_type == "tool_use":
        name = str(block.get("name") or "tool").strip()
        input_value = block.get("input")
        if isinstance(input_value, dict):
            command = input_value.get("command")
            target = input_value.get("id") or input_value.get("name")
            details = [str(part) for part in (command, target) if part]
            if details:
                return f"Tool use ({name}): {' - '.join(details)}"
        return f"Tool use ({name})"
    if block_type in {"thinking", "token_budget"}:
        return ""
    return flatten_text(block).strip()


def extract_claude_attachments(message: dict[str, Any]) -> list[dict[str, Any]]:
    extracted: list[dict[str, Any]] = []
    for attachment in message.get("attachments") or []:
        if not isinstance(attachment, dict):
            continue
        filename = str(attachment.get("file_name") or "attachment").strip() or "attachment"
        extracted.append(
            {
                "filename": filename,
                "mime_type": None,
                "blob_path": None,
                "sha256": None,
                "metadata": {
                    "source": "claude_attachment",
                    "file_size": attachment.get("file_size"),
                    "file_type": attachment.get("file_type"),
                    "extracted_content": attachment.get("extracted_content"),
                },
            }
        )
    for file_item in message.get("files") or []:
        if not isinstance(file_item, dict):
            continue
        filename = str(file_item.get("file_name") or "file").strip() or "file"
        extracted.append(
            {
                "filename": filename,
                "mime_type": None,
                "blob_path": None,
                "sha256": None,
                "metadata": {
                    "source": "claude_file_reference",
                },
            }
        )
    return extracted


def format_attachment_lines(attachments: list[dict[str, Any]]) -> str:
    names = [str(item.get("filename") or "").strip() for item in attachments]
    names = [name for name in names if name]
    if not names:
        return ""
    return "Attached files: " + ", ".join(names)


def normalize_role(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"user", "human", "prompt", "customer"}:
        return "user"
    if text in {"assistant", "model", "gemini", "bard", "bot", "chatgpt"}:
        return "assistant"
    if text in {"system", "developer"}:
        return "system"
    if text in {"tool", "function"}:
        return "tool"
    return "unknown"


def iso_timestamp(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    text = str(value).strip()
    try:
        numeric = float(text)
        return datetime.fromtimestamp(numeric, tz=timezone.utc).isoformat()
    except ValueError:
        pass
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except ValueError:
        return text


def stable_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()


def title_from_filename(source_name: str) -> str:
    name = Path(source_name).stem.replace("_", " ").replace("-", " ").strip()
    return name.title() or "Imported conversation"
