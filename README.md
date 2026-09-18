# TikSave Local

Aplicación local y extensión de Firefox para guardar contenido público de TikTok y YouTube sin depender de páginas con publicidad.

## Funciones

- TikTok: enlaces normales, móviles y enlaces cortos.
- YouTube: videos normales, enlaces `youtu.be` y Shorts.
- Descarga de video MP4 con la mejor calidad disponible.
- Extracción a MP3 mediante FFmpeg.
- Descarga del mejor audio disponible sin convertir.
- Vista previa con título, autor/canal y miniatura.
- Progreso de descarga en tiempo real.
- Guarda por defecto en `Descargas/TikSave`.
- Botón para abrir la carpeta de descargas.
- Extensión de Firefox para enviar la pestaña actual a TikSave.
- Todo corre en `127.0.0.1`; no hay servidor externo de TikSave.

## Windows

```powershell
git clone https://github.com/viccentebb-eng/TikSave.git
cd TikSave
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Al iniciar se abre `http://127.0.0.1:8173`.

## Probar la rama de YouTube

```powershell
git fetch origin
git switch feature/youtube-support
git pull
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Para regresar a la versión estable:

```powershell
git switch main
git pull
```

## Extensión temporal de Firefox

1. Inicia TikSave Local.
2. En Firefox abre `about:debugging`.
3. Entra a **Este Firefox**.
4. Pulsa **Cargar complemento temporal**.
5. Selecciona `extension/manifest.json`.
6. Abre un video de TikTok o YouTube y pulsa el icono de TikSave.

## Desarrollo manual

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m app.main
```

## Seguridad y alcance

TikSave solo admite URLs públicas de TikTok y YouTube. No incorpora cookies de cuentas ni mecanismos para evitar contenido privado, de pago, con DRM o restricciones de acceso. Úsalo únicamente con contenido que tengas derecho a guardar.

## Licencia

MIT.
