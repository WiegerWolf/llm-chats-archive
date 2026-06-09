from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import re
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from zipfile import ZipFile, ZipInfo

from .db import BLOBS_DIR


class ImportParseError(Exception):
    pass


def parse_export(export_path: Path) -> dict[str, Any]:
    provider = detect_provider(export_path)
    if provider == "pi":
        return parse_pi_export(export_path)
    if provider == "kimi":
        return parse_kimi_capture_bundle(export_path)
    if provider == "claude":
        return parse_claude_export(export_path)
    if provider == "chatgpt":
        return parse_chatgpt_export(export_path)
    if provider == "googleaistudio":
        return parse_google_ai_studio_export(export_path)
    if provider == "gemini":
        return parse_gemini_export(export_path)
    raise ImportParseError("Could not recognize this export format.")


def detect_provider(export_path: Path) -> str:
    lower_name = export_path.name.lower()
    if export_path.suffix.lower() == ".zip":
        if looks_like_google_ai_studio_archive(export_path):
            return "googleaistudio"
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
        if looks_like_pi_export(document):
            return "pi"
        if looks_like_kimi_capture_bundle(document):
            return "kimi"
        if looks_like_google_ai_studio_document(document):
            return "googleaistudio"
        if looks_like_claude(document) or "claude" in lower_name or "anthropic" in lower_name:
            return "claude"
        if looks_like_chatgpt(document):
            return "chatgpt"
        if looks_like_gemini(document) or "gemini" in lower_name or "bard" in lower_name:
            return "gemini"
    return "unknown"


def parse_pi_export(export_path: Path) -> dict[str, Any]:
    payload = load_json_file(export_path)
    if not looks_like_pi_export(payload):
        raise ImportParseError("Pi export did not contain a recognizable user history document.")

    user_data = payload.get("user_data") or {}
    details = user_data.get("details") or {}
    raw_messages = user_data.get("messages") or []
    if not isinstance(raw_messages, list):
        raise ImportParseError("Pi export did not contain a message list.")

    warnings: list[str] = []
    messages: list[dict[str, Any]] = []

    for index, raw_message in enumerate(raw_messages, start=1):
        if not isinstance(raw_message, dict):
            warnings.append(f"Skipped Pi message #{index}: unsupported structure.")
            continue

        text = str(raw_message.get("text") or "").strip()
        if not text:
            continue

        sender = str(raw_message.get("sender") or "").strip()
        role = normalize_role(sender)
        sent_at = iso_timestamp(raw_message.get("sent_at"))
        messages.append(
            {
                "provider_message_id": stable_hash(
                    f"pi:{export_path.name}:{index}:{sender}:{raw_message.get('sent_at')}:{text}"
                ),
                "role": role,
                "author_name": pi_author_name(sender),
                "model": fallback_assistant_model("pi", role),
                "created_at": sent_at,
                "text": text,
                "content": {"text": raw_message.get("text")},
                "metadata": {
                    "sender": sender,
                    "channel": raw_message.get("channel"),
                    "sent_at": sent_at,
                },
                "attachments": [],
            }
        )

    messages.sort(key=lambda item: item.get("created_at") or "")
    for sequence, message in enumerate(messages, start=1):
        message["sequence"] = sequence

    if not messages:
        raise ImportParseError("Pi export was recognized, but no messages could be parsed.")

    title = pi_conversation_title(export_path, details, messages)
    created_at = iso_timestamp(details.get("created_at")) or messages[0].get("created_at")
    updated_at = messages[-1].get("created_at")
    identifiers = details.get("identifiers") if isinstance(details.get("identifiers"), list) else []

    return {
        "provider": "pi",
        "parser_version": "pi:v1",
        "conversations": [
            {
                "provider": "pi",
                "provider_conversation_id": stable_hash(f"pi:{export_path.name}:{created_at}:{len(messages)}"),
                "title": title,
                "created_at": created_at,
                "updated_at": updated_at,
                "metadata": {
                    "first_name": details.get("first_name"),
                    "entry_channel": details.get("entry_channel"),
                    "identifiers": identifiers,
                    "source": "pi",
                    "source_file": export_path.name,
                },
                "messages": messages,
            }
        ],
        "warnings": warnings,
        "summary": {
            "conversation_count": 1,
            "message_count": len(messages),
            "attachment_count": 0,
        },
    }


