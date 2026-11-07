@echo off
title VFL Bot - Sync PC and VPS
cd /d "%~dp0puppeteer-app"
powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\vps-sync.ps1"
pause
