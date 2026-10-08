"""HTML -> Markdown con formulas, codigo, tablas y chats de IA; imagenes locales; exportes con pandoc."""
from __future__ import annotations

import base64
import importlib.util
import re
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup, NavigableString, Tag
from markdownify import markdownify

NOISE_TAGS = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "form", "dialog", "button"]
CHROME_TAGS = ["nav", "footer", "aside"]
NOISE_ATTR = re.compile(r"(cookie|consent|newsletter|subscribe|popup|modal|advert|sponsor|sidebar|breadcrumb|share-|social)", re.I)
MATH_CLASSES = {"katex-display", "katex", "MathJax", "MathJax_Display", "mjx-container"}
DISPLAY_CLASSES = {"katex-display", "MathJax_Display", "math-block"}
# Sitios de chat que exigen sesion: el servidor nunca vera la conversacion, solo la extension.
CHAT_HOSTS = {"chatgpt.com": "ChatGPT", "chat.openai.com": "ChatGPT", "gemini.google.com": "Gemini", "claude.ai": "Claude"}
IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
             "image/svg+xml": ".svg", "image/avif": ".avif", "image/bmp": ".bmp"}


def has_pandoc() -> bool:
    if importlib.util.find_spec("pypandoc") is None:
        return False
    try:
        import pypandoc
        pypandoc.get_pandoc_version()
        return True
    except Exception:  # noqa: BLE001
        return False


# --------------------------------------------------------------------- math
def _classes(tag: Tag) -> set[str]:
    return set(tag.get("class") or []) if isinstance(tag, Tag) else set()


def _detached(el: Tag, root: BeautifulSoup) -> bool:
    node = el
    while node.parent is not None:
        node = node.parent
    return node is not root


def extract_math(soup: BeautifulSoup) -> dict[str, str]:
    """Sustituye formulas (KaTeX, MathJax, MathML, Gemini, Wikipedia) por marcadores; devuelve marcador -> LaTeX."""
    store: dict[str, str] = {}

    def put(node: Tag, tex: str, display: bool) -> None:
        tex = tex.strip()
        if not tex:
            return
        key = f"TKSVMATH{len(store)}X"
        store[key] = f"\n\n$$\n{tex}\n$$\n\n" if display else f"${tex}$"
        node.replace_with(NavigableString(key))

    for el in soup.find_all(attrs={"data-math": True}):  # Gemini
        if not _detached(el, soup):
            put(el, el["data-math"], bool(_classes(el) & DISPLAY_CLASSES) or el.name == "div")
    for ann in soup.find_all("annotation", attrs={"encoding": re.compile("tex", re.I)}):  # KaTeX / MathML
        if _detached(ann, soup):
            continue
        wrappers = [p for p in ann.parents if isinstance(p, Tag) and _classes(p) & MATH_CLASSES]
        wrapper = wrappers[-1] if wrappers else ann.find_parent("math")
        if wrapper is None:
            continue
        display = any(_classes(p) & DISPLAY_CLASSES for p in [wrapper, *wrapper.parents] if isinstance(p, Tag)) \
            or (ann.find_parent("math") is not None and ann.find_parent("math").get("display") == "block")
        put(wrapper, ann.get_text(), display)
    for sc in soup.find_all("script", attrs={"type": re.compile(r"math/tex", re.I)}):  # MathJax v2
        if _detached(sc, soup):
            continue
        prev = sc.find_previous_sibling()
        if prev is not None and _classes(prev) & {"MathJax", "MathJax_Preview", "MathJax_Display"}:
            prev.decompose()
        put(sc, sc.get_text(), "mode=display" in sc.get("type", ""))
    for m in soup.find_all("math", attrs={"alttext": True}):
        if not _detached(m, soup):
            put(m, m["alttext"], m.get("display") == "block")
    for img in soup.find_all("img", class_=re.compile(r"mwe-math")):  # Wikipedia
        if not _detached(img, soup):
            tex = re.sub(r"^\{\\displaystyle\s*(.*)\}$", r"\1", (img.get("alt") or "").strip(), flags=re.S)
            put(img, tex, "inline" not in " ".join(img.get("class") or []))
    return store


