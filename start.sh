#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "错误：未找到 pnpm，请先安装 pnpm 11。" >&2
  exit 1
fi

if [[ ! -d node_modules/.pnpm ]]; then
  echo "首次启动，正在安装依赖..."
  pnpm install --frozen-lockfile
fi

echo "AI 情报工作台启动中..."
echo "前端地址：http://127.0.0.1:5173"
echo "后端健康检查：http://127.0.0.1:3000/api/system/health"

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

pnpm --filter @ai-intelligence/server exec node --import tsx src/main.ts &
pids+=("$!")
pnpm --filter @ai-intelligence/web exec vite --host 127.0.0.1 &
pids+=("$!")

wait "${pids[@]}"
