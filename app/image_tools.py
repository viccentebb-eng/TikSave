from __future__ import annotations

import re
import shutil
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse


USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0"


def _filename(url: str, index: int) -> str:
    parsed = urlparse(url)
    leaf = unquote(parsed.path.split("/")[-1])
    leaf = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "", leaf).strip()

    if not leaf or "." not in leaf:
        leaf = f"imagen-{index:02d}.jpg"

    return leaf[:140]


def download_images(
    urls: list[str],
    output_dir: Path,
    referer: str | None = None,
) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    downloaded: list[str] = []

    for index, url in enumerate(urls[:50], start=1):
        if not url.startswith(("http://", "https://")):
            continue

        filename = _filename(url, index)
        target = output_dir / filename
        stem = target.stem
        suffix = target.suffix
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

        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=45) as response, target.open("wb") as output:
                shutil.copyfileobj(response, output)
            downloaded.append(str(target))
        except Exception:
            target.unlink(missing_ok=True)

    if not downloaded:
        raise RuntimeError("No se pudo descargar ninguna de las imágenes seleccionadas.")

    return downloaded
