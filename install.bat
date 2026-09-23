@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   AILEEN - 一键安装并启动（源码版）
echo ============================================
if not exist node_modules (
  echo [1/2] 正在安装依赖，请耐心等待...
  call npm.cmd install
)
echo [2/2] 启动应用...
call npm.cmd start
pause
