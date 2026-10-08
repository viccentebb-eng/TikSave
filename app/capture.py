"""Capturador de sitios web: Markdown limpio, HTML offline, captura de pantalla y PDF."""
from __future__ import annotations

import base64
import glob
import importlib.util
import json
import mimetypes
import os
import re
import shutil
import threading
import time
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, UnicodeDammit

from app.config import SettingsStore
from app.cookies import browser_jar, cookies_for_url
from app.convert import (CHAT_HOSTS, html_to_markdown, has_pandoc, localize_images, page_meta,  # noqa: F401
                         pandoc_convert)
from app.jobs import JobCancelled, JobStore
from app.security import allow_private, assert_public_host, validate_web_url

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0.0.0 Safari/537.36")
MAX_PAGE_BYTES = 15 * 1024 * 1024
MAX_ASSET_BYTES = 4 * 1024 * 1024
MAX_TOTAL_ASSET_BYTES = 30 * 1024 * 1024
SKIP_LINK_EXT = re.compile(r"\.(pdf|zip|rar|7z|exe|dmg|mp4|mp3|avi|mov|jpe?g|png|gif|webp|svg|ico|css|js|xml)(\?|$)", re.I)


class CaptureError(Exception):
    pass


class HttpStatusError(CaptureError):
    def __init__(self, status: int) -> None:
        super().__init__(f"El sitio respondio con error HTTP {status}.")
        self.status = status


@dataclass
class CaptureOptions:
    markdown: bool = True
    html: bool = False
    screenshot: bool = False
    pdf: bool = False
    docx: bool = False
    epub: bool = False
    images: bool = True  # guardar las imagenes en una carpeta images/
    from_extension: bool = False
    full_content: bool = False  # False = solo el articulo principal
    render: str = "auto"  # auto | always | never (JavaScript con navegador)
    depth: int = 0  # 0 = solo la pagina; 1-2 = seguir enlaces del mismo sitio
    max_pages: int = 10


# ----------------------------------------------------------------- red segura
def _client(jar=None) -> httpx.Client:
    return httpx.Client(cookies=jar, headers={"User-Agent": USER_AGENT, "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
                                 "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"},
                        timeout=httpx.Timeout(20.0), follow_redirects=False)


def safe_get(client: httpx.Client, url: str, max_bytes: int = MAX_PAGE_BYTES) -> tuple[bytes, str, str, str | None]:
    """GET con validacion SSRF en cada redireccion y limite de tamano.
    Devuelve (contenido, url_final, content_type, charset)."""
    current = url
    for _ in range(6):
        parsed = urlparse(current)
        if parsed.scheme not in {"http", "https"}:
            raise CaptureError("Solo se permiten enlaces http/https.")
        assert_public_host(parsed.hostname or "")
        with client.stream("GET", current) as resp:
            if resp.status_code in {301, 302, 303, 307, 308} and resp.headers.get("location"):
                current = urljoin(current, resp.headers["location"])
                continue
            if resp.status_code >= 400:
                raise HttpStatusError(resp.status_code)
            declared = resp.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise CaptureError("El recurso es demasiado grande.")
            chunks, size = [], 0
            for chunk in resp.iter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise CaptureError("El recurso es demasiado grande.")
                chunks.append(chunk)
            return b"".join(chunks), current, resp.headers.get("content-type", ""), resp.charset_encoding
    raise CaptureError("Demasiadas redirecciones.")


def decode_html(content: bytes, charset: str | None) -> str:
    return UnicodeDammit(content, [charset] if charset else []).unicode_markup or ""


# ------------------------------------------------------------- extraccion
def front_matter(meta: dict, url: str) -> str:
    def q(v: str) -> str:
        return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'
    lines = ["---", f"title: {q(meta.get('title') or '')}", f"source: {url}",
             f"captured: {datetime.now().strftime('%Y-%m-%d %H:%M')}"]
    for key in ("author", "published", "language", "site_name"):
        if meta.get(key):
            lines.append(f"{key}: {q(meta[key])}")
    if meta.get("description"):
        lines.append(f"description: {q(meta['description'])}")
    lines.append("---")
    return "\n".join(lines)


