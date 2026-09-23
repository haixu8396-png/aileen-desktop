@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   AILEEN - 一键打包安装包
echo ============================================
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
if not exist node_modules (
  echo 正在安装依赖...
  call npm.cmd install
)
echo 正在打包，输出到 release\ 目录...
call npm.cmd run dist
echo.
echo 完成！安装包在 release\ 目录。
pause
