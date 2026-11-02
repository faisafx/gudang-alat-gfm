@echo off
setlocal
cd /d "%~dp0"
title Pasang Auto-Start Mini PC - GFM Gudang Alat

net session >nul 2>&1
if errorlevel 1 (
  echo Meminta izin Administrator untuk mengatur Firewall ^& Auto-Start...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
echo.
pause
