#Requires -Version 5.1
<#
.SYNOPSIS
    Запуск SWYVORN для разработки на Windows: проверка инструментов, зависимости, npm run tauri dev.
.DESCRIPTION
    Отладочная оболочка Tauri сама запускает ядро из исходников через uv
    (uv run python -m swyvorn --dev), поэтому отдельно ядро запускать не нужно.
    Отладочная копия запускается со своим идентификатором (ui\src-tauri\tauri.dev.conf.json)
    и может работать рядом с установленным SWYVORN.
    Удобнее всего запускать двойным щелчком по scripts\start-dev.bat.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1
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

# Vite 8 требует Node.js 20.19+ или 22.12+; проект и CI используют ветку 22 LTS.
$minNodeVersion = [version]'22.12.0'

function Assert-NodeVersion {
    $raw = (& node --version).Trim()
    $version = $null
    if (-not [version]::TryParse($raw.TrimStart('v'), [ref]$version) -or $version -lt $minNodeVersion) {
        throw "Нужен Node.js $minNodeVersion или новее (22 LTS), установлен $raw. Скачайте: https://nodejs.org/"
    }
}

function Test-MsvcToolchain {
    # vswhere ставится вместе с любым установщиком Visual Studio 2017+, в том числе с Build Tools.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { return $false }
    $found = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    return [bool]$found
}

function Get-ForeignSwyvorn {
    <#
    .SYNOPSIS
        Пути (или PID) запущенных Swyvorn.exe не из этого репозитория: установленная или портативная копия.
    #>
    param([Parameter(Mandatory = $true)] [string] $RepoRoot)
    if ($env:OS -ne 'Windows_NT') { return @() }
    $repoPrefix = $RepoRoot.TrimEnd('\') + '\'
    $found = @()
    foreach ($process in @(Get-Process -Name 'Swyvorn' -ErrorAction SilentlyContinue)) {
        $path = $null
        # Путь процесса другого пользователя может быть недоступен — такой тоже считаем чужим.
        try { $path = $process.Path } catch { $path = $null }
        if (-not $path) {
            $found += "PID $($process.Id)"
        }
        elseif (-not $path.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $found += $path
        }
    }
    return $found
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$coreDir = Join-Path $repoRoot 'core'
$uiDir = Join-Path $repoRoot 'ui'
# Путь относительно ui\: npm run запускает tauri из папки пакета.
$devConfig = 'src-tauri/tauri.dev.conf.json'
# npm — только через npm.cmd: обёртка npm.ps1 при вызове «& npm @аргументы» в части версий npm
# искажает аргументы (в том числе «--» перед --config), а при политике Restricted не запускается вовсе.
$npm = if ($env:OS -eq 'Windows_NT') { 'npm.cmd' } else { 'npm' }

if (Test-Elevated) {
    throw ('Окно запущено от имени администратора, а ядро ассистента с такими правами работать откажется. ' +
        'Откройте обычное окно PowerShell или запустите start-dev.bat двойным щелчком.')
}

Write-Step 'Проверка инструментов'
Assert-Tool ([ordered]@{
        git   = 'Git: https://git-scm.com/download/win (или: winget install --id Git.Git -e)'
        uv    = 'uv: https://docs.astral.sh/uv/getting-started/installation/ (или: winget install --id astral-sh.uv -e)'
        node  = 'Node.js 22 LTS: https://nodejs.org/ (или: winget install --id OpenJS.NodeJS.LTS -e)'
        $npm  = 'npm ставится вместе с Node.js 22 LTS: https://nodejs.org/'
        cargo = 'Rust через rustup: https://rustup.rs/ (или: winget install --id Rustlang.Rustup -e)'
    })
Assert-NodeVersion
if ($env:OS -eq 'Windows_NT' -and -not (Test-MsvcToolchain)) {
    # Не останавливаемся: инструменты могли поставить без vswhere. Если они и правда нужны,
    # сборка Rust упадёт с ошибкой про link.exe — тогда пригодится эта подсказка.
    Write-Warning ('Не найдены Microsoft C++ Build Tools. Если сборка упадёт с ошибкой «link.exe not found», ' +
        'установите их: https://visualstudio.microsoft.com/visual-cpp-build-tools/ — ' +
        'рабочая нагрузка «Разработка классических приложений на C++».')
}
Write-Host 'Все инструменты на месте.'

foreach ($where in Get-ForeignSwyvorn -RepoRoot $repoRoot) {
    # Не останавливаемся: копии уживаются, но сочетания достанутся той, что запущена первой.
    Write-Warning ("Уже запущен SWYVORN ($where). Он занял глобальные горячие клавиши, и отладочная " +
        'копия не сможет их зарегистрировать. Чтобы проверить горячие клавиши, закройте его: меню трея → «Выход».')
}

Write-Step 'Зависимости ядра (uv sync)'
Invoke-Native uv @('sync', '--project', $coreDir)

Push-Location $uiDir
try {
    if (-not (Test-Path -LiteralPath (Join-Path $uiDir 'node_modules'))) {
        Write-Step 'Зависимости интерфейса (npm ci)'
        Invoke-Native $npm @('ci')
    }

    Write-Step "Запуск: npm run tauri dev -- --config $devConfig"
    Write-Host 'Первая сборка оболочки на Rust занимает 5–10 минут, следующие запуски — секунды.'
    Write-Host 'Крестик прячет окно в трей. Завершить: меню трея → «Выход» или Ctrl+C в этом окне.'
    # Свой identifier («SWYVORN dev»): иначе single-instance принял бы отладочную копию
    # за второй экземпляр установленного приложения, и она сразу закрылась бы.
    Invoke-Native $npm @('run', 'tauri', 'dev', '--', '--config', $devConfig)
}
finally {
    Pop-Location
}
