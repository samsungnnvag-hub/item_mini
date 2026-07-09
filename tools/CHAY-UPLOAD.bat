@echo off
chcp 65001 >nul
title Upload item → Supabase

cd /d "%~dp0supabase-upload"

where node >nul 2>&1
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Tai tai: https://nodejs.org
  pause
  exit /b 1
)

if not exist ".env" (
  echo [LOI] Chua co file .env
  echo Copy .env.example thanh .env roi dien SUPABASE_URL + SUPABASE_SERVICE_KEY
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Dang cai npm packages lan dau...
  call npm install
  if errorlevel 1 (
    echo [LOI] npm install that bai
    pause
    exit /b 1
  )
)

echo.
echo === Convert PNG -^> WebP + Upload len Supabase ===
echo.

call npm run upload

echo.
pause
