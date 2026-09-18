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



## Rama experimental 0.8.0

```text
feature/full-browser-clean-mode
```

La extensión solicita acceso amplio a sitios web para mejorar dos funciones:

- detectar solicitudes HLS/DASH cargadas dentro de reproductores e iframes;
- ofrecer herramientas de navegación limpia.

### Modo limpio

El **Modo limpio** usa reglas locales de Firefox para bloquear algunas redes publicitarias y trackers comunes. No envía el historial ni las páginas visitadas a un servidor de TikSave.

Se puede activar y desactivar desde el popup de la extensión.

### Modo lectura

Cuando Firefox reconoce la pestaña como un artículo, TikSave puede abrir el **Modo lectura** nativo del navegador. Esta función elimina elementos secundarios como anuncios y barras laterales de una página cuyo contenido ya está disponible. No desbloquea artículos de suscripción ni contenido restringido.

### Detección de streams

La extensión observa solicitudes de red de tipo multimedia para identificar manifiestos `.m3u8` (HLS) y `.mpd` (DASH) que la pestaña ya haya cargado. TikSave no intenta resolver DRM, CAPTCHA, Cloudflare ni otros controles de acceso.

Para probarla:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/full-browser-clean-mode
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```



## Rama experimental 0.9.0

```text
feature/persistent-guard-douyin-images-notify
```

Novedades:

- El **Modo limpio** conserva su estado al cambiar de pestaña o reiniciar la extensión.
- **Bloquear pop-ups siempre** es un ajuste global persistente. Se aplica desde `document_start` en las páginas para que no haya que activarlo pestaña por pestaña.
- Soporte para videos públicos de **Douyin** mediante el extractor de yt-dlp.
- Detección de imágenes visibles en **Instagram, Stories, TikTok y Douyin**. El popup muestra cuántas imágenes detectó y puede guardarlas en `Descargas/TikSave/Images/<plataforma>`.
- Las imágenes se descargan usando la sesión y las URLs que el navegador ya tiene disponibles; TikSave no intenta abrir contenido privado o no autorizado.
- Al terminar una descarga, TikSave mantiene la notificación del sistema pero también muestra un aviso propio dentro de la pestaña activa y un indicador temporal ✓/! en el icono de la extensión.

Para probarla:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/persistent-guard-douyin-images-notify
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Como esta versión añade el permiso `downloads` y nuevos scripts globales, conviene quitar el complemento temporal anterior de `about:debugging` y volver a cargar `extension/manifest.json`.



## Rama experimental 0.10.0

```text
feature/image-picker-hls-fix-dezoom
```

Novedades:

- El selector de imágenes del popup ahora muestra miniaturas y permite marcar exactamente cuáles guardar.
- La detección HLS prioriza manifiestos master/video y evita usar variantes que parecen audio-only, por ejemplo `index-a1.m3u8`.
- Para streams detectados en el navegador, TikSave intenta combinar mejor video + audio en lugar de guardar una pista aislada.
- Integración opcional con **dezoomify-rs** para reconstruir imágenes de alta resolución servidas por mosaicos.
- Detecta automáticamente varias fuentes típicas: IIIF `info.json`, Deep Zoom `.dzi`, Zoomify `ImageProperties.xml`, mosaicos Zoomify/Deep Zoom e indicios de Krpano.
- Si el motor de imágenes no está instalado, el popup ofrece **Instalar motor de imágenes**. TikSave descarga el binario oficial desde GitHub Releases y lo ejecuta como herramienta externa.
- Las imágenes reconstruidas se guardan en `Descargas/TikSave/Dezoom`.

### Sobre dezoomify-rs

TikSave no incorpora el código fuente de dezoomify-rs dentro de su código MIT. Lo usa como programa externo opcional. dezoomify-rs es un proyecto independiente con licencia GPL-3.0:

https://github.com/lovasoa/dezoomify-rs

El motor admite Zoomify, IIIF, Deep Zoom, Google Arts & Culture, Krpano, IIPImage, NYPL y modos genérico/custom, entre otros.

Para probar esta rama:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/image-picker-hls-fix-dezoom
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Después vuelve a cargar `extension/manifest.json` desde `about:debugging`.



## Rama experimental 0.11.0

```text
feature/maxurl-context-googlearts
```

Novedades:

- La pantalla principal ya no asume que todos los enlaces son TikTok/YouTube/etc.
- Al pegar un solo enlace, TikSave lo **analiza automáticamente** y muestra únicamente las opciones disponibles:
  - video / audio / MP3;
  - listas y colecciones;
  - subtítulos;
  - imágenes encontradas;
  - original / máxima resolución mediante Image Max URL;
  - reconstrucción por mosaicos mediante dezoomify-rs.
- Páginas web genéricas y visores como Google Arts & Culture se analizan buscando metadatos, imágenes, HLS/DASH y protocolos IIIF/Deep Zoom/Zoomify.
- Integración opcional de **Image Max URL** (`qsniyg/maxurl`, licencia Apache-2.0). TikSave descarga el userscript oficial y un runtime Node.js local si hace falta.
- Menú contextual de Firefox **TikSave** con:
  - Abrir imagen original / máxima resolución.
  - Descargar imagen original / máxima resolución.
  - Reconstruir imagen por mosaicos.
  - Descargar video de esta página.
  - Abrir esta página en TikSave.

Para probar:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/maxurl-context-googlearts
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Como esta versión añade `contextMenus`, conviene quitar y volver a cargar el complemento temporal desde `about:debugging`.



## Rama experimental 0.12.0

```text
feature/native-image-engine-diagnostics
```

Cambios principales:

- **Image Max URL deja de ser una dependencia del flujo normal.**
- Nuevo motor integrado **TikSave Native Image**, sin Node.js ni instalación adicional.
- El motor genera y prueba candidatos de mayor resolución para:
  - Google / Googleusercontent / ggpht;
  - WordPress;
  - Shopify;
  - Pinterest;
  - Twitter/X;
  - Cloudinary;
  - parámetros genéricos de tamaño en URLs.
- Cada candidato se verifica por HTTP antes de elegirlo; cuando es posible también se leen dimensiones de PNG, JPEG, GIF y WebP.
- La opción **Original / máxima resolución** funciona desde la app web y desde el menú contextual de Firefox sin instalar motor.
- Compatibilidad temporal con los antiguos endpoints `/api/maxurl/*`: ahora redirigen internamente al motor nativo.
- Nuevo log persistente en:
  - Windows: `%LOCALAPPDATA%\TikSave\logs\tiksave.log`
- Se puede abrir el log desde:
  - la página principal;
  - el popup de Firefox;
  - el menú contextual de TikSave.
- Los errores del menú contextual también se envían al log, incluyendo URL, acción y detalle del fallo.
- El analizador filtra más logos, avatares, badges y gráficos de interfaz para no confundirlos con la imagen principal.

Para probar:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/native-image-engine-diagnostics
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Después recarga el complemento temporal en `about:debugging`.



## Rama experimental 0.13.0

```text
feature/installer-ui-performance
```

Esta rama consolida la instalación, la interfaz y el rendimiento:

- La interfaz principal es más compacta y muestra el estado real de TikSave, FFmpeg, el motor nativo de imágenes y dezoomify-rs.
- El análisis de enlaces usa caché temporal para no repetir trabajo al pegar, cambiar opciones o volver a analizar el mismo enlace.
- TikSave Native Image prueba candidatos en paralelo y conserva resultados durante unos minutos.
- Si yt-dlp falla al analizar Instagram u otra plataforma, TikSave intenta un análisis genérico de la página en lugar de convertir todo el flujo en un error.
- El instalador de Windows instala automáticamente dezoomify-rs desde el release oficial y verifica que el ejecutable funcione.
- `-SkipEngines` permite omitir motores externos y `-ForceEngineUpdate` fuerza la actualización de dezoomify-rs.
- TikSave conserva licencia MIT. dezoomify-rs sigue siendo un programa externo independiente GPL-3.0. Consulta `THIRD_PARTY_NOTICES.md`.

Instalación normal:

```powershell
cd D:\PROYECTOS\TikSave
git fetch origin
git switch feature/installer-ui-performance
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Forzar actualización del motor de mosaicos:

```powershell
.\scripts\install-windows.ps1 -ForceEngineUpdate
```

Omitir motores externos:

```powershell
.\scripts\install-windows.ps1 -SkipEngines
```

#### Parche 0.13.1

- Corrige el instalador de motores en PowerShell: ya no pasa scripts Python multilínea mediante `python -c`, evitando que PowerShell rompa las comillas.
- `dezoomify-rs` se instala mediante `python -m app.setup_engines install-dezoomify`.
- La verificación final usa el mismo helper y devuelve JSON válido.
- **Abrir imagen original** en Firefox ahora usa un visor flotante sobre la página, con zoom, ajustar, tamaño real, descarga y opción para abrir una pestaña.
- Instagram, TikTok y Douyin incorporan un escáner de imágenes/carruseles. En Instagram intenta recorrer automáticamente el carrusel y regresar al elemento inicial para descubrir imágenes sin que tengas que previsualizarlas manualmente.
- Si Instagram solo entrega al backend su pantalla de login/interfaz, la app ya no muestra logos y gráficos de Instagram como si fueran fotos del post; indica usar la extensión con la sesión abierta.

## Licencias

TikSave permanece bajo MIT. El instalador descarga dezoomify-rs como ejecutable externo separado. Junto al ejecutable se guarda un aviso de terceros, el enlace al código fuente y, cuando GitHub está disponible, una copia de la licencia GPL-3.0.

Si distribuyes un instalador o ZIP que incluya físicamente el binario de dezoomify-rs, revisa y cumple las obligaciones de distribución GPL-3.0 correspondientes a ese binario.

## Licencia

MIT.
