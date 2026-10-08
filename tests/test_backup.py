import http.server
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.capture import CaptureOptions, CaptureService
from app.config import SettingsStore
from app.jobs import JobStore

PAGES = {
    "/": '<html><head><title>Escuela</title></head><body><main><p>' + "Inicio del sitio. " * 40 +
         '</p><a href="/materias/mat1.html">Materia 1</a><a href="/docs/programa.pdf">Programa</a>'
         '<a href="/video.mp4">Video</a></main></body></html>',
    "/materias/mat1.html": '<html><head><title>Materia 1</title></head><body><main><p>' + "Contenido de materia. " * 40 +
                           '</p><a href="/docs/guia.docx">Guia</a><a href="/">Inicio</a></main></body></html>',
}


@pytest.fixture()
def site(tmp_path):
    files = {"/docs/programa.pdf": b"%PDF-1.4 programa", "/docs/guia.docx": b"PK guia", "/video.mp4": b"0" * 2000}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/robots.txt":
                body, ct = b"User-agent: *\nDisallow:\n", "text/plain"
            elif self.path in files:
                body, ct = files[self.path], "application/octet-stream"
            elif self.path in PAGES:
                body, ct = PAGES[self.path].encode(), "text/html"
            else:
                self.send_response(404); self.end_headers(); return
            self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_backup_saves_pages_and_documents_but_not_media_by_default(tmp_path, monkeypatch, site):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    pool = ThreadPoolExecutor(max_workers=1)
    jobs = JobStore()
    svc = CaptureService(SettingsStore(tmp_path / "s.json"), jobs, pool)
    job = svc.enqueue(site + "/", CaptureOptions(markdown=True, render="never", depth=3, max_pages=20, files=True))
    for _ in range(300):
        st = jobs.get(job["id"])
        if st["status"] in ("done", "error"):
            break
        time.sleep(0.1)
    pool.shutdown(wait=True)
    assert st["status"] == "done", st
    out = Path(st["files"][0]).parent
    assert (out / "archivos" / "docs" / "programa.pdf").read_bytes().startswith(b"%PDF")
    assert (out / "archivos" / "docs" / "guia.docx").exists()
    assert not (out / "archivos" / "video.mp4").exists()          # multimedia apagada por defecto
    assert (out / "paginas").exists() and any("Materia" in p.name for p in (out / "paginas").iterdir())
