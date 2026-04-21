# Acorn Group PMS - Setup Script (PowerShell)
# This is more reliable than the .bat file on modern Windows

$Host.UI.RawUI.WindowTitle = "Acorn Group PMS - Setup"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Acorn Group Performance Management System" -ForegroundColor White
Write-Host "  FIRST TIME SETUP" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# --- Find Node.js ---
Write-Host "Searching for Node.js..." -ForegroundColor Yellow

$nodePaths = @(
    "node",
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe",
    "$env:APPDATA\nvm\current\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:ProgramFiles\nodejs\node.exe"
)

$nodeExe = $null
foreach ($p in $nodePaths) {
    try {
        $ver = & $p --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            $nodeExe = $p
            Write-Host "[OK] Node.js found at: $p" -ForegroundColor Green
            Write-Host "     Version: $ver" -ForegroundColor Green
            break
        }
    } catch {}
}

if (-not $nodeExe) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  Node.js NOT FOUND" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "  1. Go to: https://nodejs.org" -ForegroundColor White
    Write-Host "  2. Click Download and install it" -ForegroundColor White
    Write-Host "  3. RESTART your computer after installing" -ForegroundColor White
    Write-Host "  4. Run SETUP-FIRST-TIME.ps1 again" -ForegroundColor White
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# --- Find npm ---
$npmExe = $null
$npmPaths = @(
    "npm",
    "C:\Program Files\nodejs\npm.cmd",
    "C:\Program Files (x86)\nodejs\npm.cmd",
    "$env:APPDATA\nvm\current\npm.cmd",
    "$env:LOCALAPPDATA\Programs\nodejs\npm.cmd"
)

foreach ($p in $npmPaths) {
    try {
        $ver = & $p --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            $npmExe = $p
            Write-Host "[OK] npm found: $ver" -ForegroundColor Green
            break
        }
    } catch {}
}

if (-not $npmExe) {
    Write-Host "npm not found - trying node to run npm directly..." -ForegroundColor Yellow
    $npmExe = "npm"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Step 1 of 2: Installing packages..." -ForegroundColor White
Write-Host "  (Needs internet - takes 1-3 minutes)" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Change to the script's directory
Set-Location $PSScriptRoot

& $npmExe install
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: npm install failed." -ForegroundColor Red
    Write-Host "Check your internet connection and try again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "[OK] Packages installed." -ForegroundColor Green
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Step 2 of 2: Setting up database (225 employees)..." -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

& $nodeExe scripts/setup-db.js
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Database setup failed." -ForegroundColor Red
    Write-Host "Please take a screenshot and share it for help." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  SUCCESS! Setup is complete." -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Now double-click START.ps1 to launch the server." -ForegroundColor White
Write-Host ""
Write-Host "  Then open your browser: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Host "  First HR login:" -ForegroundColor White
Write-Host "    Employee No:  20123" -ForegroundColor Yellow
Write-Host "    Password:     Acorn@2025" -ForegroundColor Yellow
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to close"
