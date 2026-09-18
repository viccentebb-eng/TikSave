# TikSave Local

Aplicación local y extensión de Firefox para guardar contenido público de TikTok, YouTube, Instagram y Facebook sin depender de páginas con publicidad.

## Funciones

- TikTok: videos públicos, enlaces móviles y enlaces cortos.
- YouTube: videos normales, `youtu.be`, Shorts y playlists.
- Instagram: Reels y publicaciones públicas compatibles con yt-dlp.
- Facebook: videos, Reels y enlaces públicos compatibles con yt-dlp.
- Varias URLs en un mismo lote: una por línea.
- Las descargas de un lote son independientes: si una falla, las demás continúan.
- Playlists / colecciones opcionales.
- Resolución máxima seleccionable:
  - Mejor disponible
  - 2160p / 4K
  - 1440p
  - 1080p
  - 720p
  - 480p
  - 360p
- Descarga de video MP4.
- Extracción a MP3 mediante FFmpeg.
- Descarga del mejor audio disponible sin convertir.
- Vista previa con título, canal/autor, plataforma y datos de playlist.
- Barra de progreso independiente por enlace.
- Progreso agregado para playlists cuando la plataforma informa el número de elementos.
- Guarda por defecto en `Descargas/TikSave`.
- Extensión de Firefox para enviar la pestaña actual a TikSave.
- Todo corre en `127.0.0.1`; TikSave no usa un servidor externo propio.

## Rama experimental 0.3.0

La rama con Facebook, Instagram, lotes, playlists y resoluciones es:

```text
feature/multiplatform-batch-quality
```

Para probarla en Windows:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/multiplatform-batch-quality
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Para volver a la rama anterior de TikTok + YouTube:

```powershell
git switch feature/youtube-support
git pull
```

## Uso por lotes

Pega una URL por línea:

```text
https://www.youtube.com/watch?v=...
https://www.instagram.com/reel/...
https://www.facebook.com/reel/...
https://www.tiktok.com/@usuario/video/...
```

Elige la resolución y pulsa MP4, MP3 o Audio original. TikSave crea un trabajo independiente para cada URL.

## Playlists

Activa **Permitir listas / colecciones** cuando quieras que una URL de playlist se procese completa. Si está desactivado, TikSave intenta tratar la URL como un elemento individual.

Las playlists pueden contener elementos eliminados, privados, geobloqueados o no disponibles. TikSave intenta continuar con los elementos que sí sean accesibles.

## Extensión temporal de Firefox

1. Inicia TikSave Local.
2. En Firefox abre `about:debugging`.
3. Entra a **Este Firefox**.
4. Pulsa **Cargar complemento temporal**.
5. Selecciona `extension/manifest.json`.
6. Abre contenido compatible y pulsa el icono de TikSave.

La extensión descarga un elemento por vez. Para lotes y playlists usa la interfaz local.

## Desarrollo manual

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade -r requirements.txt
python -m app.main
```

## Seguridad y alcance

TikSave está diseñado para contenido público o contenido que el usuario tenga derecho a guardar. No incorpora mecanismos para evitar DRM, contenido privado, contenido de pago ni controles de acceso.

Instagram y Facebook pueden exigir inicio de sesión para determinados enlaces aunque el contenido parezca público. Esta versión no reutiliza cookies de tu navegador; si la plataforma exige autenticación, TikSave mostrará el fallo en lugar de intentar saltarlo.

## Licencia

MIT.
