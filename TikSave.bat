@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo TikSave no esta instalado. Ejecuta install-windows.bat primero.
  pause
  exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" -m app.desktop
