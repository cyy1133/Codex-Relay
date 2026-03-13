@echo off
setlocal

set "TARGET_FILE=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Codex Relay.cmd"

if exist "%TARGET_FILE%" (
  del "%TARGET_FILE%"
  echo Startup entry removed.
) else (
  echo Startup entry is not installed.
)
