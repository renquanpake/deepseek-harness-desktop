@echo off
chcp 65001 >nul
title DeepSeek Harness - 一键环境安装与打包
cd /d "%~dp0"

echo ========================================================
echo   DeepSeek Harness 桌面端 - 一键全自动部署与打包向导
echo ========================================================
echo.
echo [说明] 本脚本将全自动完成所有步骤：
echo        1. 环境检测与全链路高速国内镜像配置 (npm/Electron/NSIS)
echo        2. 依赖自动下载与内核初始化
echo        3. 自动生成 Windows 极简一键安装包 (.exe)
echo        4. 自动弹出安装包目录，可一键直接安装
echo.
echo --------------------------------------------------------

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [提示] 系统未检测到全局 Node.js 环境。
    if exist "dsh-runtime\node.exe" (
        echo [OK] 检测到内置独立 Node.exe，已自动激活局部环境。
        set "PATH=%~dp0dsh-runtime;%PATH%"
    ) else (
        echo [错误] 需要 Node.js (>= 18) 来运行构建。
        echo 正在为您打开官方下载页面，请安装后重新双击本脚本：
        start https://nodejs.org/zh-cn/download
        pause
        exit /b 1
    )
)

echo.
echo [1/4] 正在配置全链路国内高速镜像源 (npmmirror 淘宝源)...
call npm config set registry https://registry.npmmirror.com
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo.
echo [2/4] 正在全自动安装项目与构建依赖 (通过国内源高速下载)...
call npm install --registry=https://registry.npmmirror.com
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败，请检查网络连接后重试。
    pause
    exit /b 1
)

echo.
echo [3/4] 正在预置出厂内核与 Windows 兼容性补丁...
call npm run runtime:prepare
if %errorlevel% neq 0 (
    echo [错误] 运行时内核准备失败。
    pause
    exit /b 1
)

echo.
echo [4/4] 正在全自动生成 Windows 极简一键安装包 (Setup.exe)...
call npx electron-builder --win
if %errorlevel% neq 0 (
    echo [错误] 打包生成失败。
    pause
    exit /b 1
)

echo.
echo ========================================================
echo  【大功告成】Windows 一键安装包已在 dist/ 目录下生成完毕！
echo ========================================================
echo.
if exist "dist\" (
    dir /b dist\*.exe
    echo.
    echo 正在自动为您打开输出文件夹...
    start "" explorer "%~dp0dist"
)

echo.
set /p run_now="是否立即启动刚生成的安装包进行一键安装？(Y/N，默认 Y): "
if /i "%run_now%"=="" set run_now=Y
if /i "%run_now%"=="Y" (
    for %%f in (dist\*Setup*.exe) do (
        echo 正在为您启动安装程序 %%f ...
        start "" "%%f"
        goto :done
    )
)

:done
echo.
echo 流程已全部搞定，祝使用愉快！
timeout /t 5 >nul
exit /b 0
