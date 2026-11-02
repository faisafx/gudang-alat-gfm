<#
  Pasang Gudang Alat sebagai server lokal di mini PC (Windows 10/11).
  Cara pakai: klik kanan PowerShell -> "Run as administrator", lalu:
      cd C:\GudangAlat
      powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
  Aman dijalankan ulang (misalnya setelah update aplikasi).
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$TaskName = 'GudangAlat'

function Step($t) { Write-Host "`n== $t" -ForegroundColor Yellow }

# 1. Node.js
Step 'Cek Node.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host 'Node.js belum terpasang. Download versi LTS dari https://nodejs.org lalu jalankan skrip ini lagi.' -ForegroundColor Red
  exit 1
}
$ver = [version]((& $node -v).TrimStart('v'))
if ($ver -lt [version]'22.13.0') {
  Write-Host "Node.js $ver terlalu lama. Butuh minimal 22.13 (disarankan LTS terbaru)." -ForegroundColor Red
  exit 1
}
Write-Host "Node.js $ver di $node"

# 2. Dependensi
Step 'Pasang dependensi'
& npm install --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install gagal (butuh internet saat instalasi pertama)' }

# 3. Konfigurasi .env
Step 'Konfigurasi'
if (-not (Test-Path .env)) {
  do { $pin = Read-Host 'Buat PIN admin untuk penjaga gudang (minimal 4 angka)' } while ($pin -notmatch '^\d{4,}$')
  $lines = (Get-Content .env.example) -replace '^ADMIN_PIN=.*', "ADMIN_PIN=$pin"
  [IO.File]::WriteAllLines((Join-Path $PSScriptRoot '.env'), $lines)  # UTF-8 tanpa BOM
  Write-Host '.env dibuat.'
} else {
  Write-Host '.env sudah ada, tidak diubah.'
}
New-Item -ItemType Directory -Force -Path data | Out-Null

# 4. Skrip penjalan (auto-restart kalau server berhenti)
Step 'Membuat run-server.cmd'
@"
@echo off
rem Dibuat otomatis oleh install-windows.ps1
cd /d "%~dp0"
:loop
echo [%date% %time%] server mulai >> data\server.log
"$node" --env-file-if-exists=.env server.js >> data\server.log 2>&1
echo [%date% %time%] server berhenti, restart dalam 5 detik >> data\server.log
ping -n 6 127.0.0.1 >nul
goto loop
"@ | Set-Content -Encoding ASCII run-server.cmd

# 5. Firewall: izinkan HP/tablet di jaringan gudang mengakses port 3050, 3450, 3000, 3443, 80, 443
Step 'Firewall'
Get-NetFirewallRule -DisplayName 'Gudang Alat' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Gudang Alat' -Direction Inbound -Protocol TCP -LocalPort 3050, 3450, 3000, 3443, 80, 443 -Action Allow -Profile Any | Out-Null
Write-Host 'Port 3050 (HTTP) & 3450 (HTTPS) dibuka di Windows Firewall (Port 3000 bebas untuk WTP/WWTP).'

# 6. Jalan otomatis saat mini PC menyala (tanpa perlu login)
Step 'Auto-start saat Windows menyala'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$PSScriptRoot\run-server.cmd`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Task '$TaskName' terdaftar dan dijalankan pada port 3050."

# 7. Jangan sleep/hibernate saat dicolok listrik
Step 'Power: matikan sleep'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

# 8. Cek server
Step 'Cek server'
Start-Sleep -Seconds 5
$ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
try {
  $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3050/setup' -TimeoutSec 10
  Write-Host 'Server BERJALAN.' -ForegroundColor Green
} catch {
  Write-Host 'Server belum menjawab. Lihat log: data\server.log' -ForegroundColor Red
}

Write-Host "`n================ SELESAI ================" -ForegroundColor Green
Write-Host 'Di setiap HP/tablet (terhubung ke WiFi yang sama), buka:'
foreach ($ip in $ips) {
  Write-Host "    http://${ip}:3050        (Scanner Bluetooth / Dashboard)" -ForegroundColor Cyan
  Write-Host "    https://${ip}:3450       (Kamera Live HTTPS)" -ForegroundColor Yellow
}
Write-Host "`nPENTING: Port 3000 bebas untuk monitoring WTP/WWTP. Gudang Alat berjalan di Port 3050 & 3450."
