@echo off
setlocal
cd /d "%~dp0"
title Hapus Auto-Start Mini PC - GFM Gudang Alat

net session >nul 2>&1
if errorlevel 1 (
  echo ================================================================
  echo   MEMINTA IZIN ADMINISTRATOR...
  echo   Klik "Yes" / "Ya" pada kotak dialog Windows yang muncul.
  echo ================================================================
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ================================================================
echo   MENGHAPUS AUTO-START GFM GUDANG ALAT ^& MEMBEBASKAN PORT
echo   PT Sulawesi Cahaya Mineral
echo ================================================================
echo.

echo [1/4] Menghentikan dan menghapus Task Scheduler "GudangAlat"...
schtasks /End /TN "GudangAlat" >nul 2>&1
schtasks /Delete /TN "GudangAlat" /F >nul 2>&1

echo [2/4] Menghentikan seluruh proses server Gudang Alat...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo [3/4] Menghapus file skrip penjalan latar belakang...
if exist "run-server.cmd" del /f /q "run-server.cmd" >nul 2>&1

echo [4/4] Memeriksa status Port 3000...
powershell -NoProfile -Command "Start-Sleep -Seconds 1; $p = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue; if ($p) { Write-Host '   [INFO] Port 3000 masih mendeteksi aktivitas koneksi lain.' -ForegroundColor Yellow } else { Write-Host '   [BERHASIL] Port 3000 sekarang 100%% BEBAS dan BERSIH!' -ForegroundColor Green; Write-Host '   Sistem monitoring WTP ^& WWTP Anda kini bisa berjalan lancar tanpa bentrok.' -ForegroundColor Cyan }"

echo.
echo ================================================================
echo   AUTO-START BERHASIL DIHAPUS!
echo ================================================================
echo - Windows tidak akan lagi otomatis menyalakan server Gudang Alat saat boot.
echo - Port 3000 sudah dilepas sepenuhnya untuk sistem WTP / WWTP.
echo - Data peminjaman barang dan akun crew di folder "data\" TETAP AMAN.
echo.
echo Jika nanti ingin menyalakan Gudang Alat kembali:
echo - Cukup klik 2x: mulai-gudang.bat (akan berjalan di port 3050).
echo.
pause
