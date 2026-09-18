# TikSave Local

Aplicación local y extensión de Firefox para guardar contenido público de TikTok, YouTube, Instagram y Facebook sin depender de páginas con publicidad.

## Funciones principales

- TikTok, YouTube, Instagram y Facebook.
- Varias URLs en un mismo lote, una por línea.
- Playlists y colecciones.
- Resolución máxima: mejor disponible, 2160p, 1440p, 1080p, 720p, 480p y 360p.
- Video MP4, MP3 y audio original.
- Barra de progreso independiente por enlace.
- Carpeta predeterminada: `Descargas/TikSave`.
- Extensión temporal de Firefox.
- Todo corre en `127.0.0.1`.

## Novedades 0.4.0

### Carruseles de Instagram

Cuando TikSave detecta una publicación con varios elementos:

- muestra cada elemento con su miniatura;
- selecciona todos inicialmente;
- permite desmarcar los que no quieras;
- envía únicamente los índices seleccionados a yt-dlp.

La misma selección puede funcionar con otros extractores que expongan el contenido como una colección de entradas.

### Metadatos musicales para MP3 de YouTube

La casilla **Corregir música con MusicBrainz** se aplica al descargar MP3 de YouTube.

TikSave intenta:

1. interpretar artista y canción usando los metadatos de YouTube/YouTube Music y el título;
2. consultar MusicBrainz;
3. aceptar la coincidencia solo cuando supera un umbral de confianza;
4. corregir etiquetas ID3 de título, artista, álbum y fecha;
5. buscar la carátula frontal en Cover Art Archive;
6. incrustar la carátula en el MP3;
7. renombrar el archivo como `Artista - Canción.mp3`.

Si no existe una coincidencia suficientemente confiable, conserva el archivo original en lugar de inventar metadatos.

MusicBrainz se consulta con identificación de aplicación y límite de aproximadamente una petición por segundo.

### Subtítulos

Después de analizar un enlace, si el extractor ofrece subtítulos, TikSave muestra:

- idioma;
- código del idioma;
- si es subtítulo normal o automático;
- formatos encontrados.

Formatos de salida disponibles:

- SRT
- VTT
- TXT (transcripción limpia sin marcas de tiempo)
- ASS

La descarga usa subtítulos normales y, cuando estén disponibles, subtítulos automáticos de yt-dlp.

## Probar la rama 0.4.0

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/carousel-metadata-subtitles
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Para regresar a la 0.3.0:

```powershell
git switch feature/multiplatform-batch-quality
git pull
```

## Extensión temporal de Firefox

1. Inicia TikSave Local.
2. Abre `about:debugging`.
3. Entra a **Este Firefox**.
4. Pulsa **Cargar complemento temporal**.
5. Selecciona `extension/manifest.json`.

La selección de carruseles, enriquecimiento musical y gestor de subtítulos se realizan desde la interfaz local.

## Seguridad y alcance

TikSave está diseñado para contenido público o contenido que tengas derecho a guardar. No incorpora mecanismos para evitar DRM, contenido privado, contenido de pago ni controles de acceso.

Instagram y Facebook pueden exigir sesión para determinados enlaces. Esta rama sigue usando acceso público y no extrae cookies del navegador.



## Rama experimental 0.7.0

```text
feature/clips-hls-popup-guard
```

Novedades:

- Descarga de un fragmento por tiempo.
- Desde la extensión de Firefox puedes marcar inicio y final usando el tiempo actual del reproductor.
- Opción de recorte más exacto; usa reencodificación alrededor de los cortes y puede tardar más.
- Mejor detección de reproductores HLS/DASH y reproductores incrustados en páginas no compatibles.
- Modo opcional para bloquear ventanas emergentes programáticas en la pestaña actual hasta recargar.
- Botón de prueba para diagnosticar notificaciones de Firefox.
- Corrección del icono SVG usado por las notificaciones.

Para probarla:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/clips-hls-popup-guard
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

## Licencia

MIT.
