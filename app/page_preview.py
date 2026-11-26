"""Vista previa de una pagina web (titulo, descripcion, imagen) para saber que vas a guardar."""
from __future__ import annotations

from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from app.capture import _client, decode_html, safe_get
from app.security import validate_web_url


def preview(url: str) -> dict:
    url = validate_web_url(url)
    with _client() as client:
        content, final, ctype, charset = safe_get(client, url, 2 * 1024 * 1024)
    soup = BeautifulSoup(decode_html(content, charset), "html.parser")

    def meta(*names: str) -> str | None:
        for name in names:
            tag = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
            if tag and tag.get("content"):
                return tag["content"].strip()
        return None

    title = meta("og:title", "twitter:title") or (soup.title.string.strip() if soup.title and soup.title.string else None)
    image = meta("og:image", "twitter:image")
    return {
        "title": (title or final)[:200],
        "description": (meta("og:description", "description") or "")[:300] or None,
        "image": urljoin(final, image) if image else None,
        "site": meta("og:site_name") or httpx.URL(final).host,
        "url": final,
    }
