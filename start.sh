#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo ""
echo "===================================="
echo "  3D 看房 快速启动"
echo "===================================="
echo ""

if ! command -v node &> /dev/null; then
  echo "[错误] 没有找到 Node.js，请先安装: https://nodejs.org/"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[安装依赖] 首次运行，正在安装 three.js..."
  npm install --no-audit --no-fund
  echo ""
fi

if [ ! -f "vendor/three/build/three.module.js" ]; then
  echo "[构建] 正在准备离线资源..."
  npm run vendor
  echo ""
fi

echo "[启动] 服务器即将在 http://localhost:5173/ 启动"
echo ""
echo "按 Ctrl+C 停止服务器"
echo ""
sleep 1

node serve.js
