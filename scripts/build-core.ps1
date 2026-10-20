#Requires -Version 5.1
<#
.SYNOPSIS
    Сборка ядра PyInstaller (onedir) в core\dist\jarvis-core\ — те же параметры, что в CI.
.DESCRIPTION
    Сборка консольная (не --noconsole): оболочка общается с ядром через stdin/stdout,
    а окна консоли пользователь не видит, потому что оболочка запускает ядро без окна.
    Результат — core\dist\jarvis-core\jarvis-core.exe и папка _internal рядом с ним;
    установщик кладёт их в <ресурсы приложения>\core\.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib/common.ps1')

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'Не найден uv. Установите: https://docs.astral.sh/uv/getting-started/installation/'
}

$coreDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'core'
Push-Location $coreDir
try {
    # --locked: сборка строго по зафиксированному uv.lock.
    Write-Step 'Зависимости ядра (uv sync --locked)'
    Invoke-Native uv @('sync', '--locked')

    # spec-файл и промежуточные файлы — в core\build\ (в .gitignore), чтобы не засорять репозиторий.
    Write-Step 'Сборка PyInstaller'
    Invoke-Native uv @(
        'run', '--locked', 'pyinstaller', '--noconfirm', '--clean', '--onedir', '--console',
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
