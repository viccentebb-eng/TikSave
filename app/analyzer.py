from __future__ import annotations

import copy
import html
import ipaddress
import re
import socket
import threading
import time
import urllib.request
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

from app.dezoom import status as dezoom_status
from app.downloader import TikSaveDownloader, detect_platform
from app.native_image import status as native_image_status


USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0"
MAX_HTML_BYTES = 3_000_000
ANALYZE_CACHE_TTL = 300.0
_ANALYZE_CACHE: dict[tuple[str, bool], tuple[float, dict[str, Any]]] = {}
_ANALYZE_LOCK = threading.Lock()
IMAGE_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)", re.I)
VIDEO_EXT_RE = re.compile(r"\.(?:mp4|webm|mov|mkv)(?:[?#]|$)", re.I)
AUDIO_EXT_RE = re.compile(r"\.(?:mp3|m4a|aac|ogg|opus|wav|flac)(?:[?#]|$)", re.I)
HLS_RE = re.compile(r"\.m3u8(?:[?#]|$)", re.I)
DASH_RE = re.compile(r"\.mpd(?:[?#]|$)", re.I)
ZOOM_PATTERNS = (
    ("IIIF", re.compile(r"/info\.json(?:[?#]|$)", re.I)),
    ("Deep Zoom", re.compile(r"\.dzi(?:[?#]|$)", re.I)),
    ("Zoomify", re.compile(r"/ImageProperties\.xml(?:[?#]|$)", re.I)),
    ("IIIF manifest", re.compile(r"/manifest(?:\.json)?(?:[?#]|$)", re.I)),
)


