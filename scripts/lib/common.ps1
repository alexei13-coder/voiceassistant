# Общие функции скриптов разработки; подключается через dot-source.
# Совместимо с Windows PowerShell 5.1: start-dev.bat запускает именно его, а не pwsh.

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
