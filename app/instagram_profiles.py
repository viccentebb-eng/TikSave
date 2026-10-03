from __future__ import annotations

import copy
import threading
import time
from typing import Any
from urllib.parse import urlparse, urlunparse


_LOCK = threading.Lock()
_SCANS: dict[str, tuple[float, dict[str, Any]]] = {}
TTL_SECONDS = 30 * 60


def normalize_profile_url(value: str) -> str:
    parsed = urlparse(str(value).strip())
    host = (parsed.hostname or "").lower()
    if host in {"instagram.com", "m.instagram.com"}:
        host = "www.instagram.com"
    path = parsed.path.rstrip("/") + "/"
    return urlunparse(("https", host, path, "", "", ""))


def put_scan(payload: dict[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(payload)
    value["profile_url"] = normalize_profile_url(str(value["profile_url"]))
    value["scanned_at"] = time.time()
    key = value["profile_url"]

    with _LOCK:
        _SCANS[key] = (time.monotonic(), value)
        if len(_SCANS) > 50:
            oldest = min(_SCANS.items(), key=lambda item: item[1][0])[0]
            _SCANS.pop(oldest, None)

    return copy.deepcopy(value)


def get_scan(profile_url: str) -> dict[str, Any] | None:
    key = normalize_profile_url(profile_url)
    now = time.monotonic()

    with _LOCK:
        item = _SCANS.get(key)
        if not item:
            return None
        created, value = item
        if now - created > TTL_SECONDS:
            _SCANS.pop(key, None)
            return None
        return copy.deepcopy(value)
