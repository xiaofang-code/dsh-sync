@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 没找到 Node.js
  echo.
  echo   DSH 自带了一个 Node，但不在 PATH 里。
  echo   请先安装 Node.js 22 或更新版本：https://nodejs.org/
  echo   或者把下面这个目录加到 PATH：
  echo     "%%LOCALAPPDATA%%\Programs\DeepSeek Harness\resources\app\dsh\node"
  echo.
  pause
  exit /b 1
)

node "%~dp0dsh-sync.mjs" %*
if errorlevel 1 pause
