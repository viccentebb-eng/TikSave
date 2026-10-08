import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.jobs import JobStore
from app.library import list_library, resolve_inside
from app.main import create_app
from app.security import validate_media_url


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    api = create_app(tmp_path / "home")
    return TestClient(api), api, tmp_path / "dl"


def test_validate_media_url():
    assert validate_media_url("https://vm.tiktok.com/ZMabc/")[1] == "TikTok"
    assert validate_media_url("https://www.youtube.com/watch?v=1")[1] == "YouTube"
    for bad in ("https://tiktok.com.evil.com/x", "https://evil.com/?u=tiktok.com", "ftp://tiktok.com/x", "nope", ""):
        with pytest.raises(ValueError):
            validate_media_url(bad)


def test_health_and_settings(env):
    c, _, dl = env
    h = c.get("/api/health").json()
    assert h["ok"] and "TikTok" in h["sites"] and "ffmpeg" in h["capabilities"]
    s = c.put("/api/settings", json={"subtitle_langs": ["pt"], "organize_by_site": False}).json()
    assert s["subtitle_langs"] == ["pt"] and s["organize_by_site"] is False
    assert c.get("/api/settings").json()["subtitle_langs"] == ["pt"]


def test_rejects_foreign_host_and_origin(env):
    c, _, _ = env
    assert c.get("/api/health", headers={"Host": "evil.com"}).status_code == 403
    r = c.post("/api/open-folder", headers={"Origin": "https://evil.com"})
    assert r.status_code == 403
    assert c.get("/api/health", headers={"Origin": "moz-extension://abc-123"}).headers["access-control-allow-origin"] == "moz-extension://abc-123"


def test_batch_download_validation(env, monkeypatch):
    c, api, _ = env
    c.put("/api/settings", json={"allow_other_sites": False})
    monkeypatch.setattr(api.state.downloader.pool, "submit", lambda *a, **k: None)  # no descargar de verdad
    r = c.post("/api/download/batch", json={"urls": ["https://www.tiktok.com/@a/video/1", "https://www.tiktok.com/@a/video/1",
                                                      "https://evil.com/x", "  "], "mode": "mp3", "transcript": True})
    assert r.status_code == 202
    body = r.json()
    assert len(body["jobs"]) == 1 and body["jobs"][0]["options"]["transcript"] is True
    assert body["rejected"][0]["url"] == "https://evil.com/x"
    assert c.post("/api/download/batch", json={"urls": ["https://evil.com"]}).status_code == 400
    assert c.post("/api/download", json={"url": "https://www.tiktok.com/@a/video/1", "mode": "zip"}).status_code == 422


def test_cancel_queued_and_retry(env, monkeypatch):
    c, api, _ = env
    monkeypatch.setattr(api.state.downloader.pool, "submit", lambda *a, **k: None)
    job = c.post("/api/download", json={"url": "https://www.tiktok.com/@a/video/1", "mode": "video", "notes": True}).json()
    assert c.post(f"/api/jobs/{job['id']}/cancel").status_code == 200
    assert c.get(f"/api/jobs/{job['id']}").json()["status"] == "cancelled"
    new = c.post(f"/api/jobs/{job['id']}/retry").json()
    assert new["id"] != job["id"] and new["options"]["notes"] is True
    assert c.delete("/api/jobs").json()["removed"] == 1


def test_interrupted_job_marked_error(tmp_path):
    p = tmp_path / "h.json"
    s = JobStore(p)
    a = s.create("download", "u", "video")
    b = s.create("download", "u2", "video")
    s.update(a.id, status="done")  # fuerza persistencia con b en "queued"
    s2 = JobStore(p)
    assert s2.get(b.id)["status"] == "error" and "Interrumpido" in s2.get(b.id)["error"]


def test_library_files_and_traversal(env):
    c, _, dl = env
    d = dl / "TikTok"
    d.mkdir(parents=True)
    (d / "a - t [1].mp4").write_bytes(b"x" * 10)
    (d / "a - t [1].jpg").write_bytes(b"y")
    (d / "a - t [1].spa-ES.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nhola\n")
    (d / "a - t [1].md").write_text("# t")
    (dl / "secret.txt").write_text("ok")
    items = c.get("/api/library").json()["items"]
    vid = [i for i in items if i["type"] == "video"]
    assert len(vid) == 1 and len(vid[0]["files"]) == 4 and vid[0]["cover"].endswith(".jpg")
    assert c.get("/files/TikTok/a - t [1].md").text == "# t"
    assert c.get("/files/../../etc/passwd").status_code in (403, 404)
    assert c.get("/files/%2e%2e/%2e%2e/etc/passwd").status_code in (403, 404)
    with pytest.raises(ValueError):
        resolve_inside(dl, "../x")
    assert c.post("/api/library/delete", json={"paths": ["../../etc/passwd"]}).status_code == 403
    r = c.post("/api/library/delete", json={"paths": [f["path"] for f in vid[0]["files"]]}).json()
    assert r["deleted"] == 4 and not d.exists()


