from __future__ import annotations

import os
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yt_dlp


ALLOWED_HOSTS = {
    "tiktok.com",
    "www.tiktok.com",
    "m.tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
}


def validate_tiktok_url(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("El enlace debe comenzar con http:// o https://")
    if host not in ALLOWED_HOSTS and not host.endswith(".tiktok.com"):
        raise ValueError("Solo se admiten enlaces de TikTok.")
    return value


def default_download_dir() -> Path:
    configured = os.getenv("TIKSAVE_DOWNLOAD_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "Downloads" / "TikSave").resolve()


@dataclass
class Job:
    id: str
    url: str
    mode: str
    status: str = "queued"
    progress: float = 0.0
    speed: str | None = None
    eta: str | None = None
    filename: str | None = None
    title: str | None = None
    error: str | None = None


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, url: str, mode: str) -> Job:
        job = Job(id=uuid.uuid4().hex, url=url, mode=mode)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def update(self, job_id: str, **changes: Any) -> None:
        with self._lock:
            job = self._jobs[job_id]
            for key, value in changes.items():
                setattr(job, key, value)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return asdict(job) if job else None


class TikSaveDownloader:
    def __init__(self) -> None:
        self.download_dir = default_download_dir()
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.jobs = JobStore()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="tiksave")

    def inspect(self, url: str) -> dict[str, Any]:
        url = validate_tiktok_url(url)
        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        return {
            "id": info.get("id"),
            "title": info.get("title") or info.get("description") or "TikTok",
            "uploader": info.get("uploader") or info.get("creator"),
            "thumbnail": info.get("thumbnail"),
            "duration": info.get("duration"),
            "webpage_url": info.get("webpage_url") or url,
        }

    def enqueue(self, url: str, mode: str) -> dict[str, Any]:
        url = validate_tiktok_url(url)
        job = self.jobs.create(url=url, mode=mode)
        self.pool.submit(self._download, job.id)
        return self.jobs.get(job.id) or {}

    @staticmethod
    def _safe_title(value: str | None) -> str | None:
        if not value:
            return value
        return re.sub(r"\s+", " ", value).strip()[:180]

    def _download(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return

        self.jobs.update(job_id, status="starting")

        def progress_hook(data: dict[str, Any]) -> None:
            status = data.get("status")
            if status == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                downloaded = data.get("downloaded_bytes") or 0
                pct = (downloaded / total * 100.0) if total else 0.0
                self.jobs.update(
                    job_id,
                    status="downloading",
                    progress=round(min(max(pct, 0.0), 100.0), 1),
                    speed=data.get("_speed_str"),
                    eta=data.get("_eta_str"),
                    filename=data.get("filename"),
                )
            elif status == "finished":
                self.jobs.update(
                    job_id,
                    status="processing",
                    progress=100.0,
                    filename=data.get("filename"),
                )

        output_template = str(
            self.download_dir
            / "%(uploader|creator|channel)s - %(title).100s [%(id)s].%(ext)s"
        )

        common: dict[str, Any] = {
            "outtmpl": output_template,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [progress_hook],
            "windowsfilenames": True,
            "overwrites": False,
        }

        mode = job["mode"]
        if mode == "video":
            common.update(
                {
                    "format": "bestvideo*+bestaudio/best",
                    "merge_output_format": "mp4",
                }
            )
        elif mode == "mp3":
            common.update(
                {
                    "format": "bestaudio/best",
                    "postprocessors": [
                        {
                            "key": "FFmpegExtractAudio",
                            "preferredcodec": "mp3",
                            "preferredquality": "192",
                        }
                    ],
                }
            )
        elif mode == "audio":
            common.update({"format": "bestaudio/best"})
        else:
            self.jobs.update(job_id, status="error", error="Modo de descarga inválido")
            return

        try:
            with yt_dlp.YoutubeDL(common) as ydl:
                info = ydl.extract_info(job["url"], download=True)
                final_name = ydl.prepare_filename(info)
                if mode == "mp3":
                    final_name = str(Path(final_name).with_suffix(".mp3"))
                self.jobs.update(
                    job_id,
                    status="done",
                    progress=100.0,
                    title=self._safe_title(info.get("title") or info.get("description")),
                    filename=final_name,
                    speed=None,
                    eta=None,
                )
        except Exception as exc:
            self.jobs.update(job_id, status="error", error=str(exc)[:1000])
