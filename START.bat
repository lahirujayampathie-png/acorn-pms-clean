@echo off
title Acorn Group PMS - Server Running
color 1F
cls
echo.
echo  ============================================================
echo   Acorn Group Performance Management System
echo  ============================================================
echo.

REM ── Find Node.js ───────────────────────────────────────────
set NODE_EXE=node
node --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    IF EXIST "C:\Program Files\nodejs\node.exe" (
        set NODE_EXE="C:\Program Files\nodejs\node.exe"
        SET PATH=C:\Program Files\nodejs;%PATH%
    ) ELSE IF EXIST "C:\Program Files (x86)\nodejs\node.exe" (
        set NODE_EXE="C:\Program Files (x86)\nodejs\node.exe"
        SET PATH=C:\Program Files (x86)\nodejs;%PATH%
    ) ELSE (
        color 4F
        echo  ERROR: Node.js not found.
        echo  Please run SETUP-FIRST-TIME.bat first.
        pause
        exit /b 1
    )
)

IF NOT EXIST "node_modules" (
    color 4F
    echo  ERROR: Packages not installed.
    echo  Please run SETUP-FIRST-TIME.bat first.
    pause
    exit /b 1
)

IF NOT EXIST "db\pms.db" (
    color 4F
    echo  ERROR: Database not found.
    echo  Please run SETUP-FIRST-TIME.bat first.
    pause
    exit /b 1
)

REM ── Get local IP ────────────────────────────────────────────
set LOCALIP=your-computer-ip
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set LOCALIP=%%a
    goto :gotip
)
:gotip
set LOCALIP=%LOCALIP: =%

echo.
echo  ============================================================
echo.
echo   Server is running!
echo.
echo   YOUR computer :  http://localhost:3000
echo   Share with team:  http://%LOCALIP%:3000
echo.
echo   First HR login:
echo     Employee No:  20123
echo     Password:     Acorn@2025
echo.
echo   Keep this window open while people use the system.
echo   Press Ctrl+C to stop the server.
echo.
echo  ============================================================
echo.

%NODE_EXE% server.js

echo.
echo  Server stopped.
pause
