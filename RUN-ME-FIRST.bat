@echo off
title Acorn Group PMS - Setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location '%~dp0'; & '%~dp0SETUP-FIRST-TIME.ps1'"
pause
