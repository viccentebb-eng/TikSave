import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app import capture
from app.capture import CaptureOptions, CaptureService
from app.config import SettingsStore
from app.convert import has_pandoc, html_to_markdown, localize_images
from app.jobs import JobStore

PNG_B64 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==")


def katex(tex, display=False):
    inner = (f'<span class="katex"><span class="katex-mathml"><math><semantics><mrow/>'
             f'<annotation encoding="application/x-tex">{tex}</annotation></semantics></math></span>'
             f'<span class="katex-html">render</span></span>')
    return f'<span class="katex-display">{inner}</span>' if display else inner


INLINE = katex("x=\\pm 2")
DISPLAY = katex("\\int_0^1 x_i\\,dx", True)
CHATGPT = f"""<html><head><title>Ecuaciones cuadraticas</title></head><body><nav>menu app</nav><main>
<div data-message-author-role="user"><div class="whitespace-pre-wrap">Resuelve x^2 = 4 y dame codigo</div></div>
<div data-message-author-role="assistant"><div class="markdown"><p>La solucion es {INLINE}.</p>
{DISPLAY}
<pre><div>python <button>Copiar</button></div><code class="language-python">def f(x):
    return x_1 * 2</code></pre>
<table><thead><tr><th>n</th><th>f(n)</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<img src="data:image/png;base64,{PNG_B64}" alt="grafica"></div></div></main></body></html>"""

GEMINI = """<html><head><title>Gemini</title></head><body>
<user-query><div class="query-text"><p class="query-text-line">Hola, explica E=mc^2</p></div></user-query>
<model-response><message-content><div class="markdown"><p>Famosa: <span class="math-inline" data-math="E = mc^2"><span class="katex">x</span></span></p>
<div class="math-block" data-math="\\sum_{i=1}^n i"></div></div></message-content></model-response></body></html>"""


def test_chatgpt_markdown_has_math_code_table_and_roles():
    md, meta = html_to_markdown(CHATGPT, "https://chatgpt.com/c/1", keep_data_images=True)
    assert meta["chat"] == "ChatGPT" and meta["messages"] == 2
    assert "## Tú" in md and "## ChatGPT" in md and "menu app" not in md
    assert "$x=\\pm 2$" in md and "$$\n\\int_0^1 x_i\\,dx\n$$" in md
    assert "```python\ndef f(x):\n    return x_1 * 2\n```" in md and "Copiar" not in md
    assert "| n | f(n) |" in md


def test_gemini_markdown_uses_data_math():
    md, meta = html_to_markdown(GEMINI, "https://gemini.google.com/app/1")
    assert meta["chat"] == "Gemini" and meta["messages"] == 2
    assert "$E = mc^2$" in md and "\\sum_{i=1}^n i" in md and "Hola, explica" in md


def test_localize_images_saves_files(tmp_path):
    md = f"![a](data:image/png;base64,{PNG_B64})\n\n![b](http://x.test/p.jpg)\n\n![c](http://x.test/bad.png)"

    def fetch(url):
        if "bad" in url:
            raise RuntimeError("404")
        return b"\xff\xd8\xff\xe0jpegdata", "image/jpeg"

    out, saved, failed = localize_images(md, tmp_path, fetch)
    assert saved == 2 and failed == 1
    assert "![a](images/img-01.png)" in out and "![b](images/img-02.jpg)" in out and "http://x.test/bad.png" in out
    assert (tmp_path / "images" / "img-01.png").read_bytes()[:4] == b"\x89PNG"


@pytest.fixture()
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("TIKSAVE_DOWNLOAD_DIR", str(tmp_path / "dl"))
    pool = ThreadPoolExecutor(max_workers=2)
    jobs = JobStore()
    yield CaptureService(SettingsStore(tmp_path / "s.json"), jobs, pool), jobs
    pool.shutdown(wait=True)


def run(svc, jobs, url, source=None, **opts):
    job = svc.enqueue(url, CaptureOptions(**opts), source)
    for _ in range(300):
        st = jobs.get(job["id"])
        if st["status"] in {"done", "error"}:
            return st
        time.sleep(0.1)
    raise AssertionError("timeout")


def test_extension_dom_to_markdown_with_local_images(service):
    svc, jobs = service
    st = run(svc, jobs, "https://chatgpt.com/c/abc", CHATGPT, markdown=True)
    assert st["status"] == "done", st
    md_file = next(Path(f) for f in st["files"] if f.endswith(".md"))
    text = md_file.read_text(encoding="utf-8")
    assert "![grafica](images/img-01.png)" in text and "data:image" not in text
    assert (md_file.parent / "images" / "img-01.png").exists()
    assert any("Conversacion de ChatGPT" in w for w in st["warnings"])


def test_server_side_login_chat_gives_clear_error(service):
    svc, jobs = service
    # el servidor no puede ver chats con sesion: ni siquiera intenta devolver una pagina vacia como "Listo"
    st = run(svc, jobs, "https://gemini.google.com/app/5394db913d8cc441", None, markdown=True, render="never")
    assert st["status"] == "error"
    assert "extension" in st["error"].lower() or "403" in st["error"] or "conectar" in st["error"].lower()


@pytest.mark.skipif(not has_pandoc(), reason="sin pandoc")
def test_docx_has_native_equations_and_epub(service):
    svc, jobs = service
    st = run(svc, jobs, "https://chatgpt.com/c/abc", CHATGPT, markdown=False, docx=True, epub=True)
    assert st["status"] == "done", st
    docx = next(Path(f) for f in st["files"] if f.endswith(".docx"))
    xml = zipfile.ZipFile(docx).read("word/document.xml").decode("utf-8")
    text = re.sub(r"<[^>]+>", "", xml)
    assert "<m:oMath" in xml and "def" in text and "return" in text and "ChatGPT" in text and "<w:tbl>" in xml
    assert any(n.startswith("word/media/") for n in zipfile.ZipFile(docx).namelist())
    assert zipfile.ZipFile(next(Path(f) for f in st["files"] if f.endswith(".epub"))).namelist()
    assert not any(f.endswith(".md") for f in st["files"])  # solo pidio DOCX/EPUB


@pytest.mark.skipif(not (has_pandoc() and capture.browser_available()), reason="sin pandoc/navegador")
def test_chat_reading_view_html_and_pdf(service):
    svc, jobs = service
    st = run(svc, jobs, "https://chatgpt.com/c/abc", CHATGPT, markdown=False, html=True, pdf=True, screenshot=True)
    assert st["status"] == "done", st
    by = {Path(f).suffix: Path(f) for f in st["files"]}
    html = by[".html"].read_text(encoding="utf-8")
    assert "<math" in html and "def" in re.sub(r"<[^>]+>", "", html) and "menu app" not in html
    assert by[".pdf"].read_bytes()[:4] == b"%PDF" and by[".png"].read_bytes()[:4] == b"\x89PNG"
