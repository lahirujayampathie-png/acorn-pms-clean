@echo off
title Acorn Group PMS - Server
cd /d "%~dp0"

echo.
echo ============================================================
echo   Acorn Group Performance Management System
echo ============================================================
echo.

if not exist "node_modules" (
    color 4F
    echo ERROR: node_modules folder not found.
    echo Please run RUN-ME-FIRST.bat first.
    echo.
    pause
    exit /b 1
)

if not exist "db\pms.db" (
    color 4F
    echo ERROR: Database not found.
    echo Please run RUN-ME-FIRST.bat first.
    echo.
    pause
    exit /b 1
)

echo   Starting server...
echo.

REM Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set IP=%%a
    goto :gotip
)
:gotip
set IP=%IP: =%

echo ============================================================
echo.
echo   Server is running!
echo.
echo   YOUR computer : http://localhost:3000
echo   Share with team: http://%IP%:3000
echo.
echo   Login:  Emp No 20123  /  Password: Acorn@2025
echo.
echo   Keep this window open. Ctrl+C to stop.
echo.
echo ============================================================
echo.

node server.js

echo.
echo Server stopped.
pause
