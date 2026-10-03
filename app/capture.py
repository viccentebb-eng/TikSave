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
from markdownify import markdownify

from app.config import SettingsStore
from app.jobs import JobCancelled, JobStore
from app.security import allow_private, assert_public_host, validate_web_url

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0.0.0 Safari/537.36")
MAX_PAGE_BYTES = 15 * 1024 * 1024
MAX_ASSET_BYTES = 4 * 1024 * 1024
MAX_TOTAL_ASSET_BYTES = 30 * 1024 * 1024
SKIP_LINK_EXT = re.compile(r"\.(pdf|zip|rar|7z|exe|dmg|mp4|mp3|avi|mov|jpe?g|png|gif|webp|svg|ico|css|js|xml)(\?|$)", re.I)
NOISE_TAGS = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "form", "dialog", "button"]
CHROME_TAGS = ["nav", "footer", "aside"]
NOISE_ATTR = re.compile(r"(cookie|consent|newsletter|subscribe|popup|modal|advert|sponsor|sidebar|breadcrumb|share-|social)", re.I)


class CaptureError(Exception):
    pass


@dataclass
class CaptureOptions:
    markdown: bool = True
    html: bool = False
    screenshot: bool = False
    pdf: bool = False
    full_content: bool = False  # False = solo el articulo principal
    render: str = "auto"  # auto | always | never (JavaScript con navegador)
    depth: int = 0  # 0 = solo la pagina; 1-2 = seguir enlaces del mismo sitio
    max_pages: int = 10


# ----------------------------------------------------------------- red segura
def _client() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT, "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
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
                raise CaptureError(f"El sitio respondio con error HTTP {resp.status_code}.")
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
def page_meta(soup: BeautifulSoup, url: str) -> dict:
    def meta(*names: str) -> str | None:
        for name in names:
            tag = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
            if tag and tag.get("content"):
                return tag["content"].strip()
        return None

    title = meta("og:title", "twitter:title") or (soup.title.string.strip() if soup.title and soup.title.string else None)
    if not title:
        h1 = soup.find("h1")
        title = h1.get_text(" ", strip=True) if h1 else None
    image = meta("og:image", "twitter:image")
    return {"title": title or urlparse(url).hostname, "description": meta("og:description", "description"),
            "author": meta("author", "article:author"), "published": meta("article:published_time"),
            "language": (soup.html.get("lang") if soup.html else None), "image": urljoin(url, image) if image else None,
            "site_name": meta("og:site_name")}


def _text_len(tag) -> int:
    return len(tag.get_text(" ", strip=True))


def main_container(soup: BeautifulSoup, full: bool):
    body = soup.body or soup
    if full:
        return body
    articles = soup.find_all("article")
    if articles:
        best = max(articles, key=_text_len)
        if _text_len(best) > 300:
            return best
    main = soup.find("main") or soup.find(attrs={"role": "main"})
    if main and _text_len(main) > 300:
        return main
    return body


def html_to_markdown(html: str, base_url: str, full: bool = False) -> tuple[str, dict]:
    soup = BeautifulSoup(html, "html.parser")
    meta = page_meta(soup, base_url)
    container = main_container(soup, full)
    for tag in container.find_all(NOISE_TAGS):
        tag.decompose()
    if not full:
        for tag in container.find_all(CHROME_TAGS):
            tag.decompose()
        for tag in container.find_all(True):
            if tag.attrs is None:
                continue
            ident = f"{' '.join(tag.get('class') or [])} {tag.get('id') or ''}"
            if NOISE_ATTR.search(ident):
                tag.decompose()
    for img in container.find_all("img"):
        src = img.get("data-src") or img.get("data-lazy-src") or img.get("src") or ""
        if not src or src.startswith("data:"):
            img.decompose()
        else:
            img["src"] = urljoin(base_url, src)
    for a in container.find_all("a", href=True):
        href = a["href"]
        if href.startswith(("javascript:", "mailto:", "tel:", "#")):
            del a["href"]
        else:
            a["href"] = urljoin(base_url, href)
    text = markdownify(str(container), heading_style="ATX", bullets="-")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text, meta


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


