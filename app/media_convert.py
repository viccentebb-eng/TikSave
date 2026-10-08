"""Convertir, comprimir y extraer audio de archivos ya descargados (FFmpeg)."""
from __future__ import annotations

import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.config import SettingsStore
from app.jobs import JobCancelled, JobStore
from app.library import EXT_KIND, resolve_inside

ACTIONS = {
    # accion: (tipo de origen, extension de salida, etiqueta)
    "compress": ("video", ".mp4", "comprimido"),
    "mp4": ("video", ".mp4", "mp4"),
    "webm": ("video", ".webm", "webm"),
    "mp3": ("any", ".mp3", "audio mp3"),
    "m4a": ("any", ".m4a", "audio m4a"),
    "opus": ("any", ".opus", "audio opus"),
}
# Calidad: CRF para video (mas alto = mas pequeno) y bitrate/calidad para audio.
QUALITY = {
    "alta": {"crf": 20, "vp9": 30, "mp3": "2", "aac": "256k", "opus": "192k"},
    "media": {"crf": 26, "vp9": 36, "mp3": "4", "aac": "160k", "opus": "128k"},
    "baja": {"crf": 32, "vp9": 42, "mp3": "6", "aac": "96k", "opus": "80k"},
    "muy_baja": {"crf": 38, "vp9": 48, "mp3": "8", "aac": "64k", "opus": "48k"},
}
HEIGHTS = {None, 1080, 720, 480, 360}


def _ffprobe_duration(path: Path) -> float | None:
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return float(out)
    except (ValueError, subprocess.SubprocessError):
        return None


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    n = 2
    while True:
        candidate = path.with_name(f"{path.stem} {n}{path.suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def build_command(src: Path, out: Path, action: str, quality: str, height: int | None) -> list[str]:
    q = QUALITY[quality]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y", "-i", str(src)]
    if action in {"compress", "mp4"}:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", str(q["crf"]), "-pix_fmt", "yuv420p"]
        if height:
            cmd += ["-vf", f"scale=-2:{height}"]
        cmd += ["-c:a", "aac", "-b:a", q["aac"], "-movflags", "+faststart"]
    elif action == "webm":
        cmd += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(q["vp9"])]
        if height:
            cmd += ["-vf", f"scale=-2:{height}"]
        cmd += ["-c:a", "libopus", "-b:a", q["opus"]]
    elif action == "mp3":
        cmd += ["-vn", "-c:a", "libmp3lame", "-q:a", q["mp3"]]
    elif action == "m4a":
        cmd += ["-vn", "-c:a", "aac", "-b:a", q["aac"]]
    elif action == "opus":
        cmd += ["-vn", "-c:a", "libopus", "-b:a", q["opus"]]
    else:
        raise ValueError("Accion no valida.")
    return cmd + [str(out)]


class MediaConverter:
    def __init__(self, settings: SettingsStore, jobs: JobStore, pool: ThreadPoolExecutor) -> None:
        self.settings, self.jobs, self.pool = settings, jobs, pool

    def enqueue(self, rel_path: str, action: str, quality: str = "media", height: int | None = None) -> dict:
        if not shutil.which("ffmpeg"):
            raise ValueError("Falta FFmpeg para convertir. Instalalo y reinicia TikSave.")
        if action not in ACTIONS:
            raise ValueError("Accion no valida.")
        if quality not in QUALITY:
            raise ValueError("Calidad no valida.")
        if height not in HEIGHTS:
            raise ValueError("Resolucion no valida.")
        src = resolve_inside(self.settings.download_dir, rel_path)
        kind = EXT_KIND.get(src.suffix.lower())
        need, _, label = ACTIONS[action]
        if not src.is_file() or kind not in {"video", "audio"}:
            raise ValueError("Solo se pueden convertir archivos de video o audio.")
        if need == "video" and kind != "video":
            raise ValueError("Esta accion necesita un video.")
        job = self.jobs.create("convert", str(src), action,
                               {"path": rel_path, "action": action, "quality": quality, "height": height})
        self.jobs.update(job.id, title=src.stem[:180])
        self.pool.submit(self._run, job.id)
        return self.jobs.get(job.id) or {}

    def retry(self, job_id: str) -> dict | None:
        old = self.jobs.get(job_id)
        if not old or old["kind"] != "convert":
            return None
        o = old["options"]
        return self.enqueue(o["path"], o["action"], o["quality"], o["height"])

    def _run(self, job_id: str) -> None:
        try:
            self.jobs.check_cancel(job_id)
            self._convert(job_id)
        except JobCancelled:
            self.jobs.update(job_id, status="cancelled", stage=None)
        except Exception as exc:  # noqa: BLE001
            self.jobs.update(job_id, status="error", stage=None, error=str(exc)[:400])

    def _convert(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        o = job["options"]
        src = resolve_inside(self.settings.download_dir, o["path"])
        _, ext, label = ACTIONS[o["action"]]
        res = f" {o['height']}p" if o["height"] else ""
        suffix = f" ({label}{res})"
        out = _unique(src.with_name(f"{src.stem}{suffix}{ext}"))
        duration = _ffprobe_duration(src)
        cmd = build_command(src, out, o["action"], o["quality"], o["height"])
        self.jobs.update(job_id, status="processing", stage="Convirtiendo", progress=0.0)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        last = 0.0
        try:
            for line in proc.stdout:
                self.jobs.check_cancel(job_id)
                if line.startswith("out_time_us=") and duration:
                    try:
                        done = int(line.split("=", 1)[1]) / 1_000_000
                    except ValueError:
                        continue
                    pct = max(0.0, min(99.0, done / duration * 100))
                    if time.monotonic() - last > 0.5:
                        self.jobs.update(job_id, progress=round(pct, 1), stage=f"Convirtiendo {pct:.0f}%")
                        last = time.monotonic()
        except JobCancelled:
            proc.kill()
            out.unlink(missing_ok=True)
            raise
        code = proc.wait()
        if code != 0 or not out.exists():
            out.unlink(missing_ok=True)
            err = (proc.stderr.read() or "").strip().splitlines()
            raise RuntimeError("FFmpeg no pudo convertir: " + (err[-1][:240] if err else f"codigo {code}"))
        before = src.stat().st_size
        self.jobs.update(job_id, status="done", stage=None, progress=100.0, files=[str(out)], filename=str(out),
                         warnings=[f"Tamaño: {before / 1e6:.1f} MB → {out.stat().st_size / 1e6:.1f} MB"])
