@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto failed

echo Close Autoposter before updating.
echo Downloading updates from GitHub...
git pull --ff-only
if errorlevel 1 goto failed

echo Installing dependencies...
call npm ci
if errorlevel 1 goto failed

echo Starting Autoposter...
call npm start
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Update or startup failed. Read the error above before trying again.
pause
exit /b 1
