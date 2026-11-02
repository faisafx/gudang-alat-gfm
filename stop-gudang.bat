@echo off
setlocal
cd /d "%~dp0"
title Menghentikan GFM Gudang Alat

net session >nul 2>&1
if errorlevel 1 (
  echo Meminta izin Administrator untuk menghentikan server latar belakang...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Menghentikan server GFM Gudang Alat...
schtasks /End /TN "GudangAlat" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo Server Gudang Alat berhasil dihentikan.
timeout /t 3