# --------------------------------------------------------------------- chats
def _new_div(soup: BeautifulSoup) -> Tag:
    return soup.new_tag("div")


def extract_chat(soup: BeautifulSoup) -> tuple[Tag | None, str | None, int]:
    """Si la pagina es una conversacion de ChatGPT o Gemini, devuelve un contenedor ordenado por turnos."""
    turns: list[tuple[str, Tag]] = []
    platform = None
    gpt = soup.select("[data-message-author-role]")
    if gpt:
        platform = "ChatGPT"
        for el in gpt:
            role = el.get("data-message-author-role")
            if role in {"user", "assistant"}:
                body = el.select_one(".markdown") if role == "assistant" else None
                turns.append(("Tú" if role == "user" else "ChatGPT", body or el))
    else:
        gem = soup.select("user-query, model-response")
        if gem:
            platform = "Gemini"
            for el in gem:
                if el.name == "user-query":
                    turns.append(("Tú", el.select_one(".query-text") or el))
                else:
                    turns.append(("Gemini", el.select_one("message-content .markdown, .markdown, message-content") or el))
    if not turns:
        return None, None, 0
    box = _new_div(soup)
    for who, el in turns:
        h = soup.new_tag("h2")
        h.string = who
        box.append(h)
        wrap = _new_div(soup)
        wrap.append(el.extract() if el.parent is not None else el)
        box.append(wrap)
    return box, platform, len(turns)


# ------------------------------------------------------------------ markdown
def _text_len(tag: Tag) -> int:
    return len(tag.get_text(" ", strip=True))


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
    from urllib.parse import urlparse
    return {"title": title or urlparse(url).hostname, "description": meta("og:description", "description"),
            "author": meta("author", "article:author"), "published": meta("article:published_time"),
            "language": (soup.html.get("lang") if soup.html else None), "image": urljoin(url, image) if image else None,
            "site_name": meta("og:site_name")}


def main_container(soup: BeautifulSoup, full: bool) -> Tag:
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


def _clean_code_blocks(soup: BeautifulSoup, root: Tag) -> None:
    for pre in root.find_all("pre"):
        code = pre.find("code")
        lang = None
        for tag in (code, pre):
            for cls in (tag.get("class") or []) if tag is not None else []:
                match = re.match(r"(?:language|lang)-(\w[\w+#.-]*)$", cls)
                if match:
                    lang = match.group(1)
                    break
            if lang:
                break
        text = (code or pre).get_text()
        pre.clear()
        pre["data-lang"] = lang or ""
        pre.append(NavigableString(text.rstrip("\n")))


def html_to_markdown(html: str, base_url: str, full: bool = False, keep_data_images: bool = False) -> tuple[str, dict]:
    soup = BeautifulSoup(html, "html.parser")
    meta = page_meta(soup, base_url)
    math = extract_math(soup)
    chat_box, platform, messages = extract_chat(soup)
    meta["chat"], meta["messages"] = platform, messages
    container = chat_box or main_container(soup, full)
    for tag in container.find_all(NOISE_TAGS):
        tag.decompose()
    if not full and not chat_box:
        for tag in container.find_all(CHROME_TAGS):
            tag.decompose()
        for tag in container.find_all(True):
            if tag.attrs is None:
                continue
            ident = f"{' '.join(tag.get('class') or [])} {tag.get('id') or ''}"
            if NOISE_ATTR.search(ident):
                tag.decompose()
    _clean_code_blocks(soup, container)
    for img in container.find_all("img"):
        src = img.get("data-src") or img.get("data-lazy-src") or img.get("src") or ""
        if not src or (src.startswith("data:") and not keep_data_images):
            img.decompose()
        else:
            img["src"] = src if src.startswith("data:") else urljoin(base_url, src)
    for a in container.find_all("a", href=True):
        href = a["href"]
        if href.startswith(("javascript:", "mailto:", "tel:", "#")):
            del a["href"]
        else:
            a["href"] = urljoin(base_url, href)
    text = markdownify(str(container), heading_style="ATX", bullets="-",
                       code_language_callback=lambda el: el.get("data-lang") or None)
    for key, tex in math.items():
        text = text.replace(key, tex)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text, meta


