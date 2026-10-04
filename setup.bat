@echo off
cd /d "%~dp0"
echo Downloading the local browser dependencies and building EchoLink...
npm install
if errorlevel 1 exit /b 1
npm run build
if errorlevel 1 exit /b 1
echo.
echo Setup complete. You can now disconnect from the internet and run "EchoLink.cmd".
pause
