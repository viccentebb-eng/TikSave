"""Recorte de archivos ya guardados (video o audio) con FFmpeg."""
from __future__ import annotations

import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.config import SettingsStore
from app.downloader import format_clip
from app.jobs import JobCancelled, JobStore
from app.library import EXT_KIND, resolve_inside


def probe_duration(path: Path) -> float | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=30).stdout.strip()
        return float(out)
    except (ValueError, subprocess.SubprocessError):
        return None


class Trimmer:
    def __init__(self, settings: SettingsStore, jobs: JobStore, pool: ThreadPoolExecutor) -> None:
        self.settings, self.jobs, self.pool = settings, jobs, pool

    def enqueue(self, rel_path: str, start: float, end: float, precise: bool = True) -> dict:
        if not shutil.which("ffmpeg"):
            raise ValueError("Falta FFmpeg para recortar. Instalalo y reinicia TikSave.")
        source = resolve_inside(self.settings.download_dir, rel_path)
        if not source.is_file() or EXT_KIND.get(source.suffix.lower()) not in {"video", "audio"}:
            raise ValueError("Solo se pueden recortar archivos de video o audio.")
        start = max(0.0, float(start))
        if float(end) <= start:
            raise ValueError("El final del recorte debe ser mayor que el inicio.")
        job = self.jobs.create("trim", str(source), "trim", {"path": rel_path, "start": start, "end": float(end),
                                                             "precise": precise})
        self.jobs.update(job.id, title=source.stem[:180])
        self.pool.submit(self._run, job.id)
        return self.jobs.get(job.id) or {}

    def retry(self, job_id: str) -> dict | None:
        old = self.jobs.get(job_id)
        if not old or old["kind"] != "trim":
            return None
        o = old["options"]
        return self.enqueue(o["path"], o["start"], o["end"], o.get("precise", True))

    def _run(self, job_id: str) -> None:
        try:
            self.jobs.check_cancel(job_id)
            self._trim(job_id)
        except JobCancelled:
            self.jobs.update(job_id, status="cancelled", stage=None)
        except Exception as exc:  # noqa: BLE001
            self.jobs.update(job_id, status="error", stage=None, error=str(exc)[:400])

    def _trim(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        o = job["options"]
        source = resolve_inside(self.settings.download_dir, o["path"])
        start, end = o["start"], o["end"]
        base = re.sub(r" \(recorte [^)]*\)$", "", source.stem)
        out = source.with_name(f"{base} (recorte {format_clip(start)}-{format_clip(end)}){source.suffix}")
        n = 2
        while out.exists():
            out = source.with_name(f"{base} (recorte {format_clip(start)}-{format_clip(end)}) {n}{source.suffix}")
            n += 1
        is_video = EXT_KIND[source.suffix.lower()] == "video"
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
               "-i", str(source)]
        if not o.get("precise", True):
            cmd += ["-c", "copy"]  # rapido, pero corta en el keyframe mas cercano
        elif is_video:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart"]
        cmd += ["-map_metadata", "0", str(out)]
        self.jobs.update(job_id, status="processing", stage="Recortando con FFmpeg", progress=50.0)
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if proc.returncode != 0 or not out.exists():
            out.unlink(missing_ok=True)
            raise RuntimeError("FFmpeg no pudo recortar: " + (proc.stderr.strip().splitlines() or ["error"])[-1][:200])
        self.jobs.update(job_id, status="done", stage=None, progress=100.0, files=[str(out)], filename=str(out))
