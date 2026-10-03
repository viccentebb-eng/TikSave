"""Subtitulos -> texto limpio y fichas Markdown (pensadas para pegar en Claude/ChatGPT)."""
from __future__ import annotations

import re
from datetime import datetime

_TS = re.compile(r"^\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}.*$")
_TAG = re.compile(r"<[^>]+>")


def subtitles_to_text(raw: str) -> str:
    """Convierte SRT/VTT en texto corrido sin tiempos ni lineas repetidas."""
    lines: list[str] = []
    for line in raw.replace("\ufeff", "").splitlines():
        s = line.strip()
        if not s or s.isdigit() or _TS.match(s):
            continue
        if s.startswith(("WEBVTT", "NOTE", "STYLE", "Kind:", "Language:")):
            continue
        s = _TAG.sub("", s).replace("&nbsp;", " ").replace("&amp;", "&").strip()
        if s and (not lines or lines[-1] != s):
            lines.append(s)
    return re.sub(r"\s+", " ", " ".join(lines)).strip()


def format_duration(seconds: float | int | None) -> str | None:
    if not seconds:
        return None
    seconds = int(seconds)
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _date(value: str | None) -> str | None:
    if value and re.fullmatch(r"\d{8}", value):
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value


def _yaml(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def build_notes(info: dict, site: str, transcript: str | None, transcript_source: str | None = None) -> str:
    desc = (info.get("description") or info.get("title") or "").strip()
    title = (info.get("title") or desc or "Sin titulo").strip().splitlines()[0][:140]
    uploader = info.get("uploader") or info.get("channel") or info.get("creator")
    tags = sorted({t.lstrip("#") for t in re.findall(r"#[\w\u00C0-\u024F]+", desc)})
    fm = [
        "---",
        f"title: {_yaml(title)}",
        f"source: {info.get('webpage_url') or info.get('original_url') or ''}",
        f"platform: {site}",
    ]
    if uploader:
        fm.append(f"author: {_yaml(str(uploader))}")
    if _date(info.get("upload_date")):
        fm.append(f"published: {_date(info.get('upload_date'))}")
    if format_duration(info.get("duration")):
        fm.append(f"duration: {format_duration(info.get('duration'))}")
    for key, label in (("view_count", "views"), ("like_count", "likes"), ("comment_count", "comments")):
        if info.get(key) is not None:
            fm.append(f"{label}: {info[key]}")
    if info.get("track"):
        fm.append(f"music: {_yaml(str(info['track']))}")
    if tags:
        fm.append("tags: [" + ", ".join(tags) + "]")
    fm.append(f"saved: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    fm.append("---")

    body = [f"# {title}", ""]
    if desc:
        body += ["## Descripcion", "", desc, ""]
    body += ["## Transcripcion", ""]
    if transcript:
        if transcript_source:
            body += [f"_Fuente: {transcript_source}_", ""]
        body += [transcript, ""]
    else:
        body += ["_No hay subtitulos ni transcripcion disponibles para este contenido._", ""]
    return "\n".join(fm + [""] + body)
