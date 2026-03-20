@echo off
title HivePoA Server (Spirit Bomb)
cd /d "C:\Users\theyc\Hive AI\HivePoA"
set "DATABASE_URL=postgresql://postgres@localhost:5432/hivepoa"
set "HIVE_AI_URL=http://localhost:5001"
set "NODE_ENV=production"
set "PORT=5050"
echo.
echo  === HivePoA Server (Spirit Bomb) ===
echo  Port: %PORT%
echo  Hive-AI: %HIVE_AI_URL%
echo  Database: PostgreSQL (hivepoa)
echo.
echo Starting npx tsx...
call npx tsx server/index.ts
echo.
echo === Server exited with code %ERRORLEVEL% ===
echo Press any key to close.
pause >nul
