# TikSave

Herramienta local para **guardar contenido de internet** sin anuncios ni servidores de terceros:

- **Descargar** videos de TikTok (y YouTube, Instagram, X, Facebook, Reddit, Vimeo, Twitch, Pinterest) como MP4, MP3 o audio original.
- **Texto para IA**: transcripción + una *ficha Markdown* (autor, fecha, estadísticas, descripción, transcripción) lista para pegar en Claude o ChatGPT gastando muy pocos tokens.
- **Capturar webs**: cualquier página pública a Markdown limpio, HTML offline (un solo archivo con imágenes y CSS), captura de pantalla completa (PNG) o PDF; opcionalmente sigue los enlaces del mismo sitio.
- **Lotes y perfiles**: pega muchos enlaces a la vez o carga los últimos N videos de un perfil.
- **Biblioteca** integrada con visor (video, audio, texto, imágenes), búsqueda y borrado.
- **Cola con progreso**, cancelar, reintentar e historial que sobrevive al cerrar la app.
- Extensión para Firefox/Chrome: descarga o captura la pestaña actual con un clic.

Todo corre en `127.0.0.1`. Los archivos se guardan en `Descargas/TikSave` (descargas) y `Descargas/TikSave/Sitios` (capturas).

## Instalar y usar (Windows)

```powershell
git clone https://github.com/viccentebb-eng/TikSave.git
cd TikSave
.\install-windows.bat    # una sola vez
.\run-windows.bat        # abre http://127.0.0.1:8173
```

La instalación incluye `curl_cffi`, **imprescindible para TikTok** (sin él TikTok bloquea al extractor con
"Unexpected response from webpage request"). Si algún día deja de funcionar, abre **Ajustes → Actualizar yt-dlp**.

Requisitos opcionales:

| Función | Necesita |
|---|---|
| MP3, subtítulos SRT, portadas JPG | FFmpeg (el instalador intenta ponerlo con `winget`) |
| Captura de pantalla, PDF, páginas hechas con JavaScript | Microsoft Edge o Google Chrome (ya instalados en Windows) |
| Transcribir videos **sin subtítulos** | `pip install faster-whisper` (modelo local, sin nube; `TIKSAVE_WHISPER_MODEL=small` para más precisión) |

## Extensión (Firefox o Chrome)

1. Inicia TikSave.
2. Firefox: `about:debugging` → *Este Firefox* → *Cargar complemento temporal* → `extension/manifest.json`.
   Chrome/Edge: `chrome://extensions` → *Modo desarrollador* → *Cargar descomprimida* → carpeta `extension`.
3. En un video pulsa el icono: MP4, MP3, Audio o **Kit para IA**. En cualquier página: **Capturar esta página**.

## Variables de entorno

`TIKSAVE_PORT` (8173) · `TIKSAVE_DOWNLOAD_DIR` · `TIKSAVE_HOME` (ajustes e historial, por defecto `~/.tiksave`) ·
`TIKSAVE_BROWSER` (ruta a un navegador Chromium para las capturas) · `TIKSAVE_ALLOW_PRIVATE=1` (permitir capturar direcciones locales).

## Desarrollo

```bash
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python -m app.main
pytest
```

## Seguridad y alcance

- El servidor solo acepta peticiones de la propia interfaz y de la extensión (comprueba `Host` y `Origin`), así que otra web abierta en tu navegador no puede ordenarle nada.
- El capturador bloquea direcciones locales/privadas (SSRF), valida cada redirección, limita tamaños y respeta `robots.txt` al seguir enlaces.
- No usa cookies ni cuentas: solo contenido público. Úsalo únicamente con contenido que tengas derecho a guardar.

## Licencia

MIT.
