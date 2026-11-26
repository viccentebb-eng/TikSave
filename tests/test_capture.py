import http.server
import json
import threading
import time
from pathlib import Path

import pytest

from app import capture
from app.capture import CaptureOptions, CaptureService, html_to_markdown
from app.config import SettingsStore
from app.jobs import JobStore
from concurrent.futures import ThreadPoolExecutor

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")

ARTICLE = ("<p>" + "Contenido largo del articulo principal. " * 20 + "</p>")
PAGES = {
    "/": ("text/html", f"""<html lang="es"><head><title>Mi Sitio de Prueba</title>
        <meta property="og:description" content="Descripcion X"><link rel="stylesheet" href="/style.css">
        <script>alert(1)</script></head><body onload="x()">
        <nav><a href="/about">Menu</a></nav>
        <article><h1>Titulo principal</h1>{ARTICLE}<img src="/img.png" alt="logo">
        <a href="/about">Sobre nosotros</a> <a href="/doc.pdf">pdf</a> <a href="/private">privado</a></article>
        <footer>Pie de pagina cookie</footer></body></html>"""),
    "/about": ("text/html", f"<html><head><title>Sobre</title></head><body><main><h1>Sobre</h1>{ARTICLE}"
               '<a href="/deep">deep</a></main></body></html>'),
    "/deep": ("text/html", f"<html><head><title>Profunda</title></head><body><main>{ARTICLE}</main></body></html>"),
    "/private": ("text/html", "<html><body>no</body></html>"),
    "/style.css": ("text/css", "body{background:url(/img.png)}"),
    "/js": ("text/html", "<html><head><title>App JS</title></head><body><div id=r></div><script>"
            "document.getElementById('r').innerHTML='<article><h1>Hecho con JS</h1><p>'+'texto dinamico '.repeat(60)+'</p></article>'"
            "</script></body></html>"),
    "/robots.txt": ("text/plain", "User-agent: *\nDisallow: /private\n"),
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/img.png":
            body, ctype = PNG, "image/png"
        elif self.path == "/redir":
            self.send_response(302)
            self.send_header("Location", "/")
            self.end_headers()
            return
        elif self.path in PAGES:
            ctype, text = PAGES[self.path]
            body = text.encode()
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def site():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


@pytest.fixture()
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    settings = SettingsStore(tmp_path / "settings.json")
    jobs = JobStore()
    pool = ThreadPoolExecutor(max_workers=2)
    yield CaptureService(settings, jobs, pool), jobs, settings
    pool.shutdown(wait=True)


def run(service, jobs, url, **opts):
    job = service.enqueue(url, CaptureOptions(**opts))
    for _ in range(300):
        st = jobs.get(job["id"])
        if st["status"] in {"done", "error", "cancelled"}:
            return st
        time.sleep(0.1)
    raise AssertionError("timeout")


def test_markdown_readable_only():
    html = PAGES["/"][1]
    md, meta = html_to_markdown(html, "http://x.test/")
    assert meta["title"] == "Mi Sitio de Prueba" and meta["language"] == "es"
    assert "# Titulo principal" in md and "Contenido largo" in md
    assert "Pie de pagina" not in md and "Menu" not in md and "alert" not in md
    assert "![logo](http://x.test/img.png)" in md
    assert "[Sobre nosotros](http://x.test/about)" in md


def test_markdown_full_keeps_nav():
    md, _ = html_to_markdown(PAGES["/"][1], "http://x.test/", full=True)
    assert "Pie de pagina" in md


def test_capture_markdown_and_html(service, site):
    svc, jobs, settings = service
    st = run(svc, jobs, site + "/", markdown=True, html=True, render="never")
    assert st["status"] == "done", st
    names = {Path(f).suffix for f in st["files"]}
    assert {".md", ".html", ".json"} <= names
    md = next(Path(f) for f in st["files"] if f.endswith(".md")).read_text(encoding="utf-8")
    assert md.startswith("---") and "Titulo principal" in md and f"source: {site}/" in md
    page = next(Path(f) for f in st["files"] if f.endswith(".html")).read_text(encoding="utf-8")
    assert "data:image/png;base64" in page          # imagen incrustada
    assert "<script" not in page and "onload" not in page and "alert(1)" not in page
    assert "url(data:image/png" in page            # url() dentro del CSS incrustado
    assert Path(st["files"][0]).parent.parent.name == "Sitios"


def test_capture_follows_links_and_respects_robots(service, site):
    svc, jobs, _ = service
    st = run(svc, jobs, site + "/", markdown=True, render="never", depth=2, max_pages=10)
    assert st["status"] == "done", st
    pages = sorted(Path(f).name for f in st["files"] if "paginas" in f)
    assert len(pages) == 2 and any("Sobre" in p for p in pages) and any("Profunda" in p for p in pages)
    assert not any("no\n" == Path(f).read_text(encoding="utf-8")[-3:] for f in st["files"] if "paginas" in f)  # /private excluido
    assert any(f.endswith("indice.md") for f in st["files"])


def test_follows_redirect(service, site):
    svc, jobs, _ = service
    st = run(svc, jobs, site + "/redir", markdown=True, render="never")
    assert st["status"] == "done"


def test_404_gives_clear_error(service, site):
    svc, jobs, _ = service
    st = run(svc, jobs, site + "/nope", markdown=True, render="never")
    assert st["status"] == "error" and "404" in st["error"]


def test_requires_a_format(service, site):
    svc, _, _ = service
    with pytest.raises(ValueError):
        svc.enqueue(site, CaptureOptions(markdown=False))


def test_ssrf_blocked(monkeypatch):
    monkeypatch.delenv("TIKSAVE_ALLOW_PRIVATE")
    from app.security import validate_web_url
    for bad in ("http://127.0.0.1/", "http://localhost:8173", "http://169.254.169.254/latest/meta-data",
                "http://10.0.0.5/", "http://[::1]/"):
        with pytest.raises(ValueError):
            validate_web_url(bad)
    with pytest.raises(ValueError):
        validate_web_url("ftp://example.com/x")
    monkeypatch.setenv("TIKSAVE_ALLOW_PRIVATE", "1")


def test_ssrf_redirect_to_private_blocked(monkeypatch, site):
    monkeypatch.delenv("TIKSAVE_ALLOW_PRIVATE")
    with capture._client() as c, pytest.raises(ValueError):
        capture.safe_get(c, site + "/redir")
    monkeypatch.setenv("TIKSAVE_ALLOW_PRIVATE", "1")


@pytest.mark.skipif(not capture.browser_available(), reason="sin navegador")
def test_browser_screenshot_pdf_and_js_page(service, site):
    svc, jobs, _ = service
    st = run(svc, jobs, site + "/js", markdown=True, screenshot=True, pdf=True)
    assert st["status"] == "done", st
    by = {Path(f).suffix: Path(f) for f in st["files"]}
    assert by[".png"].read_bytes()[:4] == b"\x89PNG" and by[".pdf"].read_bytes()[:4] == b"%PDF"
    assert "Hecho con JS" in by[".md"].read_text(encoding="utf-8")


@pytest.mark.skipif(not capture.browser_available(), reason="sin navegador")
def test_auto_renders_js_only_pages(service, site):
    svc, jobs, _ = service
    st = run(svc, jobs, site + "/js", markdown=True, render="auto")
    assert st["status"] == "done"
    assert "Hecho con JS" in next(Path(f) for f in st["files"] if f.endswith(".md")).read_text(encoding="utf-8")
