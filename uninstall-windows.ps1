<#
  Hapus auto-start & aturan firewall Gudang Alat. Data (folder data\) TIDAK dihapus.
  Jalankan sebagai Administrator.
#>
#Requires -RunAsAdministrator
$TaskName = 'GudangAlat'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'Gudang Alat' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if (Test-Path "$PSScriptRoot\run-server.cmd") { Remove-Item -Force "$PSScriptRoot\run-server.cmd" -ErrorAction SilentlyContinue }
Write-Host 'Gudang Alat dihentikan dan auto-start dihapus. Port 3000 telah bebas.' -ForegroundColor Green
Write-Host 'Data peminjaman & akun di folder data\ tetap aman.'
