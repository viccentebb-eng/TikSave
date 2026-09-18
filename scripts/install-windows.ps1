$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "TikSave Local - instalacion" -ForegroundColor Cyan

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

$Python = Get-WorkingPython

if (-not $Python) {
    Write-Host "Python 3.11 o superior no esta instalado. Intentando instalar Python 3.13 con winget..." -ForegroundColor Yellow

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "No se encontro winget. Instala Python 3.11+ desde python.org y ejecuta este script de nuevo."
    }

    winget install --id Python.Python.3.13 -e --accept-package-agreements --accept-source-agreements

    if ($LASTEXITCODE -ne 0) {
        throw "winget no pudo instalar Python. Ejecuta: winget install -e --id Python.Python.3.13"
    }

    $Python = Get-WorkingPython

    if (-not $Python) {
        throw "Python se instalo, pero esta ventana de PowerShell aun no lo detecta. Cierra PowerShell, abre una nueva ventana y vuelve a ejecutar .\scripts\install-windows.ps1"
    }
}

Write-Host "Python detectado: $($Python.Command)" -ForegroundColor Green

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Creando entorno virtual..." -ForegroundColor Cyan
    & $Python.Command @($Python.Args) -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudo crear el entorno virtual de Python."
    }
}

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    throw "No se encontro $VenvPython despues de crear el entorno virtual."
}

Write-Host "Instalando dependencias de TikSave..." -ForegroundColor Cyan
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install --upgrade -r requirements.txt

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "FFmpeg no esta en PATH; intentando instalarlo con winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
        Write-Host "Si FFmpeg acaba de instalarse, cierra y vuelve a abrir PowerShell antes de usar MP3." -ForegroundColor Yellow
    } else {
        Write-Host "Instala FFmpeg manualmente para MP3 y para combinar video y audio." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Instalacion terminada." -ForegroundColor Green
Write-Host "Ejecuta: .\scripts\run-windows.ps1" -ForegroundColor Green
