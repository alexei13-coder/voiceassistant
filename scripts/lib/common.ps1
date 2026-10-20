# Общие функции скриптов разработки; подключается через dot-source.
# Совместимо с Windows PowerShell 5.1: start-dev.bat запускает именно его, а не pwsh.
# Файлы .ps1 сохранены в UTF-8 с BOM: без BOM PowerShell 5.1 читает их в кодировке ANSI
# и портит русский текст (а «ё» в cp1251 даже превращается в кавычку и ломает разбор).

function Write-Step {
    param([Parameter(Mandatory = $true)] [string] $Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Native {
    <#
    .SYNOPSIS
        Запускает внешнюю программу и останавливает скрипт, если она завершилась с ошибкой.
    #>
    param(
        [Parameter(Mandatory = $true)] [string] $FilePath,
        [string[]] $ArgumentList = @()
    )
    # $ErrorActionPreference = 'Stop' не реагирует на коды выхода внешних программ,
    # а в PowerShell 5.1 ещё и превращает их stderr (прогресс uv, npm) в ошибку — поэтому локально Continue.
    $ErrorActionPreference = 'Continue'
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Команда «$FilePath $($ArgumentList -join ' ')» завершилась с кодом $LASTEXITCODE"
    }
}

function Test-Elevated {
    <#
    .SYNOPSIS
        $true, если процесс запущен с правами администратора (только Windows).
    #>
    if ($env:OS -ne 'Windows_NT') { return $false }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal $identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Tool {
    <#
    .SYNOPSIS
        Проверяет, что все программы есть в PATH; иначе перечисляет недостающие с подсказками и останавливает скрипт.
    .PARAMETER Tools
        Таблица «команда → как установить».
    #>
    param([Parameter(Mandatory = $true)] [Collections.Specialized.OrderedDictionary] $Tools)
    $missing = @($Tools.Keys | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
    if ($missing.Count -eq 0) { return }
    Write-Host ''
    Write-Host 'Не хватает программ:' -ForegroundColor Yellow
    foreach ($name in $missing) {
        Write-Host "  • $name — $($Tools[$name])"
    }
    Write-Host ''
    Write-Host 'После установки откройте новое окно терминала, чтобы обновился PATH, и запустите скрипт снова.'
    throw "Не найдено: $($missing -join ', ')"
}
