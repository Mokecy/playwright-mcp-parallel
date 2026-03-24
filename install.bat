@echo off
REM ── playwright-mcp-parallel installer ──
REM Run this script to install and set up the project.

echo [playwright-mcp-parallel] Installing dependencies...
cd /d %~dp0
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed
    exit /b 1
)

echo.
echo [playwright-mcp-parallel] Installing Chromium browser...
call npx playwright install chromium
if errorlevel 1 (
    echo [WARNING] Chromium install failed, you may need to install manually
)

echo.
echo ============================================
echo  Installation complete!
echo ============================================
echo.
echo Add this to your MCP client config:
echo.
echo   {
echo     "mcpServers": {
echo       "playwright-parallel": {
echo         "type": "stdio",
echo         "command": "node",
echo         "args": ["%~dp0cli.js"]
echo       }
echo     }
echo   }
echo.
echo Or with options:
echo   "args": ["%~dp0cli.js", "--browser", "chrome"]
echo.
