from __future__ import annotations

import re
import shutil
import struct
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse, unquote

from app.diagnostics import write_event


USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0"
MAX_PROBE_BYTES = 96 * 1024
KNOWN_SIZE_PARAMS = {
    "w", "width", "h", "height", "size", "sz", "resize", "fit", "crop",
    "dpr", "scale",
}


@dataclass
class Candidate:
    url: str
    rule: str
    priority: int = 0


@dataclass
class Probe:
    url: str
    rule: str
    ok: bool
    status: int | None = None
    content_type: str | None = None
    content_length: int | None = None
    width: int | None = None
    height: int | None = None
    final_url: str | None = None
    error: str | None = None

    @property
    def pixels(self) -> int:
        if self.width and self.height:
            return self.width * self.height
        return 0

    @property
    def score(self) -> tuple[int, int, int]:
        return (
            1 if self.ok else 0,
            self.pixels,
            int(self.content_length or 0),
        )


def status() -> dict:
    return {
        "installed": True,
        "name": "TikSave Native Image",
        "version": 1,
        "external_dependency": False,
    }


def _dedupe(candidates: list[Candidate]) -> list[Candidate]:
    seen: set[str] = set()
    out: list[Candidate] = []
    for item in sorted(candidates, key=lambda c: c.priority, reverse=True):
        if item.url in seen:
            continue
        seen.add(item.url)
        out.append(item)
    return out


def _google_candidates(url: str) -> list[Candidate]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not (
        host.endswith(".googleusercontent.com")
        or host.endswith(".ggpht.com")
        or host in {"googleusercontent.com", "ggpht.com"}
    ):
        return []

    candidates: list[Candidate] = []
    path = parsed.path

    # Google image URLs commonly use a final "=w123-h456..." or "=s512" sizing directive.
    match = re.search(r"=(?:s\d+|w\d+(?:-h\d+)?|h\d+(?:-w\d+)?)(?:-[a-z0-9_-]+)*$", path, re.I)
    if match:
        prefix = path[: match.start()]
        candidates.extend([
            Candidate(urlunparse(parsed._replace(path=prefix + "=s0")), "google:s0", 1000),
            Candidate(urlunparse(parsed._replace(path=prefix + "=s0", query="imgmax=0")), "google:s0-imgmax", 990),
            Candidate(urlunparse(parsed._replace(path=prefix + "=w0-h0")), "google:w0-h0", 970),
            Candidate(urlunparse(parsed._replace(path=prefix + "=s4096")), "google:s4096", 950),
        ])
    elif "=" not in path.rsplit("/", 1)[-1]:
        candidates.extend([
            Candidate(urlunparse(parsed._replace(path=path + "=s0")), "google:append-s0", 940),
            Candidate(urlunparse(parsed._replace(path=path + "=s0", query="imgmax=0")), "google:append-s0-imgmax", 930),
        ])

    return candidates


def _wordpress_candidates(url: str) -> list[Candidate]:
    parsed = urlparse(url)
    path = parsed.path
    candidates: list[Candidate] = []

    original_path = re.sub(
        r"-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp|avif)$)",
        "",
        path,
        flags=re.I,
    )
    if original_path != path:
        candidates.append(Candidate(urlunparse(parsed._replace(path=original_path)), "wordpress:strip-dimensions", 850))

    if "-scaled." in path:
        candidates.append(Candidate(urlunparse(parsed._replace(path=path.replace("-scaled.", "."))), "wordpress:strip-scaled", 820))

    return candidates


def _shopify_candidates(url: str) -> list[Candidate]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "shopify" not in host and "cdn.shopify.com" not in host:
        return []

    path = re.sub(
        r"_(?:pico|icon|thumb|small|compact|medium|large|grande|master|\d+x\d*|x\d+)(?=\.(?:jpe?g|png|webp|gif))",
        "",
        parsed.path,
        flags=re.I,
    )
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k.lower() not in {"width", "height"}]
    return [Candidate(urlunparse(parsed._replace(path=path, query=urlencode(query))), "shopify:original", 820)]


