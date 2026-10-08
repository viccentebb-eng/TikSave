import http.server
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import validate_media_url

SEEN = {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        SEEN["referer"] = self.headers.get("Referer")
        super().do_GET()

    def log_message(self, *a):
        pass


@pytest.fixture()
def media_server(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("sin ffmpeg")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=3:s=160x120:r=10", "-f", "lavfi",
                    "-i", "sine=d=3", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(tmp_path / "clip.mp4")], check=True)
    handler = lambda *a, **k: Handler(*a, directory=str(tmp_path), **k)  # noqa: E731
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_any_site_accepted_only_when_enabled_and_public(monkeypatch):
    with pytest.raises(ValueError):
        validate_media_url("https://example.com/v.mp4")
    monkeypatch.delenv("TIKSAVE_ALLOW_PRIVATE")
    url, site = validate_media_url("https://example.com/v.mp4", allow_any=True)
    assert site == "example.com"
    for bad in ("http://127.0.0.1/v.mp4", "http://localhost/v.mp4", "http://169.254.169.254/x", "http://10.0.0.2/x"):
        with pytest.raises(ValueError):
            validate_media_url(bad, allow_any=True)
    monkeypatch.setenv("TIKSAVE_ALLOW_PRIVATE", "1")


def test_direct_video_download_with_referer_and_page_title(tmp_path, monkeypatch, media_server):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    c = TestClient(create_app(tmp_path / "home"))
    job = c.post("/api/download", json={"url": media_server + "/clip.mp4", "mode": "video",
                                        "referer": "https://sitio-original.com/pagina", "title": "Mi video: genial/prueba"}).json()
    for _ in range(100):
        st = c.get(f"/api/jobs/{job['id']}").json()
        if st["status"] in ("done", "error"):
            break
        time.sleep(0.2)
    assert st["status"] == "done", st
    out = Path(st["filename"])
    assert out.exists() and out.suffix == ".mp4"
    assert "Mi video genial prueba" in out.name          # titulo de la pagina, saneado
    assert SEEN["referer"] == "https://sitio-original.com/pagina"
    assert out.parent.name.startswith("127.0.0.1")        # carpeta por sitio
