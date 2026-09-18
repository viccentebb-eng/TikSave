from __future__ import annotations

import json
import os
import threading
import traceback
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_LOCK = threading.Lock()
_RECENT: deque[dict[str, Any]] = deque(maxlen=200)


def log_path() -> Path:
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home())
        path = base / "TikSave" / "logs" / "tiksave.log"
    else:
        path = Path.home() / ".local" / "share" / "tiksave" / "logs" / "tiksave.log"

    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def write_event(
    component: str,
    action: str,
    *,
    level: str = "info",
    message: str = "",
    details: dict[str, Any] | None = None,
    exc: BaseException | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "time": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "component": component,
        "action": action,
        "message": message,
    }

    if details:
        item["details"] = details

    if exc is not None:
        item["exception"] = {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": "".join(
                traceback.format_exception(type(exc), exc, exc.__traceback__)
            )[-12000:],
        }

    line = json.dumps(item, ensure_ascii=False, default=str)

    with _LOCK:
        _RECENT.append(item)
        path = log_path()
        with path.open("a", encoding="utf-8") as output:
            output.write(line + "\n")

    return item


def recent(limit: int = 50) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 200))
    with _LOCK:
        return list(_RECENT)[-limit:]


def clear_recent() -> None:
    with _LOCK:
        _RECENT.clear()


def snapshot(limit: int = 50) -> dict[str, Any]:
    return {
        "log_path": str(log_path()),
        "events": recent(limit),
    }