def test_inspect_errors_are_friendly(env, monkeypatch):
    c, api, _ = env
    c.put("/api/settings", json={"allow_other_sites": False})
    assert c.post("/api/inspect", json={"url": "https://evil.com"}).status_code == 400

    def boom(url):
        raise RuntimeError("ERROR: [TikTok] 1: Unexpected response from webpage request")
    monkeypatch.setattr(api.state.downloader, "inspect", boom)
    r = c.post("/api/inspect", json={"url": "https://www.tiktok.com/@a/video/1"})
    assert r.status_code == 502 and ("curl_cffi" in r.json()["detail"] or "yt-dlp" in r.json()["detail"])


def test_library_text_only_and_capture_naming(env):
    c, _, dl = env
    t = dl / "TikTok"
    t.mkdir(parents=True)
    (t / "x - hola [2].jpg").write_bytes(b"y")
    (t / "x - hola [2].md").write_text("# hola")
    s = dl / "Sitios" / "ejemplo-20260101-000000"
    s.mkdir(parents=True)
    (s / "Mi-Articulo.md").write_text("# a")
    (s / "Mi-Articulo.html").write_text("<p>a</p>")
    (s / "captura.json").write_text("{}")
    items = {i["type"]: i for i in c.get("/api/library").json()["items"]}
    assert items["text"]["name"] == "x - hola [2]" and items["text"]["cover"].endswith(".jpg")
    assert items["site"]["name"] == "Mi-Articulo" and len(items["site"]["files"]) == 3


def test_trim_job_and_validation(env):
    import shutil, subprocess
    c, _, dl = env
    if not shutil.which("ffmpeg"):
        pytest.skip("sin ffmpeg")
    d = dl / "TikTok"
    d.mkdir(parents=True)
    src = d / "clip [1].mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=6:s=160x120:r=10",
                    "-f", "lavfi", "-i", "sine=d=6", "-shortest", "-c:v", "libx264", "-c:a", "aac", str(src)], check=True)
    assert c.post("/api/trim", json={"path": "TikTok/clip [1].mp4", "start": 3, "end": 2}).status_code == 400
    assert c.post("/api/trim", json={"path": "../x.mp4", "start": 0, "end": 2}).status_code == 400
    job = c.post("/api/trim", json={"path": "TikTok/clip [1].mp4", "start": 1, "end": 3.5}).json()
    for _ in range(100):
        st = c.get(f"/api/jobs/{job['id']}").json()
        if st["status"] in ("done", "error"):
            break
        time.sleep(0.2)
    assert st["status"] == "done", st
    out = Path(st["files"][0])
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
                               capture_output=True, text=True).stdout)
    assert 2.3 < dur < 2.8 and "recorte" in out.name and src.exists()


def test_library_snippet_for_text_items(env):
    c, _, dl = env
    t = dl / "TikTok"
    t.mkdir(parents=True)
    (t / "a - hola [3].md").write_text('---\ntitle: "x"\n---\n\n# hola\n\nEste es el **contenido** real del video.\n')
    item = c.get("/api/library").json()["items"][0]
    assert item["snippet"].startswith("hola Este es el **contenido** real")


def test_friendly_error_does_not_blame_region_for_format_errors():
    from app.downloader import friendly_error
    msg = friendly_error("ERROR: [youtube] abc: Requested format is not available")
    assert "region" not in msg and "yt-dlp" in msg
    assert "region" in friendly_error("This video is not available in your country")


def test_duplicate_download_reuses_active_job(env, monkeypatch):
    c, api, _ = env
    monkeypatch.setattr(api.state.downloader.pool, "submit", lambda *a, **k: None)
    url = "https://cdn.otro.com/clase_720.mp4"
    body = {"url": url, "mode": "video", "referer": "https://otro.com/clase"}
    first = c.post("/api/download", json=body).json()
    again = c.post("/api/download", json=body).json()
    assert again["id"] == first["id"]
    assert c.get("/api/jobs").json()["jobs"].__len__() == 1


def test_chat_links_are_not_queued_as_downloads(env):
    c, _, _ = env
    r = c.post("/api/download", json={"url": "https://chatgpt.com/c/abc", "mode": "transcript"})
    assert r.status_code == 400 and "Capturar esta página" in r.json()["detail"]
