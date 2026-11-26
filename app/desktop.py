"""TikSave como programa de escritorio: su propia ventana, sin navegador ni consola.

Arranca el servidor local en segundo plano y lo muestra en una ventana nativa (en Windows usa Edge WebView2,
que ya viene con Windows 10/11). Si la ventana nativa no está disponible, abre el navegador como antes.
Uso: pythonw -m app.desktop   (el acceso directo "TikSave" hace exactamente esto)
"""
from __future__ import annotations

import os
import socket
import threading
import time
import webbrowser

import httpx

PORT = int(os.getenv("TIKSAVE_PORT", "8173"))
URL = f"http://127.0.0.1:{PORT}"


def _port_in_use() -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def _wait_ready(timeout: float = 20.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if httpx.get(f"{URL}/api/health", timeout=1).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    return False


def start_server():
    """Servidor en un hilo. Devuelve el objeto uvicorn.Server (o None si ya había otra instancia)."""
    if _port_in_use():
        return None  # ya hay un TikSave abierto: la ventana se conecta a ese
    import uvicorn

    from app.main import app

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    threading.Thread(target=server.run, name="tiksave-server", daemon=True).start()
    return server


def main() -> None:
    server = start_server()
    if not _wait_ready():
        webbrowser.open(URL)  # algo falló al arrancar: al menos que el usuario vea el mensaje de error
        return
    try:
        import webview
    except ImportError:
        webview = None
    if webview is None:
        webbrowser.open(URL)
        if server:  # sin ventana nativa: mantener el servidor vivo
            while not server.should_exit:
                time.sleep(1)
        return
    window = webview.create_window("TikSave", URL, width=1320, height=880, min_size=(900, 620),
                                   background_color="#0c0d10", text_select=True)
    try:
        webview.start(private_mode=False)  # private_mode=False: recuerda tema y preferencias entre sesiones
    except Exception:  # noqa: BLE001 - sin WebView2 / GTK: plan B, el navegador
        webbrowser.open(URL)
        if server:
            while not server.should_exit:
                time.sleep(1)
        return
    finally:
        del window
    if server:
        server.should_exit = True  # al cerrar la ventana se cierra TikSave


if __name__ == "__main__":
    main()
