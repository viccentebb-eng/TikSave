"""Servidor MCP de TikSave: deja que Claude (Desktop o Code) descargue, capture y lea tu Biblioteca.

Uso (stdio):  python -m app.mcp_server
Habla con la app local en http://127.0.0.1:<TIKSAVE_PORT>; si no está abierta, la arranca en segundo plano.
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

logging.getLogger("httpx").setLevel(logging.WARNING)  # no llenar el canal de Claude con cada peticion
PORT = int(os.getenv("TIKSAVE_PORT", "8173"))
API = f"http://127.0.0.1:{PORT}"
ROOT = Path(__file__).resolve().parent.parent
TEXT_EXT = {".md", ".txt", ".srt", ".vtt", ".json", ".csv", ".html", ".htm"}
TERMINAL = {"done", "error", "cancelled"}

server = MCPServer(
    name="tiksave",
    title="TikSave",
    instructions=(
        "TikSave corre en la computadora del usuario. Úsalo para descargar videos o audio (TikTok, YouTube, "
        "Instagram, X y otros sitios públicos), sacar transcripciones y fichas en Markdown, capturar páginas web "
        "y leer lo que ya está guardado. Las descargas son trabajos: tiksave_download devuelve un id; espera el "
        "resultado con tiksave_wait. Para leer una transcripción o una ficha usa tiksave_read_text con la ruta "
        "que aparece en tiksave_library o en los archivos del trabajo."
    ),
    version="0.7.0",
)


async def _healthy(client: httpx.AsyncClient) -> bool:
    try:
        return (await client.get(f"{API}/api/health", timeout=2)).status_code == 200
    except httpx.HTTPError:
        return False


def _spawn_app() -> None:
    """Arranca la app sin ventana ni navegador; su salida va a un archivo de registro."""
    log_dir = Path(os.getenv("TIKSAVE_HOME") or Path.home() / ".tiksave") / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    out = open(log_dir / "server-mcp.log", "a", encoding="utf-8")  # noqa: SIM115 - lo hereda el proceso hijo
    kwargs: dict[str, Any] = {"cwd": str(ROOT), "stdout": out, "stderr": out, "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = 0x08000000 | 0x00000008  # CREATE_NO_WINDOW | DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    subprocess.Popen([sys.executable, "-m", "app.main", "--no-browser"], env=env, **kwargs)


async def _client() -> httpx.AsyncClient:
    client = httpx.AsyncClient(timeout=60)
    if await _healthy(client):
        return client
    _spawn_app()
    for _ in range(40):
        await asyncio.sleep(0.5)
        if await _healthy(client):
            return client
    await client.aclose()
    raise ToolError("No pude abrir TikSave. Ábrelo a mano (acceso directo TikSave) y vuelve a intentar.")


async def _call(method: str, path: str, **kwargs: Any) -> Any:
    client = await _client()
    try:
        resp = await client.request(method, f"{API}{path}", **kwargs)
    finally:
        await client.aclose()
    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else resp.text
    if resp.status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise ToolError(str(detail)[:600])
    return data


def _job_summary(job: dict) -> dict:
    keys = ("id", "kind", "mode", "status", "stage", "progress", "title", "url", "files", "warnings", "error",
            "error_detail")
    return {k: job.get(k) for k in keys if job.get(k) not in (None, [], "")}


@server.tool(description="Estado de TikSave: versión, carpeta de descargas y dependencias (FFmpeg, curl_cffi, "
                         "intérprete de JavaScript para YouTube, navegador para capturas).")
async def tiksave_status() -> dict:
    return await _call("GET", "/api/health")


@server.tool(description="Descarga un video o su audio. mode: video | mp3 | audio | transcript | cover. "
                         "Extras: transcript (.txt), notes (ficha Markdown para IA), cover (.jpg), subs (.srt). "
                         "start/end en segundos para bajar solo un tramo. Devuelve el trabajo; espera con tiksave_wait.")
async def tiksave_download(url: str, mode: str = "video", transcript: bool = False, notes: bool = False,
                           cover: bool = False, subs: bool = False, start: float | None = None,
                           end: float | None = None) -> dict:
    body: dict[str, Any] = {"url": url, "mode": mode, "transcript": transcript, "notes": notes, "cover": cover,
                            "subs": subs}
    if start is not None:
        body["start"] = start
    if end is not None:
        body["end"] = end
    return _job_summary(await _call("POST", "/api/download", json=body))


@server.tool(description="Lista el contenido de un perfil, canal o lista (YouTube, TikTok...) con título y "
                         "duración, para elegir qué descargar.")
async def tiksave_explore(url: str, limit: int = 20) -> dict:
    return await _call("POST", "/api/expand", json={"url": url, "limit": max(1, min(limit, 100))})


@server.tool(description="Captura una página web pública como Markdown (y opcionalmente Word, PDF u HTML). "
                         "depth > 0 sigue enlaces del mismo sitio; files=true guarda sus documentos (PDF, Word...).")
async def tiksave_capture(url: str, markdown: bool = True, docx: bool = False, pdf: bool = False,
                          html: bool = False, depth: int = 0, max_pages: int = 10, files: bool = False) -> dict:
    body = {"url": url, "markdown": markdown, "docx": docx, "pdf": pdf, "html": html, "depth": depth,
            "max_pages": max_pages, "files": files}
    return _job_summary(await _call("POST", "/api/capture", json=body))


@server.tool(description="Estado de un trabajo por su id.")
async def tiksave_job(job_id: str) -> dict:
    return _job_summary(await _call("GET", f"/api/jobs/{quote(job_id)}"))


@server.tool(description="Espera a que termine un trabajo (hasta timeout_seconds, máximo 900) y devuelve su "
                         "resultado con los archivos creados.")
async def tiksave_wait(job_id: str, timeout_seconds: int = 300) -> dict:
    deadline = asyncio.get_running_loop().time() + max(5, min(timeout_seconds, 900))
    while True:
        job = await _call("GET", f"/api/jobs/{quote(job_id)}")
        if job.get("status") in TERMINAL or asyncio.get_running_loop().time() > deadline:
            return _job_summary(job)
        await asyncio.sleep(2)


@server.tool(description="Últimos trabajos de la cola (descargas, capturas, recortes, conversiones).")
async def tiksave_jobs(limit: int = 10) -> list[dict]:
    jobs = (await _call("GET", "/api/jobs"))["jobs"][: max(1, min(limit, 50))]
    return [_job_summary(j) for j in jobs]


@server.tool(description="Busca en la Biblioteca. kind: video | audio | text | site | image (vacío = todo). "
                         "Cada elemento trae sus archivos con la ruta relativa que usan las otras herramientas.")
async def tiksave_library(query: str = "", kind: str = "", limit: int = 30) -> list[dict]:
    items = (await _call("GET", "/api/library"))["items"]
    q = query.lower().strip()
    out = []
    for it in items:
        if kind and it.get("type") != kind:
            continue
        if q and q not in it.get("name", "").lower():
            continue
        out.append({"name": it["name"], "type": it["type"], "platform": it.get("platform"),
                    "files": [f["path"].replace("\\", "/") for f in it["files"]], "snippet": it.get("snippet")})
        if len(out) >= max(1, min(limit, 200)):
            break
    return out


@server.tool(description="Lee un archivo de texto de la Biblioteca (ficha .md, transcripción .txt, subtítulos "
                         ".srt, captura .md...). path es la ruta relativa de tiksave_library.")
async def tiksave_read_text(path: str, max_chars: int = 20000) -> str:
    rel = path.replace("\\", "/").lstrip("/")
    if Path(rel).suffix.lower() not in TEXT_EXT:
        raise ToolError("Solo se pueden leer archivos de texto (.md, .txt, .srt, .vtt, .json, .csv, .html).")
    text = await _call("GET", "/files/" + "/".join(quote(p) for p in rel.split("/")))
    text = text if isinstance(text, str) else str(text)
    limit = max(500, min(max_chars, 200000))
    return text if len(text) <= limit else text[:limit] + f"\n\n[... recortado: {len(text) - limit} caracteres más]"


@server.tool(description="Convierte o comprime un video o audio de la Biblioteca. action: compress | mp4 | webm | "
                         "mp3 | m4a | opus. quality: alta | media | baja | muy_baja. height: 1080 | 720 | 480 | 360.")
async def tiksave_convert(path: str, action: str, quality: str = "media", height: int | None = None) -> dict:
    body = {"path": path.replace("\\", "/"), "action": action, "quality": quality, "height": height}
    return _job_summary(await _call("POST", "/api/convert", json=body))


@server.tool(description="Recorta un video o audio de la Biblioteca entre start y end (segundos).")
async def tiksave_trim(path: str, start: float, end: float) -> dict:
    body = {"path": path.replace("\\", "/"), "start": start, "end": end, "precise": True}
    return _job_summary(await _call("POST", "/api/trim", json=body))


def main() -> None:
    server.run("stdio")


if __name__ == "__main__":
    main()
