import base64
import http.server
import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import cookies as cookies_mod
from app.main import create_app


def make_clip(path: Path, seconds=3):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=d={seconds}:s=160x120:r=10", "-f", "lavfi",
                    "-i", f"sine=d={seconds}", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(path)], check=True)


@pytest.fixture()
def secret_site(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("sin ffmpeg")
    make_clip(tmp_path / "secret.mp4")
    seen = {"cookie": None}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen["cookie"] = self.headers.get("Cookie")
            ok = "session=abc123" in (self.headers.get("Cookie") or "")
            if not ok:
                self.send_response(403); self.end_headers(); return
            if self.path == "/page":
                body, ct = b"<html><title>Privada</title><body><main><h1>Area privada</h1><p>" + b"contenido secreto " * 30 + b"</p></main></body></html>", "text/html"
            else:
                body, ct = (tmp_path / "secret.mp4").read_bytes(), "video/mp4"
            self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}", seen
    srv.shutdown()


def wait(c, job_id, tries=150):
    for _ in range(tries):
        st = c.get(f"/api/jobs/{job_id}").json()
        if st["status"] in ("done", "error", "cancelled"):
            return st
        time.sleep(0.2)
    raise AssertionError("timeout")


def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    return TestClient(create_app(tmp_path / "home"))


def test_cookie_file_is_netscape_and_private(tmp_path):
    path = cookies_mod.write_cookie_file([{"name": "session", "value": "abc123", "domain": ".example.com", "secure": True,
                                           "expires": 4102444800, "httpOnly": True}], tmp_path, "j1")
    text = path.read_text()
    assert ".example.com" in text and "session\tabc123" in text
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_extension_cookies_unlock_download_and_are_not_kept(tmp_path, monkeypatch, secret_site):
    base, seen = secret_site
    c = client(tmp_path, monkeypatch)
    denied = wait(c, c.post("/api/download", json={"url": base + "/secret.mp4", "mode": "video"}).json()["id"])
    assert denied["status"] == "error" and "sesion" in denied["error"].lower()
    job = c.post("/api/download", json={"url": base + "/secret.mp4", "mode": "video",
                                        "cookies": [{"name": "session", "value": "abc123", "domain": "127.0.0.1"}]}).json()
    assert job["options"]["with_cookies"] is True
    st = wait(c, job["id"])
    assert st["status"] == "done", st
    assert "session=abc123" in seen["cookie"]
    assert "abc123" not in str(st) and "abc123" not in (tmp_path / "home" / "history.json").read_text()
    assert not list((tmp_path / "home" / "tmp").glob("*.txt"))  # archivo temporal borrado


def fake_firefox_profile(home: Path, host: str):
    prof = home / ".mozilla" / "firefox" / "abc.default"
    prof.mkdir(parents=True)
    db = sqlite3.connect(prof / "cookies.sqlite")
    db.execute("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, "
               "host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, "
               "inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)")
    db.execute("INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly) VALUES ('session','abc123',?,'/',4102444800,0,1)", (host,))
    db.commit(); db.close()


def test_browser_cookies_setting_unlocks_download_and_capture(tmp_path, monkeypatch, secret_site):
    base, seen = secret_site
    monkeypatch.setenv("HOME", str(tmp_path / "home_dir"))
    fake_firefox_profile(tmp_path / "home_dir", "127.0.0.1")
    cookies_mod.clear_cache()
    c = client(tmp_path, monkeypatch)
    assert c.put("/api/settings", json={"cookies_browser": "netscape"}).status_code == 400
    assert c.put("/api/settings", json={"cookies_browser": "firefox"}).json()["cookies_browser"] == "firefox"
    st = wait(c, c.post("/api/download", json={"url": base + "/secret.mp4", "mode": "video"}).json()["id"])
    assert st["status"] == "done", st
    cap = wait(c, c.post("/api/capture", json={"url": base + "/page", "markdown": True, "render": "never"}).json()["id"])
    assert cap["status"] == "done", cap
    md = next(Path(f) for f in cap["files"] if f.endswith(".md")).read_text(encoding="utf-8")
    assert "contenido secreto" in md


