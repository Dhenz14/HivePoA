@echo off
title Spirit Bomb — GPU Pool Coordinator
color 0A
cd /d "C:\Users\theyc\Hive AI\HivePoA"

echo.
echo  ======================================
echo   Spirit Bomb — Starting All Services
echo  ======================================
echo.

:: Step 1: Ensure PostgreSQL is running
echo [1/5] Checking PostgreSQL...
sc query postgresql-x64-12 | find "RUNNING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       Starting PostgreSQL...
    net start postgresql-x64-12 >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo       ERROR: Could not start PostgreSQL. Try running as admin.
        pause
        exit /b 1
    )
)
echo       PostgreSQL: OK

:: Step 2: Start Docker Desktop (if not running)
echo [2/5] Checking Docker...
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo       Waiting for Docker (30s)...
    timeout /t 30 /nobreak >nul
)
docker info >nul 2>&1 && echo       Docker: OK || echo       Docker: NOT AVAILABLE (GPU clustering disabled)

:: Step 3: Kill stale processes from previous runs
echo [3/5] Cleaning up stale processes...

:: Kill anything on port 5000 (old HivePoA)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5000 " ^| findstr "LISTEN"') do (
    echo       Killing stale HivePoA on PID %%a
    taskkill /PID %%a /F >nul 2>&1
)

:: Kill anything on port 8080 (old llama-server)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080 " ^| findstr "LISTEN"') do (
    echo       Killing stale llama-server on PID %%a
    taskkill /PID %%a /F >nul 2>&1
)

:: Kill orphaned tsx/node processes from previous HivePoA runs
:: (only kills node processes with "tsx" or "server/index" in command line)
for /f "tokens=2" %%a in ('wmic process where "name='node.exe' and commandline like '%%tsx%%server%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    echo       Killing orphaned tsx process PID %%a
    taskkill /PID %%a /F >nul 2>&1
)

echo       Ports 5000, 8080: CLEAR

:: Step 4: Start HivePoA
echo [4/5] Starting HivePoA...
echo.

set "DATABASE_URL=postgresql://postgres@localhost:5432/hivepoa"
set "HIVE_AI_URL=http://localhost:5001"
set "NODE_ENV=production"
set "PORT=5000"

echo  ======================================
echo   Spirit Bomb is LIVE
echo  ======================================
echo.
echo   HivePoA:    http://localhost:5000
echo   Hive-AI:    %HIVE_AI_URL%
echo   Database:   PostgreSQL (hivepoa)
echo   Pool:       /api/gpu/pool
echo   Inference:  /api/gpu/inference
echo.
echo   Dashboard:  http://localhost:5000/community-cloud
echo.
echo  ======================================
echo.

:: Step 5: Verify clean state before launch
echo [5/5] Verifying clean state...
netstat -ano | findstr ":5000 " | findstr "LISTEN" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo       ERROR: Port 5000 still occupied after cleanup!
    pause
    exit /b 1
)
echo       Clean state verified
echo.

call npx tsx server/index.ts

echo.
echo === Server exited with code %ERRORLEVEL% ===
echo Press any key to close.
pause >nul
