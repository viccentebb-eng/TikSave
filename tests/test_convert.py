import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="sin ffmpeg")


@pytest.fixture()
def lib(tmp_path, monkeypatch):
    dl = tmp_path / "dl" / "Pruebas"
    dl.mkdir(parents=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=4:s=640x360:r=25", "-f", "lavfi",
                    "-i", "sine=d=4", "-shortest", "-c:v", "mpeg4", "-c:a", "aac", str(dl / "clip.mp4")], check=True)
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    return TestClient(create_app(tmp_path / "home")), dl


def wait(c, job_id):
    for _ in range(300):
        st = c.get(f"/api/jobs/{job_id}").json()
        if st["status"] in ("done", "error", "cancelled"):
            return st
        time.sleep(0.2)
    raise AssertionError("timeout")


def duration(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                                capture_output=True, text=True).stdout)


def test_compress_video_lowers_size_and_resolution(lib):
    c, dl = lib
    st = wait(c, c.post("/api/convert", json={"path": "Pruebas/clip.mp4", "action": "compress", "quality": "muy_baja",
                                               "height": 360}).json()["id"])
    assert st["status"] == "done", st
    out = Path(st["files"][0])
    assert "comprimido" in out.name and out.suffix == ".mp4"
    assert out.stat().st_size < (dl / "clip.mp4").stat().st_size
    assert abs(duration(out) - 4) < 0.5


def test_extract_mp3_from_video_and_webm_convert(lib):
    c, dl = lib
    mp3 = wait(c, c.post("/api/convert", json={"path": "Pruebas/clip.mp4", "action": "mp3", "quality": "media"}).json()["id"])
    assert mp3["status"] == "done", mp3
    assert Path(mp3["files"][0]).suffix == ".mp3" and abs(duration(mp3["files"][0]) - 4) < 0.5
    webm = wait(c, c.post("/api/convert", json={"path": "Pruebas/clip.mp4", "action": "webm", "quality": "baja", "height": 360}).json()["id"])
    assert webm["status"] == "done", webm
    assert Path(webm["files"][0]).suffix == ".webm"


def test_audio_actions_reject_video_only_and_bad_input(lib):
    c, dl = lib
    assert c.post("/api/convert", json={"path": "Pruebas/clip.mp4", "action": "compress", "height": 999}).status_code == 400
    assert c.post("/api/convert", json={"path": "../x.mp4", "action": "mp3"}).status_code == 400
    assert c.post("/api/convert", json={"path": "Pruebas/clip.mp4", "action": "nope"}).status_code == 422
