import asyncio
import json
import os
import socket
import sys
from pathlib import Path

import pytest

from app.jobs import JobStore


def test_error_detail_is_kept_and_logged(tmp_path):
    store = JobStore(tmp_path / "history.json")
    job = store.create("download", "https://x.com/v", "video")
    store.update(job.id, status="error", error="Mensaje claro", error_detail="ERROR: raw yt-dlp text 416")
    saved = store.get(job.id)
    assert saved["error"] == "Mensaje claro" and "416" in saved["error_detail"]
    other = store.create("capture", "https://y.com", "capture")
    store.update(other.id, status="error", error="Solo mensaje")
    assert store.get(other.id)["error_detail"] == "Solo mensaje"      # sin detalle: se copia el mensaje
    log = (tmp_path / "logs" / "tiksave.log").read_text(encoding="utf-8")
    assert job.id in log and "raw yt-dlp text 416" in log


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_mcp_server_lists_tools_reads_library_and_reports_clear_errors(tmp_path):
    mcp = pytest.importorskip("mcp")
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    (tmp_path / "dl" / "Pruebas").mkdir(parents=True)
    (tmp_path / "dl" / "Pruebas" / "clase [1].md").write_text("# Ficha\n\nTranscripción de prueba.\n", encoding="utf-8")
    port = _free_port()
    root = Path(__file__).resolve().parent.parent
    env = {**os.environ, "TIKSAVE_PORT": str(port), "TIKSAVE_HOME": str(tmp_path / "home"),
           "TIKSAVE_DOWNLOAD_DIR": str(tmp_path / "dl"), "PYTHONPATH": str(root)}

    async def run():
        params = StdioServerParameters(command=sys.executable, args=["-m", "app.mcp_server"], env=env, cwd=str(root))
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                names = {t.name for t in (await s.list_tools()).tools}
                assert {"tiksave_download", "tiksave_capture", "tiksave_library", "tiksave_read_text",
                        "tiksave_wait", "tiksave_convert", "tiksave_trim", "tiksave_explore"} <= names
                lib = await s.call_tool("tiksave_library", {"kind": "text"})
                assert "Pruebas/clase [1].md" in lib.content[0].text
                text = await s.call_tool("tiksave_read_text", {"path": "Pruebas/clase [1].md"})
                assert "Transcripción de prueba" in text.content[0].text
                bad = await s.call_tool("tiksave_read_text", {"path": "Pruebas/x.mp4"})
                assert bad.is_error and "Solo se pueden leer" in bad.content[0].text
                status = json.loads((await s.call_tool("tiksave_status", {})).content[0].text)
                assert status["ok"] is True

    try:
        asyncio.run(run())
    finally:
        os.system(f"kill $(lsof -ti tcp:{port} 2>/dev/null) 2>/dev/null")  # la app que arrancó el servidor MCP