def parse_google_ai_studio_export(export_path: Path) -> dict[str, Any]:
    normalized: list[dict[str, Any]] = []
    warnings: list[str] = []
    sources: list[dict[str, Any]] = []
    source_paths: set[tuple[str, str]] = set()
    orphan_assets: list[dict[str, Any]] = []
    message_total = 0
    attachment_total = 0

    if export_path.suffix.lower() == ".json":
        document = load_json_file(export_path)
        if not looks_like_google_ai_studio_document(document):
            raise ImportParseError("Google AI Studio export did not contain a recognizable conversation document.")
        conversation = normalize_google_ai_studio_conversation(
            export_path.name,
            document,
            fallback_timestamp=None,
            add_source=lambda source: register_google_ai_studio_source(source, sources, source_paths),
        )
        if conversation is None:
            raise ImportParseError("Google AI Studio export was recognized, but no messages could be parsed.")
        normalized.append(conversation)
    elif export_path.suffix.lower() == ".zip":
        with ZipFile(export_path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                raw = archive.read(info.filename)
                document = parse_json_bytes(raw)
                if looks_like_google_ai_studio_document(document):
                    conversation = normalize_google_ai_studio_conversation(
                        info.filename,
                        document,
                        fallback_timestamp=zipinfo_timestamp(info),
                        add_source=lambda source: register_google_ai_studio_source(source, sources, source_paths),
                    )
                    if conversation is None:
                        warnings.append(f"Skipped Google AI Studio conversation {info.filename}: no visible messages found.")
                        continue
                    normalized.append(conversation)
                    continue

                if should_ignore_google_ai_studio_asset(info.filename):
                    continue

                asset = normalize_google_ai_studio_asset(
                    info,
                    raw,
                    add_source=lambda source: register_google_ai_studio_source(source, sources, source_paths),
                )
                if asset is not None:
                    orphan_assets.append(asset)
    else:
        raise ImportParseError("Google AI Studio imports must be a .zip or .json file.")

    if not normalized:
        raise ImportParseError("Google AI Studio export was recognized, but no conversations could be parsed.")

    attached_orphans = 0
    unmatched_orphans = 0
    for asset in orphan_assets:
        matched = match_google_ai_studio_asset(asset, normalized)
        if matched:
            attached_orphans += 1
        else:
            unmatched_orphans += 1

    for conversation in normalized:
        messages = conversation.get("messages") or []
        for sequence, message in enumerate(messages, start=1):
            message["sequence"] = sequence
        message_total += len(messages)
        attachment_total += sum(len(message.get("attachments") or []) for message in messages)
        conversation.pop("_google_ai_studio_match", None)
        for message in messages:
            message.pop("_google_ai_studio_match", None)

    if unmatched_orphans:
        warnings.append(
            f"Preserved {unmatched_orphans} Google AI Studio artifact(s) as source files because they could not be matched confidently to a conversation."
        )

    return {
        "provider": "googleaistudio",
        "parser_version": "googleaistudio:v1",
        "conversations": normalized,
        "warnings": warnings,
        "sources": sources,
        "summary": {
            "conversation_count": len(normalized),
            "message_count": message_total,
            "attachment_count": attachment_total,
            "matched_artifact_count": attached_orphans,
            "unmatched_artifact_count": unmatched_orphans,
            "source_file_count": len(sources),
        },
    }


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
            normalized_message = normalize_kimi_export_message(raw_message)
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

    archive_file_index = build_claude_archive_file_index(export_path)
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

            role = normalize_role(raw_message.get("sender"))
            text = flatten_claude_message(raw_message)
            attachments = extract_claude_attachments(raw_message, export_path, archive_file_index)
            if not text.strip() and not attachments:
                continue

            messages.append(
                {
                    "provider_message_id": raw_message.get("uuid"),
                    "role": role,
                    "author_name": claude_author_name(raw_message.get("sender")),
                    "model": fallback_assistant_model("claude", role),
                    "created_at": iso_timestamp(raw_message.get("created_at")),
                    "text": text.strip() or format_attachment_lines(attachments),
                    "content": {
                        "text": raw_message.get("text"),
                        "blocks": raw_message.get("content") or [],
                    },
                    "metadata": {
                        "sender": raw_message.get("sender"),
                        "updated_at": iso_timestamp(raw_message.get("updated_at")),
                        "thinking": extract_claude_thinking_blocks(raw_message),
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
    warnings: list[str] = []
    sources: list[dict[str, Any]] = []
    source_paths: set[tuple[str, str]] = set()
    attachment_lookup: dict[str, str] = {}

    if export_path.suffix.lower() == ".zip":
        with ZipFile(export_path) as archive:
            payload = load_chatgpt_payload_from_archive(archive)
            attachment_lookup = build_chatgpt_attachment_lookup(archive)
            result = normalize_chatgpt_payload(
                payload,
                archive=archive,
                attachment_lookup=attachment_lookup,
                warnings=warnings,
                add_source=lambda source: register_chatgpt_source(source, sources, source_paths),
            )
    else:
        payload = load_chatgpt_payload(export_path)
        result = normalize_chatgpt_payload(
            payload,
            archive=None,
            attachment_lookup=attachment_lookup,
            warnings=warnings,
            add_source=lambda source: register_chatgpt_source(source, sources, source_paths),
        )

    return {
        "provider": "chatgpt",
        "parser_version": "chatgpt:v2",
        "conversations": result["conversations"],
        "warnings": warnings,
        "sources": sources,
        "summary": {
            "conversation_count": len(result["conversations"]),
            "message_count": result["message_count"],
            "attachment_count": result["attachment_count"],
            "source_file_count": len(sources),
        },
    }


def normalize_chatgpt_payload(
    payload: Any,
    *,
    archive: ZipFile | None,
    attachment_lookup: dict[str, str],
    warnings: list[str],
    add_source: Any,
) -> dict[str, Any]:
    if isinstance(payload, dict):
        conversations = payload.get("conversations") or payload.get("items") or []
    else:
        conversations = payload
    if not isinstance(conversations, list):
        raise ImportParseError("ChatGPT export did not contain a conversation list.")

    normalized: list[dict[str, Any]] = []
    message_total = 0
    attachment_total = 0

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
            text = flatten_chatgpt_content(content)
            attachments = extract_chatgpt_attachments(
                message,
                archive=archive,
                attachment_lookup=attachment_lookup,
                add_source=add_source,
                warnings=warnings,
            )

            if not text.strip() and role not in {"system", "tool"} and not attachments:
                continue

            metadata = message.get("metadata") or {}
            messages.append(
                {
                    "provider_message_id": message.get("id") or node.get("id"),
                    "role": role,
                    "author_name": chatgpt_author_name(author),
                    "model": metadata.get("model_slug") or metadata.get("default_model_slug"),
                    "created_at": iso_timestamp(message.get("create_time")),
                    "text": text.strip() or format_attachment_lines(attachments),
                    "content": content,
                    "metadata": metadata,
                    "attachments": attachments,
                }
            )
            messages.extend(extract_chatgpt_supplemental_messages(message))

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
        attachment_total += sum(len(message.get("attachments") or []) for message in messages)

    return {
        "conversations": normalized,
        "message_count": message_total,
        "attachment_count": attachment_total,
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


def looks_like_google_ai_studio_archive(export_path: Path) -> bool:
    if export_path.suffix.lower() != ".zip":
        return False
    with ZipFile(export_path) as archive:
        names = [name for name in archive.namelist() if name and not name.endswith("/")]
        lowered = [name.lower() for name in names]
        if any(name.startswith("google ai studio/") for name in lowered):
            for name in names:
                document = parse_json_bytes(archive.read(name))
                if looks_like_google_ai_studio_document(document):
                    return True
        for name in names:
            if not likely_google_ai_studio_conversation_name(name):
                continue
            document = parse_json_bytes(archive.read(name))
            if looks_like_google_ai_studio_document(document):
                return True
    return False


def looks_like_google_ai_studio_document(document: Any) -> bool:
    if not isinstance(document, dict):
        return False
    chunked_prompt = document.get("chunkedPrompt")
    if not isinstance(chunked_prompt, dict):
        return False
    chunks = chunked_prompt.get("chunks")
    if not isinstance(chunks, list) or not chunks:
        return False
    run_settings = document.get("runSettings")
    if not isinstance(run_settings, dict):
        return False
    return any(isinstance(chunk, dict) and chunk.get("role") in {"user", "model"} for chunk in chunks)


def normalize_google_ai_studio_conversation(
    source_name: str,
    document: dict[str, Any],
    *,
    fallback_timestamp: datetime | None,
    add_source: Any,
) -> dict[str, Any] | None:
    chunked_prompt = document.get("chunkedPrompt") or {}
    raw_chunks = chunked_prompt.get("chunks") or []
    if not isinstance(raw_chunks, list):
        return None

    title = google_ai_studio_title(source_name)
    raw_run_settings = document.get("runSettings")
    run_settings: dict[str, Any] = raw_run_settings if isinstance(raw_run_settings, dict) else {}
    folder = str(PurePosixPath(source_name).parent)
    pending_inputs = chunked_prompt.get("pendingInputs")
    pending_input_count = len(pending_inputs) if isinstance(pending_inputs, list) else 0

    messages: list[dict[str, Any]] = []
    message_times: list[datetime] = []
    for index, chunk in enumerate(raw_chunks, start=1):
        if not isinstance(chunk, dict):
            continue
        if chunk.get("isThought"):
            continue

        role = normalize_role(chunk.get("role"))
        attachments: list[dict[str, Any]] = []

        inline_file = chunk.get("inlineFile")
        attachment = google_ai_studio_attachment_from_inline_file(
            inline_file,
            title=title,
            message_index=index,
            add_source=add_source,
        )
        if attachment is not None:
            attachments.append(attachment)

        raw_parts = chunk.get("parts")
        parts: list[Any] = raw_parts if isinstance(raw_parts, list) else []
        rendered_parts: list[str] = []
        for part_index, part in enumerate(parts, start=1):
            if not isinstance(part, dict):
                continue
            if part.get("thought"):
                continue
            part_text = str(part.get("text") or "")
            if part_text:
                rendered_parts.append(part_text)
            inline_data = part.get("inlineData")
            attachment = google_ai_studio_attachment_from_inline_data(
                inline_data,
                title=title,
                message_index=index,
                part_index=part_index,
                add_source=add_source,
            )
            if attachment is not None:
                attachments.append(attachment)

        text = str(chunk.get("text") or "").strip()
        if not text:
            text = "".join(rendered_parts).strip()
        if not text and not attachments:
            continue

        created_at = iso_timestamp(chunk.get("createTime"))
        if created_at is None and fallback_timestamp is not None:
            created_at = fallback_timestamp.isoformat()
        created_at_dt = parse_iso_datetime(created_at)
        if created_at_dt is not None:
            message_times.append(created_at_dt)

        message = {
            "provider_message_id": stable_hash(f"googleaistudio:{source_name}:{index}"),
            "role": role,
            "author_name": google_ai_studio_author_name(role),
            "model": run_settings.get("model") if role == "assistant" else None,
            "created_at": created_at,
            "text": text or format_attachment_lines(attachments),
            "content": {
                "text": text or None,
                "part_count": len(parts),
                "has_inline_file": inline_file is not None,
                "generated_attachment_count": sum(1 for part in parts if isinstance(part, dict) and part.get("inlineData")),
            },
            "metadata": {
                "source": "google_ai_studio",
                "archive_path": source_name,
                "chunk_index": index,
                "finish_reason": chunk.get("finishReason"),
                "pending_input_count": pending_input_count,
            },
            "attachments": attachments,
            "_google_ai_studio_match": {
                "fallback_timestamp": created_at_dt,
            },
        }
        messages.append(message)

    if not messages:
        return None

    created_at = messages[0].get("created_at") or (fallback_timestamp.isoformat() if fallback_timestamp else None)
    updated_at = messages[-1].get("created_at") or created_at
    conversation_time = message_times[-1] if message_times else fallback_timestamp

    return {
        "provider": "googleaistudio",
        "provider_conversation_id": stable_hash(f"googleaistudio:{source_name}"),
        "title": title,
        "created_at": created_at,
        "updated_at": updated_at,
        "metadata": {
            "source": "google_ai_studio",
            "source_file": source_name,
            "folder": folder,
            "model": run_settings.get("model"),
            "thinking_level": run_settings.get("thinkingLevel"),
            "temperature": run_settings.get("temperature"),
        },
        "messages": messages,
        "_google_ai_studio_match": {
            "folder": folder,
            "timestamp": conversation_time,
        },
    }


def normalize_google_ai_studio_asset(
    info: ZipInfo,
    raw: bytes,
    *,
    add_source: Any,
) -> dict[str, Any] | None:
    filename = PurePosixPath(info.filename).name
    if not filename:
        return None
    mime_type = detect_mime_type(filename, raw)
    stored = store_blob_bytes(raw, filename, mime_type)
    add_source(
        {
            "kind": "blob",
            "relative_path": stored["blob_path"],
            "sha256": stored["sha256"],
            "metadata": {
                "source": "google_ai_studio_artifact",
                "archive_path": info.filename,
                "filename": filename,
                "mime_type": mime_type,
                "size": len(raw),
            },
        }
    )
    return {
        "filename": filename,
        "mime_type": mime_type,
        "blob_path": stored["blob_path"],
        "sha256": stored["sha256"],
        "folder": str(PurePosixPath(info.filename).parent),
        "archive_path": info.filename,
        "timestamp": zipinfo_timestamp(info),
        "metadata": {
            "source": "google_ai_studio_artifact",
            "archive_path": info.filename,
            "match_reason": "unmatched",
        },
    }


def match_google_ai_studio_asset(asset: dict[str, Any], conversations: list[dict[str, Any]]) -> bool:
    asset_time = asset.get("timestamp")
    if not isinstance(asset_time, datetime):
        return False

    best_conversation: dict[str, Any] | None = None
    best_delta: float | None = None
    asset_folder = str(asset.get("folder") or "")
    asset_name = normalize_google_ai_studio_name(str(asset.get("filename") or ""))

    for conversation in conversations:
        match_context = conversation.get("_google_ai_studio_match") or {}
        if str(match_context.get("folder") or "") != asset_folder:
            continue
        conversation_time = match_context.get("timestamp")
        if not isinstance(conversation_time, datetime):
            continue
        delta = abs((asset_time - conversation_time).total_seconds())
        title_name = normalize_google_ai_studio_name(str(conversation.get("title") or ""))
        title_bonus = 30.0 if asset_name and title_name and (asset_name in title_name or title_name in asset_name) else 0.0
        adjusted_delta = max(delta - title_bonus, 0.0)
        if adjusted_delta > 180.0:
            continue
        if best_delta is None or adjusted_delta < best_delta:
            best_conversation = conversation
            best_delta = adjusted_delta

    if best_conversation is None:
        return False

    target_message = select_google_ai_studio_attachment_message(best_conversation, asset_time)
    if target_message is None:
        return False

    attachment = {
        "filename": asset.get("filename") or "attachment",
        "mime_type": asset.get("mime_type"),
        "blob_path": asset.get("blob_path"),
        "sha256": asset.get("sha256"),
        "metadata": {
            **dict(asset.get("metadata") or {}),
            "match_reason": "timestamp_only",
            "matched_conversation_title": best_conversation.get("title"),
            "matched_by_same_folder": True,
            "matched_delta_seconds": best_delta,
        },
    }
    matched_title_name = normalize_google_ai_studio_name(str(best_conversation.get("title") or ""))
    if asset_name and matched_title_name and (matched_title_name in asset_name or asset_name in matched_title_name):
        attachment["metadata"]["match_reason"] = "timestamp_and_name"
    target_message.setdefault("attachments", []).append(attachment)
    if not str(target_message.get("text") or "").strip():
        target_message["text"] = format_attachment_lines(target_message.get("attachments") or [])
    return True


def select_google_ai_studio_attachment_message(conversation: dict[str, Any], asset_time: datetime) -> dict[str, Any] | None:
    messages = conversation.get("messages") or []
    if not isinstance(messages, list) or not messages:
        return None

    best_message: dict[str, Any] | None = None
    best_delta: float | None = None
    for message in messages:
        match_context = message.get("_google_ai_studio_match") or {}
        message_time = match_context.get("fallback_timestamp")
        if not isinstance(message_time, datetime):
            continue
        delta = abs((asset_time - message_time).total_seconds())
        if best_delta is None or delta < best_delta:
            best_message = message
            best_delta = delta
    return best_message or messages[-1]


def google_ai_studio_attachment_from_inline_file(
    inline_file: Any,
    *,
    title: str,
    message_index: int,
    add_source: Any,
) -> dict[str, Any] | None:
    if not isinstance(inline_file, dict):
        return None
    raw = decode_base64_payload(inline_file.get("data"))
    if raw is None:
        return None
    mime_type = str(inline_file.get("mimeType") or "").strip() or None
    filename = google_ai_studio_generated_filename(title, message_index, None, mime_type, prefix="upload")
    stored = store_blob_bytes(raw, filename, mime_type)
    add_source(
        {
            "kind": "blob",
            "relative_path": stored["blob_path"],
            "sha256": stored["sha256"],
            "metadata": {
                "source": "google_ai_studio_inline_file",
                "filename": filename,
                "mime_type": mime_type,
            },
        }
    )
    return {
        "filename": filename,
        "mime_type": mime_type,
        "blob_path": stored["blob_path"],
        "sha256": stored["sha256"],
        "metadata": {
            "source": "google_ai_studio_inline_file",
        },
    }


def google_ai_studio_attachment_from_inline_data(
    inline_data: Any,
    *,
    title: str,
    message_index: int,
    part_index: int,
    add_source: Any,
) -> dict[str, Any] | None:
    if not isinstance(inline_data, dict):
        return None
    raw = decode_base64_payload(inline_data.get("data"))
    if raw is None:
        return None
    mime_type = str(inline_data.get("mimeType") or "").strip() or None
    filename = google_ai_studio_generated_filename(title, message_index, part_index, mime_type, prefix="generated")
    stored = store_blob_bytes(raw, filename, mime_type)
    add_source(
        {
            "kind": "blob",
            "relative_path": stored["blob_path"],
            "sha256": stored["sha256"],
            "metadata": {
                "source": "google_ai_studio_inline_data",
                "filename": filename,
                "mime_type": mime_type,
            },
        }
    )
    return {
        "filename": filename,
        "mime_type": mime_type,
        "blob_path": stored["blob_path"],
        "sha256": stored["sha256"],
        "metadata": {
            "source": "google_ai_studio_inline_data",
        },
    }


def register_google_ai_studio_source(source: dict[str, Any], sources: list[dict[str, Any]], seen: set[tuple[str, str]]) -> None:
    key = (str(source.get("kind") or ""), str(source.get("relative_path") or ""))
    if not key[0] or not key[1] or key in seen:
        return
    seen.add(key)
    sources.append(source)


def should_ignore_google_ai_studio_asset(name: str) -> bool:
    lowered = name.lower()
    return lowered.endswith("/info.md") or lowered.endswith("applet_access_history.json")


def google_ai_studio_title(source_name: str) -> str:
    base = PurePosixPath(source_name).name
    stem = Path(base).stem if "." in base else base
    stem = stem.rstrip("_")
    return stem.replace("_", " ").strip() or "Google AI Studio conversation"


def google_ai_studio_author_name(role: str) -> str | None:
    if role == "user":
        return "You"
    if role == "assistant":
        return "Google AI Studio"
    return None


def google_ai_studio_generated_filename(
    title: str,
    message_index: int,
    part_index: int | None,
    mime_type: str | None,
    *,
    prefix: str,
) -> str:
    extension = mimetypes.guess_extension(mime_type or "") or ""
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "google-ai-studio"
    suffix = f"-{message_index}"
    if part_index is not None:
        suffix += f"-{part_index}"
    return f"{prefix}-{slug}{suffix}{extension}"


def normalize_google_ai_studio_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def likely_google_ai_studio_conversation_name(name: str) -> bool:
    suffix = PurePosixPath(name).suffix.lower()
    return suffix in {"", ".json"}


def parse_json_bytes(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def decode_base64_payload(value: Any) -> bytes | None:
    if not value:
        return None
    try:
        return base64.b64decode(str(value), validate=False)
    except (ValueError, TypeError):
        return None


def zipinfo_timestamp(info: ZipInfo) -> datetime | None:
    try:
        return datetime(*info.date_time, tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_iso_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def detect_mime_type(filename: str, raw: bytes) -> str | None:
    guessed, _ = mimetypes.guess_type(filename)
    if guessed:
        return guessed
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"GIF87a") or raw.startswith(b"GIF89a"):
        return "image/gif"
    if raw.startswith(b"%PDF"):
        return "application/pdf"
    if raw.startswith(b"ftyp") or raw[4:8] == b"ftyp":
        return "video/mp4"
    if looks_like_text(raw):
        return "text/plain"
    return None


def looks_like_text(raw: bytes) -> bool:
    if not raw:
        return True
    sample = raw[:1024]
    try:
        decoded = sample.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return "\x00" not in decoded


def store_blob_bytes(raw: bytes, filename: str, mime_type: str | None) -> dict[str, str | None]:
    sha256 = hashlib.sha256(raw).hexdigest()
    suffix = Path(filename).suffix
    if not suffix:
        suffix = mimetypes.guess_extension(mime_type or "") or ""
    relative_path = f"{sha256[:2]}/{sha256}{suffix}"
    destination = BLOBS_DIR / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(raw)
    return {
        "blob_path": relative_path,
        "sha256": sha256,
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
            return load_chatgpt_payload_from_archive(archive)
    return load_json_file(export_path)


def load_chatgpt_payload_from_archive(archive: ZipFile) -> Any:
    manifest_name = next((name for name in archive.namelist() if name.lower().endswith("export_manifest.json")), None)
    if manifest_name:
        with archive.open(manifest_name) as handle:
            manifest = json.load(handle)
        sharded = load_chatgpt_payload_from_manifest(archive, manifest)
        if sharded is not None:
            return sharded

    for name in archive.namelist():
        if name.lower().endswith("conversations.json"):
            with archive.open(name) as handle:
                return json.load(handle)
    raise ImportParseError("ChatGPT export zip did not contain a recognizable conversations document.")


def load_chatgpt_payload_from_manifest(archive: ZipFile, manifest: Any) -> list[dict[str, Any]] | None:
    if not isinstance(manifest, dict):
        return None
    logical_files = manifest.get("logical_files")
    if not isinstance(logical_files, dict):
        return None
    conversation_entry = logical_files.get("conversations.json")
    if not isinstance(conversation_entry, dict):
        return None
    files = conversation_entry.get("files")
    if not isinstance(files, list) or not files:
        return None

    combined: list[dict[str, Any]] = []
    for name in files:
        if not isinstance(name, str) or not name:
            continue
        with archive.open(name) as handle:
            document = json.load(handle)
        if isinstance(document, list):
            combined.extend(item for item in document if isinstance(item, dict))
        elif isinstance(document, dict):
            shard_conversations = document.get("conversations") or document.get("items") or []
            if isinstance(shard_conversations, list):
                combined.extend(item for item in shard_conversations if isinstance(item, dict))

    return combined or None


def build_chatgpt_attachment_lookup(archive: ZipFile) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for name in archive.namelist():
        if not name or name.endswith("/") or name.lower().endswith(".json") or name.lower().endswith(".html"):
            continue
        basename = PurePosixPath(name).name
        lookup.setdefault(basename, name)
    return lookup


def extract_chatgpt_attachments(
    message: dict[str, Any],
    *,
    archive: ZipFile | None,
    attachment_lookup: dict[str, str],
    add_source: Any,
    warnings: list[str],
) -> list[dict[str, Any]]:
    raw_metadata = message.get("metadata")
    metadata: dict[str, Any] = {}
    if isinstance(raw_metadata, dict):
        metadata = raw_metadata
    raw_attachments = metadata.get("attachments")
    if not isinstance(raw_attachments, list):
        return []

    extracted: list[dict[str, Any]] = []
    for attachment in raw_attachments:
        if not isinstance(attachment, dict):
            continue
        extracted.append(
            normalize_chatgpt_attachment(
                attachment,
                archive=archive,
                attachment_lookup=attachment_lookup,
                add_source=add_source,
                warnings=warnings,
            )
        )
    return extracted


def normalize_chatgpt_attachment(
    attachment: dict[str, Any],
    *,
    archive: ZipFile | None,
    attachment_lookup: dict[str, str],
    add_source: Any,
    warnings: list[str],
) -> dict[str, Any]:
    attachment_id = str(attachment.get("id") or "").strip()
    filename = str(attachment.get("name") or attachment.get("filename") or attachment_id or "attachment").strip() or "attachment"
    path = find_chatgpt_attachment_path(attachment_id, filename, attachment_lookup)
    mime_type = str(attachment.get("mimeType") or attachment.get("mime_type") or "").strip() or None
    metadata = {
        "source": "chatgpt_attachment",
        "attachment_id": attachment_id or None,
        "archive_path": path,
        "size": attachment.get("size"),
        "width": attachment.get("width"),
        "height": attachment.get("height"),
    }

    if archive is not None and path:
        raw = archive.read(path)
        stored = store_blob_bytes(raw, filename, mime_type)
        detected_mime = mime_type or detect_mime_type(filename, raw)
        add_source(
            {
                "kind": "blob",
                "relative_path": stored["blob_path"],
                "sha256": stored["sha256"],
                "metadata": {
                    "source": "chatgpt_attachment",
                    "archive_path": path,
                    "filename": filename,
                    "mime_type": detected_mime,
                    "attachment_id": attachment_id or None,
                    "size": len(raw),
                },
            }
        )
        return {
            "filename": filename,
            "mime_type": detected_mime,
            "blob_path": stored["blob_path"],
            "sha256": stored["sha256"],
            "metadata": metadata,
        }

    if archive is not None and attachment_id:
        warning = f"ChatGPT attachment {attachment_id} ({filename}) was referenced but the file was not bundled in the export."
        if warning not in warnings:
            warnings.append(warning)

    metadata["missing_blob"] = True
    return {
        "filename": filename,
        "mime_type": mime_type,
        "blob_path": None,
        "sha256": None,
        "metadata": metadata,
    }


def find_chatgpt_attachment_path(attachment_id: str, filename: str, attachment_lookup: dict[str, str]) -> str | None:
    basename_candidates: list[str] = []
    if attachment_id and filename:
        basename_candidates.append(f"{attachment_id}-{filename}")
    if filename:
        basename_candidates.append(filename)
    if attachment_id:
        basename_candidates.append(attachment_id)

    for candidate in basename_candidates:
        path = attachment_lookup.get(candidate)
        if path:
            return path

    if attachment_id:
        prefix = f"{attachment_id}-"
        for basename, path in attachment_lookup.items():
            if basename.startswith(prefix):
                return path
    if filename:
        suffix = f"-{filename}"
        for basename, path in attachment_lookup.items():
            if basename == filename or basename.endswith(suffix):
                return path
    return None


def register_chatgpt_source(source: dict[str, Any], sources: list[dict[str, Any]], seen: set[tuple[str, str]]) -> None:
    key = (str(source.get("kind") or ""), str(source.get("relative_path") or ""))
    if not key[0] or not key[1] or key in seen:
        return
    seen.add(key)
    sources.append(source)


def chatgpt_author_name(author: Any) -> str | None:
    if not isinstance(author, dict):
        return None
    name = str(author.get("name") or "").strip()
    if name:
        return name
    role = normalize_role(author.get("role"))
    if role == "user":
        return "You"
    if role == "assistant":
        return "ChatGPT"
    return None


def flatten_chatgpt_content(content: Any) -> str:
    if not isinstance(content, dict):
        return flatten_text(content)

    content_type = str(content.get("content_type") or "").strip().lower()
    if content_type in {"text", "multimodal_text"}:
        parts = content.get("parts")
        if isinstance(parts, list):
            rendered = [render_chatgpt_content_part(part).strip() for part in parts]
            return "\n\n".join(part for part in rendered if part)
    if content_type in {"code", "execution_output"}:
        return flatten_text(content.get("text") or content.get("result") or content.get("content") or content.get("parts"))
    if content_type == "tether_browsing_display":
        return flatten_text(content.get("summary") or content.get("result") or content.get("content"))
    if content_type == "tether_quote":
        return flatten_text(content.get("text") or content.get("title") or content.get("content") or content.get("parts"))
    if content_type == "system_error":
        return flatten_text(content.get("text") or content.get("name") or content.get("content"))
    return flatten_text(content)


def render_chatgpt_content_part(part: Any) -> str:
    if isinstance(part, str):
        return part
    if not isinstance(part, dict):
        return flatten_text(part)

    part_type = str(part.get("content_type") or "").strip().lower()
    if part_type.endswith("asset_pointer"):
        return ""
    for key in ("text", "caption", "summary", "title"):
        value = part.get(key)
        if value not in (None, ""):
            return flatten_text(value)
    if "parts" in part:
        return flatten_text(part.get("parts"))
    return ""


def extract_chatgpt_supplemental_messages(message: dict[str, Any]) -> list[dict[str, Any]]:
    metadata = message.get("metadata") if isinstance(message.get("metadata"), dict) else {}
    chatgpt_sdk = metadata.get("chatgpt_sdk") if isinstance(metadata.get("chatgpt_sdk"), dict) else {}
    widget_state_raw = chatgpt_sdk.get("widget_state")
    if not widget_state_raw:
        return []

    if isinstance(widget_state_raw, str):
        widget_state = parse_json_bytes(widget_state_raw.encode("utf-8"))
    else:
        widget_state = widget_state_raw
    if not isinstance(widget_state, dict):
        return []

    report_message = widget_state.get("report_message")
    if not isinstance(report_message, dict):
        return []

    report_content = report_message.get("content") if isinstance(report_message.get("content"), dict) else {}
    markdown = flatten_chatgpt_content(report_content).strip()
    cleaned_markdown = strip_chatgpt_citation_markers(markdown)
    if not cleaned_markdown:
        return []

    report_metadata = report_message.get("metadata") if isinstance(report_message.get("metadata"), dict) else {}
    references = extract_chatgpt_report_references(report_metadata)
    artifact_title = chatgpt_deep_research_title(cleaned_markdown)

    synthetic_message = {
        "provider_message_id": report_message.get("id") or f"{message.get('id')}:report",
        "role": "assistant",
        "author_name": "ChatGPT",
        "model": report_metadata.get("resolved_model_slug") or metadata.get("resolved_model_slug") or metadata.get("model_slug"),
        "created_at": iso_timestamp(report_message.get("create_time")) or iso_timestamp(message.get("create_time")),
        "text": "",
        "content": report_content,
        "metadata": {
            "source": "chatgpt_deep_research_report",
            "refs": {
                "search_chunks": references,
            },
            "artifacts": [
                {
                    "artifact_id": report_message.get("id") or f"{message.get('id')}:report-artifact",
                    "type": "ARTIFACT_TYPE_MARKDOWN",
                    "title": artifact_title,
                    "content": cleaned_markdown,
                }
            ],
            "research_summary": chatgpt_deep_research_summary(widget_state, references),
        },
        "attachments": [],
    }
    return [synthetic_message]


def extract_chatgpt_report_references(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    content_references = metadata.get("content_references")
    if not isinstance(content_references, list):
        return []

    references: list[dict[str, Any]] = []
    seen: set[str] = set()
    for reference in content_references:
        if not isinstance(reference, dict):
            continue
        items = reference.get("items") if isinstance(reference.get("items"), list) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            candidates = [item, *(site for site in item.get("supporting_websites") or [] if isinstance(site, dict))]
            for candidate in candidates:
                url = str(candidate.get("url") or "").strip()
                if not url or url in seen:
                    continue
                seen.add(url)
                references.append(
                    {
                        "url": url,
                        "title": candidate.get("title") or url,
                        "snippet": candidate.get("snippet"),
                        "site_name": candidate.get("attribution"),
                        "publish_time": candidate.get("pub_date"),
                    }
                )
    return references


def strip_chatgpt_citation_markers(text: str) -> str:
    cleaned = re.sub(r"\ue200cite\ue202.*?\ue201", "", text)
    cleaned = re.sub(r"\ue200entity\ue202.*?\ue201", "", cleaned)
    cleaned = re.sub(r"\ue200image_group\ue202.*?\ue201", "", cleaned)
    cleaned = cleaned.replace("\uE200", "").replace("\uE201", "").replace("\uE202", "")
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def chatgpt_deep_research_title(markdown: str) -> str:
    first_line = markdown.splitlines()[0].strip() if markdown.splitlines() else ""
    if first_line.startswith("#"):
        return first_line.lstrip("#").strip() or "Research report"
    return first_line or "Research report"


def chatgpt_deep_research_summary(widget_state: dict[str, Any], references: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "status": widget_state.get("status"),
        "citation_count": len(references),
    }
    started = parse_iso_datetime(widget_state.get("research_started_at"))
    stopped = parse_iso_datetime(widget_state.get("research_stopped_at"))
    if started is not None and stopped is not None:
        duration_seconds = max(int((stopped - started).total_seconds()), 0)
        summary["duration_seconds"] = duration_seconds
    return summary


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


def looks_like_pi_export(document: Any) -> bool:
    if not isinstance(document, dict):
        return False
    user_data = document.get("user_data")
    if not isinstance(user_data, dict):
        return False
    details = user_data.get("details")
    messages = user_data.get("messages")
    return isinstance(details, dict) and isinstance(messages, list)


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


def normalize_kimi_export_message(raw_message: dict[str, Any]) -> dict[str, Any] | None:
    if is_normalized_kimi_export_message(raw_message):
        return normalize_exported_kimi_message(raw_message)
    return normalize_kimi_message(raw_message)


def is_normalized_kimi_export_message(raw_message: dict[str, Any]) -> bool:
    return all(key in raw_message for key in ("role", "text", "attachments")) and any(
        key in raw_message for key in ("message_id", "created_at", "metadata", "raw")
    )


def normalize_exported_kimi_message(raw_message: dict[str, Any]) -> dict[str, Any] | None:
    text = str(raw_message.get("text") or "").strip()
    attachments = normalize_import_attachments(raw_message.get("attachments"))
    if not text and not attachments:
        return None

    role = normalize_kimi_role(raw_message)
    metadata = raw_message.get("metadata") if isinstance(raw_message.get("metadata"), dict) else {}
    content = raw_message.get("raw") if isinstance(raw_message.get("raw"), dict) else raw_message.get("content")
    if not isinstance(content, dict):
        content = {"raw": raw_message}

    return {
        "provider_message_id": extract_first(raw_message, ["provider_message_id", "message_id", "msg_id", "id", "uuid"]),
        "role": role,
        "author_name": raw_message.get("author_name") or ("You" if role == "user" else "Kimi" if role == "assistant" else None),
        "model": derive_kimi_model(raw_message, metadata, role, content),
        "created_at": extract_timestamp(raw_message, ["created_at", "create_time", "createTime", "timestamp", "time", "updated_at", "updateTime"]),
        "text": text or format_attachment_lines(attachments),
        "content": content,
        "metadata": metadata,
        "attachments": attachments,
    }


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
        "model": derive_kimi_model(raw_message, metadata, role, raw_message),
        "created_at": extract_timestamp(raw_message, ["created_at", "create_time", "timestamp", "time", "updated_at"]),
        "text": text or format_attachment_lines(attachments),
        "content": raw_message,
        "metadata": metadata,
        "attachments": attachments,
    }


def normalize_import_attachments(raw_attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_attachments, list):
        return []

    normalized: list[dict[str, Any]] = []
    for attachment in raw_attachments:
        if not isinstance(attachment, dict):
            continue
        filename = str(attachment.get("filename") or attachment.get("name") or "attachment").strip() or "attachment"
        metadata = attachment.get("metadata") if isinstance(attachment.get("metadata"), dict) else {}
        normalized.append(
            {
                "filename": filename,
                "mime_type": attachment.get("mime_type"),
                "blob_path": attachment.get("blob_path"),
                "sha256": attachment.get("sha256"),
                "metadata": metadata,
            }
        )
    return normalized


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


def fallback_assistant_model(provider: str, role: str) -> str | None:
    return None


def pi_author_name(sender: Any) -> str | None:
    role = normalize_role(sender)
    if role == "user":
        return "You"
    if role == "assistant":
        return "Pi"
    return None


def pi_conversation_title(export_path: Path, details: dict[str, Any], messages: list[dict[str, Any]]) -> str:
    first_name = str(details.get("first_name") or "").strip()
    if first_name and first_name != "_":
        return f"Pi chat with {first_name}"

    first_user_message = next((item for item in messages if item.get("role") == "user" and item.get("text")), None)
    if first_user_message:
        text = str(first_user_message.get("text") or "").strip()
        compact = re.sub(r"\s+", " ", text)
        if compact:
            return compact[:80]

    return title_from_filename(export_path.name)


def derive_kimi_model(
    raw_message: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    role: str,
    content: dict[str, Any] | None = None,
) -> str | None:
    if role != "assistant":
        return None

    raw_message_dict: dict[str, Any] = {}
    if isinstance(raw_message, dict):
        raw_message_dict = raw_message

    metadata_dict: dict[str, Any] = {}
    if isinstance(metadata, dict):
        metadata_dict = metadata

    content_dict: dict[str, Any] = {}
    if isinstance(content, dict):
        content_dict = content

    nested_raw: dict[str, Any] = {}
    raw_content = content_dict.get("raw")
    if isinstance(raw_content, dict):
        nested_raw = raw_content

    explicit_model = (
        extract_first(raw_message_dict, ["model", "model_name"])
        or metadata_dict.get("model")
        or extract_first(nested_raw, ["model", "model_name"])
    )
    if explicit_model not in (None, ""):
        return str(explicit_model).strip()

    scenario = str(
        extract_first(raw_message_dict, ["scenario"])
        or metadata_dict.get("scenario")
        or extract_first(nested_raw, ["scenario"])
        or ""
    ).strip()
    kimi_plus = first_dict(
        raw_message_dict.get("kimiPlus"),
        metadata_dict.get("kimi_plus"),
        nested_raw.get("kimiPlus"),
        extract_nested(content_dict, ["raw", "kimiPlus"]),
    )
    thinking = first_bool(
        extract_nested(raw_message_dict, ["lastRequest", "options", "thinking"]),
        extract_nested(content_dict, ["raw", "lastRequest", "options", "thinking"]),
        metadata_dict.get("thinking"),
    )
    if thinking is None:
        thinking = kimi_metadata_implies_thinking(metadata_dict) or kimi_metadata_implies_thinking(nested_raw)

    agent_mode = str((kimi_plus or {}).get("agentMode") or "").strip().upper()

    if scenario == "SCENARIO_DEEP_RESEARCH":
        return "Deep Research"
    if scenario == "SCENARIO_OK_COMPUTER":
        if agent_mode == "TYPE_ULTRA":
            return "K2.5 Agent Swarm"
        return "K2.5 Agent"
    if scenario == "SCENARIO_K2D5":
        if thinking is True:
            return "K2.5 Thinking"
        return "K2.5 Instant"

    kimi_plus_name = str((kimi_plus or {}).get("name") or "").strip()
    if kimi_plus_name:
        return kimi_plus_name
    if thinking is True:
        return "K2.5 Thinking"

    return fallback_assistant_model("kimi", role)


def first_dict(*values: Any) -> dict[str, Any] | None:
    for value in values:
        if isinstance(value, dict):
            return value
    return None


def first_bool(*values: Any) -> bool | None:
    for value in values:
        if isinstance(value, bool):
            return value
    return None


def kimi_metadata_implies_thinking(candidate: Any) -> bool:
    if not isinstance(candidate, dict):
        return False

    blocks = candidate.get("blocks")
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict):
                continue
            kind = str(block.get("kind") or "").strip().lower()
            if kind == "think":
                return True
            stages = block.get("stages")
            if isinstance(stages, list):
                for stage in stages:
                    if not isinstance(stage, dict):
                        continue
                    name = str(stage.get("name") or "").strip().upper()
                    if name == "STAGE_NAME_THINKING":
                        return True

    stages = candidate.get("stages")
    if isinstance(stages, list):
        for stage in stages:
            if not isinstance(stage, dict):
                continue
            name = str(stage.get("name") or "").strip().upper()
            if name == "STAGE_NAME_THINKING":
                return True
    return False


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
    parts: list[str] = []

    if blocks:
        for block in blocks:
            if not isinstance(block, dict):
                continue
            rendered = render_claude_block(block, include_text=True)
            if rendered:
                parts.append(rendered)
    else:
        message_text = str(message.get("text") or "").strip()
        if message_text:
            parts.append(message_text)

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


def extract_claude_thinking_blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    raw_blocks = message.get("content")
    blocks: list[Any] = raw_blocks if isinstance(raw_blocks, list) else []
    thoughts: list[dict[str, Any]] = []

    for block in blocks:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "").strip().lower()
        if block_type != "thinking":
            continue
        text = str(block.get("thinking") or "").strip()
        if not text:
            continue
        thoughts.append(
            {
                "text": text,
                "created_at": iso_timestamp(block.get("start_timestamp") or block.get("stop_timestamp")),
                "summaries": [
                    str(summary.get("summary") or "").strip()
                    for summary in block.get("summaries") or []
                    if isinstance(summary, dict) and str(summary.get("summary") or "").strip()
                ],
            }
        )

    return thoughts


def build_claude_archive_file_index(export_path: Path) -> dict[str, str]:
    if export_path.suffix.lower() != ".zip":
        return {}

    index: dict[str, str] = {}
    with ZipFile(export_path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = PurePosixPath(info.filename).name
            if not name or name.lower().endswith(".json"):
                continue
            for key in {name.lower(), Path(name).stem.lower()}:
                index.setdefault(key, info.filename)
    return index


def store_claude_archive_file(export_path: Path, archive_file_index: dict[str, str], filename: str, file_uuid: Any) -> dict[str, Any] | None:
    if not archive_file_index:
        return None

    keys = [str(file_uuid or "").strip().lower(), filename.strip().lower(), Path(filename).stem.lower()]
    archive_name = next((archive_file_index[key] for key in keys if key and key in archive_file_index), None)
    if not archive_name:
        return None

    with ZipFile(export_path) as archive:
        raw = archive.read(archive_name)
    mime_type = detect_mime_type(filename, raw)
    stored = store_blob_bytes(raw, filename, mime_type)
    return {
        "mime_type": mime_type,
        "blob_path": stored["blob_path"],
        "sha256": stored["sha256"],
        "file_size": len(raw),
        "archive_path": archive_name,
    }


def extract_claude_attachments(message: dict[str, Any], export_path: Path | None = None, archive_file_index: dict[str, str] | None = None) -> list[dict[str, Any]]:
    extracted: list[dict[str, Any]] = []
    archive_index = archive_file_index or {}
    for attachment in message.get("attachments") or []:
        if not isinstance(attachment, dict):
            continue
        filename = str(attachment.get("file_name") or "attachment").strip() or "attachment"
        file_uuid = attachment.get("file_uuid")
        stored = store_claude_archive_file(export_path, archive_index, filename, file_uuid) if export_path else None
        extracted.append(
            {
                "filename": filename,
                "mime_type": stored.get("mime_type") if stored else detect_mime_type(filename, b""),
                "blob_path": stored.get("blob_path") if stored else None,
                "sha256": stored.get("sha256") if stored else None,
                "metadata": {
                    "source": "claude_attachment",
                    "file_uuid": file_uuid,
                    "file_size": stored.get("file_size") if stored else attachment.get("file_size"),
                    "file_type": attachment.get("file_type"),
                    "extracted_content": attachment.get("extracted_content"),
                    "archive_path": stored.get("archive_path") if stored else None,
                },
            }
        )
    for file_item in message.get("files") or []:
        if not isinstance(file_item, dict):
            continue
        filename = str(file_item.get("file_name") or "file").strip() or "file"
        file_uuid = file_item.get("file_uuid")
        stored = store_claude_archive_file(export_path, archive_index, filename, file_uuid) if export_path else None
        extracted.append(
            {
                "filename": filename,
                "mime_type": stored.get("mime_type") if stored else detect_mime_type(filename, b""),
                "blob_path": stored.get("blob_path") if stored else None,
                "sha256": stored.get("sha256") if stored else None,
                "metadata": {
                    "source": "claude_file_reference",
                    "file_uuid": file_uuid,
                    "file_size": stored.get("file_size") if stored else None,
                    "archive_path": stored.get("archive_path") if stored else None,
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
    if text in {"assistant", "model", "gemini", "bard", "bot", "chatgpt", "ai"}:
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
