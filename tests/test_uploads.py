import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.uploads import safe_name


def test_safe_name_strips_paths_and_odd_characters():
    assert safe_name("../../etc/passwd.mp4") == "passwd.mp4"
    assert safe_name("C:\\Users\\x\\mi video <1>.MP4") == "mi video _1_.mp4"
    assert safe_name("sin_extension") == "sin_extension"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    return TestClient(create_app(tmp_path / "home")), tmp_path / "dl"


def test_upload_saves_into_library_folder(client):
    c, dl = client
    r = c.post("/api/upload", files={"file": ("notas clase.pdf", io.BytesIO(b"%PDF-1.4 x"), "application/pdf")})
    assert r.status_code == 201, r.text
    assert r.json()["path"] == "Subidos/notas clase.pdf"
    assert (dl / "Subidos" / "notas clase.pdf").read_bytes().startswith(b"%PDF")
    again = c.post("/api/upload", files={"file": ("notas clase.pdf", io.BytesIO(b"%PDF-1.4 y"), "application/pdf")})
    assert again.json()["path"] != r.json()["path"]           # no pisa el anterior
    items = c.get("/api/library").json()["items"]
    assert any(i["name"].startswith("notas clase") for i in items)


def test_upload_rejects_unknown_types_and_empty_files(client):
    c, _ = client
    assert c.post("/api/upload", files={"file": ("virus.exe", io.BytesIO(b"MZ"), "application/octet-stream")}).status_code == 400
    assert c.post("/api/upload", files={"file": ("vacio.mp4", io.BytesIO(b""), "video/mp4")}).status_code == 400
