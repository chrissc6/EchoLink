@echo off
setlocal
cd /d "%~dp0"
title EchoLink - Offline Kokoro Reader

if not exist "dist\index.html" (
  echo The offline app has not been built yet.
  echo Run setup.bat while connected, then launch EchoLink.cmd again.
  pause
  exit /b 1
)

:menu
cls
echo ========================================
echo  EchoLink - Offline Kokoro Reader
echo ========================================
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-control.ps1" -Action Status
echo.
if defined notice echo %notice%
set "notice="
echo [1] Start local only  (this computer)
echo [2] Start shared  (this computer + local network)
echo [3] Stop
echo [V] Verify app (offline smoke test)
echo [Q] Quit  (stops the server before exiting)
echo.
set "selection="
set /p "selection=Choose an action, or press Enter to refresh: "
if not defined selection goto menu
if /i "%selection%"=="1" goto startLocal
if /i "%selection%"=="2" goto startShared
if /i "%selection%"=="3" goto stopServer
if /i "%selection%"=="V" goto verifyApp
if /i "%selection%"=="Q" goto quitLauncher
set "notice=Choose 1, 2, 3, V, or Q."
goto menu

:startLocal
for /f "delims=" %%R in ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-control.ps1" -Action Start -Mode Local') do set "notice=%%R"
goto menu

:startShared
for /f "delims=" %%R in ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-control.ps1" -Action Start -Mode Shared') do set "notice=%%R"
goto menu

:stopServer
for /f "delims=" %%R in ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-control.ps1" -Action Stop') do set "notice=%%R"
goto menu

:verifyApp
call npm run verify
if errorlevel 1 (set "notice=Verification FAILED. Review the PASS/FAIL summary above.") else (set "notice=Verification passed. The local server was stopped after the check.")
pause
goto menu

:quitLauncher
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0server-control.ps1" -Action Stop
if errorlevel 1 (
  echo.
  echo The port was not released. Review the message above; unrelated processes are never terminated.
  pause
  goto menu
)
exit /b 0