def render_page(url: str, shot: Path | None, pdf: Path | None) -> tuple[str, str, list[str]]:
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
            page = context.new_page()
            page.set_default_timeout(30000)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
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

    def enqueue(self, url: str, options: CaptureOptions) -> dict:
        url = validate_web_url(url)
        if not (options.markdown or options.html or options.screenshot or options.pdf):
            raise ValueError("Elige al menos un formato de captura.")
        options.depth = max(0, min(options.depth, 2))
        options.max_pages = max(1, min(options.max_pages, 50))
        if options.render not in {"auto", "always", "never"}:
            options.render = "auto"
        job = self.jobs.create("capture", url, "capture", options.__dict__.copy())
        self.pool.submit(self._run, job.id)
        return self.jobs.get(job.id) or {}

    def retry(self, job_id: str) -> dict | None:
        old = self.jobs.get(job_id)
        if not old or old["kind"] != "capture":
            return None
        return self.enqueue(old["url"], CaptureOptions(**old["options"]))

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
        opts = CaptureOptions(**job["options"])
        url = job["url"]
        check = lambda: self.jobs.check_cancel(job_id)  # noqa: E731
        step = lambda stage, pct: self.jobs.update(job_id, status="downloading", stage=stage, progress=pct)  # noqa: E731
        warnings: list[str] = []
        caps_browser = browser_available()
        need_browser_outputs = opts.screenshot or opts.pdf

        host = urlparse(url).hostname or "sitio"
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_dir = self.settings.download_dir / "Sitios" / f"{slugify(host)}-{stamp}"
        out_dir.mkdir(parents=True, exist_ok=True)

        step("Abriendo la pagina", 5)
        with _client() as client:
            html = final_url = None
            rendered = False
            slug_tmp = out_dir / "_tmp"
            shot_tmp = slug_tmp.with_suffix(".png") if opts.screenshot else None
            pdf_tmp = slug_tmp.with_suffix(".pdf") if opts.pdf else None

            static_html = None
            if opts.render != "always" and not need_browser_outputs:
                content, final_url, ctype, charset = safe_get(client, url)
                if "html" not in ctype.lower() and "xml" not in ctype.lower() and content[:1] != b"<":
                    raise CaptureError(f"El enlace no es una pagina web ({ctype or 'tipo desconocido'}).")
                static_html = decode_html(content, charset)
                html = static_html
            check()
            wants_render = opts.render == "always" or need_browser_outputs
            if opts.render == "auto" and static_html is not None:
                visible = len(BeautifulSoup(static_html, "html.parser").get_text(" ", strip=True))
                wants_render = visible < 400  # probable pagina hecha con JavaScript
            if wants_render and opts.render != "never":
                if caps_browser:
                    step("Renderizando con navegador", 25)
                    try:
                        html, final_url, w = render_page(final_url or url, shot_tmp, pdf_tmp)
                        rendered, warnings = True, warnings + w
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

            def final_path(suffix: str) -> Path:
                return out_dir / f"{slug}{suffix}"

            for tmp, suffix in ((shot_tmp, ".png"), (pdf_tmp, ".pdf")):
                if tmp and tmp.exists():
                    tmp.replace(final_path(suffix))
                    files.append(final_path(suffix))

            if opts.markdown:
                step("Convirtiendo a Markdown", 55)
                body, meta = html_to_markdown(html, final_url, opts.full_content)
                if len(body) < 80:
                    warnings.append("Se extrajo muy poco texto; prueba 'Pagina completa' o 'Renderizar JavaScript'.")
                final_path(".md").write_text(front_matter(meta, final_url) + "\n\n" + body + "\n", encoding="utf-8")
                files.append(final_path(".md"))
            if opts.html:
                step("Guardando HTML offline (descargando recursos)", 70)
                final_path(".html").write_text(inline_page(html, final_url, client, check), encoding="utf-8")
                files.append(final_path(".html"))

            pages = 1
            if opts.depth > 0 and opts.markdown:
                pages += self._crawl(client, final_url, html, opts, out_dir, step, check, warnings)
                if (out_dir / "indice.md").exists():
                    files.append(out_dir / "indice.md")

            (out_dir / "captura.json").write_text(json.dumps({
                **soup_meta, "url": url, "final_url": final_url, "captured_at": datetime.now().isoformat(timespec="seconds"),
                "rendered_with_browser": rendered, "pages": pages}, ensure_ascii=False, indent=2), encoding="utf-8")
            files.append(out_dir / "captura.json")

        if not any(f.suffix in {".md", ".html", ".png", ".pdf"} for f in files):
            raise CaptureError("No se pudo generar ningun archivo. " + " ".join(warnings))
        order = {".md": 0, ".html": 1, ".png": 2, ".pdf": 3}
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
