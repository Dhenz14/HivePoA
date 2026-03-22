@echo off
setlocal enabledelayedexpansion
title Spirit Bomb — GPU Pool Coordinator
color 0A
cd /d "C:\Users\theyc\Hive AI\HivePoA"

echo.
echo  ======================================
echo   Spirit Bomb — Starting All Services
echo  ======================================
echo.

:: Step 1: Ensure PostgreSQL is running
echo [1/6] Checking PostgreSQL...
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
echo [2/6] Checking Docker...
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo       Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo       Waiting for Docker (30s)...
    timeout /t 30 /nobreak >nul
)
docker info >nul 2>&1 && echo       Docker: OK || echo       Docker: NOT AVAILABLE (GPU clustering disabled)

:: Step 3: Kill stale processes and VRAM thieves
echo [3/6] Cleaning up stale processes...

:: Kill known VRAM thieves that auto-start on Windows
for %%p in (ollama.exe "ollama app.exe" llama-server.exe) do (
    tasklist /FI "IMAGENAME eq %%~p" 2>nul | findstr /i "%%~p" >nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        echo       Killing VRAM thief: %%~p
        taskkill /IM "%%~p" /F >nul 2>&1
    )
)

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
for /f "tokens=2" %%a in ('wmic process where "name='node.exe' and commandline like '%%tsx%%server%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    echo       Killing orphaned tsx process PID %%a
    taskkill /PID %%a /F >nul 2>&1
)

echo       Ports 5000, 8080: CLEAR

:: Step 4: VRAM sanity check — warn if something is eating GPU memory
echo [4/6] Checking GPU VRAM...
for /f "usebackq tokens=*" %%a in (`nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2^>nul`) do (
    set "VRAM_USED=%%a"
)
if defined VRAM_USED (
    if !VRAM_USED! GTR 4000 (
        echo       WARNING: !VRAM_USED! MiB VRAM already in use before startup!
        echo       Something is eating GPU memory. Check nvidia-smi for culprits.
        echo       Common thieves: Ollama, old llama-server, Docker containers
        echo.
        nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader 2>nul
        echo.
        echo       Press any key to continue anyway, or Ctrl+C to abort...
        pause >nul
    ) else (
        echo       GPU VRAM: !VRAM_USED! MiB used (clean)
    )
) else (
    echo       nvidia-smi not found — skipping VRAM check
)

:: Step 5: Start HivePoA
echo [5/6] Starting HivePoA...
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

:: Step 6: Verify clean state before launch
echo [6/6] Verifying clean state...
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
