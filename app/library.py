"""Biblioteca: lista y gestiona lo guardado en la carpeta de descargas."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import platform
from pathlib import Path

KINDS = {
    "video": {".mp4", ".webm", ".mkv", ".mov"},
    "audio": {".mp3", ".m4a", ".opus", ".ogg", ".wav", ".aac"},
    "image": {".jpg", ".jpeg", ".png", ".webp", ".gif"},
    "text": {".md", ".txt", ".srt", ".vtt", ".json"},
    "page": {".html", ".htm", ".pdf"},
}
EXT_KIND = {ext: kind for kind, exts in KINDS.items() for ext in exts}
LANG_SUFFIX = re.compile(r"\.[a-z]{2,3}(?:-[A-Za-z0-9]+)?$")


def resolve_inside(base: Path, rel: str) -> Path:
    """Resuelve `rel` dentro de `base`; lanza ValueError si intenta salir (../)."""
    target = (base / rel).resolve()
    if base.resolve() != target and base.resolve() not in target.parents:
        raise ValueError("Ruta fuera de la carpeta de TikSave.")
    return target


def _group_key(path: Path) -> str:
    stem = path.name[: -len(path.suffix)] if path.suffix else path.name
    if path.suffix.lower() in {".srt", ".vtt"}:
        stem = LANG_SUFFIX.sub("", stem)
    return f"{path.parent}/{stem}"


def list_library(base: Path, limit: int = 400) -> list[dict]:
    base = base.resolve()
    files: list[Path] = []
    for root, dirs, names in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        depth = len(Path(root).relative_to(base).parts)
        if depth > 4:
            dirs[:] = []
        for name in names:
            p = Path(root) / name
            if not name.startswith(".") and p.suffix.lower() in EXT_KIND:
                files.append(p)
    groups: dict[str, list[Path]] = {}
    for p in files:
        parent_is_capture = "Sitios" in p.relative_to(base).parts[:1]
        key = f"{p.parent}" if parent_is_capture else _group_key(p)
        groups.setdefault(key, []).append(p)

    items = []
    for key, members in groups.items():
        members.sort(key=lambda p: (EXT_KIND[p.suffix.lower()] not in {"video", "audio", "page"}, p.name))
        main = members[0]
        is_capture = "Sitios" in main.relative_to(base).parts[:1]
        primary = next((m for m in members if EXT_KIND[m.suffix.lower()] in {"video", "audio"}), None)
        if is_capture:
            primary = next((m for m in members if m.suffix.lower() == ".md"), main)
        elif primary is None:  # sin video/audio: preferir ficha o texto antes que la portada
            primary = next((m for m in members if m.suffix.lower() in {".md", ".txt"}), main)
        cover = next((m for m in members if EXT_KIND[m.suffix.lower()] == "image" and m != primary), None)
        stats = [m.stat() for m in members]
        items.append({
            "id": str(Path(key).relative_to(base)) if Path(key).is_absolute() else key,
            "name": (primary.name[: -len(primary.suffix)] if primary.suffix else primary.name),
            "type": "site" if is_capture else EXT_KIND[primary.suffix.lower()],
            "platform": primary.relative_to(base).parts[0] if len(primary.relative_to(base).parts) > 1 else None,
            "modified": max(s.st_mtime for s in stats),
            "size": sum(s.st_size for s in stats),
            "snippet": next((_snippet(m) for m in members if m.suffix.lower() in {".md", ".txt"}), None),
            "cover": str(cover.relative_to(base)) if cover else (
                str(primary.relative_to(base)) if EXT_KIND[primary.suffix.lower()] == "image" else None),
            "files": [{"path": str(m.relative_to(base)), "name": m.name, "kind": EXT_KIND[m.suffix.lower()],
                       "size": m.stat().st_size} for m in members],
        })
    items.sort(key=lambda i: i["modified"], reverse=True)
    return items[:limit]


def _snippet(path: Path, limit: int = 220) -> str | None:
    """Primeras lineas utiles de un .md/.txt (sin front matter ni titulos) para la tarjeta."""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")[:6000]
    except OSError:
        return None
    if text.startswith("---"):
        end = text.find("\n---", 3)
        text = text[end + 4:] if end != -1 else text
    lines = [ln.strip(" #>*-") for ln in text.splitlines() if ln.strip() and not ln.strip().startswith(("![", "```"))]
    out = " ".join(lines)
    out = re.sub(r"\s+", " ", out).strip()
    return (out[:limit].rstrip() + "...") if len(out) > limit else (out or None)


def delete_files(base: Path, rels: list[str]) -> int:
    count = 0
    for rel in rels:
        target = resolve_inside(base, rel)
        if target == base.resolve():
            raise ValueError("No se puede borrar la carpeta principal.")
        if target.is_file():
            target.unlink()
            count += 1
        # limpia carpetas de captura vacias
        parent = target.parent
        if parent != base.resolve() and parent.exists() and parent.parent.name == "Sitios" and not any(parent.iterdir()):
            parent.rmdir()
        elif parent != base.resolve() and parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
    return count


def open_in_os(path: Path, reveal: bool = False) -> None:
    system = platform.system()
    if system == "Windows":
        if reveal and path.is_file():
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(path if path.is_dir() or not reveal else path.parent)  # type: ignore[attr-defined]
    elif system == "Darwin":
        subprocess.Popen(["open", "-R", str(path)] if reveal and path.is_file() else ["open", str(path)])
    else:
        opener = shutil.which("xdg-open")
        if not opener:
            raise RuntimeError("No se encontro xdg-open para abrir la carpeta.")
        subprocess.Popen([opener, str(path.parent if path.is_file() else path)])
