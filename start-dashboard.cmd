@echo off
setlocal

cd /d "%~dp0"

if not exist "output" mkdir "output"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/health' -Method Get -TimeoutSec 2; if ($response.ok) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo Codex Relay is already running.
  echo Local: http://127.0.0.1:3210
  echo LAN:   http://^<this-pc-ip^>:3210
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$workdir = (Resolve-Path '%~dp0').Path; " ^
  "$stdout = Join-Path $workdir 'output\server.log'; " ^
  "$stderr = Join-Path $workdir 'output\server.err.log'; " ^
  "Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $workdir -WindowStyle Minimized -RedirectStandardOutput $stdout -RedirectStandardError $stderr"
echo Codex Relay started in the background.
echo Local: http://127.0.0.1:3210
echo LAN:   http://^<this-pc-ip^>:3210
