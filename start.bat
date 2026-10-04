@echo off
chcp 65001 >nul
echo.
echo ====================================
echo   3D 看房 快速启动
echo ====================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [安装依赖] 首次运行，正在安装 three.js...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
  echo.
)

if not exist "vendor\three\build\three.module.js" (
  echo [构建] 正在准备离线资源...
  call npm run vendor
  echo.
)

echo [启动] 服务器即将在 http://localhost:5173/ 启动
echo.
echo 按 Ctrl+C 停止服务器
echo.
timeout /t 2 >nul

node serve.js
