from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import threading
import time
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

from app.diagnostics import write_event


RELEASE_API = "https://api.github.com/repos/lovasoa/dezoomify-rs/releases/latest"
LICENSE_URL = "https://raw.githubusercontent.com/lovasoa/dezoomify-rs/master/LICENSE"
SOURCE_URL = "https://github.com/lovasoa/dezoomify-rs"
USER_AGENT = "TikSave/0.13.0 (https://github.com/viccentebb-eng/TikSave)"
_STATUS_CACHE: tuple[float, dict] | None = None
_STATUS_LOCK = threading.Lock()


def _tool_dir() -> Path:
    if platform.system() == "Windows":
        root = Path(os.getenv("LOCALAPPDATA") or Path.home())
        return root / "TikSave" / "tools" / "dezoomify-rs"
    return Path.home() / ".local" / "share" / "tiksave" / "tools" / "dezoomify-rs"


def _binary_name() -> str:
    return "dezoomify-rs.exe" if platform.system() == "Windows" else "dezoomify-rs"


def find_binary() -> Path | None:
    configured = os.getenv("TIKSAVE_DEZOOMIFY_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser()
        if path.exists():
            return path.resolve()

    on_path = shutil.which("dezoomify-rs")
    if on_path:
        return Path(on_path).resolve()

    local = _tool_dir() / _binary_name()
    if local.exists():
        return local.resolve()

    return None


def _clear_status_cache() -> None:
    global _STATUS_CACHE
    with _STATUS_LOCK:
        _STATUS_CACHE = None


def status(force: bool = False) -> dict:
    global _STATUS_CACHE

    now = time.monotonic()
    with _STATUS_LOCK:
        if not force and _STATUS_CACHE and now - _STATUS_CACHE[0] < 60:
            return dict(_STATUS_CACHE[1])

    binary = find_binary()
    version = None

    if binary:
        try:
            result = subprocess.run(
                [str(binary), "--version"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            version = (result.stdout or result.stderr or "").strip() or None
        except Exception:
            version = None

    value = {
        "installed": bool(binary),
        "path": str(binary) if binary else None,
        "version": version,
        "license": "GPL-3.0",
        "upstream": "lovasoa/dezoomify-rs",
        "source": SOURCE_URL,
        "external_process": True,
    }

    with _STATUS_LOCK:
        _STATUS_CACHE = (time.monotonic(), dict(value))

    return value


def _request_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _asset_score(name: str) -> int:
    lower = name.lower()
    system = platform.system().lower()
    machine = platform.machine().lower()
    score = 0

    if system == "windows":
        if "windows" in lower or "win" in lower:
            score += 100
        if lower.endswith(".exe"):
            score += 50
    elif system == "darwin":
        if "mac" in lower or "darwin" in lower or "apple" in lower:
            score += 100
    else:
        if "linux" in lower:
            score += 100

    if machine in {"amd64", "x86_64"} and any(x in lower for x in ("x86_64", "amd64", "x64")):
        score += 40
    if machine in {"arm64", "aarch64"} and any(x in lower for x in ("aarch64", "arm64")):
        score += 40

    if lower.endswith(".zip"):
        score += 20
    elif lower.endswith((".tar.gz", ".tgz")):
        score += 15

    if "sha" in lower or "checksum" in lower:
        score -= 200

    return score


def _extract_binary(downloaded: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)

    if downloaded.suffix.lower() == ".exe":
        target = destination / _binary_name()
        shutil.copy2(downloaded, target)
        return target

    temp_extract = destination / "_extract"
    if temp_extract.exists():
        shutil.rmtree(temp_extract)
    temp_extract.mkdir(parents=True)

    lower = downloaded.name.lower()

    if lower.endswith(".zip"):
        with zipfile.ZipFile(downloaded) as archive:
            archive.extractall(temp_extract)
    elif lower.endswith((".tar.gz", ".tgz", ".tar")):
        with tarfile.open(downloaded, "r:*") as archive:
            archive.extractall(temp_extract)
    else:
        raise RuntimeError(f"Formato de paquete no compatible: {downloaded.name}")

    expected = _binary_name().lower()
    candidates = [
        path for path in temp_extract.rglob("*")
        if path.is_file() and path.name.lower() == expected
    ]

    if not candidates:
        candidates = [
            path for path in temp_extract.rglob("*")
            if path.is_file() and "dezoomify-rs" in path.name.lower()
        ]

    if not candidates:
        raise RuntimeError("El paquete oficial no contenía el ejecutable de dezoomify-rs.")

    target = destination / _binary_name()
    shutil.copy2(candidates[0], target)

    if platform.system() != "Windows":
        target.chmod(target.stat().st_mode | 0o111)

    shutil.rmtree(temp_extract, ignore_errors=True)
    return target


def install(force: bool = False) -> dict:
    existing = find_binary()
    if existing and not force:
        return status(force=True)

    release = _request_json(RELEASE_API)
    assets = release.get("assets") or []

    candidates = sorted(
        (
            (_asset_score(str(asset.get("name") or "")), asset)
            for asset in assets
            if asset.get("browser_download_url")
        ),
        key=lambda item: item[0],
        reverse=True,
    )

    if not candidates or candidates[0][0] <= 0:
        raise RuntimeError("No encontré un paquete oficial compatible con este sistema.")

    asset = candidates[0][1]
    url = str(asset["browser_download_url"])
    name = str(asset.get("name") or "dezoomify-rs-download")

    tool_dir = _tool_dir()
    tool_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="tiksave-dezoom-") as temp:
        package = Path(temp) / name
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=120) as response, package.open("wb") as output:
            shutil.copyfileobj(response, output)

        binary = _extract_binary(package, tool_dir)

    notice = tool_dir / "THIRD_PARTY.txt"
    notice.write_text(
        "dezoomify-rs is an independent GPL-3.0 project by Ophir LOJKINE and contributors.\n"
        f"Source: {SOURCE_URL}\n"
        "License: GPL-3.0\n"
        "TikSave invokes it as a separate external executable.\n",
        encoding="utf-8",
    )

    try:
        request = urllib.request.Request(LICENSE_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            (tool_dir / "LICENSE-GPL-3.0.txt").write_bytes(response.read())
    except Exception:
        # The source URL and license identifier remain in THIRD_PARTY.txt even if
        # GitHub is temporarily unavailable for the license text.
        pass

    _clear_status_cache()
    result = status(force=True)
    result["release"] = release.get("tag_name")
    result["asset"] = name
    result["path"] = str(binary)
    return result


def run(
    source_url: str,
    output_path: Path,
    referer: str | None = None,
    progress: Callable[[str], None] | None = None,
) -> tuple[Path, str]:
    binary = find_binary()
    if not binary:
        raise RuntimeError("El motor de imágenes de alta resolución no está instalado.")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        str(binary),
        "--largest",
        "--image-index",
        "0",
        "--retries",
        "3",
        "--retry-delay",
        "2s",
        "--min-interval",
        "80ms",
    ]

    if referer:
        command.extend(["-H", f"Referer: {referer}"])

    command.extend([source_url, str(output_path)])

    write_event(
        "dezoomify",
        "command",
        message=source_url,
        details={
            "command": command,
            "output": str(output_path),
            "has_referer": bool(referer),
        },
    )

    if progress:
        progress("Analizando el visor y localizando mosaicos…")

    creationflags = 0
    if platform.system() == "Windows" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        creationflags = subprocess.CREATE_NO_WINDOW

    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        creationflags=creationflags,
    )

    output_lines: list[str] = []

    assert process.stdout is not None
    for line in process.stdout:
        cleaned = line.strip()
        if cleaned:
            output_lines.append(cleaned)
            output_lines = output_lines[-30:]
            if progress:
                progress(cleaned[-220:])

    return_code = process.wait()

    if return_code != 0:
        detail = "\n".join(output_lines[-8:]).strip()
        write_event(
            "dezoomify",
            "error",
            level="error",
            message=source_url,
            details={"return_code": return_code, "tail": output_lines[-8:]},
        )
        raise RuntimeError(detail or f"dezoomify-rs terminó con código {return_code}.")

    if not output_path.exists():
        raise RuntimeError("El motor terminó sin crear la imagen esperada.")

    write_event(
        "dezoomify",
        "done",
        message=str(output_path),
        details={"source_url": source_url, "bytes": output_path.stat().st_size},
    )
    return output_path, "\n".join(output_lines[-8:])
