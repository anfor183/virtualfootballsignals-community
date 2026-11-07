@echo off
TITLE Bot Launcher

:: Define temporary file to track last update check
set "update_file=%TEMP%\bot_last_update.txt"

:: Use PowerShell to check if 7 days have passed since the last update
powershell -NoProfile -Command "$file='%update_file%'; if (Test-Path $file) { $lastWrite=(Get-Item $file).LastWriteTime; if ((Get-Date) - $lastWrite -lt (New-TimeSpan -Days 7)) { exit 1 } }; New-Item -ItemType File -Force -Path $file | Out-Null; exit 0"

if %errorLevel% == 0 (
    echo ========================================
    echo      WEEKLY DEPENDENCY UPDATER
    echo ========================================
    echo Checking for core bot updates...
    call npm update --silent
    
    echo Checking for dashboard updates...
    cd dashboard
    call npm update --silent
    cd ..
    
    echo Dependencies updated successfully!
    echo ========================================
    timeout /t 2 >nul
)

cd dashboard
npm run dev
