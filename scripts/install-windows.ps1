$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "TikSave Local - instalacion" -ForegroundColor Cyan

$Python = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    $Python = "py"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $Python = "python"
} else {
    Write-Host "Python 3.11 o superior es necesario." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id Python.Python.3.13 -e --accept-package-agreements --accept-source-agreements
        $Python = "py"
    } else {
        throw "Instala Python 3.11+ y ejecuta este script de nuevo."
    }
}

if (-not (Test-Path ".venv")) {
    if ($Python -eq "py") { & py -3 -m venv .venv } else { & python -m venv .venv }
}

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r requirements.txt

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "FFmpeg no esta en PATH; intentando instalarlo con winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
        Write-Host "Si FFmpeg acaba de instalarse, cierra y vuelve a abrir PowerShell antes de usar MP3." -ForegroundColor Yellow
    } else {
        Write-Host "Instala FFmpeg manualmente para conversion MP3 y combinacion de video/audio." -ForegroundColor Yellow
    }
}

Write-Host "Instalacion terminada. Ejecuta .\scripts\run-windows.ps1" -ForegroundColor Green
