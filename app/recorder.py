"""Grabaciones en tiempo real (videos blob:/MSE): la extension manda trozos WebM y aqui se unen y convierten a MP4."""
from __future__ import annotations

import base64
import binascii
import re
import shutil
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

from app.config import SettingsStore
from app.jobs import JobCancelled, JobStore

MAX_BYTES = 6 * 1024 ** 3  # 6 GB por grabacion


def _safe_name(text: str, fallback: str) -> str:
    text = re.sub(r"\s+", " ", re.sub(r"[\\/:*?\"<>|\r\n]+", " ", text or "")).strip()[:90]
    return text or fallback


class Recorder:
    def __init__(self, settings: SettingsStore, jobs: JobStore, pool: ThreadPoolExecutor) -> None:
        self.settings, self.jobs, self.pool = settings, jobs, pool
        self._state: dict[str, dict] = {}  # id -> {path, size, next_seq, host}
        self._lock = threading.Lock()

    def _tmp_path(self, rec_id: str) -> Path:
        folder = self.settings.download_dir / ".tmp"
        folder.mkdir(parents=True, exist_ok=True)
        return folder / f"rec-{rec_id}.webm"

    def start(self, title: str, page_url: str) -> dict:
        host = re.sub(r"[^\w.-]", "_", (urlparse(page_url).hostname or "grabaciones").removeprefix("www."))
        job = self.jobs.create("record", page_url or "grabacion", "record", {"title": title[:200], "host": host})
        path = self._tmp_path(job.id)
        path.write_bytes(b"")
        with self._lock:
            self._state[job.id] = {"path": path, "size": 0, "next_seq": 0, "host": host}
        self.jobs.update(job.id, status="downloading", stage="Grabando…", title=_safe_name(title, host))
        return self.jobs.get(job.id) or {}

    def chunk(self, rec_id: str, seq: int, data: str) -> dict:
        """Devuelve {ok, cancelled}. cancelled=True indica a la extension que debe dejar de grabar."""
        job = self.jobs.get(rec_id)
        with self._lock:
            state = self._state.get(rec_id)
        if not job or not state or job["status"] in {"cancelled", "error", "done"}:
            return {"ok": False, "cancelled": True}
        try:
            self.jobs.check_cancel(rec_id)  # el usuario pulso Cancelar en la cola
        except JobCancelled:
            self.abort(rec_id)
            return {"ok": False, "cancelled": True}
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Trozo de grabacion no valido.") from exc
        if seq != state["next_seq"]:
            raise ValueError(f"Trozo fuera de orden (esperaba {state['next_seq']}).")
        if state["size"] + len(raw) > MAX_BYTES:
            self.abort(rec_id, "La grabacion supera el limite de 6 GB.")
            return {"ok": False, "cancelled": True}
        with state["path"].open("ab") as fh:
            fh.write(raw)
        state["size"] += len(raw)
        state["next_seq"] += 1
        self.jobs.update(rec_id, stage=f"Grabando… {state['size'] / 1e6:.1f} MB")
        return {"ok": True, "cancelled": False}

    def abort(self, rec_id: str, reason: str | None = None) -> None:
        with self._lock:
            state = self._state.pop(rec_id, None)
        if state:
            state["path"].unlink(missing_ok=True)
        job = self.jobs.get(rec_id)
        if job and job["status"] not in {"done", "error", "cancelled"}:
            self.jobs.update(rec_id, status="error" if reason else "cancelled", stage=None, error=reason)

    def finish(self, rec_id: str, to_mp4: bool = True) -> dict:
        with self._lock:
            state = self._state.get(rec_id)
        job = self.jobs.get(rec_id)
        if not job or not state:
            raise ValueError("Grabacion no encontrada o cancelada.")
        if state["size"] < 1024:
            self.abort(rec_id, "La grabacion quedo vacia (¿el video estaba pausado o tiene proteccion DRM?).")
            raise ValueError("La grabacion quedo vacia.")
        self.jobs.update(rec_id, status="processing", stage="Procesando grabacion", progress=60.0)
        self.pool.submit(self._finalize, rec_id, to_mp4)
        return self.jobs.get(rec_id) or {}

    def _finalize(self, rec_id: str, to_mp4: bool) -> None:
        with self._lock:
            state = self._state.pop(rec_id, None)
        job = self.jobs.get(rec_id)
        if not state or not job:
            return
        try:
            out_dir = self.settings.download_dir / state["host"]
            out_dir.mkdir(parents=True, exist_ok=True)
            base = f"{_safe_name(job['options'].get('title') or '', state['host'])} [rec-{rec_id[:8]}]"
            webm = state["path"]
            if to_mp4 and shutil.which("ffmpeg"):
                out = out_dir / f"{base}.mp4"
                proc = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(webm), "-c:v", "libx264",
                     "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
                     "-movflags", "+faststart", str(out)], capture_output=True, text=True, timeout=7200)
                if proc.returncode == 0 and out.exists():
                    webm.unlink(missing_ok=True)
                else:  # conservar el WebM si la conversion falla
                    out.unlink(missing_ok=True)
                    out = out_dir / f"{base}.webm"
                    shutil.move(str(webm), out)
            else:
                out = out_dir / f"{base}.webm"
                shutil.move(str(webm), out)
            self.jobs.update(rec_id, status="done", stage=None, progress=100.0, files=[str(out)], filename=str(out))
        except Exception as exc:  # noqa: BLE001
            self.jobs.update(rec_id, status="error", stage=None, error=f"No se pudo guardar la grabacion: {str(exc)[:200]}")
