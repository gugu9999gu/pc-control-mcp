@echo off
setlocal
if "%~1"=="" (
  call "%~dp0MCP-Remote-Control-App.cmd"
  exit /b %ERRORLEVEL%
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1" %*
exit /b %ERRORLEVEL%
