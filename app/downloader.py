"""Descargas con yt-dlp: video, audio, transcripcion, portada y ficha Markdown."""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import yt_dlp
from yt_dlp.postprocessor import PostProcessor
from yt_dlp.utils import download_range_func

from app.config import SettingsStore
from app.cookies import write_cookie_file
from app.jobs import JobCancelled, JobStore
from app.security import site_for_url, validate_media_url
from app.textutils import build_notes, subtitles_to_text

MODES = {"video", "mp3", "audio", "transcript", "cover"}
ANSI_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
SUB_EXTS = (".srt", ".vtt", ".ass", ".json3", ".ttml")
# TikTok publica los idiomas con codigo ISO 639-2 (spa-ES); aceptamos ambos.
LANG_ALIASES = {"es": "spa", "en": "eng", "pt": "por", "fr": "fra", "de": "deu", "it": "ita", "ca": "cat", "zh": "zho"}
OUTPUT_TEMPLATE = "%(uploader,creator,channel&{} - |)s%(title).80s [%(id)s].%(ext)s"


def clean_error(value: Exception | str) -> str:
    text = ANSI_RE.sub("", str(value))
    return re.sub(r"\s+", " ", text).strip()


def has_curl_cffi() -> bool:
    return importlib.util.find_spec("curl_cffi") is not None


def has_whisper() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def friendly_error(value: Exception | str) -> str:
    text = clean_error(value)
    low = text.lower()
    if "impersonat" in low or "unexpected response from webpage" in low or "rehydration" in low:
        if not has_curl_cffi():
            return ("TikTok bloquea al extractor porque falta 'curl_cffi'. Ejecuta de nuevo "
                    "install-windows.bat (o: pip install -U \"yt-dlp[default,curl-cffi]\") y reinicia TikSave.")
        return ("TikTok rechazo la peticion. Pulsa Ajustes > Actualizar yt-dlp y reintenta; "
                "si persiste, puede ser una restriccion temporal de tu conexion.")
    if "cookie" in low and any(m in low for m in ("could not", "failed", "decrypt", "database", "locked", "no pude leer")):
        return ("No pude leer las cookies de tu navegador (cierra el navegador o prueba con Firefox; en Chrome/Edge el "
                "cifrado de Windows puede impedirlo). Tambien puedes descargar desde la extension, que envia tu sesion.")
    if any(m in low for m in ("private", "log in", "login", "sign in", "cookies", "members-only", "authenticat",
                              "http error 403", "forbidden", "http error 401")):
        return ("Este contenido exige iniciar sesion. En Ajustes elige tu navegador en 'Usar mis cookies' o descargalo "
                "desde la extension de TikSave, que usa tu sesion.")
    if any(m in low for m in ("removed", "unavailable", "not available", "404", "no longer", "deleted")):
        return "El contenido ya no esta disponible (borrado o restringido en tu region)."
    if "ffmpeg" in low or "ffprobe" in low:
        return "Falta FFmpeg (necesario para MP3 y subtitulos SRT). Instala FFmpeg y reinicia TikSave."
    if "unsupported url" in low and "/photo/" not in low:
        return ("TikSave no sabe extraer videos de esa página. Si la reproduces en el navegador, usa uno de los "
                "videos detectados en el popup de la extensión (botones MP4/MP3).")
    if "unsupported url" in low or "no video formats" in low or "/photo/" in low:
        return "No se encontro un video en ese enlace (las publicaciones de solo fotos no estan soportadas)."
    if any(m in low for m in ("timed out", "timeout", "connection", "getaddrinfo", "name resolution")):
        return "Error de red al conectar. Revisa tu conexion a internet y reintenta."
    return text[:600]


def pick_subtitle_langs(info: dict, wanted: list[str]) -> list[str]:
    """Elige las claves exactas de subtitulo (manual primero, luego automatico)."""
    chosen: list[str] = []
    for pool in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        keys = [k for k, v in pool.items() if v and k != "live_chat"]
        for want in wanted:
            prefixes = {want.lower(), LANG_ALIASES.get(want.lower(), want.lower())}
            for key in keys:
                if key.lower().split("-")[0] in prefixes and key not in chosen:
                    chosen.append(key)
        if chosen:
            return chosen[:2]
    for pool in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        keys = [k for k, v in pool.items() if v and k != "live_chat"]
        if keys:
            return keys[:1]
    return []


_NOISE = re.compile(r"\s*[\(\[](official|oficial|lyrics?|letra|audio|video|v[ií]deo|hd|4k|visuali[sz]er|music video)[^\)\]]*[\)\]]", re.I)


