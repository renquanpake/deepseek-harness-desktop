@echo off
chcp 65001 >nul
title DeepSeek Harness 轻量版
cd /d "%~dp0"

if not exist "dsh-runtime\node_modules\@deepseek-ai\dsh" (
    echo [错误] 未找到内置内核，请先运行一键部署.bat。
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo [错误] 未找到 Electron，请先运行一键部署.bat。
    pause
    exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" lite\main.js
exit /b 0
