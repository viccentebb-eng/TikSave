from __future__ import annotations

import os
import platform
import shutil
import subprocess
import threading
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.analyzer import analyze as analyze_url
from app.diagnostics import log_path as diagnostics_log_path, snapshot as diagnostics_snapshot, write_event
from app.dezoom import install as install_dezoomify, status as dezoom_status
from app.native_image import download as download_native_image, resolve as resolve_native_image, status as native_image_status
from app.image_tools import download_images as download_image_batch
from app.downloader import (
    TikSaveDownloader,
    clean_error,
    validate_supported_url,
)
from app.models import BrowserMediaRequest, DezoomRequest, DiagnosticEventRequest, DownloadRequest, ImageBatchDownloadRequest, InspectRequest, MaxUrlResolveRequest, NativeImageRequest


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

downloader = TikSaveDownloader()
app = FastAPI(title="TikSave Local", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8173", "http://localhost:8173"],
    allow_origin_regex=r"^moz-extension://[a-zA-Z0-9-]+$",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "name": "TikSave Local",
        "version": __version__,
        "download_dir": str(downloader.download_dir),
        "platforms": ["tiktok", "douyin", "youtube", "instagram", "facebook"],
        "qualities": ["best", "2160", "1440", "1080", "720", "480", "360"],
        "subtitle_formats": ["srt", "vtt", "txt", "ass"],
        "dezoomify": dezoom_status(),
        "native_image": native_image_status(),
        "ffmpeg": {
            "installed": bool(shutil.which("ffmpeg")),
            "path": shutil.which("ffmpeg"),
        },
    }


@app.post("/api/analyze")
def analyze_content(payload: InspectRequest) -> dict:
    try:
        return analyze_url(
            str(payload.url),
            downloader,
            playlist=payload.playlist,
        )
    except ValueError as exc:
        write_event("api", "analyze", level="warning", message=str(payload.url), exc=exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        write_event("api", "analyze", level="error", message=str(payload.url), exc=exc)
        raise HTTPException(
            status_code=502,
            detail=f"No se pudo analizar el contenido: {clean_error(exc)}",
        ) from exc


@app.post("/api/inspect")
def inspect_media(payload: InspectRequest) -> dict:
    try:
        return downloader.inspect(str(payload.url), playlist=payload.playlist)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"No se pudo analizar el enlace: {clean_error(exc)}",
        ) from exc


