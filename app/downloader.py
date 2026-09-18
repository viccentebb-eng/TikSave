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


TIKTOK_HOSTS = {
    "tiktok.com",
    "www.tiktok.com",
    "m.tiktok.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
}

YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtube-nocookie.com",
}

# TikTok currently varies its anti-bot response according to the HTTP User-Agent.
# Keep more than one normal browser UA so TikSave can retry without asking the
# user to change yt-dlp flags manually.
DEFAULT_USER_AGENTS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
)

ANSI_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
RETRYABLE_TIKTOK_ERRORS = (
    "Unexpected response from webpage request",
    "Unable to extract universal data for rehydration",
)


def detect_platform(value: str) -> str | None:
    parsed = urlparse(value.strip())
    host = (parsed.hostname or "").lower()

    if host in TIKTOK_HOSTS or host.endswith(".tiktok.com"):
        return "tiktok"

    if host in YOUTUBE_HOSTS or host.endswith(".youtube.com"):
        return "youtube"

    return None


def validate_supported_url(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value)

    if parsed.scheme not in {"http", "https"}:
        raise ValueError("El enlace debe comenzar con http:// o https://")

    if not detect_platform(value):
        raise ValueError("Solo se admiten enlaces de TikTok o YouTube.")

    return value


def default_download_dir() -> Path:
    configured = os.getenv("TIKSAVE_DOWNLOAD_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "Downloads" / "TikSave").resolve()


def browser_user_agents() -> tuple[str, ...]:
    configured = os.getenv("TIKSAVE_USER_AGENT", "").strip()
    if configured:
        return (configured, *DEFAULT_USER_AGENTS)
    return DEFAULT_USER_AGENTS


def clean_error(value: Exception | str) -> str:
    text = ANSI_RE.sub("", str(value))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def is_retryable_tiktok_error(value: Exception | str) -> bool:
    text = clean_error(value)
    return any(marker.lower() in text.lower() for marker in RETRYABLE_TIKTOK_ERRORS)


@dataclass
class Job:
    id: str
    url: str
    mode: str
    platform: str
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

    def create(self, url: str, mode: str, platform: str) -> Job:
        job = Job(id=uuid.uuid4().hex, url=url, mode=mode, platform=platform)
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

    @staticmethod
    def _base_options(user_agent: str) -> dict[str, Any]:
        return {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "http_headers": {
                "User-Agent": user_agent,
                "Accept-Language": "es-MX,es;q=0.9,en;q=0.7",
            },
            "retries": 2,
            "fragment_retries": 2,
        }

    @staticmethod
    def _agents_for(platform: str) -> tuple[str, ...]:
        if platform == "tiktok":
            return browser_user_agents()
        return (browser_user_agents()[0],)

    def inspect(self, url: str) -> dict[str, Any]:
        url = validate_supported_url(url)
        platform = detect_platform(url)
        if not platform:
            raise ValueError("Plataforma no compatible.")

        last_error: Exception | None = None
        agents = self._agents_for(platform)

        for user_agent in agents:
            opts = {
                **self._base_options(user_agent),
                "skip_download": True,
            }
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)

                return {
                    "id": info.get("id"),
                    "platform": platform,
                    "title": info.get("title") or info.get("description") or platform.title(),
                    "uploader": info.get("uploader") or info.get("creator") or info.get("channel"),
                    "thumbnail": info.get("thumbnail"),
                    "duration": info.get("duration"),
                    "webpage_url": info.get("webpage_url") or url,
                }
            except Exception as exc:
                last_error = exc
                if platform != "tiktok" or not is_retryable_tiktok_error(exc):
                    break

        if last_error:
            raise last_error
        raise RuntimeError("La plataforma no devolvió información del video.")

    def enqueue(self, url: str, mode: str) -> dict[str, Any]:
        url = validate_supported_url(url)
        platform = detect_platform(url)
        if not platform:
            raise ValueError("Plataforma no compatible.")

        job = self.jobs.create(url=url, mode=mode, platform=platform)
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

        platform = job["platform"]
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

        mode = job["mode"]
        mode_options: dict[str, Any] = {}

        if mode == "video":
            mode_options.update(
                {
                    "format": "bestvideo*+bestaudio/best",
                    "merge_output_format": "mp4",
                }
            )
        elif mode == "mp3":
            mode_options.update(
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
            mode_options.update({"format": "bestaudio/best"})
        else:
            self.jobs.update(job_id, status="error", error="Modo de descarga inválido")
            return

        last_error: Exception | None = None
        agents = self._agents_for(platform)

        for attempt, user_agent in enumerate(agents, start=1):
            common: dict[str, Any] = {
                **self._base_options(user_agent),
                **mode_options,
                "outtmpl": output_template,
                "progress_hooks": [progress_hook],
                "windowsfilenames": True,
                "overwrites": False,
            }

            try:
                self.jobs.update(
                    job_id,
                    status="starting",
                    progress=0.0,
                    speed=None,
                    eta=None,
                    error=None,
                )

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
                    return

            except Exception as exc:
                last_error = exc

                if (
                    platform != "tiktok"
                    or not is_retryable_tiktok_error(exc)
                    or attempt >= len(agents)
                ):
                    break

                self.jobs.update(
                    job_id,
                    status="starting",
                    progress=0.0,
                    error=None,
                )

        error_text = clean_error(last_error or "Error desconocido")

        if platform == "tiktok" and is_retryable_tiktok_error(error_text):
            error_text = (
                "TikTok rechazó temporalmente la petición del extractor incluso después "
                "de probar varios perfiles de navegador. Vuelve a intentar; si continúa, "
                "TikTok puede estar aplicando una restricción temporal a esta conexión."
            )

        self.jobs.update(job_id, status="error", error=error_text[:1000])
