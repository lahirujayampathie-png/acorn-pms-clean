@echo off
title Acorn PMS - Diagnostic
echo.
echo Running diagnostic - please wait...
echo.
echo === Node.js check ===
where node 2>nul
node --version 2>nul
echo.
echo === npm check ===
where npm 2>nul
npm --version 2>nul
echo.
echo === Looking in Program Files ===
dir "C:\Program Files\nodejs\node.exe" 2>nul
dir "C:\Program Files (x86)\nodejs\node.exe" 2>nul
echo.
echo === PATH variable ===
echo %PATH%
echo.
echo === Done ===
echo.
pause
