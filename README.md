# TikSave Local

Aplicacion local y extension de Firefox para guardar contenido publico de TikTok sin depender de paginas con publicidad.

## Funciones

- Descarga de video MP4 con la mejor calidad disponible.
- Extraccion a MP3 mediante FFmpeg.
- Descarga del mejor audio disponible sin convertir.
- Vista previa con titulo, autor y miniatura.
- Progreso de descarga en tiempo real.
- Guarda por defecto en `Descargas/TikSave`.
- Boton para abrir la carpeta de descargas.
- Extension de Firefox para enviar la pestaña actual a TikSave.
- Todo corre en `127.0.0.1`; no hay servidor externo de TikSave.

## Windows

```powershell
git clone https://github.com/viccentebb-eng/TikSave.git
cd TikSave
.\scripts\install-windows.ps1
.\scripts\run-windows.ps1
```

Al iniciar se abre `http://127.0.0.1:8173`.

## Extension temporal de Firefox

1. Inicia TikSave Local.
2. En Firefox abre `about:debugging`.
3. Entra a **Este Firefox**.
4. Pulsa **Cargar complemento temporal**.
5. Selecciona `extension/manifest.json`.
6. Abre un TikTok y pulsa el icono de TikSave.

## Desarrollo manual

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m app.main
```

## Seguridad y alcance

TikSave valida que el enlace pertenezca a TikTok y no incorpora cookies de cuentas ni mecanismos para acceder a contenido privado. Esta pensado para contenido publico que el usuario tenga derecho a guardar.

## Licencia

MIT.
