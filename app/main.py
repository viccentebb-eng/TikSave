from __future__ import annotations

import os
import socket
import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.capture import CaptureOptions, CaptureService, browser_available
from app.convert import has_pandoc
from app.config import SettingsStore, app_home
from app.downloader import Downloader, friendly_error
from app.jobs import JobStore
from app.library import delete_files, list_library, open_in_os, resolve_inside
from app.recorder import Recorder
from app.trim import Trimmer
from app.models import (BatchRequest, TrimRequest, CaptureRequest, DownloadRequest, ExpandRequest, InspectRequest,
                        PathRequest, PathsRequest, RecordingChunk, RecordingFinish, RecordingStart, SettingsUpdate)
from app.security import SUPPORTED_SITES, validate_media_url

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
PORT = int(os.getenv("TIKSAVE_PORT", "8173"))
LOCAL_ORIGINS = {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}
LOCAL_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
EXTENSION_ORIGIN_PREFIXES = ("moz-extension://", "chrome-extension://")


def create_app(home: Path | None = None) -> FastAPI:
    home = home or app_home()
    settings = SettingsStore(home / "settings.json")
    jobs = JobStore(home / "history.json")
    downloader = Downloader(settings, jobs)
    capturer = CaptureService(settings, jobs, downloader.pool)
    trimmer = Trimmer(settings, jobs, downloader.pool)
    recorder = Recorder(settings, jobs, downloader.pool)

    api = FastAPI(title="TikSave", version=__version__)
    api.state.settings, api.state.jobs, api.state.downloader = settings, jobs, downloader

    @api.middleware("http")
    async def local_only(request: Request, call_next):
        """Bloquea DNS-rebinding (Host) y peticiones de otras webs (Origin) hacia esta app local."""
        host = request.headers.get("host", "")
        if host not in LOCAL_HOSTS and not host.startswith("testserver"):
            return JSONResponse({"detail": "Host no permitido."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin not in LOCAL_ORIGINS and not origin.startswith(EXTENSION_ORIGIN_PREFIXES) \
                and urlparse(origin).hostname != "testserver":
            return JSONResponse({"detail": "Origen no permitido."}, status_code=403)
        response = Response(status_code=204) if request.method == "OPTIONS" else await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        if request.method == "OPTIONS":
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    api.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    def bad(exc: Exception, status: int = 400) -> HTTPException:
        return HTTPException(status_code=status, detail=str(exc))

    @api.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @api.get("/api/health")
    def health() -> dict:
        return {"ok": True, "name": "TikSave", "version": __version__,
                "download_dir": str(settings.download_dir),
                "sites": {name: list(domains) for name, domains in SUPPORTED_SITES.items()},
                "allow_other_sites": settings.value.allow_other_sites,
                "capabilities": {**downloader.capabilities(), "browser": browser_available(), "pandoc": has_pandoc()}}

    @api.get("/api/settings")
    def get_settings() -> dict:
        return settings.value.model_dump()

    @api.put("/api/settings")
    def put_settings(payload: SettingsUpdate) -> dict:
        try:
            return settings.update(payload.model_dump(exclude_none=True)).model_dump()
        except (OSError, ValueError) as exc:
            raise bad(exc) from exc

    @api.post("/api/inspect")
    def inspect(payload: InspectRequest) -> dict:
        try:
            return downloader.inspect(payload.url)
        except ValueError as exc:
            raise bad(exc) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=friendly_error(exc)) from exc

    @api.post("/api/expand")
    def expand(payload: ExpandRequest) -> dict:
        try:
            return {"entries": downloader.expand(payload.url, payload.limit)}
        except ValueError as exc:
            raise bad(exc) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=friendly_error(exc)) from exc

    @api.post("/api/download", status_code=202)
    def download(payload: DownloadRequest) -> dict:
        try:
            return downloader.enqueue(payload.url, payload.mode, payload.transcript, payload.cover, payload.notes,
                                      payload.start, payload.end, payload.referer, payload.title,
                                      [c.model_dump() for c in payload.cookies] if payload.cookies else None)
        except ValueError as exc:
            raise bad(exc) from exc

    @api.post("/api/download/batch", status_code=202)
    def download_batch(payload: BatchRequest) -> dict:
        created, rejected = [], []
        for url in dict.fromkeys(u.strip() for u in payload.urls if u.strip()):
            try:
                created.append(downloader.enqueue(url, payload.mode, payload.transcript, payload.cover, payload.notes))
            except ValueError as exc:
                rejected.append({"url": url, "error": str(exc)})
        if not created:
            raise HTTPException(status_code=400, detail=rejected[0]["error"] if rejected else "Sin enlaces.")
        return {"jobs": created, "rejected": rejected}

    @api.post("/api/capture", status_code=202)
    def capture(payload: CaptureRequest) -> dict:
        try:
            fields = payload.model_dump(exclude={"url", "html_source"})
            return capturer.enqueue(payload.url, CaptureOptions(**fields), payload.html_source)
        except ValueError as exc:
            raise bad(exc) from exc

    @api.post("/api/trim", status_code=202)
    def trim(payload: TrimRequest) -> dict:
        try:
            return trimmer.enqueue(payload.path, payload.start, payload.end, payload.precise)
        except ValueError as exc:
            raise bad(exc) from exc

    @api.post("/api/recordings", status_code=201)
    def recording_start(payload: RecordingStart) -> dict:
        return recorder.start(payload.title, payload.page_url)

    @api.post("/api/recordings/{rec_id}/chunk")
    def recording_chunk(rec_id: str, payload: RecordingChunk) -> dict:
        try:
            return recorder.chunk(rec_id, payload.seq, payload.data)
        except ValueError as exc:
            raise bad(exc) from exc

    @api.post("/api/recordings/{rec_id}/finish")
    def recording_finish(rec_id: str, payload: RecordingFinish) -> dict:
        try:
            return recorder.finish(rec_id, payload.to_mp4)
        except ValueError as exc:
            raise bad(exc) from exc

    @api.post("/api/recordings/{rec_id}/abort")
    def recording_abort(rec_id: str) -> dict:
        recorder.abort(rec_id)
        return {"ok": True}

    @api.get("/api/jobs")
    def list_jobs() -> dict:
        return {"jobs": jobs.list()}

    @api.get("/api/jobs/{job_id}")
    def job_status(job_id: str) -> dict:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Trabajo no encontrado")
        return job

    @api.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict:
        if not jobs.request_cancel(job_id):
            raise HTTPException(status_code=404, detail="No hay nada que cancelar.")
        return {"ok": True}

    @api.post("/api/jobs/{job_id}/retry", status_code=202)
    def retry_job(job_id: str) -> dict:
        try:
            new = downloader.retry(job_id) or capturer.retry(job_id) or trimmer.retry(job_id)
        except ValueError as exc:
            raise bad(exc) from exc
        if not new:
            raise HTTPException(status_code=404, detail="Trabajo no encontrado")
        return new

    @api.delete("/api/jobs/{job_id}")
    def remove_job(job_id: str) -> dict:
        return {"ok": jobs.remove(job_id)}

    @api.delete("/api/jobs")
    def clear_jobs() -> dict:
        return {"removed": jobs.clear_finished()}

    @api.get("/api/library")
    def library() -> dict:
        return {"items": list_library(settings.download_dir)}

    @api.post("/api/library/delete")
    def library_delete(payload: PathsRequest) -> dict:
        try:
            return {"deleted": delete_files(settings.download_dir, payload.paths)}
        except ValueError as exc:
            raise bad(exc, 403) from exc

    @api.get("/files/{rel:path}")
    def files(rel: str) -> FileResponse:
        try:
            target = resolve_inside(settings.download_dir, rel)
        except ValueError as exc:
            raise bad(exc, 403) from exc
        if not target.is_file():
            raise HTTPException(status_code=404, detail="Archivo no encontrado")
        return FileResponse(target)

    @api.post("/api/open-folder")
    def open_folder(payload: PathRequest | None = None) -> dict:
        base = settings.download_dir
        base.mkdir(parents=True, exist_ok=True)
        try:
            target = resolve_inside(base, payload.path) if payload and payload.path else base
            open_in_os(target, reveal=bool(payload and payload.path))
        except ValueError as exc:
            raise bad(exc, 403) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"No se pudo abrir la carpeta: {exc}") from exc
        return {"ok": True, "path": str(target)}

    @api.post("/api/update-ytdlp")
    def update_ytdlp() -> dict:
        try:
            return downloader.update_ytdlp()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"No se pudo actualizar: {exc}") from exc

    return api


app = create_app()


def _port_free() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", PORT)) != 0


def main() -> None:
    url = f"http://127.0.0.1:{PORT}"
    if not _port_free():
        print(f"TikSave ya esta corriendo (o el puerto {PORT} esta ocupado). Abriendo {url} ...")
        webbrowser.open(url)
        return
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
