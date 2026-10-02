from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any


INVALID_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WHITESPACE_RE = re.compile(r"\s+")


def safe_filename(value: str, fallback: str = "chat") -> str:
    value = INVALID_FILENAME_RE.sub("", str(value or ""))
    value = WHITESPACE_RE.sub(" ", value).strip(" .")
    if not value:
        value = fallback
    return value[:120]


def save_chat_markdown(
    output_root: Path,
    *,
    platform: str,
    title: str,
    source_url: str,
    markdown: str,
    message_count: int | None = None,
) -> dict[str, Any]:
    platform_key = str(platform or "").strip().lower()
    labels = {
        "chatgpt": "ChatGPT",
        "gemini": "Gemini",
    }

    if platform_key not in labels:
        raise ValueError("Plataforma de chat no compatible.")

    body = str(markdown or "").strip()
    if not body:
        raise ValueError("La conversación no contiene texto para exportar.")

    folder = output_root / "Chats" / labels[platform_key]
    folder.mkdir(parents=True, exist_ok=True)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    filename = f"{stamp} - {safe_filename(title, labels[platform_key])}.md"
    path = folder / filename

    metadata = [
        "---",
        f'title: "{str(title or labels[platform_key]).replace(chr(34), chr(39))}"',
        f"platform: {labels[platform_key]}",
        f'source: "{str(source_url).replace(chr(34), "%22")}"',
        f"exported_at: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
    ]
    if message_count is not None:
        metadata.append(f"messages: {max(0, int(message_count))}")
    metadata.extend(["---", ""])

    path.write_text(
        "\n".join(metadata) + body.rstrip() + "\n",
        encoding="utf-8",
    )

    return {
        "ok": True,
        "platform": platform_key,
        "title": title,
        "path": str(path),
        "filename": filename,
        "message_count": message_count,
    }
