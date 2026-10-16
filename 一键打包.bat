@echo off
chcp 65001 >nul
title DeepSeek Harness 桌面端 - 一键自动化打包发布
cd /d "%~dp0"

echo ========================================================
echo   DeepSeek Harness 桌面端 - 一键打包流水线
echo   (将全自动构建 Windows 安装程序 Setup.exe 与便携免安装版 Portable.exe)
echo ========================================================
echo.

if not exist "node_modules\" (
    echo [1/3] 正在通过国内淘宝镜像安装依赖...
    call npm install --registry=https://registry.npmmirror.com
)

echo [2/3] 正在打包前置运行时环境与出厂插件...
call npm run runtime:prepare

echo [3/3] 正在生成 Windows 目标产物 (NSIS 安装包 + 便携免安装版)...
call npx electron-builder --win

echo.
echo ========================================================
echo   [OK] 打包完成！生成文件位于 dist/ 目录：
echo ========================================================
if exist "dist\" dir /b dist\*.exe
echo.
pause