@app.post("/api/download", status_code=202)
def start_download(payload: DownloadRequest) -> dict:
    try:
        validate_supported_url(str(payload.url))
        return downloader.enqueue(
            str(payload.url),
            payload.mode,
            quality=payload.quality,
            playlist=payload.playlist,
            selected_items=payload.selected_items,
            music_metadata=payload.music_metadata,
            subtitle_format=payload.subtitle_format,
            subtitle_languages=payload.subtitle_languages,
            clip_start=payload.clip_start,
            clip_end=payload.clip_end,
            precise_clip=payload.precise_clip,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/browser-media", status_code=202)
def start_browser_media(payload: BrowserMediaRequest) -> dict:
    try:
        return downloader.enqueue_browser_media(
            page_url=str(payload.page_url),
            media_url=str(payload.media_url) if payload.media_url else None,
            mode=payload.mode,
            quality=payload.quality,
            clip_start=payload.clip_start,
            clip_end=payload.clip_end,
            precise_clip=payload.precise_clip,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/dezoom/status")
def dezoom_engine_status() -> dict:
    return dezoom_status()


@app.post("/api/dezoom/install")
def dezoom_engine_install() -> dict:
    try:
        return install_dezoomify()
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"No se pudo instalar dezoomify-rs: {clean_error(exc)}",
        ) from exc


@app.post("/api/dezoom/download", status_code=202)
def start_dezoom(payload: DezoomRequest) -> dict:
    try:
        return downloader.enqueue_dezoom(
            source_url=str(payload.source_url),
            page_url=str(payload.page_url) if payload.page_url else None,
            output_format=payload.output_format,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/image/status")
def native_image_engine_status() -> dict:
    return native_image_status()


@app.post("/api/image/resolve")
def native_image_engine_resolve(payload: NativeImageRequest) -> dict:
    try:
        return resolve_native_image(
            str(payload.url),
            referer=str(payload.page_url) if payload.page_url else None,
        )
    except ValueError as exc:
        write_event("api", "image-resolve", level="warning", message=str(payload.url), exc=exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        write_event("api", "image-resolve", level="error", message=str(payload.url), exc=exc)
        raise HTTPException(
            status_code=502,
            detail=f"TikSave Native Image no pudo analizar la imagen: {clean_error(exc)}",
        ) from exc


@app.post("/api/image/download")
def native_image_engine_download(payload: NativeImageRequest) -> dict:
    try:
        return download_native_image(
            str(payload.url),
            downloader.download_dir / "Originals",
            referer=str(payload.page_url) if payload.page_url else None,
        )
    except ValueError as exc:
        write_event("api", "image-download", level="warning", message=str(payload.url), exc=exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        write_event("api", "image-download", level="error", message=str(payload.url), exc=exc)
        raise HTTPException(
            status_code=502,
            detail=f"No se pudo descargar la imagen original: {clean_error(exc)}",
        ) from exc


# Compatibility aliases for extension builds prior to 0.12.
@app.get("/api/maxurl/status")
def legacy_maxurl_status() -> dict:
    return native_image_status()


@app.post("/api/maxurl/install")
def legacy_maxurl_install() -> dict:
    return native_image_status()


@app.post("/api/maxurl/resolve")
def legacy_maxurl_resolve(payload: MaxUrlResolveRequest) -> dict:
    try:
        return resolve_native_image(str(payload.url))
    except Exception as exc:
        write_event("api", "legacy-maxurl-resolve", level="error", message=str(payload.url), exc=exc)
        raise HTTPException(
            status_code=502,
            detail=f"TikSave Native Image no pudo analizar la imagen: {clean_error(exc)}",
        ) from exc


@app.post("/api/maxurl/download")
def legacy_maxurl_download(payload: MaxUrlResolveRequest) -> dict:
    try:
        return download_native_image(
            str(payload.url),
            downloader.download_dir / "Originals",
        )
    except Exception as exc:
        write_event("api", "legacy-maxurl-download", level="error", message=str(payload.url), exc=exc)
        raise HTTPException(
            status_code=502,
            detail=f"No se pudo descargar la imagen original: {clean_error(exc)}",
        ) from exc


@app.post("/api/images/download")
def images_download(payload: ImageBatchDownloadRequest) -> dict:
    try:
        files = download_image_batch(
            [str(url) for url in payload.urls],
            downloader.download_dir / "Images",
            referer=str(payload.page_url) if payload.page_url else None,
        )
        return {"ok": True, "count": len(files), "files": files}
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"No se pudieron descargar las imágenes: {clean_error(exc)}",
        ) from exc


@app.get("/api/diagnostics")
def diagnostics(limit: int = 50) -> dict:
    return diagnostics_snapshot(limit)


@app.post("/api/diagnostics/event")
def diagnostics_event(payload: DiagnosticEventRequest) -> dict:
    item = write_event(
        payload.component,
        payload.action,
        level=payload.level,
        message=payload.message,
        details=payload.details,
    )
    return {"ok": True, "event": item}


@app.post("/api/diagnostics/open-log")
def open_diagnostics_log() -> dict:
    path = diagnostics_log_path()
    path.touch(exist_ok=True)
    try:
        if platform.system() == "Windows":
            os.startfile(path)
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo abrir el log: {exc}") from exc
    return {"ok": True, "path": str(path)}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = downloader.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Descarga no encontrada")
    return job


@app.post("/api/open-folder")
def open_folder() -> dict:
    folder = downloader.download_dir
    folder.mkdir(parents=True, exist_ok=True)
    system = platform.system()
    try:
        if system == "Windows":
            os.startfile(folder)
        elif system == "Darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo abrir la carpeta: {exc}") from exc
    return {"ok": True, "path": str(folder)}


def _open_browser() -> None:
    webbrowser.open("http://127.0.0.1:8173")


if __name__ == "__main__":
    threading.Timer(1.0, _open_browser).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=8173, reload=False)
