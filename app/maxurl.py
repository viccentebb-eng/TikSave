from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlparse


MAXURL_REPO = "qsniyg/maxurl"
MAXURL_BRANCH = "master"
USER_AGENT = "TikSave/0.11.0 (https://github.com/viccentebb-eng/TikSave)"


def _root() -> Path:
    if platform.system() == "Windows":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home())
        return base / "TikSave" / "tools" / "maxurl"
    return Path.home() / ".local" / "share" / "tiksave" / "tools" / "maxurl"


def _node_root() -> Path:
    return _root() / "node"


def _script_path() -> Path:
    return _root() / "userscript.user.js"


def _runner_path() -> Path:
    return _root() / "runner.cjs"


def _source_meta_path() -> Path:
    return _root() / "source.json"


def _request(url: str, accept: str = "*/*"):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": accept,
        },
    )
    return urllib.request.urlopen(req, timeout=90)


def _request_json(url: str) -> dict | list:
    with _request(url, "application/json") as response:
        return json.loads(response.read().decode("utf-8"))


def _validate_public_url(value: str) -> str:
    value = value.strip()
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("La URL de imagen debe comenzar con http:// o https://")

    host = parsed.hostname.lower()
    if host in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("No se aceptan direcciones locales.")

    return value


def find_node() -> Path | None:
    configured = os.getenv("TIKSAVE_NODE_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser()
        if path.exists():
            return path.resolve()

    system_node = shutil.which("node")
    if system_node:
        return Path(system_node).resolve()

    if platform.system() == "Windows":
        bundled = next(_node_root().glob("node-v*-win-x64/node.exe"), None)
        if bundled and bundled.exists():
            return bundled.resolve()
    else:
        bundled = next(_node_root().glob("node-v*/bin/node"), None)
        if bundled and bundled.exists():
            return bundled.resolve()

    return None


def _install_node() -> Path:
    existing = find_node()
    if existing:
        return existing

    index = _request_json("https://nodejs.org/dist/index.json")
    if not isinstance(index, list):
        raise RuntimeError("Node.js no devolvió una lista de versiones válida.")

    system = platform.system()
    machine = platform.machine().lower()

    if system == "Windows" and machine in {"amd64", "x86_64"}:
        package_kind = "win-x64-zip"
        suffix = "-win-x64.zip"
    elif system == "Linux" and machine in {"amd64", "x86_64"}:
        package_kind = "linux-x64"
        suffix = "-linux-x64.tar.xz"
    elif system == "Darwin" and machine in {"arm64", "aarch64"}:
        package_kind = "osx-arm64-tar"
        suffix = "-darwin-arm64.tar.gz"
    elif system == "Darwin" and machine in {"amd64", "x86_64"}:
        package_kind = "osx-x64-tar"
        suffix = "-darwin-x64.tar.gz"
    else:
        raise RuntimeError(f"No hay instalador automático de Node.js para {system} {machine}.")

    selected = next(
        (
            item
            for item in index
            if item.get("lts")
            and package_kind in (item.get("files") or [])
        ),
        None,
    )
    if not selected:
        raise RuntimeError("No encontré una versión LTS de Node.js compatible.")

    version = str(selected["version"])
    package_name = f"node-{version}{suffix}"
    url = f"https://nodejs.org/dist/{version}/{package_name}"

    root = _node_root()
    root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="tiksave-node-") as temp:
        package = Path(temp) / package_name
        with _request(url) as response, package.open("wb") as output:
            shutil.copyfileobj(response, output)

        if package.suffix.lower() == ".zip":
            with zipfile.ZipFile(package) as archive:
                archive.extractall(root)
        else:
            with tarfile.open(package, "r:*") as archive:
                archive.extractall(root)

    node = find_node()
    if not node:
        raise RuntimeError("Node.js se descargó, pero TikSave no encontró el ejecutable.")
    return node


def _latest_source() -> tuple[str, str]:
    commit = _request_json(f"https://api.github.com/repos/{MAXURL_REPO}/commits/{MAXURL_BRANCH}")
    if not isinstance(commit, dict) or not commit.get("sha"):
        raise RuntimeError("GitHub no devolvió una versión válida de Image Max URL.")
    sha = str(commit["sha"])
    url = f"https://raw.githubusercontent.com/{MAXURL_REPO}/{sha}/userscript.user.js"
    return sha, url


