# Acorn Group PMS - Start Server (PowerShell)

$Host.UI.RawUI.WindowTitle = "Acorn Group PMS - Running"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Acorn Group Performance Management System" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

# Find node
$nodeExe = "node"
try { & node --version 2>$null | Out-Null } catch {
    $nodeExe = "C:\Program Files\nodejs\node.exe"
}

if (-not (Test-Path "node_modules")) {
    Write-Host "ERROR: Packages not installed. Run SETUP-FIRST-TIME.ps1 first." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

if (-not (Test-Path "db\pms.db")) {
    Write-Host "ERROR: Database not found. Run SETUP-FIRST-TIME.ps1 first." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Get local IP
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" } | Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "  Server is running!" -ForegroundColor Green
Write-Host ""
Write-Host "  Your computer : http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Share with team: http://${ip}:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "  First HR login:" -ForegroundColor White
Write-Host "    Employee No:  20123" -ForegroundColor Yellow
Write-Host "    Password:     Acorn@2025" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Keep this window open. Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

& $nodeExe server.js
