@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing the Electron launcher dependencies for the first run...
  call npm.cmd install
  if errorlevel 1 (
    echo Electron dependency installation failed.
    pause
    exit /b 1
  )
)
call npm.cmd run app
if errorlevel 1 pause
