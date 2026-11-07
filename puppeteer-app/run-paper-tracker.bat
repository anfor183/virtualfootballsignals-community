@echo off
title HT Draw Paper Trading Tracker
cd /d "%~dp0"
echo ========================================================
echo  HT Draw 6-hour cycle - PAPER trading tracker (no money)
echo  Report: reports\htdraw_paper_report.html (auto-refresh)
echo ========================================================
start "" "%~dp0reports\htdraw_paper_report.html"
node utils\paper_trader_htdraw.js --watch
pause
