param(
    [switch]$SkipEngines,
    [switch]$ForceEngineUpdate
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host ""
Write-Host "TikSave - instalacion local" -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor DarkGray

function Get-WorkingPython {
    $candidates = @()

    $pyCmd = Get-Command py -ErrorAction SilentlyContinue
    if ($pyCmd) {
        try {
            & py -3 --version *> $null
            if ($LASTEXITCODE -eq 0) {
                return @{ Command = "py"; Args = @("-3") }
            }
        } catch {}
    }

    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCmd) {
        try {
            & python --version *> $null
            if ($LASTEXITCODE -eq 0) {
                return @{ Command = "python"; Args = @() }
            }
        } catch {}
    }

    $candidates += Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
    $candidates += Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"

    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles "Python313\python.exe"
        $candidates += Join-Path $env:ProgramFiles "Python312\python.exe"
        $candidates += Join-Path $env:ProgramFiles "Python311\python.exe"
    }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return @{ Command = $candidate; Args = @() }
        }
    }

    return $null
}

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host ">> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "   OK  $Text" -ForegroundColor Green
}

function Write-Warn([string]$Text) {
    Write-Host "   !!  $Text" -ForegroundColor Yellow
}

$Python = Get-WorkingPython

if (-not $Python) {
    Write-Step "Python no esta instalado. Intentando instalar Python 3.13 con winget"

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "No se encontro winget. Instala Python 3.11+ desde python.org y ejecuta este script de nuevo."
    }

    winget install --id Python.Python.3.13 -e --accept-package-agreements --accept-source-agreements

    if ($LASTEXITCODE -ne 0) {
        throw "winget no pudo instalar Python. Ejecuta: winget install -e --id Python.Python.3.13"
    }

    $Python = Get-WorkingPython

    if (-not $Python) {
        throw "Python se instalo, pero esta ventana aun no lo detecta. Cierra PowerShell, abre una nueva ventana y vuelve a ejecutar .\scripts\install-windows.ps1"
    }
}

Write-Ok "Python detectado: $($Python.Command)"

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Step "Creando entorno virtual"
    & $Python.Command @($Python.Args) -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo crear el entorno virtual de Python."
    }
}

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    throw "No se encontro $VenvPython despues de crear el entorno virtual."
}

Write-Step "Actualizando dependencias de TikSave"
& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar pip." }

& $VenvPython -m pip install --upgrade -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "No se pudieron instalar las dependencias de TikSave." }
Write-Ok "Dependencias de Python listas"

Write-Step "Comprobando FFmpeg"
$Ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue

if (-not $Ffmpeg) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "   FFmpeg no esta en PATH. Instalando con winget..." -ForegroundColor Yellow
        winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements

        if ($LASTEXITCODE -eq 0) {
            Write-Warn "FFmpeg se instalo. Windows puede requerir abrir una nueva PowerShell para actualizar PATH."
        } else {
            Write-Warn "No se pudo instalar FFmpeg automaticamente. TikSave seguira funcionando, pero MP3 y algunas uniones de video/audio pueden fallar."
        }
    } else {
        Write-Warn "winget no esta disponible. Instala FFmpeg manualmente para MP3 y mezcla de video/audio."
    }
} else {
    Write-Ok "FFmpeg: $($Ffmpeg.Source)"
}

if (-not $SkipEngines) {
    Write-Step "Instalando motores auxiliares"

    $ForceValue = if ($ForceEngineUpdate) { "True" } else { "False" }
    $EngineScript = @"
import json
from app.dezoom import install, status

try:
    result = install(force=$ForceValue)
    print(json.dumps(result, ensure_ascii=False))
    if not result.get("installed"):
        raise SystemExit(2)
except Exception as exc:
    print(json.dumps({"installed": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
    raise
"@

    try {
        $env:PYTHONUTF8 = "1"
        $EngineResult = & $VenvPython -c $EngineScript
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "dezoomify-rs instalado y verificado"
            if ($EngineResult) {
                Write-Host "   $EngineResult" -ForegroundColor DarkGray
            }
        } else {
            Write-Warn "dezoomify-rs no pudo instalarse. TikSave seguira usando el motor nativo para imagenes normales."
        }
    } catch {
        Write-Warn "dezoomify-rs no pudo instalarse: $($_.Exception.Message)"
        Write-Warn "Puedes volver a intentar con: .\scripts\install-windows.ps1 -ForceEngineUpdate"
    }
} else {
    Write-Warn "Instalacion de motores omitida por -SkipEngines"
}

Write-Step "Verificacion final"
$VerifyScript = @"
import json
import shutil
from app import __version__
from app.dezoom import status as dezoom_status
from app.native_image import status as image_status

print(json.dumps({
    "version": __version__,
    "ffmpeg": shutil.which("ffmpeg"),
    "native_image": image_status(),
    "dezoomify": dezoom_status(force=True),
}, ensure_ascii=False))
"@

try {
    $Summary = & $VenvPython -c $VerifyScript
    Write-Host "   $Summary" -ForegroundColor DarkGray
} catch {
    Write-Warn "No se pudo generar el resumen final: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "Instalacion terminada." -ForegroundColor Green
Write-Host "Ejecuta: .\scripts\run-windows.ps1" -ForegroundColor Green
Write-Host ""
