@echo off
TITLE Bot Auto-Installer Wizard

:: Check for admin privileges (required to install Node.js globally if missing)
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :RunScript
) else (
    echo Requesting Administrator privileges to install requirements...
    powershell -Command "Start-Process -FilePath '%~dpnx0' -Verb RunAs"
    exit /b
)

:RunScript
:: Ensure we are in the exact directory of this script, even when elevated
cd /d "%~dp0"

echo Launching PowerShell Setup Script...
powershell -NoProfile -ExecutionPolicy Bypass -File "setup_requirements.ps1"
