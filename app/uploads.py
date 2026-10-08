"""Subida de archivos locales a la Biblioteca (se guardan en <descargas>/Subidos)."""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from app.library import EXT_KIND

MAX_UPLOAD_BYTES = 4 * 1024 ** 3  # 4 GB por archivo
UPLOAD_DIR = "Subidos"


def safe_name(name: str) -> str:
    """Solo el nombre del archivo, sin rutas ni caracteres raros; conserva la extension."""
    base = Path(name.replace("\\", "/")).name
    stem, dot, ext = base.rpartition(".") if "." in base else (base, "", "")
    stem = re.sub(r"[^\w\- ()\[\]]+", "_", stem).strip(" .")[:120] or "archivo"
    ext = re.sub(r"[^A-Za-z0-9]", "", ext).lower()
    return f"{stem}.{ext}" if ext else stem


def is_allowed(name: str) -> bool:
    ext = name.rpartition(".")[2].lower() if "." in name else ""
    return f".{ext}" in EXT_KIND


def unique_target(folder: Path, name: str) -> Path:
    target = folder / name
    if not target.exists():
        return target
    stem, dot, ext = name.rpartition(".") if "." in name else (name, "", "")
    return folder / f"{stem} {uuid.uuid4().hex[:6]}{dot}{ext}"


def save_upload(download_dir: Path, filename: str, stream, max_bytes: int = MAX_UPLOAD_BYTES) -> Path:
    """Escribe el archivo en disco por trozos, con limite de tamano. Lanza ValueError si no se acepta."""
    if not is_allowed(filename):
        raise ValueError("Tipo de archivo no soportado (video, audio, imagen, PDF, Word, Excel, texto).")
    folder = download_dir / UPLOAD_DIR
    folder.mkdir(parents=True, exist_ok=True)
    target = unique_target(folder, safe_name(filename))
    size = 0
    try:
        with target.open("wb") as fh:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("El archivo supera el límite de 4 GB.")
                fh.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    if size == 0:
        target.unlink(missing_ok=True)
        raise ValueError("El archivo está vacío.")
    return target