def split_artist_title(title: str) -> tuple[str | None, str]:
    """'Artista - Cancion (Official Video)' -> ('Artista', 'Cancion')."""
    clean = _NOISE.sub("", title or "").strip()
    match = re.match(r"^(.+?)\s[-\u2013\u2014]\s(.+)$", clean)
    return (match.group(1).strip(), match.group(2).strip()) if match else (None, clean)


class TagFixer(PostProcessor):
    """Completa artista/titulo/album antes de escribir los metadatos del audio."""

    def run(self, info):
        title = info.get("track") or info.get("title") or ""
        artist = info.get("artist") or info.get("creator")
        guessed_artist, guessed_title = split_artist_title(title)
        if not info.get("track") or not artist:
            info["track"] = guessed_title or title
            if not artist:
                uploader = re.sub(r"\s*-\s*Topic$", "", info.get("uploader") or info.get("channel") or "")
                artist = guessed_artist or uploader or None
        if artist:
            info["artist"] = artist
        if not info.get("album") and info.get("playlist_title") and info.get("playlist_title") != artist:
            info["album"] = info["playlist_title"]
        if info.get("release_year") and not info.get("upload_date"):
            info["upload_date"] = f"{info['release_year']}0101"
        return [], info


def format_clip(seconds: float) -> str:
    seconds = int(seconds)
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else f"{m}m{s:02d}s"


