@echo off
chcp 65001 >nul
title Xem truoc upload (dry-run)

cd /d "%~dp0supabase-upload"

where node >nul 2>&1
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Tai tai: https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" call npm install

echo.
echo === Xem truoc - KHONG upload, KHONG xoa PNG ===
echo.

call npm run upload:dry

echo.
pause
