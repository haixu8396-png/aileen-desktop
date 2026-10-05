@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  AILEEN - 把当前源码同步到已安装版
echo ============================================
echo.
echo 更新前请先关掉 AILEEN（文件被占用会写不进去）。
echo.
pause
node scripts\sync-installed.mjs
echo.
pause
