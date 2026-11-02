@echo off
setlocal
cd /d "%~dp0"
title GFM Gudang Alat - PT Sulawesi Cahaya Mineral

echo ================================================================
echo   GFM GUDANG ALAT - PT SULAWESI CAHAYA MINERAL
echo   Sistem Peminjaman ^& Pengembalian Alat Gudang (QR Scan)
echo ================================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js belum terpasang di komputer ini.
  echo Silakan unduh dan pasang Node.js LTS dari https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Memasang komponen aplikasi pertama kali...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] Gagal memasang komponen. Pastikan internet terhubung.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [INFO] File konfigurasi .env dibuat otomatis.
  )
)

if not exist "data\gudang.db" (
  echo [INFO] Menyiapkan database awal...
  node --env-file-if-exists=.env seed.js
)

echo [INFO] Menyiapkan server dan membuka browser otomatis saat server siap...
start "" cmd /c "for /L %%i in (1,1,15) do @(curl -s http://127.0.0.1:3050/api/config >nul 2>&1 && (start http://localhost:3050 & exit /b) || ping -n 2 127.0.0.1 >nul)"

:loop
echo.
echo [%date% %time%] Server Gudang Alat AKTIF pada Port 3050...
echo (Jangan tutup jendela hitam ini selama sistem dipakai. Tekan Ctrl+C untuk berhenti)
echo.
node --env-file-if-exists=.env server.js
echo.
echo [PERINGATAN] Server berhenti. Menjalankan ulang otomatis dalam 5 detik...
timeout /t 5
goto loop
