from __future__ import annotations

import html
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit


URL_RE = re.compile(
    r"https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+",
    re.IGNORECASE,
)
TRAILING_PUNCTUATION = ".,;:!?)]}>，。；：！？）》】」』"
SHORT_REDIRECT_HOSTS = {
    "v.douyin.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "youtu.be",
    "fb.watch",
}
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) "
    "Gecko/20100101 Firefox/156.0"
)


def extract_http_urls(value: str) -> list[str]:
    text = html.unescape(str(value or "")).replace("\\/", "/")
    result: list[str] = []
    seen: set[str] = set()

    for match in URL_RE.finditer(text):
        candidate = match.group(0).rstrip(TRAILING_PUNCTUATION)
        try:
            normalized = canonicalize_http_url(candidate, extract=False)
        except ValueError:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)

    return result


def canonicalize_http_url(value: str, *, extract: bool = True) -> str:
    raw = str(value or "").strip()
    if extract:
        matches = extract_http_urls(raw)
        if not matches:
            raise ValueError("No encontré una URL HTTP/HTTPS válida en el texto pegado.")
        raw = matches[0]

    raw = raw.rstrip(TRAILING_PUNCTUATION)
    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()

    if scheme not in {"http", "https"} or not host:
        raise ValueError("El enlace debe comenzar con http:// o https://")

    if ":" in host and not host.startswith("["):
        host_text = f"[{host}]"
    else:
        host_text = host

    port = parsed.port
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        netloc = f"{host_text}:{port}"
    else:
        netloc = host_text

    return urlunsplit((scheme, netloc, parsed.path or "", parsed.query, ""))


def follow_known_short_url(value: str, timeout: float = 12.0) -> tuple[str, list[str]]:
    initial = canonicalize_http_url(value)
    host = (urlsplit(initial).hostname or "").lower()
    if host not in SHORT_REDIRECT_HOSTS:
        return initial, []

    attempts = (
        ("HEAD", {}),
        ("GET", {"Range": "bytes=0-0"}),
    )

    for method, extra_headers in attempts:
        request = urllib.request.Request(
            initial,
            method=method,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                **extra_headers,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                final = canonicalize_http_url(response.geturl())
            if final != initial:
                return final, [initial, final]
            return initial, []
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError):
            continue

    return initial, []
