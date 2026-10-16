@echo off
chcp 65001 >nul
title DeepSeek Harness 桌面端 - 一键极速启动向导
cd /d "%~dp0"

echo ========================================================
echo   DeepSeek Harness 桌面端 - 极速启动向导
echo ========================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [提示] 检测到系统环境中未找到全局 Node.js。
    echo 正在检查是否包含内置运行时...
    if exist "dsh-runtime\node.exe" (
        echo [OK] 发现内置独立 Node.exe，无需配置任何环境变量，直接拉起！
    ) else (
        echo [错误] 源码开发模式需要 Node.js (>= 18)。
        echo 请先前往 https://nodejs.org 下载安装 Node.js 后重新双击本脚本。
        echo （若直接运行打包后的 Setup 安装包或免安装便携版，则完全无需安装 Node.js）。
        pause
        exit /b 1
    )
)

if not exist "node_modules\" (
    echo [1/3] 正在通过国内高速镜像安装依赖 (仅首次运行需要)...
    call npm install --registry=https://registry.npmmirror.com
)

if not exist "dsh-runtime\node_modules\@deepseek-ai\dsh\" (
    echo [2/3] 正在自动初始化出厂内核与预置工作台组件...
    call npm run runtime:prepare
)

echo [3/3] 启动桌面客户端...
call npm start