# ----------------------------------------------------------- HTML offline
class AssetInliner:
    """Descarga imagenes/CSS/fuentes y las incrusta como data: URIs."""

    def __init__(self, client: httpx.Client, check: callable) -> None:
        self.client, self.check = client, check
        self.cache: dict[str, str | None] = {}
        self.total = 0
        self.lock = threading.Lock()

    def data_uri(self, url: str) -> str | None:
        with self.lock:
            if url in self.cache:
                return self.cache[url]
            if self.total >= MAX_TOTAL_ASSET_BYTES:
                return None
        self.check()
        try:
            content, final, ctype, _ = safe_get(self.client, url, MAX_ASSET_BYTES)
        except Exception:  # noqa: BLE001 - un recurso roto no debe romper la captura
            content = None
        uri = None
        if content:
            mime = (ctype.split(";")[0].strip() or mimetypes.guess_type(final)[0] or "application/octet-stream")
            uri = f"data:{mime};base64,{base64.b64encode(content).decode()}"
        with self.lock:
            self.cache[url] = uri
            if content:
                self.total += len(content)
        return uri

    def css(self, text: str, base: str) -> str:
        def repl(match: re.Match) -> str:
            raw = match.group(2).strip()
            if raw.startswith(("data:", "#")):
                return match.group(0)
            if re.search(r"\.(ttf|otf|woff|eot)(\?|#|$)", raw, re.I):  # el navegador usa el woff2 listado antes
                return match.group(0)
            uri = self.data_uri(urljoin(base, raw))
            return f"url({match.group(1)}{uri}{match.group(1)})" if uri else match.group(0)
        return re.sub(r"url\(\s*(['\"]?)([^)'\"]+)\1\s*\)", repl, text)


def inline_page(html: str, base_url: str, client: httpx.Client, check: callable) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(["script", "noscript", "iframe", "object", "embed", "base"]):
        tag.decompose()
    for tag in soup.find_all("link", rel=True):
        rels = {r.lower() for r in (tag["rel"] if isinstance(tag["rel"], list) else [tag["rel"]])}
        if rels & {"preload", "prefetch", "modulepreload", "dns-prefetch", "preconnect"}:
            tag.decompose()
    for tag in soup.find_all(True):
        for attr in [a for a in tag.attrs if a.lower().startswith("on")]:
            del tag[attr]

    inliner = AssetInliner(client, check)
    imgs = []
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or img.get("data-lazy-src")
        if not src and img.get("srcset"):
            src = img["srcset"].split(",")[0].strip().split(" ")[0]
        if src and not src.startswith("data:"):
            imgs.append((img, urljoin(base_url, src)))
        for attr in ("srcset", "data-srcset", "sizes", "loading"):
            if img.has_attr(attr):
                del img[attr]
    for source in soup.find_all("source"):
        for attr in ("srcset", "src"):
            if source.has_attr(attr):
                del source[attr]
    sheets = [(tag, urljoin(base_url, tag["href"])) for tag in soup.find_all("link", href=True)
              if "stylesheet" in " ".join(tag.get("rel") or []).lower()]
    icons = [(tag, urljoin(base_url, tag["href"])) for tag in soup.find_all("link", href=True)
             if "icon" in " ".join(tag.get("rel") or []).lower()]

    with ThreadPoolExecutor(max_workers=8) as pool:
        urls = {u for _, u in imgs} | {u for _, u in icons}
        list(pool.map(inliner.data_uri, urls))
    for img, url in imgs:
        uri = inliner.data_uri(url)
        img["src"] = uri or url
    for tag, url in icons:
        tag["href"] = inliner.data_uri(url) or url
    for link, url in sheets:
        try:
            check()
            content, final, _, charset = safe_get(client, url, 2 * 1024 * 1024)
            style = soup.new_tag("style")
            style.string = inliner.css(decode_html(content, charset), final)
            link.replace_with(style)
        except Exception:  # noqa: BLE001
            link["href"] = url
    for style in soup.find_all("style"):
        if style.string:
            style.string = inliner.css(style.string, base_url)
    for a in soup.find_all("a", href=True):
        if not a["href"].startswith(("#", "javascript:", "mailto:", "tel:", "data:")):
            a["href"] = urljoin(base_url, a["href"])
    stamp = f"<!-- Capturado con TikSave desde {base_url} el {datetime.now().isoformat(timespec='seconds')} -->\n"
    return stamp + str(soup)


