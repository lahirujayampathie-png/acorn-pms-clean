@echo off
title Acorn Group PMS - First Time Setup
color 1F
cls
echo.
echo  ============================================================
echo   Acorn Group Performance Management System
echo   FIRST TIME SETUP
echo  ============================================================
echo.

REM ── Try to find Node.js in common install locations ─────────
REM First try the PATH
set NODE_EXE=node
node --version >nul 2>&1
IF %ERRORLEVEL% EQU 0 GOTO :node_found

REM Not in PATH - search common install folders
echo  Searching for Node.js on your computer...

IF EXIST "C:\Program Files\nodejs\node.exe" (
    set NODE_EXE="C:\Program Files\nodejs\node.exe"
    set NPM_EXE="C:\Program Files\nodejs\npm.cmd"
    GOTO :node_found
)
IF EXIST "C:\Program Files (x86)\nodejs\node.exe" (
    set NODE_EXE="C:\Program Files (x86)\nodejs\node.exe"
    set NPM_EXE="C:\Program Files (x86)\nodejs\npm.cmd"
    GOTO :node_found
)
IF EXIST "%APPDATA%\nvm\current\node.exe" (
    set NODE_EXE="%APPDATA%\nvm\current\node.exe"
    set NPM_EXE="%APPDATA%\nvm\current\npm.cmd"
    GOTO :node_found
)
IF EXIST "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set NODE_EXE="%LOCALAPPDATA%\Programs\nodejs\node.exe"
    set NPM_EXE="%LOCALAPPDATA%\Programs\nodejs\npm.cmd"
    GOTO :node_found
)

REM ── Node.js truly not found ─────────────────────────────────
color 4F
cls
echo.
echo  ============================================================
echo   Node.js WAS NOT FOUND on this computer
echo  ============================================================
echo.
echo  Even though you may have downloaded it, it seems the
echo  installation did not complete correctly.
echo.
echo  Please do the following:
echo.
echo  1. Open your browser and go to:  https://nodejs.org
echo  2. Click the download button (any version is fine)
echo  3. Run the downloaded .msi file
echo  4. On the installer, make sure to check the box that says:
echo     "Add to PATH"  or  "Automatically install tools"
echo  5. Click through all steps and FINISH the install
echo  6. RESTART your computer
echo  7. Then double-click SETUP-FIRST-TIME.bat again
echo.
echo  ============================================================
echo.
pause
exit /b 1

:node_found
REM ── Node.js found ─────────────────────────────────────────
echo  [OK] Node.js found!
%NODE_EXE% --version
echo.

REM ── Add nodejs folder to PATH for this session ─────────────
IF EXIST "C:\Program Files\nodejs" (
    SET PATH=C:\Program Files\nodejs;%PATH%
)
IF EXIST "C:\Program Files (x86)\nodejs" (
    SET PATH=C:\Program Files (x86)\nodejs;%PATH%
)

echo  ============================================================
echo  Step 1 of 2:  Installing packages...
echo  (Needs internet - takes 1 to 3 minutes, please wait)
echo  ============================================================
echo.

REM Try npm from PATH first, then full path
npm --version >nul 2>&1
IF %ERRORLEVEL% EQU 0 (
    call npm install
) ELSE IF DEFINED NPM_EXE (
    call %NPM_EXE% install
) ELSE (
    call "C:\Program Files\nodejs\npm.cmd" install
)

IF %ERRORLEVEL% NEQ 0 (
    color 4F
    echo.
    echo  ERROR: Package installation failed.
    echo.
    echo  Make sure you have internet access and try again.
    echo  If you are on a company network, try turning off your VPN.
    echo.
    pause
    exit /b 1
)

echo.
echo  [OK] Packages installed successfully.
echo.
echo  ============================================================
echo  Step 2 of 2:  Setting up database (225 employees)...
echo  ============================================================
echo.

%NODE_EXE% scripts/setup-db.js
IF %ERRORLEVEL% NEQ 0 (
    color 4F
    echo.
    echo  ERROR: Database setup failed.
    echo  Please take a photo of this screen and share it for help.
    echo.
    pause
    exit /b 1
)

echo.
color 2F
echo  ============================================================
echo   SUCCESS!  Setup is complete.
echo  ============================================================
echo.
echo  Now double-click  START.bat  to launch the server.
echo.
echo  Then open your browser:  http://localhost:3000
echo.
echo  First HR login:
echo    Employee No:   20123
echo    Password:      Acorn@2025
echo.
echo  ============================================================
echo.
pause
