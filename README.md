# TikSave

Herramienta local para **guardar contenido de internet** sin anuncios ni servidores de terceros:

- **Descargar** videos de TikTok, YouTube, Instagram, X, Facebook, Reddit, Vimeo, Twitch, Pinterest y cualquier otro sitio público que yt-dlp entienda, como MP4, MP3 o audio original.
- **Texto para IA**: transcripción + una *ficha Markdown* (autor, fecha, estadísticas, descripción, transcripción) lista para pegar en Claude o ChatGPT gastando muy pocos tokens.
- **Capturar webs**: cualquier página pública a Markdown limpio, HTML offline (un solo archivo con imágenes y CSS), captura de pantalla completa (PNG) o PDF; opcionalmente sigue los enlaces del mismo sitio.
- **Lotes y perfiles**: pega muchos enlaces a la vez o carga los últimos N videos de un perfil.
- **Biblioteca** integrada con visor (video, audio, texto, imágenes), búsqueda y borrado.
- **Cola con progreso**, cancelar, reintentar e historial que sobrevive al cerrar la app.
- **Extensión para Firefox/Chrome:** botón flotante *Guardar* sobre cualquier video que estés viendo, detector de videos/streams de la pestaña, y captura de páginas y chats con tu sesión.
- **Recorte** de videos (slider) al descargar o sobre lo ya guardado; metadatos y portada incrustados en el MP3.

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
3. Abre el icono de TikSave y pulsa **Activar en todos los sitios** (permiso opcional que el navegador te pide una vez).
   Recarga la pestaña del video.

Qué hace:

- **Botón flotante:** al pasar el mouse sobre un video aparece *Guardar* con un menú: Video MP4, *Desde aquí hasta el final*
  (usa el minuto en el que estás), Solo audio MP3 y Kit para IA. Muestra el progreso en el mismo botón.
  En feeds (TikTok, Instagram, X…) detecta el enlace del video concreto sobre el que estás.
- **Detector de streams:** en sitios que no son de la lista, el icono muestra un contador con los videos y streams
  (`.m3u8`, `.mpd`, `.mp4`) que cargó la página; desde el popup los guardas con MP4/MP3. TikSave envía el `Referer` de la
  página, que muchos CDN exigen.
- **Capturar esta página:** guarda lo que ves ahora (con tu sesión) como Markdown, Word, PDF o HTML; sirve para ChatGPT
  y Gemini, con fórmulas, código e imágenes.

Límites: no descarga contenido con DRM (Netflix, Disney+…) ni videos que exigen iniciar sesión en el servidor del sitio;
un video servido por `blob:` solo se puede guardar si el sitio lo entiende yt-dlp o si se detecta su stream.

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
