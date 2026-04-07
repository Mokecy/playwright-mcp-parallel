@echo off
REM ============================================
REM  playwright-mcp-parallel 发布脚本
REM  用法: release.bat [patch|minor|major]
REM  发布由 GitHub Actions 自动完成
REM ============================================

setlocal

set VERSION_TYPE=%1
if "%VERSION_TYPE%"=="" set VERSION_TYPE=patch

echo.
echo ========================================
echo  playwright-mcp-parallel Release
echo  Version bump: %VERSION_TYPE%
echo ========================================
echo.

REM 检查工作区是否干净
git diff --quiet 2>nul
if errorlevel 1 (
    echo [!] 有未提交的修改，先提交...
    git add -A
    set /p COMMIT_MSG="请输入 commit message: "
    git commit -m "%COMMIT_MSG%"
    if errorlevel 1 (
        echo [ERROR] git commit 失败
        exit /b 1
    )
)

REM 升版本号
echo [1/3] 升级版本号 (%VERSION_TYPE%)...
call npm version %VERSION_TYPE% --no-git-tag-version
if errorlevel 1 (
    echo [ERROR] npm version 失败
    exit /b 1
)

REM 读取新版本号
for /f "tokens=*" %%i in ('node -e "console.log(require('./package.json').version)"') do set NEW_VERSION=%%i
echo       新版本: v%NEW_VERSION%

REM Git 提交 + Tag
echo [2/3] Git 提交并打 Tag...
git add -A
git commit -m "release: v%NEW_VERSION%"
git tag -a "v%NEW_VERSION%" -m "Release v%NEW_VERSION%"
if errorlevel 1 (
    echo [ERROR] git tag 失败
    exit /b 1
)

REM 推送到 GitHub（CI 自动发布到 npm）
echo [3/3] 推送到 GitHub，触发 CI 自动发布...
git push
git push --tags
if errorlevel 1 (
    echo [ERROR] git push 失败
    exit /b 1
)

echo.
echo ========================================
echo  推送成功! v%NEW_VERSION%
echo  GitHub Actions 正在自动发布到 npm...
echo ========================================
echo.
echo  查看进度: https://github.com/Mokecy/playwright-mcp-parallel/actions
echo  发布后:   https://www.npmjs.com/package/playwright-mcp-parallel
echo  使用:     npx playwright-mcp-parallel@latest
echo.

endlocal