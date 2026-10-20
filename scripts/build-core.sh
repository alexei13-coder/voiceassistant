#!/usr/bin/env bash
# Сборка ядра PyInstaller (onedir) в core/dist/jarvis-core/ — те же параметры, что в scripts/build-core.ps1 и CI.
# На Linux/macOS получается бинарник для проверки сборки; установщик для Windows собирает только CI.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v uv >/dev/null 2>&1; then
  echo "Не найден uv. Установите: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

cd "$repo_root/core"
# --locked: сборка строго по зафиксированному uv.lock, как в CI.
uv sync --locked
# spec-файл и промежуточные файлы — в core/build/ (в .gitignore), чтобы не засорять репозиторий.
uv run --locked pyinstaller --noconfirm --clean --onedir --console \
  --name jarvis-core --contents-directory _internal \
  --distpath dist --workpath build/pyinstaller --specpath build \
  jarvis_entry.py

echo "Готово: $repo_root/core/dist/jarvis-core/"