def _pinterest_candidates(url: str) -> list[Candidate]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host.endswith("pinimg.com"):
        return []

    path = re.sub(r"^/(?:75x75_RS|136x136|236x|474x|564x|736x)/", "/originals/", parsed.path, flags=re.I)
    if path == parsed.path:
        return []
    return [Candidate(urlunparse(parsed._replace(path=path)), "pinterest:originals", 900)]


def _twitter_candidates(url: str) -> list[Candidate]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host != "pbs.twimg.com":
        return []

    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if "name" in query:
        query["name"] = "orig"
        return [Candidate(urlunparse(parsed._replace(query=urlencode(query))), "twitter:name-orig", 900)]

    path = re.sub(r":(?:small|medium|large|thumb)$", ":orig", parsed.path, flags=re.I)
    if path != parsed.path:
        return [Candidate(urlunparse(parsed._replace(path=path)), "twitter:path-orig", 880)]

    return []


def _cloudinary_candidates(url: str) -> list[Candidate]:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if "cloudinary.com" not in host and "res.cloudinary.com" not in host:
        return []

    # /image/upload/<transformations>/v123/file.jpg -> /image/upload/v123/file.jpg
    path = parsed.path
    match = re.match(r"^(.*?/image/upload/)(.+?)/(v\d+/.*)$", path, re.I)
    if match and re.search(r"(?:^|,)(?:w_|h_|c_|q_|f_|ar_|dpr_)", match.group(2), re.I):
        clean = match.group(1) + match.group(3)
        return [Candidate(urlunparse(parsed._replace(path=clean)), "cloudinary:strip-transform", 860)]
    return []


def _generic_query_candidates(url: str) -> list[Candidate]:
    parsed = urlparse(url)
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    if not pairs:
        return []

    filtered = [(k, v) for k, v in pairs if k.lower() not in KNOWN_SIZE_PARAMS]
    if len(filtered) == len(pairs):
        return []

    return [Candidate(urlunparse(parsed._replace(query=urlencode(filtered))), "generic:strip-size-query", 300)]


def generate_candidates(url: str) -> list[Candidate]:
    candidates = [Candidate(url, "current", 1)]
    for rule in (
        _google_candidates,
        _pinterest_candidates,
        _twitter_candidates,
        _cloudinary_candidates,
        _shopify_candidates,
        _wordpress_candidates,
        _generic_query_candidates,
    ):
        try:
            candidates.extend(rule(url))
        except Exception as exc:
            write_event("native-image", "candidate-rule-error", level="warning", message=rule.__name__, exc=exc)

    return _dedupe(candidates)


def _jpeg_dimensions(data: bytes) -> tuple[int | None, int | None]:
    if not data.startswith(b"\xff\xd8"):
        return None, None

    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue

        marker = data[index + 1]
        index += 2

        if marker in {0xD8, 0xD9}:
            continue
        if index + 2 > len(data):
            break

        length = int.from_bytes(data[index:index + 2], "big")
        if length < 2 or index + length > len(data):
            break

        if marker in {
            0xC0, 0xC1, 0xC2, 0xC3,
            0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB,
            0xCD, 0xCE, 0xCF,
        } and length >= 7:
            height = int.from_bytes(data[index + 3:index + 5], "big")
            width = int.from_bytes(data[index + 5:index + 7], "big")
            return width, height

        index += length

    return None, None


def image_dimensions(data: bytes, content_type: str | None = None) -> tuple[int | None, int | None]:
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        return struct.unpack(">II", data[16:24])

    if len(data) >= 10 and data[:6] in {b"GIF87a", b"GIF89a"}:
        width, height = struct.unpack("<HH", data[6:10])
        return width, height

    width, height = _jpeg_dimensions(data)
    if width and height:
        return width, height

    # WebP VP8X canvas size.
    if len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X":
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
            return width, height

    return None, None


