#!/usr/bin/env bash
# Разработка интерфейса в обычном браузере (Linux/macOS): ядро в режиме --dev и Vite с тем же токеном.
# Оболочка Tauri здесь не участвует: нет трея, глобальных горячих клавиш и аварийного стопа.
# Порт ядра можно сменить: JARVIS_DEV_PORT=8766 scripts/dev-browser.sh
# Остановка — Ctrl+C: скрипт завершит и ядро, и Vite.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${JARVIS_DEV_PORT:-8765}"
ready_timeout_s=30

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Не найден $1. $2" >&2
    exit 1
  fi
}
require uv "Установите: https://docs.astral.sh/uv/getting-started/installation/"
require npm "Установите Node.js 22 LTS: https://nodejs.org/"

# Свой случайный токен, а не сгенерированный ядром: его нужно заранее передать и ядру, и Vite.
token="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-dev.XXXXXX")"
core_stdout="$work_dir/core-stdout.jsonl"
core_pid=""
: >"$core_stdout"

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$core_pid" ]] && kill -0 "$core_pid" 2>/dev/null; then
    # Фоновые процессы неинтерактивного bash не получают Ctrl+C — останавливаем ядро сами.
    kill -TERM "$core_pid" 2>/dev/null || true
    wait "$core_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> Зависимости ядра (uv sync)"
(cd "$repo_root/core" && uv sync)

echo "==> Запуск ядра на порту $port"
# stdout ядра — канал JSON Lines (ready, fatal); логи идут в stderr, то есть в этот терминал.
JARVIS_IPC_TOKEN="$token" uv run --project "$repo_root/core" \
  python -m jarvis --dev --no-stdin --port "$port" >"$core_stdout" &
core_pid=$!

if [[ ! -d "$repo_root/ui/node_modules" ]]; then
  echo "==> Зависимости интерфейса (npm ci)"
  (cd "$repo_root/ui" && npm ci)
fi

waited_ticks=0
until grep -q '"type":"ready"' "$core_stdout"; do
  if ! kill -0 "$core_pid" 2>/dev/null; then
    code=0
    wait "$core_pid" || code=$?
    core_pid=""
    echo "Ядро завершилось с кодом $code, не успев запуститься — причина в журнале выше." >&2
    if [[ "$code" -eq 4 ]]; then
      echo "Порт $port занят. Укажите другой: JARVIS_DEV_PORT=8766 $0" >&2
    fi
    exit 1
  fi
  if ((waited_ticks >= ready_timeout_s * 5)); then
    echo "Ядро не сообщило о готовности за $ready_timeout_s с." >&2
    exit 1
  fi
  sleep 0.2
  waited_ticks=$((waited_ticks + 1))
done

echo
echo "==> Ядро готово. Откройте интерфейс: http://127.0.0.1:1420/"
echo "    Порт и токен ядра уже переданы Vite, добавлять их в адрес не нужно."
echo

cd "$repo_root/ui"
VITE_CORE_PORT="$port" VITE_CORE_TOKEN="$token" npm run dev
