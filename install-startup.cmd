@echo off
setlocal

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_FILE=%STARTUP_DIR%\Codex Relay.cmd"

if not exist "%STARTUP_DIR%" (
  echo Startup folder was not found.
  exit /b 1
)

> "%TARGET_FILE%" echo @echo off
>> "%TARGET_FILE%" echo call "%~dp0start-dashboard.cmd"

echo Startup entry created.
echo File: "%TARGET_FILE%"
