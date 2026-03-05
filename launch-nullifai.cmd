@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: ── Paths ──────────────────────────────────────────────────────────────
set "NULLCLAW_EXE=C:\Tools\nullclaw\2026.3.4\nullclaw.exe"
set "BRIDGE=%~dp0nullifai-bridge.js"
set "HIDDEN=%~dp0launch-hidden.vbs"
set "PROJECT_DIR=%~dp0"

:: ── Verify prerequisites ──────────────────────────────────────────────
if not exist "%NULLCLAW_EXE%" (
    echo [ERROR] nullclaw binary not found at: %NULLCLAW_EXE%
    pause
    exit /b 1
)
if not exist "%BRIDGE%" (
    echo [ERROR] Bridge not found at: %BRIDGE%
    pause
    exit /b 1
)
where node >nul 2>&1
if %errorlevel% NEQ 0 (
    echo [ERROR] Node.js not found in PATH
    pause
    exit /b 1
)

:: ── Check if bridge is already running ──────────────────────────────
powershell -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1',4173); $c.Close(); exit 0 } catch { exit 1 }" 2>nul
if %errorlevel%==0 (
    echo nullifAi is already running. Opening browser...
    start "" "http://127.0.0.1:4173"
    exit /b 0
)

:: ── Start the bridge (hidden, no terminal window) ───────────────────
echo Starting nullifAi bridge...
cscript //nologo "%HIDDEN%"

:: ── Wait for bridge to be ready ─────────────────────────────────────
set RETRIES=0
:wait_loop
timeout /t 1 >nul
set /a RETRIES+=1
powershell -Command "try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1',4173); $c.Close(); exit 0 } catch { exit 1 }" 2>nul
if %errorlevel%==0 goto bridge_ready
if %RETRIES% GEQ 10 (
    echo [WARN] Bridge not responding after 10s, opening browser anyway...
    goto open_browser
)
goto wait_loop

:bridge_ready
echo Bridge is ready.

:: ── Open browser ────────────────────────────────────────────────────
:open_browser
timeout /t 1 >nul
start "" "http://127.0.0.1:4173"
echo nullifAi is running. You can close this window.