def probe(candidate: Candidate, referer: str | None = None) -> Probe:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Range": f"bytes=0-{MAX_PROBE_BYTES - 1}",
    }
    if referer:
        headers["Referer"] = referer

    request = urllib.request.Request(candidate.url, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            status_code = getattr(response, "status", 200)
            content_type = (response.headers.get_content_type() or "").lower()
            content_length_header = response.headers.get("Content-Length")
            content_range = response.headers.get("Content-Range") or ""
            data = response.read(MAX_PROBE_BYTES)
            width, height = image_dimensions(data, content_type)

            total_length: int | None = None
            range_match = re.search(r"/(\d+)$", content_range)
            if range_match:
                total_length = int(range_match.group(1))
            elif content_length_header and status_code != 206:
                try:
                    total_length = int(content_length_header)
                except ValueError:
                    total_length = None

            ok = status_code < 400 and (
                content_type.startswith("image/")
                or width is not None
            )

            result = Probe(
                url=candidate.url,
                rule=candidate.rule,
                ok=ok,
                status=status_code,
                content_type=content_type,
                content_length=total_length,
                width=width,
                height=height,
                final_url=response.geturl(),
            )
    except urllib.error.HTTPError as exc:
        result = Probe(
            url=candidate.url,
            rule=candidate.rule,
            ok=False,
            status=exc.code,
            error=f"HTTP {exc.code}",
        )
    except Exception as exc:
        result = Probe(
            url=candidate.url,
            rule=candidate.rule,
            ok=False,
            error=f"{type(exc).__name__}: {exc}",
        )

    write_event(
        "native-image",
        "probe",
        level="info" if result.ok else "warning",
        message=result.rule,
        details=asdict(result),
    )
    return result


def resolve(url: str, referer: str | None = None) -> dict:
    write_event("native-image", "resolve-start", message=url, details={"referer": referer})
    candidates = generate_candidates(url)
    probes = [probe(candidate, referer=referer) for candidate in candidates]
    working = [item for item in probes if item.ok]

    if not working:
        write_event(
            "native-image",
            "resolve-empty",
            level="error",
            message="Ningún candidato respondió como imagen.",
            details={"url": url, "candidates": [asdict(item) for item in probes]},
        )
        raise RuntimeError("TikSave probó las variantes conocidas, pero ninguna respondió como imagen válida.")

    best = max(working, key=lambda item: item.score)
    current = next((item for item in working if item.rule == "current"), None)

    write_event(
        "native-image",
        "resolve-done",
        message=best.url,
        details={
            "input": url,
            "best": asdict(best),
            "current": asdict(current) if current else None,
            "candidate_count": len(probes),
        },
    )

    return {
        "input": url,
        "found": True,
        "engine": "TikSave Native Image",
        "best": asdict(best),
        "current": asdict(current) if current else None,
        "candidates": [asdict(item) for item in probes],
        "improved": bool(
            current
            and best.url != current.url
            and (
                best.pixels > current.pixels
                or int(best.content_length or 0) > int(current.content_length or 0)
            )
        ),
    }


def _safe_filename(url: str, fallback: str = "imagen-original") -> str:
    try:
        leaf = unquote(urlparse(url).path.split("/")[-1])
    except Exception:
        leaf = ""

    leaf = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "", leaf).strip()
    if not leaf:
        leaf = fallback

    if not Path(leaf).suffix:
        leaf += ".jpg"

    return leaf[:160]


def download(url: str, output_dir: Path, referer: str | None = None) -> dict:
    result = resolve(url, referer=referer)
    best = result["best"]
    target_url = str(best["final_url"] or best["url"])

    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / _safe_filename(target_url)
    stem = target.stem
    suffix = target.suffix or ".jpg"
    counter = 2

    while target.exists():
        target = output_dir / f"{stem} ({counter}){suffix}"
        counter += 1

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    if referer:
        headers["Referer"] = referer

    try:
        request = urllib.request.Request(target_url, headers=headers)
        with urllib.request.urlopen(request, timeout=90) as response, target.open("wb") as output:
            shutil.copyfileobj(response, output)
    except Exception as exc:
        target.unlink(missing_ok=True)
        write_event("native-image", "download-error", level="error", message=target_url, exc=exc)
        raise

    write_event(
        "native-image",
        "download-done",
        message=str(target),
        details={"source": target_url, "bytes": target.stat().st_size},
    )

    return {
        "ok": True,
        "path": str(target),
        "url": target_url,
        "engine": "TikSave Native Image",
        "resolution": [best.get("width"), best.get("height")],
        "bytes": target.stat().st_size,
        "resolve": result,
    }
