"""Cookies del usuario para descargar/capturar contenido que exige sesion.

Solo se usan en esta computadora: se leen del navegador (Firefox, Chrome...) o llegan desde la extension por
127.0.0.1, se escriben en un archivo temporal 0600 durante el trabajo y se borran al terminar. Nunca se guardan
en el historial ni en los ajustes."""
from __future__ import annotations

import http.cookiejar
import os
import time
from pathlib import Path
from urllib.parse import urlparse

from yt_dlp.cookies import YoutubeDLCookieJar, extract_cookies_from_browser

BROWSERS = ("firefox", "chrome", "edge", "brave", "chromium", "opera", "vivaldi", "safari")
# Orden en que se prueban cuando la opcion es "auto": el primero con sesion legible gana.
AUTO_ORDER = ("chrome", "edge", "firefox", "brave", "opera", "vivaldi")
_auto: dict[str, object] = {"at": 0.0, "name": None}
MAX_COOKIES = 600
_cache: dict[str, tuple[float, YoutubeDLCookieJar]] = {}


def jar_from_items(items: list[dict]) -> YoutubeDLCookieJar:
    """Lista [{name, value, domain, path, secure, expires, httpOnly}] (formato de cookies.getAll) -> jar."""
    jar = YoutubeDLCookieJar()
    for it in items[:MAX_COOKIES]:
        name, value, domain = str(it.get("name") or ""), str(it.get("value") or ""), str(it.get("domain") or "").strip()
        if not name or not domain:
            continue
        expires = it.get("expires")
        jar.set_cookie(http.cookiejar.Cookie(
            0, name, value, None, False, domain, True, domain.startswith("."), it.get("path") or "/", True,
            bool(it.get("secure")), int(expires) if expires else None, not expires, None, None,
            {"HttpOnly": None} if it.get("httpOnly") else {}))
    return jar


def write_cookie_file(items: list[dict], directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{name}.cookies.txt"
    jar_from_items(items).save(str(path), ignore_discard=True, ignore_expires=True)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def browser_jar(browser: str, ttl: float = 60.0) -> YoutubeDLCookieJar | None:
    """Cookies del perfil activo del navegador (con cache corto para no leer la base de datos en cada peticion)."""
    browser = (browser or "").strip().lower()
    if not browser:
        return None
    if browser not in BROWSERS:
        raise ValueError(f"Navegador no soportado: {browser}")
    cached = _cache.get(browser)
    if cached and time.time() - cached[0] < ttl:
        return cached[1]
    try:
        jar = extract_cookies_from_browser(browser)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"No pude leer las cookies de {browser}: {str(exc)[:160]}") from exc
    _cache[browser] = (time.time(), jar)
    return jar


def auto_browser(ttl: float = 300.0) -> str | None:
    """Primer navegador de AUTO_ORDER cuyas cookies se pueden leer; None si ninguno. Nunca lanza error."""
    if time.time() - float(_auto["at"]) < ttl:
        return _auto["name"]  # type: ignore[return-value]
    found = None
    for name in AUTO_ORDER:
        try:
            if browser_jar(name, ttl=ttl) is not None:
                found = name
                break
        except Exception:  # noqa: BLE001 - no instalado, bloqueado o sin perfil: se prueba el siguiente
            continue
    _auto.update(at=time.time(), name=found)
    return found


def jar_for_setting(setting: str) -> YoutubeDLCookieJar | None:
    """Cookies segun el ajuste. 'auto' nunca falla: si no hay sesion disponible devuelve None."""
    if setting == "auto":
        name = auto_browser()
        return browser_jar(name) if name else None
    return browser_jar(setting)


def clear_cache() -> None:
    _cache.clear()
    _auto.update(at=0.0, name=None)


def cookies_for_url(jar: http.cookiejar.CookieJar | None, url: str) -> list[dict]:
    """Cookies del jar que corresponden al host de `url`, en el formato de Playwright."""
    host = (urlparse(url).hostname or "").lower()
    out = []
    for c in jar or []:
        domain = c.domain.lstrip(".").lower()
        if host == domain or host.endswith("." + domain):
            out.append({"name": c.name, "value": c.value or "", "domain": c.domain, "path": c.path or "/",
                        "secure": bool(c.secure), "expires": float(c.expires) if c.expires else -1})
    return out
