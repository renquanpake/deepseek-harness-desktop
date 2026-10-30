@echo off
chcp 65001 >nul
title DeepSeek Harness 一键部署
set "REPO=https://github.com/renquanpake/deepseek-harness-desktop.git"
set "DEFAULT_DIR=%USERPROFILE%\DeepSeek-Harness"
set "NPM_REGISTRY=https://registry.npmmirror.com"

echo ========================================================
echo   DeepSeek Harness 一键部署
echo   选择目录 - 自动拉取 - 安装依赖 - 准备内核 - 启动
echo ========================================================
echo.

set "TARGET=%~1"
if "%TARGET%"=="" set /p "TARGET=请输入部署目录（直接回车使用 %DEFAULT_DIR%）: "
if "%TARGET%"=="" set "TARGET=%DEFAULT_DIR%"
set TARGET=%TARGET:"=%

echo.
echo [目标目录] %TARGET%
echo.

where git >nul 2>nul
if errorlevel 1 goto :no_git
where node >nul 2>nul
if errorlevel 1 goto :no_node

for /f "tokens=1 delims=." %%v in ('node -v') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if not defined NODE_MAJOR goto :no_node
if %NODE_MAJOR% LSS 18 goto :old_node

echo [1/4] 检查代码目录...
if exist "%TARGET%\.git" (
    echo       检测到已有部署，执行 git pull 更新...
    git -C "%TARGET%" pull --ff-only
    if errorlevel 1 goto :pull_failed
) else (
    set "HAS_FILES="
    if exist "%TARGET%" for /f "delims=" %%f in ('dir /b "%TARGET%" 2^>nul') do set "HAS_FILES=1"
    if defined HAS_FILES goto :dir_not_empty
    echo       正在克隆仓库到目标目录...
    git clone "%REPO%" "%TARGET%"
    if errorlevel 1 goto :clone_failed
)

cd /d "%TARGET%"
if errorlevel 1 goto :cd_failed

echo.
echo [2/4] 安装依赖（国内镜像，首次较慢）...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if exist "package-lock.json" (
    call npm ci --no-audit --no-fund --registry=%NPM_REGISTRY%
) else (
    call npm install --no-audit --no-fund --registry=%NPM_REGISTRY%
)
if errorlevel 1 goto :install_failed

echo.
echo [3/4] 准备内置内核与预置插件（需要联网，数分钟）...
if exist "dsh-runtime\node_modules\@deepseek-ai\dsh" (
    echo       已存在内置内核，跳过。
) else (
    call npm run runtime:prepare
    if errorlevel 1 goto :runtime_failed
)
echo       校验内核与外壳的兼容性...
node scripts/check-runtime-compat.js
if errorlevel 1 goto :runtime_incompatible

echo.
echo [4/4] 部署完成。
echo       之后可随时双击本目录下的「一键启动.bat」启动，
echo       更新时重新运行本脚本即可自动 git pull 并同步依赖与内核。
echo.
set "START_NOW=Y"
set /p "START_NOW=现在启动吗？(Y/N，默认 Y): "
if /i "%START_NOW%"=="N" goto :done
call npm start
goto :done

:done
echo.
echo 部署目录: %TARGET%
pause
exit /b 0

:no_git
echo [缺少] 未检测到 Git。
where winget >nul 2>nul
if errorlevel 1 goto :no_git_manual
set "INSTALL_GIT="
set /p "INSTALL_GIT=是否用 winget 自动安装 Git？(Y/N): "
if /i not "%INSTALL_GIT%"=="Y" goto :no_git_manual
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
echo [提示] Git 安装结束后，请关闭此窗口并重新双击本脚本。
goto :fail
:no_git_manual
echo [错误] 请手动安装 Git for Windows: https://git-scm.com/download/win
goto :fail
:no_node
echo [缺少] 未检测到 Node.js。
where winget >nul 2>nul
if errorlevel 1 goto :no_node_manual
set "INSTALL_NODE="
set /p "INSTALL_NODE=是否用 winget 自动安装 Node.js LTS？(Y/N): "
if /i not "%INSTALL_NODE%"=="Y" goto :no_node_manual
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
echo [提示] Node.js 安装结束后，请关闭此窗口并重新双击本脚本。
goto :fail
:no_node_manual
echo [错误] 请手动安装 Node.js 22 或更高版本: https://nodejs.org
goto :fail
:old_node
echo [错误] Node.js 版本过低（当前主版本 %NODE_MAJOR%），需要 18 及以上，推荐 22。
goto :fail
:dir_not_empty
echo [错误] 目标目录已存在且不为空，为避免覆盖已中止: %TARGET%
echo        请换一个目录，或先清理该目录后重试。
goto :fail
:clone_failed
echo [错误] 克隆仓库失败，请检查网络或代理设置。
goto :fail
:pull_failed
echo [错误] 更新代码失败，请先处理该目录内的本地改动后重试。
goto :fail
:cd_failed
echo [错误] 无法进入目录: %TARGET%
goto :fail
:install_failed
echo [错误] 依赖安装失败，请检查网络或 npm 镜像配置。
goto :fail
:runtime_failed
echo [错误] 内置内核准备失败，请检查网络后重新运行本脚本。
goto :fail
:runtime_incompatible
echo [错误] 下载到的 DSH 内核超出外壳已验证的版本范围，已停止部署。
echo        请先更新外壳代码，或固定 DSH_VERSION 后重试。
goto :fail

:fail
echo.
echo 部署未完成，可修正问题后重新双击本脚本，已下载的内容会被复用。
pause
exit /b 1
