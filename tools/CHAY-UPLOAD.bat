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
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo [OK] Da tao file .env tu .env.example
  ) else (
    echo [LOI] Thieu ca .env va .env.example
    pause
    exit /b 1
  )
)

findstr /c:"YOUR_PROJECT" /c:"eyJhbGciOi..." ".env" >nul
if not errorlevel 1 (
  echo [LOI] Chua dien thong tin Supabase trong file .env
  echo Mo file: %cd%\.env
  echo Dien SUPABASE_URL + SUPABASE_SERVICE_KEY ^(service_role, khong dung anon^)
  echo.
  notepad ".env"
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