class Downloader:
    def __init__(self, settings: SettingsStore, jobs: JobStore, workers: int = 3) -> None:
        self.settings = settings
        self.jobs = jobs
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="tiksave")
        self._run_lock = threading.Lock()
        self._cookies: dict[str, list[dict]] = {}  # cookies de la extension por trabajo (solo en memoria)
        self._cookie_files: dict[str, Path] = {}

    # ------------------------------------------------------------------ info
    @staticmethod
    def capabilities() -> dict[str, Any]:
        return {
            "ffmpeg": shutil.which("ffmpeg") is not None,
            "curl_cffi": has_curl_cffi(),
            "whisper": has_whisper(),
            "yt_dlp": yt_dlp.version.__version__,
        }

    @staticmethod
    def _base_options(referer: str | None = None) -> dict[str, Any]:
        headers = {"Accept-Language": "es-MX,es;q=0.9,en;q=0.7"}
        if referer and referer.startswith(("http://", "https://")):
            origin = "/".join(referer.split("/", 3)[:3])
            headers.update({"Referer": referer, "Origin": origin})
        return {
            "quiet": True,
            "noprogress": True,
            "no_warnings": True,
            "noplaylist": True,
            "retries": 3,
            "fragment_retries": 3,
            "socket_timeout": 30,
            "http_headers": headers,
            "windowsfilenames": True,
        }

    def _check_url(self, url: str) -> tuple[str, str]:
        return validate_media_url(url, self.settings.value.allow_other_sites)

    def _auth_options(self, job_id: str | None = None) -> dict[str, Any]:
        """Sesion del usuario: cookies que mando la extension para este trabajo, o las del navegador elegido."""
        if job_id and self._cookies.get(job_id):
            if job_id not in self._cookie_files:
                self._cookie_files[job_id] = write_cookie_file(self._cookies[job_id], self.settings.path.parent / "tmp",
                                                               job_id)
            return {"cookiefile": str(self._cookie_files[job_id])}
        browser = self.settings.value.cookies_browser
        return {"cookiesfrombrowser": (browser,)} if browser else {}

    def _forget_cookies(self, job_id: str) -> None:
        path = self._cookie_files.pop(job_id, None)
        if path:
            path.unlink(missing_ok=True)

    def inspect(self, url: str) -> dict[str, Any]:
        url, site = self._check_url(url)
        with yt_dlp.YoutubeDL({**self._base_options(), **self._auth_options(), "skip_download": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        subs = list((info.get("subtitles") or {}).keys())
        auto = list((info.get("automatic_captions") or {}).keys())
        heights = [f.get("height") for f in info.get("formats") or [] if f.get("height")]
        return {
            "id": info.get("id"),
            "site": site,
            "title": (info.get("title") or info.get("description") or site),
            "description": info.get("description"),
            "uploader": info.get("uploader") or info.get("creator") or info.get("channel"),
            "thumbnail": info.get("thumbnail"),
            "duration": info.get("duration"),
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "upload_date": info.get("upload_date"),
            "max_height": max(heights) if heights else None,
            "subtitle_langs": subs + [a for a in auto if a not in subs],
            "has_subtitles": bool(subs or auto),
            "webpage_url": info.get("webpage_url") or url,
        }

    def expand(self, url: str, limit: int = 20) -> list[dict[str, str]]:
        """Perfil / lista -> enlaces individuales (los ultimos `limit`)."""
        url, _ = self._check_url(url)
        opts = {**self._base_options(), **self._auth_options(), "noplaylist": False, "extract_flat": "in_playlist",
                "playlistend": max(1, min(limit, 100)), "skip_download": True}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        entries = info.get("entries")
        if entries is None:
            return [{"url": url, "title": info.get("title") or url}]
        out = []
        for entry in entries:
            if not entry:
                continue
            link = entry.get("webpage_url") or entry.get("url")
            try:
                link, _ = self._check_url(link or "")
            except ValueError:
                continue
            out.append({"url": link, "title": entry.get("title") or entry.get("id") or link})
        return out[:limit]

    # --------------------------------------------------------------- enqueue
    def enqueue(self, url: str, mode: str = "video", transcript: bool = False,
                cover: bool = False, notes: bool = False, start: float | None = None,
                end: float | None = None, referer: str | None = None, title: str | None = None,
                cookies: list[dict] | None = None) -> dict[str, Any]:
        url, site = self._check_url(url)
        if mode not in MODES:
            raise ValueError("Modo de descarga invalido.")
        if start is not None or end is not None:
            start = max(0.0, float(start or 0))
            if end is not None and float(end) <= start:
                raise ValueError("El final del recorte debe ser mayor que el inicio.")
            if mode in {"transcript", "cover"}:
                start = end = None
        options = {"site": site, "transcript": transcript or mode == "transcript",
                   "cover": cover or mode in {"cover", "transcript"}, "notes": notes, "start": start,
                   "end": float(end) if end is not None else None,
                   "referer": referer or None, "title": (title or "").strip()[:200] or None,
                   "with_cookies": bool(cookies) or bool(self.settings.value.cookies_browser)}
        job = self.jobs.create("download", url, mode, options)
        if cookies:
            self._cookies[job.id] = cookies
            while len(self._cookies) > 20:  # no acumular sesiones en memoria
                self._cookies.pop(next(iter(self._cookies)))
        self.pool.submit(self._run, job.id)
        return self.jobs.get(job.id) or {}

    def retry(self, job_id: str) -> dict[str, Any] | None:
        old = self.jobs.get(job_id)
        if not old or old["kind"] != "download":
            return None
        o = old["options"]
        return self.enqueue(old["url"], old["mode"], o.get("transcript", False), o.get("cover", False),
                            o.get("notes", False), o.get("start"), o.get("end"), o.get("referer"), o.get("title"),
                            self._cookies.get(job_id))

    # ------------------------------------------------------------------- run
    def _run(self, job_id: str) -> None:
        try:
            self.jobs.check_cancel(job_id)
            self._download(job_id)
        except JobCancelled:
            self.jobs.update(job_id, status="cancelled", stage=None, speed=None, eta=None)
        except Exception as exc:  # noqa: BLE001 - se reporta al usuario
            self.jobs.update(job_id, status="error", stage=None, speed=None, eta=None,
                             error=friendly_error(exc))
        finally:
            self._forget_cookies(job_id)

    def _target_dir(self, site: str) -> Path:
        base = self.settings.download_dir
        target = base / site if self.settings.value.organize_by_site else base
        target.mkdir(parents=True, exist_ok=True)
        return target

    def _format_options(self, mode: str, has_ffmpeg: bool) -> dict[str, Any]:
        if mode == "video":
            if not has_ffmpeg:
                return {"format": "best[ext=mp4]/best"}
            opts: dict[str, Any] = {"format": "bv*+ba/b", "merge_output_format": "mp4"}
            if self.settings.value.prefer_h264:
                opts["format_sort"] = ["vcodec:h264", "res", "acodec:aac"]
            return opts
        if mode == "mp3":
            return {"format": "bestaudio/best", "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
                {"key": "FFmpegMetadata", "add_metadata": True}]}
        if mode == "audio":
            if not has_ffmpeg:
                return {"format": "bestaudio/best"}
            return {"format": "bestaudio/best", "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "best"},
                {"key": "FFmpegMetadata", "add_metadata": True}]}
        return {"format": "best/bestvideo*+bestaudio", "skip_download": True}

    def _download(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return
        mode, options, url = job["mode"], job["options"], job["url"]
        caps = self.capabilities()
        if mode == "mp3" and not caps["ffmpeg"]:
            raise RuntimeError("ffmpeg no encontrado")
        want_transcript, want_cover, want_notes = options["transcript"], options["cover"], options["notes"]
        out_dir = self._target_dir(options["site"])

        self.jobs.update(job_id, status="starting", stage="Analizando enlace", progress=0.0)
        referer = options.get("referer")
        with yt_dlp.YoutubeDL({**self._base_options(referer), **self._auth_options(job_id), "skip_download": True}) as probe:
            probe_info = probe.extract_info(url, download=False)
        self.jobs.update(job_id, title=(probe_info.get("title") or probe_info.get("description") or "")[:180] or None,
                         uploader=probe_info.get("uploader") or probe_info.get("creator"),
                         thumbnail=probe_info.get("thumbnail"))
        self.jobs.check_cancel(job_id)

        top = {"value": 0.0}

        def progress_hook(data: dict[str, Any]) -> None:
            self.jobs.check_cancel(job_id)
            if data.get("status") == "downloading":
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                pct = (data.get("downloaded_bytes") or 0) / total * 100 if total else top["value"]
                top["value"] = max(top["value"], min(pct, 99.0))
                self.jobs.update(job_id, status="downloading", stage="Descargando", progress=round(top["value"], 1),
                                 speed=ANSI_RE.sub("", data.get("_speed_str") or "").strip() or None,
                                 eta=ANSI_RE.sub("", data.get("_eta_str") or "").strip() or None)
            elif data.get("status") == "finished":
                self.jobs.update(job_id, status="processing", stage="Procesando archivo", progress=99.0,
                                 speed=None, eta=None)

        def pp_hook(data: dict[str, Any]) -> None:
            self.jobs.check_cancel(job_id)
            if data.get("status") == "started":
                self.jobs.update(job_id, status="processing", stage="Procesando archivo", progress=99.0)

        start, end = options.get("start"), options.get("end")
        clipped = start is not None or end is not None
        template = OUTPUT_TEMPLATE
        if clipped:
            label = f"{format_clip(start or 0)}-{format_clip(end)}" if end else f"desde {format_clip(start or 0)}"
            template = template.replace(".%(ext)s", f" (recorte {label}).%(ext)s")
        if options.get("title") and site_for_url(url) is None:  # archivo suelto: usar el titulo de la pagina
            literal = re.sub(r"\s+", " ", re.sub(r"[\\/:*?\"<>|\r\n]+", " ", options["title"])).strip()[:80].replace("%", "%%")
            template = template.replace("%(title).80s", literal or "%(title).80s")
        opts: dict[str, Any] = {
            **self._base_options(referer),
            **self._auth_options(job_id),
            **self._format_options(mode, caps["ffmpeg"]),
            "outtmpl": str(out_dir / template),
            "progress_hooks": [progress_hook],
            "postprocessor_hooks": [pp_hook],
        }
        sub_langs: list[str] = []
        if want_transcript or want_notes:
            sub_langs = pick_subtitle_langs(probe_info, self.settings.value.subtitle_langs)
            if sub_langs:
                opts.update({"writesubtitles": True, "writeautomaticsub": True,
                             "subtitleslangs": sub_langs, "subtitlesformat": "srt/vtt/best"})
                if caps["ffmpeg"]:
                    opts["postprocessors"] = [*opts.get("postprocessors", []),
                                              {"key": "FFmpegSubtitlesConvertor", "format": "srt", "when": "before_dl"}]
        if clipped:
            if not caps["ffmpeg"]:
                raise RuntimeError("ffmpeg no encontrado")
            opts["download_ranges"] = download_range_func(None, [(start or 0, end if end else float("inf"))])
            opts["force_keyframes_at_cuts"] = True
        embed_cover = mode in {"mp3", "audio"} and caps["ffmpeg"]
        if embed_cover:  # la portada va DENTRO del archivo de audio
            opts["writethumbnail"] = True
            pps = opts.get("postprocessors", [])
            opts["postprocessors"] = [*pps, {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
                                      {"key": "EmbedThumbnail", "already_have_thumbnail": bool(want_cover)}]
        if want_cover and not embed_cover:
            opts["writethumbnail"] = True
            if caps["ffmpeg"]:
                opts["postprocessors"] = [*opts.get("postprocessors", []),
                                          {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"}]

        self.jobs.update(job_id, status="downloading", stage="Descargando")
        with yt_dlp.YoutubeDL(opts) as ydl:
            if mode in {"mp3", "audio"}:
                ydl.add_post_processor(TagFixer(ydl), when="pre_process")
            info = ydl.extract_info(url, download=True)
            downloads = info.get("requested_downloads") or []
            media_path = Path(downloads[0]["filepath"]) if downloads and downloads[0].get("filepath") else None
            final = Path(ydl.prepare_filename(info))
            stem_path = final.with_name(final.name[: -len(final.suffix)] if final.suffix else final.name)
        has_media = mode in {"video", "mp3", "audio"} and media_path is not None and media_path.exists()

        transcript_text, transcript_source = None, None
        if want_transcript or want_notes:
            self.jobs.update(job_id, status="processing", stage="Preparando transcripcion", progress=99.0)
            transcript_text, transcript_source = self._collect_transcript(
                stem_path, sub_langs, media_path if has_media else None, url, out_dir, job_id)
            if want_transcript and transcript_text:
                stem_path.with_name(stem_path.name + ".txt").write_text(transcript_text, encoding="utf-8")
            elif want_transcript:
                self.jobs.update(job_id, warnings=[*(self.jobs.get(job_id) or {}).get("warnings", []),
                                                   "Este contenido no tiene subtitulos"
                                                   + ("" if has_whisper() else
                                                      " (instala faster-whisper para transcribir el audio)") + "."])
        if want_notes:
            self.jobs.update(job_id, stage="Generando ficha Markdown")
            md = build_notes(info, options["site"], transcript_text, transcript_source)
            stem_path.with_name(stem_path.name + ".md").write_text(md, encoding="utf-8")

        files = self._collect_files(stem_path)
        primary = str(media_path) if has_media else (files[0] if files else None)
        self.jobs.update(job_id, status="done", stage=None, progress=100.0, speed=None, eta=None,
                         files=files, filename=primary,
                         title=(info.get("title") or info.get("description") or "")[:180] or None)

    # --------------------------------------------------------------- helpers
    @staticmethod
    def _collect_files(stem_path: Path) -> list[str]:
        prefix = stem_path.name + "."
        found = [p for p in stem_path.parent.iterdir()
                 if p.is_file() and p.name.startswith(prefix) and not p.name.endswith((".part", ".ytdl", ".temp"))]
        return [str(p) for p in sorted(found)]

    def _collect_transcript(self, stem_path: Path, langs: list[str], media: Path | None,
                            url: str, out_dir: Path, job_id: str) -> tuple[str | None, str | None]:
        prefix = stem_path.name + "."
        subs = sorted(p for p in stem_path.parent.iterdir()
                      if p.name.startswith(prefix) and p.suffix.lower() in SUB_EXTS)
        subs.sort(key=lambda p: p.suffix.lower() != ".srt")  # prefiere SRT
        for sub in subs:
            text = subtitles_to_text(sub.read_text(encoding="utf-8", errors="ignore"))
            if text:
                lang = sub.name[len(prefix):].rsplit(".", 1)[0]
                return text, f"subtitulos de la plataforma ({lang})"
        if has_whisper():
            return self._whisper(media, url, out_dir, job_id), "transcripcion automatica local (Whisper)"
        return None, None

    def _whisper(self, media: Path | None, url: str, out_dir: Path, job_id: str) -> str | None:
        from faster_whisper import WhisperModel  # import perezoso: es opcional

        tmp_dir = None
        source = media
        if source is None:
            tmp_dir = out_dir / ".tmp" / job_id
            tmp_dir.mkdir(parents=True, exist_ok=True)
            with yt_dlp.YoutubeDL({**self._base_options(), **self._auth_options(job_id), "format": "bestaudio/best",
                                   "outtmpl": str(tmp_dir / "audio.%(ext)s")}) as ydl:
                info = ydl.extract_info(url, download=True)
                source = Path(info["requested_downloads"][0]["filepath"])
        try:
            self.jobs.update(job_id, stage="Transcribiendo con Whisper (puede tardar)")
            model = WhisperModel(os.getenv("TIKSAVE_WHISPER_MODEL", "base"), compute_type="int8")
            segments, _ = model.transcribe(str(source), vad_filter=True)
            text = " ".join(seg.text.strip() for seg in segments).strip()
            return text or None
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)

    # ---------------------------------------------------------------- update
    @staticmethod
    def update_ytdlp() -> dict[str, Any]:
        cmd = [sys.executable, "-m", "pip", "install", "-U", "yt-dlp[default,curl-cffi]"]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-3:]
        return {"ok": proc.returncode == 0, "output": "\n".join(tail),
                "restart_required": proc.returncode == 0}
