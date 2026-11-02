@echo off
setlocal
cd /d "%~dp0"
title Buka Akses HP (Firewall Wi-Fi) - GFM Gudang Alat

net session >nul 2>&1
if errorlevel 1 (
  echo Meminta izin Administrator untuk membuka blokir Windows Firewall agar HP bisa masuk...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ================================================================
echo   MEMBUKA AKSES JARINGAN WI-FI UNTUK HP ^& TABLET
echo   GFM Gudang Alat - PT Sulawesi Cahaya Mineral
echo ================================================================
echo.

powershell -NoProfile -Command ^
  "Get-NetFirewallRule -DisplayName 'Gudang Alat' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; " ^
  "New-NetFirewallRule -DisplayName 'Gudang Alat' -Direction Inbound -Protocol TCP -LocalPort 3050,3450,3000,3443,80,443 -Action Allow -Profile Any | Out-Null; " ^
  "Get-NetConnectionProfile | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private -ErrorAction SilentlyContinue }"

echo [BERHASIL] Port 3050 (HTTP) ^& 3450 (HTTPS) sudah dibuka di Windows Firewall!
echo (Port 3000 bebas untuk sistem monitoring WTP/WWTP).
echo.
echo Alamat yang bisa dibuka dari browser Chrome/Safari di HP Anda:
echo (Pastikan HP dan komputer ini terhubung ke Wi-Fi / Hotspot yang sama)
echo.
powershell -NoProfile -Command ^
  "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object { Write-Host ('   👉 http://' + $_.IPAddress + ':3050') -ForegroundColor Cyan; Write-Host ('   🔒 https://' + $_.IPAddress + ':3450  (Kamera Live)') -ForegroundColor Yellow }"
echo.
echo ================================================================
pause
