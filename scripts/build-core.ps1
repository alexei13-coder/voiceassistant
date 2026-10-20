#Requires -Version 5.1
<#
.SYNOPSIS
    Сборка ядра PyInstaller (onedir) в core\dist\jarvis-core\ — этот же скрипт запускает CI.
.DESCRIPTION
    Сборка консольная (не --noconsole): оболочка общается с ядром через stdin/stdout,
    а окна консоли пользователь не видит, потому что оболочка запускает ядро без окна.
    Результат — core\dist\jarvis-core\jarvis-core.exe и папка _internal рядом с ним;
    установщик кладёт их в <ресурсы приложения>\core\.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-core.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib/common.ps1')

# Понятное сообщение вместо трассировки PowerShell: скрипт запускают и двойным щелчком.
trap {
    Write-Host ''
    Write-Host "Ошибка: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Assert-Tool ([ordered]@{ uv = 'https://docs.astral.sh/uv/getting-started/installation/ (или: winget install --id astral-sh.uv -e)' })

$coreDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'core'
Push-Location $coreDir
try {
    # --locked: сборка строго по зафиксированному uv.lock.
    Write-Step 'Зависимости ядра (uv sync --locked)'
    Invoke-Native uv @('sync', '--locked')

    # spec-файл и промежуточные файлы — в core\build\ (в .gitignore), чтобы не засорять репозиторий.
    # «X utf8» — режим UTF-8 Python: собранный интерпретатор игнорирует переменные PYTHON*
    # (PYTHONUTF8=1 от оболочки на него не действует), а без этого режима stdout в канале —
    # в кодировке ANSI, и русский текст (например, справка --help) падает с UnicodeEncodeError.
    Write-Step 'Сборка PyInstaller'
    Invoke-Native uv @(
        'run', '--locked', 'pyinstaller', '--noconfirm', '--clean', '--onedir', '--console',
        '--python-option', 'X utf8',
        '--name', 'jarvis-core', '--contents-directory', '_internal',
        '--distpath', 'dist', '--workpath', 'build/pyinstaller', '--specpath', 'build',
        'jarvis_entry.py'
    )
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host "Готово: $([IO.Path]::Combine($coreDir, 'dist', 'jarvis-core'))" -ForegroundColor Green