RUNNER = r"""
const path = require("path");

const scriptPath = process.argv[2];
const inputUrl = process.argv[3];
const maximage = require(path.resolve(scriptPath));

let finished = false;
let timer = null;

function emit(result) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  process.stdout.write("__TIKSAVE_JSON__" + JSON.stringify(Array.isArray(result) ? result : []) + "\\n");
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null && value !== undefined && value !== "") out[key] = String(value);
  }
  return out;
}

function doRequest(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  fetch(options.url, {
    method: options.method || "GET",
    headers: normalizeHeaders(options.headers),
    body: options.data || undefined,
    redirect: "follow",
    signal: controller.signal,
  })
    .then(async (response) => {
      clearTimeout(timeout);
      const text = await response.text();
      const headers = {};
      response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

      options.onload?.({
        finalUrl: response.url,
        readyState: 4,
        responseText: text,
        status: response.status,
        responseHeaders: Object.entries(headers).map(([k, v]) => k + ": " + v).join("\\r\\n"),
        getResponseHeader: (name) => headers[String(name || "").toLowerCase()] || null,
      });
    })
    .catch((error) => {
      clearTimeout(timeout);
      options.onerror?.({
        finalUrl: options.url,
        readyState: 4,
        responseText: String(error?.message || error),
        status: 0,
      });
    });
}

try {
  maximage(inputUrl, {
    fill_object: true,
    iterations: 200,
    use_cache: true,
    urlcache_time: 3600,
    exclude_videos: false,
    include_pastobjs: true,
    force_page: false,
    allow_thirdparty: false,
    do_request: doRequest,
    cb: emit,
  });

  timer = setTimeout(() => emit([]), 25000);
} catch (error) {
  process.stderr.write(String(error?.stack || error) + "\\n");
  process.exit(2);
}
"""


def install() -> dict:
    root = _root()
    root.mkdir(parents=True, exist_ok=True)

    _install_node()
    sha, source_url = _latest_source()

    with _request(source_url) as response, _script_path().open("wb") as output:
        shutil.copyfileobj(response, output)

    _runner_path().write_text(RUNNER, encoding="utf-8")

    license_url = f"https://raw.githubusercontent.com/{MAXURL_REPO}/{sha}/LICENSE.txt"
    try:
        with _request(license_url) as response:
            (root / "LICENSE.maxurl.txt").write_bytes(response.read())
    except Exception:
        pass

    _source_meta_path().write_text(
        json.dumps(
            {
                "repo": MAXURL_REPO,
                "sha": sha,
                "source_url": source_url,
                "license": "Apache-2.0",
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    return status()


def status() -> dict:
    node = find_node()
    script = _script_path()

    source = None
    if _source_meta_path().exists():
        try:
            source = json.loads(_source_meta_path().read_text(encoding="utf-8"))
        except Exception:
            source = None

    return {
        "installed": bool(node and script.exists() and _runner_path().exists()),
        "node": str(node) if node else None,
        "script": str(script) if script.exists() else None,
        "repo": MAXURL_REPO,
        "license": "Apache-2.0",
        "source": source,
    }


def _score(item: dict, input_url: str) -> int:
    url = str(item.get("url") or "")
    if not url or url == input_url:
        return -10_000

    score = 0
    if item.get("is_original"):
        score += 1000
    if item.get("always_ok"):
        score += 160
    if item.get("video"):
        score -= 40
    if item.get("likely_broken"):
        score -= 500
    if item.get("bad"):
        score -= 1000
    if item.get("fake"):
        score -= 1000
    if item.get("is_private"):
        score -= 20

    problems = item.get("problems") or {}
    if problems.get("watermark"):
        score -= 100
    if problems.get("smaller"):
        score -= 250
    if problems.get("possibly_different"):
        score -= 200
    if problems.get("possibly_broken"):
        score -= 220

    score += max(0, 120 - min(len(url), 120)) // 10
    return score


def resolve(value: str) -> dict:
    value = _validate_public_url(value)

    if not status()["installed"]:
        raise RuntimeError("Image Max URL no está instalado. Usa 'Instalar motor Image Max URL'.")

    node = find_node()
    assert node is not None

    result = subprocess.run(
        [str(node), str(_runner_path()), str(_script_path()), value],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=35,
        check=False,
    )

    marker = "__TIKSAVE_JSON__"
    payload_line = next(
        (
            line[len(marker):]
            for line in reversed((result.stdout or "").splitlines())
            if line.startswith(marker)
        ),
        None,
    )

    if result.returncode not in {0, None} and payload_line is None:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(detail[-1200:] or f"Image Max URL terminó con código {result.returncode}.")

    if payload_line is None:
        raise RuntimeError("Image Max URL no devolvió resultados.")

    try:
        raw = json.loads(payload_line)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Image Max URL devolvió una respuesta no válida.") from exc

    clean: list[dict] = []
    seen: set[str] = set()

    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "")
        if not url.startswith(("http://", "https://")) or url in seen:
            continue
        seen.add(url)

        clean.append(
            {
                "url": url,
                "video": bool(item.get("video")),
                "is_original": bool(item.get("is_original")),
                "always_ok": bool(item.get("always_ok")),
                "likely_broken": bool(item.get("likely_broken")),
                "is_private": bool(item.get("is_private")),
                "headers": item.get("headers") or {},
                "filename": str(item.get("filename") or ""),
                "problems": item.get("problems") or {},
                "extra": item.get("extra") or {},
                "score": _score(item, value),
            }
        )

    clean.sort(key=lambda item: item["score"], reverse=True)
    usable = [item for item in clean if item["score"] > -500]

    return {
        "input": value,
        "found": bool(usable),
        "best": usable[0] if usable else None,
        "results": usable[:20],
        "engine": "Image Max URL",
        "source": status().get("source"),
    }
