"""Miniaturas de la Biblioteca: fotograma de los videos y portada de los audios (cache en disco)."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path

from app.library import EXT_KIND, resolve_inside

THUMB_DIR = ".thumbs"


def thumb_path(download_dir: Path, rel: str) -> Path:
    source = resolve_inside(download_dir, rel)
    if not source.is_file() or EXT_KIND.get(source.suffix.lower()) not in {"video", "audio"}:
        raise ValueError("Solo hay miniatura para videos y audios.")
    stamp = f"{source.stat().st_mtime_ns}:{source.stat().st_size}"
    key = hashlib.sha1(f"{rel}|{stamp}".encode("utf-8")).hexdigest()
    return download_dir / THUMB_DIR / f"{key}.jpg"


def ensure_thumb(download_dir: Path, rel: str) -> Path | None:
    """Crea la miniatura si no existe. Devuelve None si no se pudo (sin FFmpeg o sin imagen)."""
    target = thumb_path(download_dir, rel)
    if target.exists():
        return target
    if not shutil.which("ffmpeg"):
        return None
    source = resolve_inside(download_dir, rel)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Videos: un fotograma al 10% (minimo 1 s). Audios: la portada incrustada, si la tiene.
    if EXT_KIND.get(source.suffix.lower()) == "video":
        seek = ["-ss", "1"]
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *seek, "-i", str(source), "-frames:v", "1",
               "-vf", "scale=480:-2", "-q:v", "4", str(target)]
    else:
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-map", "0:v:0", "-frames:v", "1",
               "-vf", "scale=480:-2", "-q:v", "4", str(target)]
    try:
        subprocess.run(cmd, capture_output=True, timeout=60)
    except subprocess.SubprocessError:
        pass
    if target.exists() and target.stat().st_size > 0:
        return target
    target.unlink(missing_ok=True)
    return None