def _public_http_url(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()

    if parsed.scheme not in {"http", "https"} or not host:
        raise ValueError("El enlace debe comenzar con http:// o https://")

    if host in {"localhost", "localhost.localdomain"}:
        raise ValueError("No se permiten direcciones locales.")

    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("No se permiten direcciones privadas o locales.")
    except ValueError as exc:
        if "No se permiten" in str(exc):
            raise

    return value


def _safe_remote_host(url: str) -> None:
    host = urlparse(url).hostname
    if not host:
        raise ValueError("El enlace no tiene un host válido.")

    try:
        addresses = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return

    for address in addresses:
        raw = address[4][0]
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("El enlace resolvió a una dirección local o privada.")


class PageParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title = ""
        self._in_title = False
        self.meta: dict[str, str] = {}
        self.images: list[dict[str, Any]] = []
        self.media: list[str] = []
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {str(k).lower(): (v or "") for k, v in attrs}

        if tag == "title":
            self._in_title = True
            return

        if tag == "meta":
            key = (
                values.get("property")
                or values.get("name")
                or values.get("itemprop")
                or ""
            ).strip().lower()
            content = values.get("content", "").strip()
            if key and content:
                self.meta[key] = content
            return

        if tag == "img":
            sources: list[tuple[str, int]] = []
            src = values.get("src") or values.get("data-src") or values.get("data-original")
            if src:
                sources.append((src, 0))

            srcset = values.get("srcset") or values.get("data-srcset")
            if srcset:
                for item in srcset.split(","):
                    pieces = item.strip().split()
                    if not pieces:
                        continue
                    score = 0
                    if len(pieces) > 1:
                        descriptor = pieces[1].lower()
                        try:
                            if descriptor.endswith("w"):
                                score = int(float(descriptor[:-1]))
                            elif descriptor.endswith("x"):
                                score = int(float(descriptor[:-1]) * 1000)
                        except ValueError:
                            score = 0
                    sources.append((pieces[0], score))

            width = _number(values.get("width"))
            height = _number(values.get("height"))
            alt = values.get("alt", "").strip()

            for source, srcset_score in sources:
                url = _absolute(self.base_url, source)
                if not url:
                    continue
                self.images.append({
                    "url": url,
                    "width": width,
                    "height": height,
                    "alt": alt,
                    "score": max(width * height // 1000, srcset_score),
                    "source": "img",
                })
            return

        if tag in {"video", "audio", "source"}:
            src = values.get("src")
            if src:
                url = _absolute(self.base_url, src)
                if url:
                    self.media.append(url)
            poster = values.get("poster")
            if poster:
                url = _absolute(self.base_url, poster)
                if url:
                    self.images.append({
                        "url": url,
                        "width": 0,
                        "height": 0,
                        "alt": "",
                        "score": 80,
                        "source": "poster",
                    })
            return

        if tag in {"a", "link", "iframe", "script"}:
            raw = values.get("href") or values.get("src")
            if raw:
                url = _absolute(self.base_url, raw)
                if url:
                    self.links.append(url)

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data


def _number(value: str | None) -> int:
    try:
        return max(0, int(float(str(value or "0").replace("px", ""))))
    except ValueError:
        return 0


def _absolute(base: str, raw: str | None) -> str | None:
    if not raw:
        return None
    raw = html.unescape(raw.strip())
    if raw.startswith(("data:", "blob:", "javascript:", "#")):
        return None
    try:
        value = urljoin(base, raw)
    except ValueError:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        return None
    return value


def _dedupe(items: list[dict[str, Any]], key: str = "url", limit: int = 50) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        value = str(item.get(key) or "")
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def _request_page(url: str) -> tuple[str, str, bytes, str]:
    _safe_remote_host(url)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,image/*,video/*,*/*;q=0.8",
            "Accept-Language": "es-MX,es;q=0.9,en;q=0.7",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        final_url = response.geturl()
        content_type = (response.headers.get_content_type() or "application/octet-stream").lower()
        charset = response.headers.get_content_charset() or "utf-8"
        body = response.read(MAX_HTML_BYTES + 1)

    if len(body) > MAX_HTML_BYTES:
        body = body[:MAX_HTML_BYTES]

    return final_url, content_type, body, charset


def _meta_image(parser: PageParser, final_url: str) -> list[dict[str, Any]]:
    keys = (
        "og:image",
        "og:image:url",
        "twitter:image",
        "twitter:image:src",
        "image",
        "thumbnail",
        "thumbnailurl",
    )
    out: list[dict[str, Any]] = []
    for index, key in enumerate(keys):
        raw = parser.meta.get(key)
        url = _absolute(final_url, raw)
        if not url:
            continue
        out.append({
            "url": url,
            "width": 0,
            "height": 0,
            "alt": "",
            "score": 900 - index * 10,
            "source": key,
        })
    return out


def _extract_urls(text: str, final_url: str) -> list[str]:
    candidates: list[str] = []
    normalized = (
        text.replace("\\/", "/")
        .replace("\\u0026", "&")
        .replace("\\u003d", "=")
        .replace("\\u003D", "=")
        .replace("\\u002f", "/")
        .replace("\\u002F", "/")
        .replace("\\u003a", ":")
        .replace("\\u003A", ":")
    )

    patterns = [
        r'https?://[^"\'<>\\\s]+',
        r'//[^"\'<>\\\s]+(?:\.m3u8|\.mpd|/info\.json|\.dzi|/ImageProperties\.xml)[^"\'<>\\\s]*',
    ]
    for pattern in patterns:
        for match in re.findall(pattern, normalized, flags=re.I):
            value = str(match)
            if value.startswith("//"):
                value = f"{urlparse(final_url).scheme}:{value}"
            value = html.unescape(value)
            if value.startswith(("http://", "https://")):
                candidates.append(value.rstrip("\\,;)]}"))
    return candidates


def _classify_generic(url: str, final_url: str, content_type: str, body: bytes, charset: str) -> dict[str, Any]:
    host = (urlparse(final_url).hostname or "").lower()
    result: dict[str, Any] = {
        "url": url,
        "final_url": final_url,
        "platform": "web",
        "host": host,
        "title": host or "Contenido web",
        "thumbnail": None,
        "kind": "page",
        "capabilities": [],
        "images": [],
        "media": [],
        "zoom_sources": [],
        "subtitle_tracks": [],
        "engine": {
            "native_image": native_image_status(),
            "dezoomify": dezoom_status(),
        },
    }

    if content_type.startswith("image/") or IMAGE_EXT_RE.search(final_url):
        result["kind"] = "image"
        result["thumbnail"] = final_url
        result["images"] = [{"url": final_url, "score": 1000, "source": "direct"}]
        result["capabilities"] = [
            {"id": "image_download", "label": "Descargar imagen", "available": True},
            {
                "id": "image_max",
                "label": "Buscar original / máxima resolución",
                "available": True,
                "needs_install": False,
                "source_url": final_url,
            },
        ]
        return result

    if content_type.startswith("video/") or VIDEO_EXT_RE.search(final_url) or HLS_RE.search(final_url) or DASH_RE.search(final_url):
        result["kind"] = "video"
        result["media"] = [{"url": final_url, "type": "video"}]
        result["capabilities"] = [
            {"id": "web_video", "label": "Descargar video", "available": True, "source_url": final_url},
            {"id": "web_audio", "label": "Solo audio", "available": True, "source_url": final_url},
        ]
        return result

    if content_type.startswith("audio/") or AUDIO_EXT_RE.search(final_url):
        result["kind"] = "audio"
        result["media"] = [{"url": final_url, "type": "audio"}]
        result["capabilities"] = [
            {"id": "web_audio", "label": "Descargar audio", "available": True, "source_url": final_url},
        ]
        return result

    text = body.decode(charset, errors="replace")
    parser = PageParser(final_url)
    try:
        parser.feed(text)
    except Exception:
        pass

    title = (
        parser.meta.get("og:title")
        or parser.meta.get("twitter:title")
        or parser.title.strip()
        or host
        or "Contenido web"
    )
    result["title"] = re.sub(r"\s+", " ", title).strip()[:220]

    images = _meta_image(parser, final_url) + parser.images
    embedded_urls = parser.links + parser.media + _extract_urls(text, final_url)

    for candidate in embedded_urls:
        lower = candidate.lower()
        if IMAGE_EXT_RE.search(candidate) or "googleusercontent.com" in lower or "ggpht.com" in lower:
            images.append({
                "url": candidate,
                "width": 0,
                "height": 0,
                "alt": "",
                "score": 120 if "googleusercontent.com" in lower else 50,
                "source": "page",
            })

    def image_rank(item: dict[str, Any]) -> int:
        value = str(item.get("url") or "").lower()
        alt = str(item.get("alt") or "").lower()
        score = int(item.get("score") or 0)
        if any(token in value or token in alt for token in (
            "logo", "favicon", "avatar", "profile", "icon", "badge",
            "google-play", "app-store", "qr", "sprite",
        )):
            score -= 700
        width = int(item.get("width") or 0)
        height = int(item.get("height") or 0)
        if width and height and (width < 180 or height < 180):
            score -= 400
        return score

    images.sort(key=image_rank, reverse=True)
    images = [item for item in _dedupe(images, limit=50) if image_rank(item) > -250][:30]
    result["images"] = images
    if images:
        result["thumbnail"] = images[0]["url"]

    media: list[dict[str, Any]] = []
    zoom: list[dict[str, Any]] = []
    for candidate in embedded_urls:
        if HLS_RE.search(candidate):
            media.append({"url": candidate, "type": "hls", "score": _stream_score(candidate)})
        elif DASH_RE.search(candidate):
            media.append({"url": candidate, "type": "dash", "score": _stream_score(candidate)})
        elif VIDEO_EXT_RE.search(candidate):
            media.append({"url": candidate, "type": "video", "score": 100})
        elif AUDIO_EXT_RE.search(candidate):
            media.append({"url": candidate, "type": "audio", "score": 60})

        for kind, pattern in ZOOM_PATTERNS:
            if pattern.search(candidate):
                zoom.append({"url": candidate, "kind": kind, "score": 200})

    media.sort(key=lambda item: int(item.get("score") or 0), reverse=True)
    zoom.sort(key=lambda item: int(item.get("score") or 0), reverse=True)
    result["media"] = _dedupe(media, limit=15)
    result["zoom_sources"] = _dedupe(zoom, limit=15)

    capabilities: list[dict[str, Any]] = []

    best_video = next(
        (item for item in result["media"] if item["type"] in {"hls", "dash", "video"} and int(item.get("score") or 0) >= 0),
        None,
    )
    if best_video:
        capabilities.extend([
            {
                "id": "web_video",
                "label": "Descargar video",
                "available": True,
                "source_url": best_video["url"],
                "source_type": best_video["type"],
            },
            {
                "id": "web_audio",
                "label": "Solo audio",
                "available": True,
                "source_url": best_video["url"],
            },
        ])

    if images:
        capabilities.append({
            "id": "images",
            "label": f"Descargar imágenes ({len(images)})",
            "available": True,
        })
        capabilities.append({
            "id": "image_max",
            "label": "Buscar original / máxima resolución",
            "available": True,
            "needs_install": False,
            "source_url": images[0]["url"],
        })

    if result["zoom_sources"]:
        capabilities.append({
            "id": "dezoom",
            "label": "Reconstruir imagen por mosaicos",
            "available": True,
            "needs_install": not bool(result["engine"]["dezoomify"].get("installed")),
            "source_url": result["zoom_sources"][0]["url"],
        })

    # Google Arts & Culture often exposes regular Google-hosted preview images even
    # when the page itself does not expose an IIIF/DeepZoom descriptor.
    if "artsandculture.google.com" in host and images:
        result["kind"] = "artwork"
        result["notes"] = [
            "Google Arts & Culture detectado.",
            "TikSave Native Image prueba variantes de mayor resolución sobre las imágenes Google/Googleusercontent encontradas; si aparece un descriptor de mosaicos también se ofrece Dezoomify.",
        ]

    result["capabilities"] = capabilities
    return result


def _stream_score(url: str) -> int:
    lower = url.lower()
    score = 80
    if re.search(r"(?:master|manifest|playlist)[^/]*\.m3u8", lower):
        score += 220
    if re.search(r"(?:index-v\d+|video|avc|h264|h265|hevc|1080|720|2160|1440)", lower):
        score += 100
    if re.search(r"(?:index-a\d+|audio|aac|opus|m4a)(?:[?&/_.-]|$)", lower):
        score -= 300
    return score


def _cache_get(url: str, playlist: bool) -> dict[str, Any] | None:
    key = (url, bool(playlist))
    now = time.monotonic()
    with _ANALYZE_LOCK:
        item = _ANALYZE_CACHE.get(key)
        if not item:
            return None
        created, value = item
        if now - created > ANALYZE_CACHE_TTL:
            _ANALYZE_CACHE.pop(key, None)
            return None
        return copy.deepcopy(value)


def _cache_put(url: str, playlist: bool, value: dict[str, Any]) -> dict[str, Any]:
    key = (url, bool(playlist))
    with _ANALYZE_LOCK:
        _ANALYZE_CACHE[key] = (time.monotonic(), copy.deepcopy(value))
        if len(_ANALYZE_CACHE) > 128:
            oldest = min(_ANALYZE_CACHE.items(), key=lambda item: item[1][0])[0]
            _ANALYZE_CACHE.pop(oldest, None)
    return value


def _platform_result(
    url: str,
    platform: str,
    downloader: TikSaveDownloader,
    playlist: bool,
) -> dict[str, Any]:
    info = downloader.inspect(url, playlist=playlist)
    info["host"] = urlparse(url).hostname
    info["kind"] = "media"
    info["engine"] = {
        "native_image": native_image_status(),
        "dezoomify": dezoom_status(),
    }

    capabilities: list[dict[str, Any]] = [
        {"id": "video", "label": "Descargar MP4", "available": True},
        {"id": "mp3", "label": "Descargar MP3", "available": True},
        {"id": "audio", "label": "Solo audio", "available": True},
    ]
    if info.get("subtitles"):
        capabilities.append({
            "id": "subtitles",
            "label": f"Subtítulos ({len(info['subtitles'])} idiomas)",
            "available": True,
        })
    if info.get("is_playlist"):
        capabilities.append({
            "id": "playlist",
            "label": f"Lista / colección ({info.get('entry_count') or 'varios'})",
            "available": True,
        })
    if info.get("entries") and len(info["entries"]) > 1:
        capabilities.append({
            "id": "selection",
            "label": f"Elegir elementos ({len(info['entries'])})",
            "available": True,
        })

    info["capabilities"] = capabilities
    return info


def analyze(url: str, downloader: TikSaveDownloader, playlist: bool = False) -> dict[str, Any]:
    url = _public_http_url(url)

    cached = _cache_get(url, playlist)
    if cached is not None:
        cached["cached"] = True
        return cached

    platform = detect_platform(url)

    if platform:
        try:
            result = _platform_result(url, platform, downloader, playlist)
            result["cached"] = False
            return _cache_put(url, playlist, result)
        except Exception as extractor_error:
            # A platform extractor can fail even when the browser can still render
            # useful public metadata/images. Fall back to generic page analysis so
            # the UI does not collapse into a single red error.
            try:
                final_url, content_type, body, charset = _request_page(url)
                result = _classify_generic(url, final_url, content_type, body, charset)
                result["platform"] = platform
                result["extractor_error"] = str(extractor_error)
                result.setdefault("notes", [])
                result["notes"].append(
                    "El extractor directo no pudo analizar este enlace. TikSave mostró lo que pudo detectar desde la página pública."
                )
                if platform == "instagram":
                    result["notes"].append(
                        "Si es una Story o contenido que requiere sesión, abre el contenido en Firefox y usa la extensión de TikSave para aprovechar tu sesión ya iniciada."
                    )
                result["cached"] = False
                return _cache_put(url, playlist, result)
            except Exception:
                raise extractor_error

    final_url, content_type, body, charset = _request_page(url)
    result = _classify_generic(url, final_url, content_type, body, charset)
    result["cached"] = False
    return _cache_put(url, playlist, result)