# ------------------------------------------------------------- imagenes locales
_IMG = re.compile(r"!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\)")


def _ext_for(content: bytes, ctype: str, url: str) -> str:
    ctype = ctype.split(";")[0].strip().lower()
    if ctype in IMAGE_EXT:
        return IMAGE_EXT[ctype]
    for magic, ext in ((b"\x89PNG", ".png"), (b"\xff\xd8", ".jpg"), (b"GIF8", ".gif"), (b"RIFF", ".webp")):
        if content.startswith(magic):
            return ext
    match = re.search(r"\.(png|jpe?g|gif|webp|svg|avif)(?:\?|$)", url, re.I)
    return ("." + match.group(1).lower().replace("jpeg", "jpg")) if match else ".img"


def localize_images(md: str, out_dir: Path, fetch, max_images: int = 80) -> tuple[str, int, int]:
    """Guarda las imagenes del Markdown en out_dir/images y reescribe los enlaces.
    `fetch(url) -> (bytes, content_type)` descarga http(s). Devuelve (md, guardadas, fallidas)."""
    sources: list[str] = []
    for match in _IMG.finditer(md):
        src = match.group(2).strip("<>")
        if src not in sources:
            sources.append(src)
    saved, failed, mapping = 0, 0, {}
    folder = out_dir / "images"
    for src in sources[:max_images]:
        try:
            if src.startswith("data:"):
                header, _, payload = src.partition(",")
                content = base64.b64decode(payload) if ";base64" in header else payload.encode()
                ctype = header[5:].split(";")[0]
            else:
                content, ctype = fetch(src)
            if not content:
                raise ValueError("vacio")
            folder.mkdir(exist_ok=True)
            name = f"img-{saved + 1:02d}{_ext_for(content, ctype, src)}"
            (folder / name).write_bytes(content)
            mapping[src] = f"images/{name}"
            saved += 1
        except Exception:  # noqa: BLE001 - una imagen rota no debe romper la captura
            failed += 1
    failed += max(0, len(sources) - max_images)

    def repl(match: re.Match) -> str:
        src = match.group(2).strip("<>")
        if src in mapping:
            return f"![{match.group(1)}]({mapping[src]})"
        if src.startswith("data:"):  # no se pudo guardar: mejor sin imagen que con un base64 enorme
            return ""
        return match.group(0)

    return _IMG.sub(repl, md), saved, failed


# ----------------------------------------------------------------- pandoc
READING_CSS = """body{font:16px/1.6 system-ui,Segoe UI,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
h1,h2,h3{line-height:1.25}h2{margin-top:2rem;padding-top:.5rem;border-top:1px solid #ddd}
pre{background:#f5f6f8;padding:12px;border-radius:8px;overflow:auto}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}
img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}blockquote{border-left:4px solid #ccc;margin-left:0;padding-left:1rem;color:#555}"""
PANDOC_FROM = "markdown+tex_math_dollars+pipe_tables+yaml_metadata_block-implicit_figures"


def pandoc_convert(md_path: Path, fmt: str, out_path: Path, resource_dir: Path) -> None:
    import pypandoc

    extra = ["--resource-path", str(resource_dir)]
    if fmt == "html":
        css = resource_dir / "_reading.css"
        css.write_text(READING_CSS, encoding="utf-8")
        extra += ["--standalone", "--embed-resources", "--mathml", "--css", str(css), "--metadata", "lang=es"]
    try:
        pypandoc.convert_file(str(md_path), fmt, format=PANDOC_FROM, outputfile=str(out_path), extra_args=extra)
    finally:
        (resource_dir / "_reading.css").unlink(missing_ok=True)
