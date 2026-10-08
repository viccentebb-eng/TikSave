import http.server
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

from app import capture

ROOT = Path(__file__).resolve().parent.parent
PAGES = {
    "/watch": '<html><title>Pelicula X</title><body><video id="v" src="/clip.webm" width="480" height="270" muted></video></body></html>',
    "/tiny": '<html><body><video src="/clip.webm" width="90" height="60"></video></body></html>',
    "/feed": """<html><title>Feed</title><body>
      <article><a href="/@ana/video/111">ana</a><video src="/clip.webm" width="480" height="270" muted></video></article>
      <article><a href="/@bob/video/222">bob</a><video src="/clip.webm" width="480" height="270" muted></video></article></body></html>""",
}
SHIM = """
(() => {
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { return orig.call(this, { ...init, mode: 'open' }); };  // solo para poder inspeccionar en el test
  window.__sent = [];
  globalThis.browser = {
    runtime: { sendMessage: async (m) => { window.__sent.push(m); return { ok: true, job: { id: 'j1' } }; }, onMessage: { addListener: (fn) => { window.__onmsg = fn; } } },
    storage: { local: { get: async (d) => d }, onChanged: { addListener: () => {} } },
  };
})();
"""


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    if not shutil.which("ffmpeg"):
        pytest.skip("sin ffmpeg")
    d = tmp_path_factory.mktemp("site")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=8:s=320x180:r=10", "-c:v", "libvpx", "-b:v", "200k", str(d / "clip.webm")], check=True)

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/clip.webm":
                body, ct = (d / "clip.webm").read_bytes(), "video/webm"
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


@pytest.fixture(scope="module")
def browser():
    cands = capture._browser_candidates()
    if not cands:
        pytest.skip("sin navegador")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=cands[0]["executable_path"])
        yield b
        b.close()


def open_page(browser, url):
    page = browser.new_page(viewport={"width": 1000, "height": 800})
    page.add_init_script(SHIM)
    page.goto(url)
    page.add_script_tag(path=str(ROOT / "extension" / "content.js"))
    return page


def hover_first_video(page, n=0):
    box = page.locator("video").nth(n).bounding_box()
    page.mouse.move(box["x"] + 50, box["y"] + 50)
    page.mouse.move(box["x"] + 60, box["y"] + 60)
    page.wait_for_timeout(250)
    return box


def shadow(page, js):
    return page.evaluate(f"(() => {{ const r = document.querySelector('tiksave-float').shadowRoot; return {js}; }})()")


def real_click(page, element_js):
    rect = shadow(page, f"(() => {{ const b = {element_js}.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }})()")
    page.mouse.click(rect[0], rect[1])


def test_button_appears_on_hover_and_sends_save_message(browser, site):
    page = open_page(browser, site + "/watch")
    assert page.evaluate("!document.querySelector('tiksave-float')") or shadow(page, "r.getElementById('wrap').style.display") != "block"
    hover_first_video(page)
    assert shadow(page, "r.getElementById('wrap').style.display") == "block"
    real_click(page, "r.getElementById('btn')")
    assert shadow(page, "r.getElementById('menu').classList.contains('open')") is True
    real_click(page, "r.querySelector('[data-mode=mp3]')")
    page.wait_for_timeout(200)
    sent = page.evaluate("window.__sent")
    assert len(sent) == 1
    msg = sent[0]
    assert msg["type"] == "save" and msg["mode"] == "mp3" and msg["title"] == "Pelicula X"
    assert msg["pageUrl"].endswith("/watch") and msg["directSrc"].endswith("/clip.webm")
    assert msg["candidate"] is None and msg["start"] == 0
    # el progreso que reenvia el fondo se refleja en el boton
    page.evaluate("window.__onmsg({type:'progress', jobId:'j1', status:'downloading', progress: 43})")
    assert shadow(page, "r.getElementById('label').textContent") == "Descargando 43%"
    page.evaluate("window.__onmsg({type:'progress', jobId:'j1', status:'done'})")
    assert shadow(page, "r.getElementById('label').textContent") == "Guardado ✓"
    page.close()


def test_start_from_here_uses_current_time(browser, site):
    page = open_page(browser, site + "/watch")
    page.evaluate("Object.defineProperty(document.getElementById('v'), 'currentTime', {value: 4, configurable: true})")  # el servidor de prueba no soporta Range
    page.wait_for_timeout(300)
    hover_first_video(page)
    real_click(page, "r.getElementById('btn')")
    assert shadow(page, "r.getElementById('here').style.display") == "block"
    real_click(page, "r.getElementById('here')")
    page.wait_for_timeout(200)
    msg = page.evaluate("window.__sent")[0]
    assert msg["mode"] == "video" and 3 <= msg["start"] <= 5
    page.close()


def test_feed_finds_the_link_of_the_hovered_video(browser, site):
    page = open_page(browser, site + "/feed")
    hover_first_video(page, 1)  # segundo video (bob)
    real_click(page, "r.getElementById('btn')")
    real_click(page, "r.querySelector('[data-mode=video]')")
    page.wait_for_timeout(200)
    assert page.evaluate("window.__sent")[0]["candidate"].endswith("/@bob/video/222")
    page.close()


def test_ignores_script_clicks_and_tiny_videos(browser, site):
    page = open_page(browser, site + "/watch")
    hover_first_video(page)
    shadow(page, "r.getElementById('btn').click()")  # clic sintetico de un script de la pagina
    assert shadow(page, "r.getElementById('menu').classList.contains('open')") is False
    page.close()
    page = open_page(browser, site + "/tiny")
    hover_first_video(page)
    assert page.evaluate("!document.querySelector('tiksave-float')")
    page.close()
