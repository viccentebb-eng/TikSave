from __future__ import annotations

import html
import ipaddress
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import yt_dlp
from yt_dlp.utils import download_range_func

from app.dezoom import run as run_dezoom
from app.music import apply_music_metadata


TIKTOK_HOSTS = {
    "tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
}
YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtube-nocookie.com",
}
INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}
FACEBOOK_HOSTS = {
    "facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "fb.watch",
}
DOUYIN_HOSTS = {
    "douyin.com", "www.douyin.com", "m.douyin.com", "v.douyin.com", "iesdouyin.com",
}

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
    host = (urlparse(value.strip()).hostname or "").lower()
    if host in TIKTOK_HOSTS or host.endswith(".tiktok.com"):
        return "tiktok"
    if host in YOUTUBE_HOSTS or host.endswith(".youtube.com"):
        return "youtube"
    if host in INSTAGRAM_HOSTS or host.endswith(".instagram.com"):
        return "instagram"
    if host in FACEBOOK_HOSTS or host.endswith(".facebook.com"):
        return "facebook"
    if host in DOUYIN_HOSTS or host.endswith(".douyin.com") or host.endswith(".iesdouyin.com"):
        return "douyin"
    return None


def validate_supported_url(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("El enlace debe comenzar con http:// o https://")
    if not detect_platform(value):
        raise ValueError("Solo se admiten enlaces de TikTok, Douyin, YouTube, Instagram o Facebook.")
    return value


def validate_public_web_url(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()

    if parsed.scheme not in {"http", "https"} or not host:
        raise ValueError("La fuente del video debe ser una URL web HTTP o HTTPS.")

    if host in {"localhost", "localhost.localdomain"}:
        raise ValueError("No se permiten direcciones locales como fuente multimedia.")

    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("No se permiten direcciones privadas o locales.")
    except ValueError as exc:
        if "No se permiten" in str(exc):
            raise
        # A normal domain name is valid here.

    return value


def default_download_dir() -> Path:
    configured = os.getenv("TIKSAVE_DOWNLOAD_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "Downloads" / "TikSave").resolve()


def browser_user_agents() -> tuple[str, ...]:
    configured = os.getenv("TIKSAVE_USER_AGENT", "").strip()
    return (configured, *DEFAULT_USER_AGENTS) if configured else DEFAULT_USER_AGENTS


def clean_error(value: Exception | str) -> str:
    text = ANSI_RE.sub("", str(value))
    return re.sub(r"\s+", " ", text).strip()


def is_retryable_tiktok_error(value: Exception | str) -> bool:
    text = clean_error(value).lower()
    return any(marker.lower() in text for marker in RETRYABLE_TIKTOK_ERRORS)


def video_format(quality: str) -> str:
    if quality == "best":
        return "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"
    height = int(quality)
    return (
        f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/"
        f"b[height<={height}][ext=mp4]/"
        f"bv*[height<={height}]+ba/"
        f"b[height<={height}]"
    )


def validate_clip_range(
    clip_start: float | None,
    clip_end: float | None,
) -> tuple[float | None, float | None]:
    if clip_start is None and clip_end is None:
        return None, None

    start = float(clip_start or 0.0)
    end = float(clip_end) if clip_end is not None else None

    if start < 0:
        raise ValueError("El inicio del recorte no puede ser negativo.")

    if end is not None and end <= start:
        raise ValueError("El final del recorte debe ser posterior al inicio.")

    if end is not None and end - start < 0.25:
        raise ValueError("El fragmento debe durar al menos 0.25 segundos.")

    return start, end


def _entry_thumbnail(entry: dict[str, Any]) -> str | None:
    if entry.get("thumbnail"):
        return entry["thumbnail"]
    thumbs = entry.get("thumbnails") or []
    for thumb in reversed(thumbs):
        if isinstance(thumb, dict) and thumb.get("url"):
            return thumb["url"]
    return None


def _entry_summary(entry: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        "index": index,
        "id": entry.get("id"),
        "title": entry.get("title") or entry.get("description") or f"Elemento {index}",
        "thumbnail": _entry_thumbnail(entry),
        "duration": entry.get("duration"),
        "webpage_url": entry.get("webpage_url") or entry.get("url"),
    }


def _subtitle_tracks(info: dict[str, Any]) -> list[dict[str, Any]]:
    manual = info.get("subtitles") or {}
    automatic = info.get("automatic_captions") or {}
    tracks: list[dict[str, Any]] = []

    for code in sorted(set(manual) | set(automatic)):
        source = manual.get(code) or automatic.get(code) or []
        formats = sorted({
            str(item.get("ext"))
            for item in source
            if isinstance(item, dict) and item.get("ext")
        })
        name = None
        for item in source:
            if isinstance(item, dict) and item.get("name"):
                name = item["name"]
                break
        tracks.append({
            "code": code,
            "name": name or code,
            "automatic": code not in manual,
            "formats": formats,
        })
    return tracks


def _walk_entries(info: dict[str, Any]) -> list[dict[str, Any]]:
    entries = info.get("entries")
    if entries is None:
        return [info]
    return [entry for entry in entries if isinstance(entry, dict)]


def _subtitle_text(source: Path) -> str:
    raw = source.read_text(encoding="utf-8", errors="replace")

    if source.suffix.lower() == ".ass":
        cues: list[str] = []
        for line in raw.splitlines():
            if not line.startswith("Dialogue:"):
                continue
            parts = line.split(",", 9)
            if len(parts) < 10:
                continue
            value = parts[9].replace(r"\N", " ").replace(r"\n", " ")
            value = re.sub(r"\{[^}]*\}", "", value)
            value = html.unescape(value).strip()
            if value:
                cues.append(value)
    else:
        blocks = re.split(r"\n\s*\n", raw.replace("\r\n", "\n"))
        cues = []

        for block in blocks:
            lines = [line.strip() for line in block.splitlines() if line.strip()]
            if not lines:
                continue

            text_lines: list[str] = []
            for line in lines:
                if (
                    line == "WEBVTT"
                    or "-->" in line
                    or line.isdigit()
                    or line.startswith(("NOTE", "STYLE", "REGION", "Kind:", "Language:"))
                ):
                    continue

                value = re.sub(r"<[^>]+>", "", line)
                value = html.unescape(value)
                value = re.sub(r"\s+", " ", value).strip()

                if value:
                    text_lines.append(value)

            if text_lines:
                cue = re.sub(r"\s+", " ", " ".join(text_lines)).strip()
                if cue:
                    cues.append(cue)

    transcript_words: list[str] = []

    for cue in cues:
        words = cue.split()
        if not words:
            continue

        max_overlap = min(len(transcript_words), len(words), 80)
        overlap = 0

        for size in range(max_overlap, 0, -1):
            left = [word.casefold() for word in transcript_words[-size:]]
            right = [word.casefold() for word in words[:size]]
            if left == right:
                overlap = size
                break

        transcript_words.extend(words[overlap:])

    text = " ".join(transcript_words)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"([.!?])\s+", r"\1\n\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    return text + ("\n" if text else "")


@dataclass
class Job:
    id: str
    url: str
    mode: str
    platform: str
    quality: str = "best"
    playlist: bool = False
    selected_items: list[int] | None = None
    music_metadata: bool = False
    subtitle_format: str = "srt"
    subtitle_languages: list[str] | None = None
    referer: str | None = None
    clip_start: float | None = None
    clip_end: float | None = None
    precise_clip: bool = False
    status: str = "queued"
    progress: float = 0.0
    speed: str | None = None
    eta: str | None = None
    filename: str | None = None
    title: str | None = None
    error: str | None = None
    current_index: int | None = None
    total_items: int | None = None
    metadata_note: str | None = None


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def create(self, **kwargs: Any) -> Job:
        job = Job(id=uuid.uuid4().hex, **kwargs)
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
        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="tiksave")

    @staticmethod
    def _base_options(user_agent: str, playlist: bool = False) -> dict[str, Any]:
        return {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": not playlist,
            "ignoreerrors": playlist,
            "http_headers": {
                "User-Agent": user_agent,
                "Accept-Language": "es-MX,es;q=0.9,en;q=0.7",
            },
            "retries": 2,
            "fragment_retries": 2,
        }

    @staticmethod
    def _agents_for(platform: str) -> tuple[str, ...]:
        return browser_user_agents() if platform == "tiktok" else (browser_user_agents()[0],)

    def inspect(self, url: str, playlist: bool = False) -> dict[str, Any]:
        url = validate_supported_url(url)
        platform = detect_platform(url)
        if not platform:
            raise ValueError("Plataforma no compatible.")

        last_error: Exception | None = None

        for user_agent in self._agents_for(platform):
            opts = {
                **self._base_options(user_agent, playlist=playlist),
                "skip_download": True,
            }
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=False)

                if not info:
                    raise RuntimeError("No se encontró información del contenido.")

                entries_raw = info.get("entries") if isinstance(info, dict) else None
                entries = [entry for entry in entries_raw or [] if isinstance(entry, dict)]

                subtitle_source = entries[0] if entries else info
                return {
                    "id": info.get("id"),
                    "platform": platform,
                    "title": info.get("title") or info.get("description") or platform.title(),
                    "uploader": info.get("uploader") or info.get("creator") or info.get("channel"),
                    "thumbnail": info.get("thumbnail") or (entries and _entry_thumbnail(entries[0])),
                    "duration": info.get("duration"),
                    "webpage_url": info.get("webpage_url") or url,
                    "is_playlist": bool(entries),
                    "entry_count": len(entries) if entries else None,
                    "entries": [
                        _entry_summary(entry, index)
                        for index, entry in enumerate(entries, start=1)
                    ][:100],
                    "subtitles": _subtitle_tracks(subtitle_source),
                }
            except Exception as exc:
                last_error = exc
                if platform != "tiktok" or not is_retryable_tiktok_error(exc):
                    break

        if last_error:
            raise last_error
        raise RuntimeError("La plataforma no devolvió información del contenido.")

    def enqueue(
        self,
        url: str,
        mode: str,
        quality: str = "best",
        playlist: bool = False,
        selected_items: list[int] | None = None,
        music_metadata: bool = False,
        subtitle_format: str = "srt",
        subtitle_languages: list[str] | None = None,
        clip_start: float | None = None,
        clip_end: float | None = None,
        precise_clip: bool = False,
    ) -> dict[str, Any]:
        url = validate_supported_url(url)
        platform = detect_platform(url)
        if not platform:
            raise ValueError("Plataforma no compatible.")

        selected = sorted({int(item) for item in selected_items or [] if int(item) > 0}) or None
        clip_start, clip_end = validate_clip_range(clip_start, clip_end)

        if (playlist or selected) and (clip_start is not None or clip_end is not None):
            raise ValueError("El recorte por tiempo se usa con un solo video, no con listas o canales.")

        if mode == "subtitles" and not subtitle_languages:
            raise ValueError("Selecciona al menos un idioma de subtítulos.")

        job = self.jobs.create(
            url=url,
            mode=mode,
            platform=platform,
            quality=quality,
            playlist=playlist or bool(selected),
            selected_items=selected,
            music_metadata=bool(music_metadata),
            subtitle_format=subtitle_format,
            subtitle_languages=subtitle_languages,
            clip_start=clip_start,
            clip_end=clip_end,
            precise_clip=bool(precise_clip),
        )
        self.pool.submit(self._download, job.id)
        return self.jobs.get(job.id) or {}

    def enqueue_browser_media(
        self,
        page_url: str,
        media_url: str | None,
        mode: str,
        quality: str = "best",
        clip_start: float | None = None,
        clip_end: float | None = None,
        precise_clip: bool = False,
    ) -> dict[str, Any]:
        page_url = validate_public_web_url(page_url)
        source_url = validate_public_web_url(media_url) if media_url else page_url

        if media_url and mode == "video":
            lower_source = source_url.lower()
            if re.search(r"(?:index-a\d+|audio|aac|opus|m4a)(?:[?&/_.-]|$)", lower_source):
                raise ValueError(
                    "La fuente detectada parece ser solo audio HLS. Reproduce el video unos segundos más y vuelve a abrir TikSave."
                )

        if mode not in {"video", "mp3", "audio"}:
            raise ValueError("Modo de descarga multimedia inválido.")

        clip_start, clip_end = validate_clip_range(clip_start, clip_end)

        job = self.jobs.create(
            url=source_url,
            mode=mode,
            platform="web",
            quality=quality,
            playlist=False,
            selected_items=None,
            music_metadata=False,
            subtitle_format="srt",
            subtitle_languages=None,
            referer=page_url,
            clip_start=clip_start,
            clip_end=clip_end,
            precise_clip=bool(precise_clip),
        )
        self.pool.submit(self._download, job.id)
        return self.jobs.get(job.id) or {}

    def enqueue_dezoom(
        self,
        source_url: str,
        page_url: str | None = None,
        output_format: str = "jpg",
    ) -> dict[str, Any]:
        source_url = validate_public_web_url(source_url)
        referer = validate_public_web_url(page_url) if page_url else None

        if output_format not in {"jpg", "png", "webp"}:
            raise ValueError("Formato de imagen no compatible.")

        job = self.jobs.create(
            url=source_url,
            mode="image",
            platform="dezoom",
            quality=output_format,
            playlist=False,
            selected_items=None,
            music_metadata=False,
            subtitle_format="srt",
            subtitle_languages=None,
            referer=referer,
        )
        self.pool.submit(self._dezoom, job.id)
        return self.jobs.get(job.id) or {}

    def _dezoom(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return

        output_dir = self.download_dir / "Dezoom"
        output_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        output_path = output_dir / f"dezoom-{stamp}-{job_id[:6]}.{job['quality']}"

        self.jobs.update(
            job_id,
            status="starting",
            progress=2.0,
            title="Imagen de alta resolución",
        )

        def note(message: str) -> None:
            current = self.jobs.get(job_id) or {}
            progress = float(current.get("progress") or 5.0)
            if progress < 90:
                progress = min(progress + 2.5, 90.0)
            self.jobs.update(
                job_id,
                status="processing",
                progress=progress,
                metadata_note=self._safe_title(message),
            )

        try:
            result, tail = run_dezoom(
                source_url=job["url"],
                output_path=output_path,
                referer=job.get("referer"),
                progress=note,
            )
            self.jobs.update(
                job_id,
                status="done",
                progress=100.0,
                title=result.name,
                filename=str(result),
                metadata_note=self._safe_title(tail.splitlines()[-1] if tail else "Imagen reconstruida."),
                error=None,
            )
        except Exception as exc:
            self.jobs.update(
                job_id,
                status="error",
                progress=100.0,
                error=clean_error(exc)[:1000],
            )

    @staticmethod
    def _safe_title(value: str | None) -> str | None:
        if not value:
            return value
        return re.sub(r"\s+", " ", value).strip()[:180]

    def _subtitle_result_files(
        self,
        ydl: yt_dlp.YoutubeDL,
        info: dict[str, Any],
        target_format: str,
        languages: list[str],
    ) -> list[Path]:
        results: list[Path] = []

        for item in _walk_entries(info):
            requested = item.get("requested_subtitles") or {}

            for language in languages:
                track = requested.get(language) or {}
                filepath = track.get("filepath")

                if filepath:
                    source = Path(filepath)

                    if target_format == "txt":
                        if source.exists():
                            target = source.with_suffix(".txt")
                            target.write_text(_subtitle_text(source), encoding="utf-8")
                            results.append(target)
                        continue

                    converted = source.with_suffix(f".{target_format}")
                    if converted.exists():
                        results.append(converted)
                    elif source.exists() and source.suffix.lower() == f".{target_format}":
                        results.append(source)

            base = Path(ydl.prepare_filename(item)).with_suffix("")
            patterns = (
                [f"{base.name}.*.vtt", f"{base.name}.*.srt", f"{base.name}.*.ass"]
                if target_format == "txt"
                else [f"{base.name}.*.{target_format}"]
            )

            for pattern in patterns:
                for source in base.parent.glob(pattern):
                    if target_format == "txt":
                        target = source.with_suffix(".txt")
                        if not target.exists():
                            target.write_text(_subtitle_text(source), encoding="utf-8")
                        results.append(target)
                    else:
                        results.append(source)

        unique: list[Path] = []
        seen: set[str] = set()

        for path in results:
            if not path.exists():
                continue
            key = str(path.resolve())
            if key not in seen:
                seen.add(key)
                unique.append(path)

        return unique

    def _download_subtitles_job(
        self,
        job_id: str,
        job: dict[str, Any],
        output_template: str,
    ) -> None:
        languages = job.get("subtitle_languages") or []
        target = str(job.get("subtitle_format") or "srt")
        platform = str(job["platform"])
        playlist = bool(job.get("playlist"))
        all_files: list[Path] = []
        failures: list[str] = []
        last_info: dict[str, Any] | None = None

        for language_index, language in enumerate(languages, start=1):
            language_files: list[Path] = []
            language_error: Exception | None = None

            for retry_index in range(3):
                if retry_index:
                    time.sleep(2.0 * retry_index)

                source_format = "vtt/srt/best" if target == "txt" else f"{target}/best"
                options: dict[str, Any] = {
                    **self._base_options(browser_user_agents()[0], playlist=playlist),
                    "skip_download": True,
                    "writesubtitles": True,
                    "writeautomaticsub": True,
                    "subtitleslangs": [language],
                    "subtitlesformat": source_format,
                    "outtmpl": output_template,
                    "windowsfilenames": True,
                    "overwrites": False,
                    "sleep_interval_subtitles": 1.0,
                    "sleep_interval_requests": 0.75,
                }

                if job.get("selected_items"):
                    options["playlist_items"] = ",".join(
                        str(item) for item in job["selected_items"]
                    )

                if target in {"srt", "vtt", "ass"}:
                    options["postprocessors"] = [{
                        "key": "FFmpegSubtitlesConvertor",
                        "format": target,
                        "when": "before_dl",
                    }]

                try:
                    self.jobs.update(
                        job_id,
                        status="processing",
                        progress=round((language_index - 1) / len(languages) * 100.0, 1),
                        title=f"Subtítulos: {language}",
                        current_index=language_index,
                        total_items=len(languages),
                    )

                    with yt_dlp.YoutubeDL(options) as ydl:
                        info = ydl.extract_info(job["url"], download=True)
                        if not info:
                            raise RuntimeError("No se encontró información del contenido.")

                        last_info = info
                        language_files = self._subtitle_result_files(
                            ydl,
                            info,
                            target,
                            [language],
                        )

                    if language_files:
                        break

                    language_error = RuntimeError(
                        f"No se generó un archivo para el idioma {language}."
                    )

                except Exception as exc:
                    language_error = exc
                    error_text = clean_error(exc).lower()
                    if "429" not in error_text and "too many requests" not in error_text:
                        break

            if language_files:
                all_files.extend(language_files)
            else:
                failures.append(
                    f"{language}: {clean_error(language_error or 'sin archivo')}"
                )

            self.jobs.update(
                job_id,
                progress=round(language_index / len(languages) * 100.0, 1),
            )

        unique_files: list[Path] = []
        seen: set[str] = set()
        for path in all_files:
            key = str(path.resolve())
            if key not in seen:
                seen.add(key)
                unique_files.append(path)

        if not unique_files:
            error_text = failures[0] if failures else "No se generaron archivos de subtítulos."
            self.jobs.update(job_id, status="error", progress=100.0, error=error_text[:1000])
            return

        filename = " · ".join(path.name for path in unique_files[:3])
        if len(unique_files) > 3:
            filename += f" · +{len(unique_files) - 3} archivo(s)"

        note = None
        if failures:
            note = (
                f"Se descargaron {len(unique_files)} archivo(s), pero "
                f"{len(failures)} idioma(s) no pudieron descargarse. "
                f"{failures[0][:220]}"
            )

        self.jobs.update(
            job_id,
            status="done",
            progress=100.0,
            title=self._safe_title(
                (last_info or {}).get("title") or "Subtítulos"
            ),
            filename=filename,
            speed=None,
            eta=None,
            error=None,
            metadata_note=note,
        )

    def _music_enrich(
        self,
        ydl: yt_dlp.YoutubeDL,
        info: dict[str, Any],
    ) -> tuple[list[str], str]:
        files: list[str] = []
        matched = 0
        attempted = 0
        notes: list[str] = []

        for item in _walk_entries(info):
            prepared = Path(ydl.prepare_filename(item)).with_suffix(".mp3")
            if not prepared.exists():
                continue

            attempted += 1
            result = apply_music_metadata(prepared, item)
            files.append(str(result.get("path") or prepared))

            if result.get("matched"):
                matched += 1
            elif result.get("note"):
                notes.append(str(result["note"]))

        if not attempted:
            return files, "No se encontraron MP3 para enriquecer."

        note = f"MusicBrainz: {matched}/{attempted} coincidencia(s) aplicada(s)."
        if notes and not matched:
            note += f" {notes[0]}"
        return files, note

    def _download(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return

        platform = job["platform"]
        playlist = bool(job["playlist"])
        self.jobs.update(job_id, status="starting")

        def progress_hook(data: dict[str, Any]) -> None:
            status = data.get("status")
            info = data.get("info_dict") or {}
            item_index = info.get("playlist_index")
            item_count = info.get("playlist_count") or info.get("n_entries")
            item_title = info.get("title")

            try:
                item_index = int(item_index) if item_index is not None else None
            except (TypeError, ValueError):
                item_index = None
            try:
                item_count = int(item_count) if item_count is not None else None
            except (TypeError, ValueError):
                item_count = None

            if status == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                downloaded = data.get("downloaded_bytes") or 0
                item_pct = (downloaded / total * 100.0) if total else 0.0
                pct = (
                    ((item_index - 1) + item_pct / 100.0) / item_count * 100.0
                    if playlist and item_index and item_count
                    else item_pct
                )
                self.jobs.update(
                    job_id,
                    status="downloading",
                    progress=round(min(max(pct, 0.0), 100.0), 1),
                    speed=data.get("_speed_str"),
                    eta=data.get("_eta_str"),
                    filename=data.get("filename"),
                    title=self._safe_title(item_title),
                    current_index=item_index,
                    total_items=item_count,
                )
            elif status == "finished":
                pct = (
                    item_index / item_count * 100.0
                    if playlist and item_index and item_count
                    else 100.0
                )
                self.jobs.update(
                    job_id,
                    status="processing",
                    progress=round(min(max(pct, 0.0), 100.0), 1),
                    filename=data.get("filename"),
                    title=self._safe_title(item_title),
                    current_index=item_index,
                    total_items=item_count,
                )

        if job.get("clip_start") is not None or job.get("clip_end") is not None:
            output_template = str(
                self.download_dir
                / "%(uploader|creator|channel)s - %(title).90s [%(id)s] [clip %(section_start)s-%(section_end)s].%(ext)s"
            )
        else:
            output_template = str(
                self.download_dir / "%(uploader|creator|channel)s - %(title).100s [%(id)s].%(ext)s"
            )

        mode = job["mode"]
        mode_options: dict[str, Any] = {}

        if mode == "video":
            direct_browser_media = (
                platform == "web"
                and job.get("referer")
                and str(job["referer"]) != str(job["url"])
            )
            mode_options.update({
                "format": "bv*+ba/b" if direct_browser_media else video_format(job["quality"]),
                "merge_output_format": "mp4",
            })
        elif mode == "mp3":
            mode_options.update({
                "format": "bestaudio/best",
                "postprocessors": [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }],
            })
        elif mode == "audio":
            mode_options.update({"format": "bestaudio/best"})
        elif mode == "subtitles":
            self._download_subtitles_job(job_id, job, output_template)
            return
        else:
            self.jobs.update(job_id, status="error", error="Modo de descarga inválido")
            return

        last_error: Exception | None = None

        for attempt, user_agent in enumerate(self._agents_for(platform), start=1):
            common: dict[str, Any] = {
                **self._base_options(user_agent, playlist=playlist),
                **mode_options,
                "outtmpl": output_template,
                "progress_hooks": [progress_hook],
                "windowsfilenames": True,
                "overwrites": False,
            }

            if job.get("referer"):
                headers = dict(common.get("http_headers") or {})
                headers["Referer"] = str(job["referer"])
                common["http_headers"] = headers

            if job.get("clip_start") is not None or job.get("clip_end") is not None:
                clip_start = float(job.get("clip_start") or 0.0)
                clip_end = (
                    float(job["clip_end"])
                    if job.get("clip_end") is not None
                    else float("inf")
                )
                common["download_ranges"] = download_range_func([], [[clip_start, clip_end]])
                common["force_keyframes_at_cuts"] = bool(job.get("precise_clip"))

            if job.get("selected_items"):
                common["playlist_items"] = ",".join(str(item) for item in job["selected_items"])

            try:
                self.jobs.update(
                    job_id,
                    status="starting",
                    progress=0.0,
                    speed=None,
                    eta=None,
                    error=None,
                    metadata_note=None,
                )

                with yt_dlp.YoutubeDL(common) as ydl:
                    info = ydl.extract_info(job["url"], download=True)

                    if not info:
                        raise RuntimeError("No se encontró contenido descargable.")

                    entries = _walk_entries(info)
                    final_name: str
                    metadata_note: str | None = None

                    if mode == "subtitles":
                        files = self._subtitle_result_files(
                            ydl,
                            info,
                            job["subtitle_format"],
                            job["subtitle_languages"] or [],
                        )
                        if not files:
                            raise RuntimeError(
                                "No se generaron archivos de subtítulos para los idiomas seleccionados."
                            )
                        final_name = " · ".join(path.name for path in files[:3])
                        if len(files) > 3:
                            final_name += f" · +{len(files) - 3} archivo(s)"
                    elif (
                        mode == "mp3"
                        and platform == "youtube"
                        and job.get("music_metadata")
                    ):
                        enriched, metadata_note = self._music_enrich(ydl, info)
                        if len(enriched) == 1:
                            final_name = enriched[0]
                        elif enriched:
                            final_name = f"{len(enriched)} MP3 · metadatos musicales procesados"
                        else:
                            final_name = str(Path(ydl.prepare_filename(info)).with_suffix(".mp3"))
                    elif info.get("entries") is not None:
                        total_items = len(entries)
                        final_name = (
                            f"{info.get('title') or 'Lista'} · "
                            f"{total_items} elemento{'s' if total_items != 1 else ''}"
                        )
                    else:
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
                        total_items=len(entries) if len(entries) > 1 else job.get("total_items"),
                        metadata_note=metadata_note,
                    )
                    return

            except Exception as exc:
                last_error = exc
                if (
                    platform != "tiktok"
                    or not is_retryable_tiktok_error(exc)
                    or attempt >= len(self._agents_for(platform))
                ):
                    break
                self.jobs.update(job_id, status="starting", progress=0.0, error=None)

        error_text = clean_error(last_error or "Error desconocido")

        if platform == "tiktok" and is_retryable_tiktok_error(error_text):
            error_text = (
                "TikTok rechazó temporalmente la petición incluso después de probar "
                "varios perfiles de navegador."
            )

        if platform in {"instagram", "facebook"} and (
            "login" in error_text.lower()
            or "cookies" in error_text.lower()
            or "authentication" in error_text.lower()
        ):
            error_text = (
                f"{platform.title()} pidió iniciar sesión para este contenido. TikSave "
                "solo está usando acceso público en esta versión."
            )

        self.jobs.update(job_id, status="error", error=error_text[:1000])