# ----------------------------------------------------------------- navegador
def _browser_candidates() -> list[dict]:
    paths: list[str] = []
    if os.getenv("TIKSAVE_BROWSER"):
        paths.append(os.environ["TIKSAVE_BROWSER"])
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        root = os.getenv(env)
        if root:
            paths += [os.path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
                      os.path.join(root, "Google", "Chrome", "Application", "chrome.exe")]
    paths += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    paths += [p for p in (shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge")) if p]
    cache = os.getenv("PLAYWRIGHT_BROWSERS_PATH") or str(Path.home() / ".cache" / "ms-playwright")
    paths += sorted(glob.glob(os.path.join(cache, "chromium-*", "chrome-linux*", "chrome")), reverse=True)
    return [{"executable_path": p} for p in paths if os.path.isfile(p)]


def browser_available() -> bool:
    if importlib.util.find_spec("playwright") is None:
        return False
    cache = os.getenv("PLAYWRIGHT_BROWSERS_PATH") or str(Path.home() / ".cache" / "ms-playwright")
    bundled = bool(glob.glob(os.path.join(cache, "chromium*")) or
                   glob.glob(os.path.join(os.getenv("LOCALAPPDATA", "-"), "ms-playwright", "chromium*")))
    return bool(_browser_candidates()) or bundled


_host_ok_cache: dict[str, bool] = {}


def _host_allowed(host: str) -> bool:
    if host not in _host_ok_cache:
        try:
            assert_public_host(host)
            _host_ok_cache[host] = True
        except ValueError:
            _host_ok_cache[host] = False
    return _host_ok_cache[host]


_SCROLL_JS = """async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let last = -1;
  for (let i = 0; i < 30; i++) {
    window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
    await sleep(250);
    const h = document.documentElement.scrollHeight;
    if (window.scrollY + window.innerHeight >= h - 4) { if (h === last) break; last = h; }
  }
  window.scrollTo(0, 0);
  await sleep(300);
}"""


def render_page(url: str, shot: Path | None, pdf: Path | None, html_file: Path | None = None,
                cookies: list[dict] | None = None) -> tuple[str, str, list[str]]:
    """Abre la pagina en un navegador real. Devuelve (html_renderizado, url_final, avisos)."""
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright

    warnings: list[str] = []
    with sync_playwright() as p:
        browser, last_error = None, None
        for kwargs in [*_browser_candidates(), {}]:
            try:
                browser = p.chromium.launch(headless=True, **kwargs)
                break
            except PlaywrightError as exc:
                last_error = exc
        if browser is None:
            raise CaptureError("No se encontro un navegador (Edge/Chrome). Instala Chrome o ejecuta: "
                               f"python -m playwright install chromium. Detalle: {str(last_error)[:120]}")
        try:
            context = browser.new_context(viewport={"width": 1366, "height": 900}, user_agent=USER_AGENT,
                                          locale="es-MX", ignore_https_errors=False)

            def guard(route):
                target = urlparse(route.request.url)
                if target.scheme in {"http", "https"} and not (allow_private() or _host_allowed(target.hostname or "")):
                    return route.abort()
                return route.continue_()

            context.route("**/*", guard)
            if cookies:
                context.add_cookies(cookies)
            page = context.new_page()
            page.set_default_timeout(30000)
            try:
                page.goto(html_file.as_uri() if html_file else url, wait_until="domcontentloaded", timeout=30000)
            except PlaywrightError as exc:
                raise CaptureError(f"No se pudo abrir la pagina: {str(exc).splitlines()[0][:160]}") from exc
            try:
                page.wait_for_load_state("networkidle", timeout=8000)
            except PlaywrightError:
                warnings.append("La pagina sigue cargando recursos; se capturo lo disponible.")
            try:
                page.evaluate(_SCROLL_JS)
                page.wait_for_load_state("networkidle", timeout=3000)
            except PlaywrightError:
                pass
            final_url = page.url
            if shot:
                try:
                    page.screenshot(path=str(shot), full_page=True)
                except PlaywrightError:
                    page.screenshot(path=str(shot), full_page=False)
                    warnings.append("La pagina es muy larga: la captura solo incluye la parte visible.")
            if pdf:
                page.pdf(path=str(pdf), format="A4", print_background=True)
            return page.content(), final_url, warnings
        finally:
            browser.close()


# ------------------------------------------------------------------ servicio
def slugify(text: str, fallback: str = "pagina") -> str:
    text = re.sub(r"[^\w\- ]+", "", text or "", flags=re.UNICODE).strip()
    text = re.sub(r"\s+", "-", text)[:60].strip("-")
    return text or fallback


class CaptureService:
    def __init__(self, settings: SettingsStore, jobs: JobStore, pool: ThreadPoolExecutor) -> None:
        self.settings, self.jobs, self.pool = settings, jobs, pool
        self._sources: dict[str, str] = {}  # DOM recibido de la extension (solo en memoria)

    def enqueue(self, url: str, options: CaptureOptions, source_html: str | None = None) -> dict:
        if source_html is not None:  # DOM ya renderizado por la extension: no se descarga nada de la pagina
            parsed = urlparse((url or "").strip())
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError("Direccion de la pagina no valida.")
            url = url.strip()
            options.from_extension = True
        else:
            url = validate_web_url(url)
        if not (options.markdown or options.html or options.screenshot or options.pdf or options.docx or options.epub):
            raise ValueError("Elige al menos un formato de captura.")
        options.depth = 0 if source_html is not None else max(0, min(options.depth, 2))
        options.max_pages = max(1, min(options.max_pages, 50))
        if options.render not in {"auto", "always", "never"}:
            options.render = "auto"
        job = self.jobs.create("capture", url, "capture", options.__dict__.copy())
        if source_html is not None:
            self._sources[job.id] = source_html
            while len(self._sources) > 5:
                self._sources.pop(next(iter(self._sources)))
        self.pool.submit(self._run, job.id)
        return self.jobs.get(job.id) or {}

    def retry(self, job_id: str) -> dict | None:
        old = self.jobs.get(job_id)
        if not old or old["kind"] != "capture":
            return None
        options = CaptureOptions(**old["options"])
        if options.from_extension:
            if job_id not in self._sources:
                raise ValueError("Esta captura vino de la extension: vuelve a capturar la pagina desde ella.")
            return self.enqueue(old["url"], options, self._sources[job_id])
        return self.enqueue(old["url"], options)

    def _run(self, job_id: str) -> None:
        try:
            self.jobs.check_cancel(job_id)
            self._capture(job_id)
        except JobCancelled:
            self.jobs.update(job_id, status="cancelled", stage=None)
        except CaptureError as exc:
            self.jobs.update(job_id, status="error", stage=None, error=str(exc))
        except httpx.HTTPError as exc:
            self.jobs.update(job_id, status="error", stage=None,
                             error=f"No se pudo conectar con el sitio: {type(exc).__name__}. Revisa la direccion y tu internet.")
        except ValueError as exc:
            self.jobs.update(job_id, status="error", stage=None, error=str(exc))
        except Exception as exc:  # noqa: BLE001
            self.jobs.update(job_id, status="error", stage=None, error=f"Error inesperado: {str(exc)[:300]}")

    def _capture(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        host = urlparse(job["url"]).hostname or "sitio"
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_dir = self.settings.download_dir / "Sitios" / f"{slugify(host)}-{stamp}"
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._capture_into(job_id, job, out_dir, host)
        except BaseException:
            shutil.rmtree(out_dir, ignore_errors=True)  # no dejar carpetas vacias de capturas fallidas
            raise

    def _capture_into(self, job_id: str, job: dict, out_dir: Path, host: str) -> None:
        opts = CaptureOptions(**job["options"])
        url = job["url"]
        source_html = self._sources.get(job_id)
        check = lambda: self.jobs.check_cancel(job_id)  # noqa: E731
        step = lambda stage, pct: self.jobs.update(job_id, status="downloading", stage=stage, progress=pct)  # noqa: E731
        warnings: list[str] = []
        caps_browser = browser_available()
        need_browser_outputs = opts.screenshot or opts.pdf
        login_hint = ("Si la pagina exige iniciar sesion (ChatGPT, Gemini, redes sociales), usa la extension de TikSave: "
                      "captura lo que ya ves en tu navegador, con tu sesion.")

        jar = None
        try:
            jar = browser_jar(self.settings.value.cookies_browser)
        except (RuntimeError, ValueError) as exc:
            warnings.append(str(exc))
        page_cookies = cookies_for_url(jar, url) if jar is not None else []
        step("Abriendo la pagina", 5)
        with _client(jar) as client:
            html = final_url = None
            rendered = source_html is not None
            shot_tmp = out_dir / "_tmp.png" if opts.screenshot else None
            pdf_tmp = out_dir / "_tmp.pdf" if opts.pdf else None
            early_render = False  # shot/pdf ya generados desde la URL en vivo

            if source_html is not None:
                html, final_url = source_html, url
            else:
                static_html, blocked = None, False
                if opts.render != "always" and not need_browser_outputs:
                    try:
                        content, final_url, ctype, charset = safe_get(client, url)
                        if "html" not in ctype.lower() and "xml" not in ctype.lower() and content[:1] != b"<":
                            raise CaptureError(f"El enlace no es una pagina web ({ctype or 'tipo desconocido'}).")
                        static_html = html = decode_html(content, charset)
                    except HttpStatusError as exc:
                        if exc.status in {401, 403, 429, 503} and caps_browser and opts.render != "never":
                            blocked = True
                            warnings.append("El sitio bloqueo la descarga directa; se abrio con el navegador.")
                        else:
                            raise CaptureError(f"{exc} {login_hint}") from exc
                check()
                wants_render = blocked or opts.render == "always" or need_browser_outputs
                if opts.render == "auto" and static_html is not None:
                    visible = len(BeautifulSoup(static_html, "html.parser").get_text(" ", strip=True))
                    wants_render = visible < 400  # probable pagina hecha con JavaScript
                if wants_render and opts.render != "never":
                    if caps_browser:
                        step("Renderizando con navegador", 25)
                        try:
                            html, final_url, w = render_page(final_url or url, shot_tmp, pdf_tmp, cookies=page_cookies or None)
                            rendered, early_render, warnings = True, True, warnings + w
                        except CaptureError:
                            if need_browser_outputs or static_html is None:
                                raise
                            warnings.append("No se pudo renderizar JavaScript; se uso el HTML estatico.")
                    elif need_browser_outputs:
                        warnings.append("Captura de pantalla/PDF omitidos: no hay navegador. Instala Edge/Chrome o ejecuta "
                                        "'python -m playwright install chromium'.")
                    elif opts.render == "always":
                        warnings.append("Renderizado JavaScript omitido: no hay navegador disponible.")
                if html is None:
                    content, final_url, ctype, charset = safe_get(client, url)
                    html = decode_html(content, charset)
            check()
            final_url = final_url or url

            soup_meta = page_meta(BeautifulSoup(html, "html.parser"), final_url)
            slug = slugify(soup_meta["title"], slugify(host))
            files: list[Path] = []
            final_path = lambda suffix: out_dir / f"{slug}{suffix}"  # noqa: E731

            for tmp, suffix in ((shot_tmp, ".png"), (pdf_tmp, ".pdf")):
                if tmp and tmp.exists():
                    tmp.replace(final_path(suffix))
                    files.append(final_path(suffix))

            # ---- texto (Markdown) y derivados ----
            step("Convirtiendo a Markdown", 45)
            body, meta = html_to_markdown(html, final_url, opts.full_content, keep_data_images=opts.images)
            chat = meta.get("chat")
            known_chat = next((name for domain, name in CHAT_HOSTS.items() if host == domain or host.endswith("." + domain)), None)
            if known_chat and not chat:
                if source_html is None:
                    raise CaptureError(f"{known_chat} solo muestra la conversacion con tu sesion iniciada, y el servidor no la tiene "
                                       "(lo que se veria es la pagina de inicio). Abre la conversacion en tu navegador y usa la "
                                       "extension de TikSave: Capturar esta pagina.")
                warnings.append(f"No encontre mensajes de {known_chat} en la pagina: puede que haya cambiado su formato.")
            elif chat:
                warnings.append(f"Conversacion de {chat} detectada: {meta['messages']} mensajes.")
            elif source_html is None and len(body) < 800 and re.search(
                    r"(iniciar sesi[oó]n|inicia sesi[oó]n|acceder|sign in|log ?in)", body, re.I):
                warnings.append("Parece una pagina de inicio de sesion: el contenido real puede requerir tu cuenta. " + login_hint)
            elif len(body) < 80:
                warnings.append("Se extrajo muy poco texto; prueba 'Pagina completa' o 'Renderizar JavaScript'.")

            reading = bool(chat)  # los chats se imprimen/guardan desde una vista de lectura limpia, no desde la app
            need_md = opts.markdown or opts.docx or opts.epub or (reading and (opts.html or need_browser_outputs))
            md_path = final_path(".md")
            if need_md:
                if opts.images:
                    step("Guardando imagenes", 55)

                    def fetch(src: str) -> tuple[bytes, str]:
                        check()
                        content, _, ctype, _ = safe_get(client, src, 8 * 1024 * 1024)
                        return content, ctype

                    body, saved, failed = localize_images(body, out_dir, fetch)
                    if failed:
                        warnings.append(f"{failed} imagen(es) no se pudieron guardar (si requieren sesion, usa la extension).")
                else:
                    body = re.sub(r"!\[[^\]]*\]\(data:[^)]*\)", "", body)
                md_path.write_text(front_matter(meta, final_url) + "\n\n" + body + "\n", encoding="utf-8")
                if opts.markdown:
                    files.append(md_path)
            if opts.docx or opts.epub:
                for fmt, wanted in (("docx", opts.docx), ("epub", opts.epub)):
                    if not wanted:
                        continue
                    if not has_pandoc():
                        warnings.append(f"No se genero el {fmt.upper()}: falta pypandoc (pip install pypandoc_binary).")
                        continue
                    step(f"Generando {fmt.upper()}", 65)
                    try:
                        pandoc_convert(md_path, fmt, final_path(f".{fmt}"), out_dir)
                        files.append(final_path(f".{fmt}"))
                    except Exception as exc:  # noqa: BLE001
                        warnings.append(f"No se pudo generar el {fmt.upper()}: {str(exc)[:160]}")
            check()

            # ---- HTML offline / lectura, y PDF / captura cuando no salieron de la URL en vivo ----
            render_src: Path | None = None
            if reading and (opts.html or need_browser_outputs) and has_pandoc():
                step("Generando vista de lectura", 75)
                render_src = final_path(".html") if opts.html else out_dir / "_render.html"
                try:
                    pandoc_convert(md_path, "html", render_src, out_dir)
                    if opts.html:
                        files.append(render_src)
                except Exception as exc:  # noqa: BLE001
                    render_src = None
                    warnings.append(f"No se pudo generar la vista de lectura: {str(exc)[:160]}")
            elif opts.html or (need_browser_outputs and not early_render):
                step("Guardando HTML offline (descargando recursos)", 75)
                inlined = inline_page(html, final_url, client, check)
                render_src = final_path(".html") if opts.html else out_dir / "_render.html"
                render_src.write_text(inlined, encoding="utf-8")
                if opts.html:
                    files.append(render_src)
            if need_browser_outputs and not early_render:
                if render_src and caps_browser:
                    step("Generando PDF / captura", 85)
                    try:
                        render_page(final_url, shot_tmp, pdf_tmp, html_file=render_src)
                        for tmp, suffix in ((shot_tmp, ".png"), (pdf_tmp, ".pdf")):
                            if tmp and tmp.exists():
                                tmp.replace(final_path(suffix))
                                files.append(final_path(suffix))
                    except CaptureError as exc:
                        warnings.append(str(exc))
                elif not caps_browser:
                    warnings.append("PDF / captura de pantalla omitidos: no hay navegador (Edge o Chrome).")
            (out_dir / "_render.html").unlink(missing_ok=True)
            if not opts.markdown and md_path.exists():
                md_path.unlink()
                shutil.rmtree(out_dir / "images", ignore_errors=True)

            pages = 1
            if opts.depth > 0 and opts.markdown:
                pages += self._crawl(client, final_url, html, opts, out_dir, step, check, warnings)
                if (out_dir / "indice.md").exists():
                    files.append(out_dir / "indice.md")

            (out_dir / "captura.json").write_text(json.dumps({
                **soup_meta, "url": url, "final_url": final_url, "captured_at": datetime.now().isoformat(timespec="seconds"),
                "rendered_with_browser": rendered, "from_extension": source_html is not None, "chat": chat,
                "messages": meta.get("messages"), "pages": pages}, ensure_ascii=False, indent=2), encoding="utf-8")
            files.append(out_dir / "captura.json")

        if not any(f.suffix in {".md", ".html", ".png", ".pdf", ".docx", ".epub"} for f in files):
            raise CaptureError("No se pudo generar ningun archivo. " + " ".join(warnings))
        order = {".md": 0, ".docx": 1, ".html": 2, ".pdf": 3, ".png": 4, ".epub": 5}
        files.sort(key=lambda f: order.get(f.suffix, 9))
        extra = [str(p) for p in sorted((out_dir / "paginas").glob("*.md"))] if (out_dir / "paginas").exists() else []
        self.jobs.update(job_id, status="done", stage=None, progress=100.0, title=soup_meta["title"],
                         thumbnail=soup_meta.get("image"), uploader=host, files=[str(f) for f in files] + extra,
                         filename=str(files[0]), warnings=warnings)

    def _crawl(self, client: httpx.Client, start_url: str, start_html: str, opts: CaptureOptions,
               out_dir: Path, step, check, warnings: list[str]) -> int:
        host = urlparse(start_url).hostname
        robots = urllib.robotparser.RobotFileParser()
        try:
            content, _, _, charset = safe_get(client, urljoin(start_url, "/robots.txt"), 256 * 1024)
            robots.parse(decode_html(content, charset).splitlines())
        except Exception:  # noqa: BLE001 - sin robots.txt se permite
            robots = None

        def links(html: str, base: str) -> list[str]:
            out = []
            for a in BeautifulSoup(html, "html.parser").find_all("a", href=True):
                href = urldefrag(urljoin(base, a["href"]))[0]
                p = urlparse(href)
                if p.scheme in {"http", "https"} and p.hostname == host and not SKIP_LINK_EXT.search(p.path or "/"):
                    out.append(href)
            return list(dict.fromkeys(out))

        seen = {urldefrag(start_url)[0]}
        frontier, saved, index = [(u, 1) for u in links(start_html, start_url)], 0, []
        pages_dir = out_dir / "paginas"
        queue_i = 0
        while queue_i < len(frontier) and saved < opts.max_pages - 1:
            url, depth = frontier[queue_i]
            queue_i += 1
            if url in seen:
                continue
            seen.add(url)
            if robots and not robots.can_fetch(USER_AGENT, url):
                continue
            check()
            step(f"Siguiendo enlaces ({saved + 1}/{opts.max_pages - 1})", min(95, 75 + saved * 20 // max(1, opts.max_pages)))
            try:
                content, final, ctype, charset = safe_get(client, url)
                if "html" not in ctype.lower():
                    continue
                html = decode_html(content, charset)
                body, meta = html_to_markdown(html, final, opts.full_content)
            except (CaptureError, httpx.HTTPError, ValueError):
                continue
            pages_dir.mkdir(exist_ok=True)
            saved += 1
            name = f"{saved:02d}-{slugify(meta['title'], 'pagina')}.md"
            (pages_dir / name).write_text(front_matter(meta, final) + "\n\n" + body + "\n", encoding="utf-8")
            index.append(f"- [{meta['title']}](paginas/{name}) - {final}")
            if depth < opts.depth:
                frontier.extend((u, depth + 1) for u in links(html, final))
            time.sleep(0.3)
        if index:
            (out_dir / "indice.md").write_text("# Paginas capturadas\n\n" + "\n".join(index) + "\n", encoding="utf-8")
        elif opts.depth:
            warnings.append("No se encontraron enlaces del mismo sitio para seguir (o robots.txt lo impide).")
        return saved
