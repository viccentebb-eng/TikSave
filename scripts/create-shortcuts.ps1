# Crea los accesos directos "TikSave" en el Escritorio y en el menu Inicio.
# Abren TikSave en su propia ventana, sin consola (pythonw -m app.desktop).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PythonW = Join-Path $Root ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $PythonW)) { throw "TikSave no esta instalado. Ejecuta install-windows.bat primero." }
$Icon = Join-Path $Root "app\static\tiksave.ico"

$Shell = New-Object -ComObject WScript.Shell
$Targets = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "TikSave.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Programs")) "TikSave.lnk")
)
foreach ($Path in $Targets) {
    $Link = $Shell.CreateShortcut($Path)
    $Link.TargetPath = $PythonW
    $Link.Arguments = "-m app.desktop"
    $Link.WorkingDirectory = $Root
    $Link.Description = "TikSave: descargar videos, audio, textos y paginas"
    if (Test-Path $Icon) { $Link.IconLocation = "$Icon,0" }
    $Link.Save()
    Write-Host "Acceso directo creado: $Path" -ForegroundColor Green
}
