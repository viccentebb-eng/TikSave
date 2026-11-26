# Registra el servidor MCP de TikSave en Claude Desktop (claude_desktop_config.json).
# Guarda una copia del archivo anterior y no toca los demas servidores.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) { throw "TikSave no esta instalado. Ejecuta install-windows.bat primero." }

$Dir = Join-Path $env:APPDATA "Claude"
$Config = Join-Path $Dir "claude_desktop_config.json"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$Data = [pscustomobject]@{}
if (Test-Path $Config) {
    Copy-Item $Config "$Config.bak" -Force
    $Text = Get-Content $Config -Raw
    if ($Text.Trim()) { $Data = $Text | ConvertFrom-Json }
}
if (-not $Data.mcpServers) {
    $Data | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
}
$Entry = [pscustomobject]@{
    command = $Python
    args    = @("-m", "app.mcp_server")
    env     = [pscustomobject]@{ PYTHONPATH = $Root }
}
$Data.mcpServers | Add-Member -NotePropertyName tiksave -NotePropertyValue $Entry -Force

# Sin BOM: Claude Desktop no lee JSON con BOM.
$Json = $Data | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($Config, $Json, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Servidor MCP 'tiksave' registrado en: $Config" -ForegroundColor Green
Write-Host "Cierra Claude Desktop por completo (tambien desde la bandeja) y vuelve a abrirlo." -ForegroundColor Yellow
Write-Host "Para Claude Code: claude mcp add tiksave -e PYTHONPATH=`"$Root`" -- `"$Python`" -m app.mcp_server" -ForegroundColor Cyan
