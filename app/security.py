"""Validacion de URLs: sitios soportados para descarga y proteccion SSRF para captura."""
from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlparse

# Plataformas publicas que yt-dlp sabe descargar. TikTok es la principal.
SUPPORTED_SITES: dict[str, tuple[str, ...]] = {
    "TikTok": ("tiktok.com",),
    "YouTube": ("youtube.com", "youtu.be"),
    "Instagram": ("instagram.com",),
    "X": ("x.com", "twitter.com"),
    "Facebook": ("facebook.com", "fb.watch"),
    "Reddit": ("reddit.com", "redd.it"),
    "Vimeo": ("vimeo.com",),
    "Twitch": ("twitch.tv", "clips.twitch.tv"),
    "Pinterest": ("pinterest.com", "pin.it"),
}


def _host(value: str) -> str:
    return (urlparse(value).hostname or "").lower().rstrip(".")


def site_for_url(value: str) -> str | None:
    host = _host(value)
    for site, domains in SUPPORTED_SITES.items():
        if any(host == d or host.endswith("." + d) for d in domains):
            return site
    return None


def validate_media_url(value: str) -> tuple[str, str]:
    """Devuelve (url_limpia, sitio). Lanza ValueError si no es valida/soportada."""
    value = (value or "").strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("El enlace debe comenzar con http:// o https://")
    site = site_for_url(value)
    if not site:
        names = ", ".join(SUPPORTED_SITES)
        raise ValueError(f"Sitio no soportado para descargar video. Soportados: {names}. "
                         "Para guardar cualquier otra pagina usa la pestana Capturar web.")
    return value, site


def validate_tiktok_url(value: str) -> str:
    """Compatibilidad: solo TikTok."""
    url, site = validate_media_url(value)
    if site != "TikTok":
        raise ValueError("Solo se admiten enlaces de TikTok.")
    return url


def allow_private() -> bool:
    return os.getenv("TIKSAVE_ALLOW_PRIVATE", "").strip() in {"1", "true", "yes"}


def assert_public_host(host: str) -> None:
    """Bloquea localhost / redes privadas / metadatos cloud (SSRF)."""
    if allow_private():
        return
    if not host:
        raise ValueError("URL sin host.")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"No se pudo resolver el dominio '{host}'.") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise ValueError("Por seguridad no se permite capturar direcciones locales o privadas.")


def validate_web_url(value: str) -> str:
    value = (value or "").strip()
    if value and "://" not in value:
        value = "https://" + value
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Escribe una direccion web valida (http o https).")
    assert_public_host(parsed.hostname)
    return value
