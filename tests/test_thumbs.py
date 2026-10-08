import shutil
import subprocess
import threading
import http.server
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.page_preview import preview

HTML = b'<html><head><title>Clase 3 | Academia</title><meta property="og:image" content="/img/portada.png">' \
       b'<meta property="og:description" content="Resumen de la clase"></head><body>x</body></html>'


@pytest.fixture()
def site():
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = HTML if self.path == "/" else b"\x89PNG"
            self.send_response(200); self.send_header("Content-Type", "text/html" if self.path == "/" else "image/png")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def test_page_preview_reads_title_description_and_image(site):
    data = preview(site + "/")
    assert data["title"] == "Clase 3 | Academia" and data["description"] == "Resumen de la clase"
    assert data["image"] == site + "/img/portada.png"


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="sin ffmpeg")
def test_video_thumbnail_is_generated_and_cached(tmp_path, monkeypatch):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    folder = tmp_path / "dl" / "Pruebas"
    folder.mkdir(parents=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=3:s=320x180:r=10", "-f", "lavfi",
                    "-i", "sine=d=3", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(folder / "clip.mp4")], check=True)
    c = TestClient(create_app(tmp_path / "home"))
    first = c.get("/api/thumb", params={"path": "Pruebas/clip.mp4"})
    assert first.status_code == 200 and first.content[:2] == b"\xff\xd8"
    again = c.get("/api/thumb", params={"path": "Pruebas/clip.mp4"})
    assert again.content == first.content
    assert c.get("/api/thumb", params={"path": "../clip.mp4"}).status_code == 400