def test_unreadable_browser_cookies_give_clear_message(tmp_path, monkeypatch, secret_site):
    base, _ = secret_site
    monkeypatch.setenv("HOME", str(tmp_path / "vacio"))
    cookies_mod.clear_cache()
    c = client(tmp_path, monkeypatch)
    c.put("/api/settings", json={"cookies_browser": "firefox"})
    st = wait(c, c.post("/api/download", json={"url": base + "/secret.mp4", "mode": "video"}).json()["id"])
    assert st["status"] == "error" and "cookies" in st["error"].lower()


# ------------------------------------------------------------------ grabador
def b64_chunks(data: bytes, n=3):
    size = -(-len(data) // n)
    return [base64.b64encode(data[i:i + size]).decode() for i in range(0, len(data), size)]


@pytest.fixture()
def webm_bytes(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("sin ffmpeg")
    out = tmp_path / "rec.webm"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=3:s=160x120:r=10", "-c:v", "libvpx", "-b:v", "200k",
                    str(out)], check=True)
    return out.read_bytes()


def test_recording_chunks_become_mp4(tmp_path, monkeypatch, webm_bytes):
    c = client(tmp_path, monkeypatch)
    job = c.post("/api/recordings", json={"title": "Video: blob/prueba", "page_url": "https://sitio.com/ver"}).json()
    assert job["kind"] == "record" and job["status"] == "downloading"
    chunks = b64_chunks(webm_bytes)
    assert c.post(f"/api/recordings/{job['id']}/chunk", json={"seq": 1, "data": chunks[0]}).status_code == 400  # fuera de orden
    for i, data in enumerate(chunks):
        r = c.post(f"/api/recordings/{job['id']}/chunk", json={"seq": i, "data": data}).json()
        assert r["ok"] and not r["cancelled"]
    assert c.post(f"/api/recordings/{job['id']}/chunk", json={"seq": 3, "data": "###"}).status_code in (400, 422)
    c.post(f"/api/recordings/{job['id']}/finish", json={"to_mp4": True})
    st = wait(c, job["id"])
    assert st["status"] == "done", st
    out = Path(st["filename"])
    assert out.suffix == ".mp4" and out.parent.name == "sitio.com" and "Video blob prueba" in out.name
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
                               capture_output=True, text=True).stdout)
    assert 2.5 < dur < 3.6
    assert not list((tmp_path / "dl" / ".tmp").glob("rec-*"))


def test_recording_cancel_from_queue_and_empty(tmp_path, monkeypatch, webm_bytes):
    c = client(tmp_path, monkeypatch)
    job = c.post("/api/recordings", json={"title": "x", "page_url": "https://a.com"}).json()
    c.post(f"/api/jobs/{job['id']}/cancel")
    r = c.post(f"/api/recordings/{job['id']}/chunk", json={"seq": 0, "data": b64_chunks(webm_bytes)[0]}).json()
    assert r["cancelled"] is True
    assert c.get(f"/api/jobs/{job['id']}").json()["status"] == "cancelled"
    empty = c.post("/api/recordings", json={"title": "vacio", "page_url": "https://a.com"}).json()
    assert c.post(f"/api/recordings/{empty['id']}/finish", json={}).status_code == 400
    assert c.get(f"/api/jobs/{empty['id']}").json()["status"] == "error"


def test_cookies_default_to_auto_and_stay_silent_without_a_browser(tmp_path, monkeypatch, secret_site):
    base, _ = secret_site
    monkeypatch.setenv("HOME", str(tmp_path / "sin_navegadores"))
    cookies_mod.clear_cache()
    c = client(tmp_path, monkeypatch)
    assert c.get("/api/settings").json()["cookies_browser"] == "auto"
    st = wait(c, c.post("/api/download", json={"url": base + "/secret.mp4", "mode": "video"}).json()["id"])
    assert st["status"] == "error"
    assert "cookies" not in st["error"].lower()  # no se muestra un error de cookies: la opcion automatica es silenciosa
    assert "sesion" in st["error"].lower()
