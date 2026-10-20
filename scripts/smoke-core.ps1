#Requires -Version 5.1
<#
.SYNOPSIS
    Проверка собранного ядра: запускается, сообщает ready, отвечает по WebSocket, не пишет токен в лог.
.DESCRIPTION
    Запускает jarvis-core --no-stdin --port 0 с временной папкой данных, ждёт строку
    {"type":"ready"} в stdout, проходит auth по WebSocket и получает hello, затем останавливает процесс.

    Ядро отказывается работать от имени администратора (код 3), а на раннерах GitHub Actions всё
    выполняется с правами администратора. Поэтому в таком сеансе ядро запускается с маркером
    уровня SAFER «обычный пользователь», где группа «Администраторы» только запрещающая.
.PARAMETER CoreDir
    Папка сборки ядра (по умолчанию core\dist\jarvis-core).
.PARAMETER TimeoutSeconds
    Сколько секунд ждать сообщения ready.
#>
[CmdletBinding()]
param(
    [string] $CoreDir,
    [ValidateRange(1, 300)] [int] $TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'lib/common.ps1')

$limitedLauncherSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace JarvisSmoke
{
    public static class LimitedLauncher
    {
        private const uint SaferScopeIdUser = 2;
        private const uint SaferLevelIdNormalUser = 0x20000;
        private const uint SaferLevelOpen = 1;
        private const uint GenericWrite = 0x40000000;
        private const uint FileShareReadWrite = 0x3;
        private const uint CreateAlways = 2;
        private const uint FileAttributeNormal = 0x80;
        private const uint StartfUseStdHandles = 0x100;
        private const uint CreateSuspended = 0x4;
        private const uint CreateNoWindow = 0x08000000;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr SecurityDescriptor;
            public int InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int Size;
            public string Reserved;
            public string Desktop;
            public string Title;
            public int X;
            public int Y;
            public int XSize;
            public int YSize;
            public int XCountChars;
            public int YCountChars;
            public int FillAttribute;
            public uint Flags;
            public short ShowWindow;
            public short Reserved2Size;
            public IntPtr Reserved2;
            public IntPtr StdInput;
            public IntPtr StdOutput;
            public IntPtr StdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process;
            public IntPtr Thread;
            public int ProcessId;
            public int ThreadId;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SaferCreateLevel(
            uint scopeId, uint levelId, uint openFlags, out IntPtr level, IntPtr reserved);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SaferComputeTokenFromLevel(
            IntPtr level, IntPtr inToken, out IntPtr outToken, uint flags, IntPtr reserved);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SaferCloseLevel(IntPtr level);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUserW(
            IntPtr token, string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
            IntPtr environment, string currentDirectory, ref StartupInfo startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFileW(
            string fileName, uint access, uint share, ref SecurityAttributes securityAttributes,
            uint creationDisposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        // Маркер — урезанная копия собственного, поэтому CreateProcessAsUser не требует
        // SeAssignPrimaryTokenPrivilege. Окружение (environment = NULL) наследуется от вызывающего.
        public static Process Start(string commandLine, string workingDirectory, string stdoutPath, string stderrPath)
        {
            IntPtr level;
            if (!SaferCreateLevel(SaferScopeIdUser, SaferLevelIdNormalUser, SaferLevelOpen, out level, IntPtr.Zero))
            {
                throw new Win32Exception();
            }
            IntPtr token = IntPtr.Zero;
            IntPtr stdout = InvalidHandle;
            IntPtr stderr = InvalidHandle;
            try
            {
                if (!SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero))
                {
                    throw new Win32Exception();
                }
                stdout = CreateInheritableFile(stdoutPath);
                stderr = CreateInheritableFile(stderrPath);
                StartupInfo startup = new StartupInfo();
                startup.Size = Marshal.SizeOf(typeof(StartupInfo));
                startup.Flags = StartfUseStdHandles;
                startup.StdOutput = stdout;
                startup.StdError = stderr;
                ProcessInformation info;
                if (!CreateProcessAsUserW(token, null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
                        true, CreateSuspended | CreateNoWindow, IntPtr.Zero, workingDirectory, ref startup, out info))
                {
                    throw new Win32Exception();
                }
                try
                {
                    // Дескриптор процесса берём, пока поток приостановлен: иначе код выхода
                    // мгновенно завершившегося ядра было бы уже не узнать.
                    Process process = Process.GetProcessById(info.ProcessId);
                    GC.KeepAlive(process.Handle);
                    if (ResumeThread(info.Thread) == uint.MaxValue)
                    {
                        int error = Marshal.GetLastWin32Error();
                        process.Kill();
                        throw new Win32Exception(error);
                    }
                    return process;
                }
                finally
                {
                    CloseHandle(info.Thread);
                    CloseHandle(info.Process);
                }
            }
            finally
            {
                if (stdout != InvalidHandle) { CloseHandle(stdout); }
                if (stderr != InvalidHandle) { CloseHandle(stderr); }
                if (token != IntPtr.Zero) { CloseHandle(token); }
                SaferCloseLevel(level);
            }
        }

        // Совместный доступ на чтение: скрипт читает вывод, пока ядро ещё пишет.
        private static IntPtr CreateInheritableFile(string path)
        {
            SecurityAttributes attributes = new SecurityAttributes();
            attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            attributes.InheritHandle = 1;
            IntPtr handle = CreateFileW(path, GenericWrite, FileShareReadWrite, ref attributes,
                CreateAlways, FileAttributeNormal, IntPtr.Zero);
            if (handle == InvalidHandle)
            {
                throw new Win32Exception();
            }
            return handle;
        }
    }
}
'@

function Test-Elevated {
    if ($env:OS -ne 'Windows_NT') { return $false }
    $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Grant-CurrentUserAccess {
    param([string] $Path, [string] $Rights)
    # Явное разрешение для SID пользователя: в урезанном маркере права группы «Администраторы» не действуют.
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Invoke-Native icacls @($Path, '/grant', "*${sid}:(OI)(CI)$Rights", '/Q') | Out-Null
}

function Start-Core {
    param([string] $Exe, [string] $WorkingDirectory, [string] $StdoutPath, [string] $StderrPath, [bool] $Limited)
    if ($Limited) {
        if (-not ('JarvisSmoke.LimitedLauncher' -as [type])) {
            Add-Type -TypeDefinition $limitedLauncherSource
        }
        $commandLine = "`"$Exe`" --no-stdin --port 0"
        return [JarvisSmoke.LimitedLauncher]::Start($commandLine, $WorkingDirectory, $StdoutPath, $StderrPath)
    }
    $process = Start-Process -FilePath $Exe -ArgumentList @('--no-stdin', '--port', '0') -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -NoNewWindow -PassThru
    # Без обращения к Handle PowerShell на Windows теряет код выхода процесса.
    if ($env:OS -eq 'Windows_NT') { $null = $process.Handle }
    return $process
}

function Read-SharedText {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete')
    try {
        $reader = New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding($false)))
        return $reader.ReadToEnd()
    }
    finally {
        $stream.Dispose()
    }
}

function Get-MessageType {
    param($Message)
    if ($Message -is [pscustomobject] -and $Message.PSObject.Properties['type']) { return [string]$Message.type }
    return $null
}

function Wait-Ready {
    param([Diagnostics.Process] $Process, [string] $StdoutPath, [int] $TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ($true) {
        # Сначала читаем, потом проверяем завершение: ready могло прийти прямо перед выходом.
        $exited = $Process.HasExited
        $text = Read-SharedText $StdoutPath
        # Только законченные строки: последняя может быть дописана наполовину.
        $complete = $text.Substring(0, $text.LastIndexOf("`n") + 1)
        foreach ($line in ($complete -split "`r?`n")) {
            if (-not $line.Trim()) { continue }
            try {
                $message = $line | ConvertFrom-Json
            }
            catch {
                throw "В stdout ядра посторонний вывод (канал зарезервирован под JSON Lines): $line"
            }
            switch (Get-MessageType $message) {
                'ready' { return $message }
                'fatal' { throw "Ядро сообщило о фатальной ошибке: $($message.message)" }
                default { throw "Первым сообщением в stdout ожидался ready, получено: $line" }
            }
        }
        if ($exited) { throw "Ядро завершилось с кодом $($Process.ExitCode), не сообщив ready" }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Ядро не сообщило ready за $TimeoutSeconds с" }
        Start-Sleep -Milliseconds 200
    }
}

function Receive-Hello {
    param([int] $Port, [string] $Token)
    $socket = New-Object Net.WebSockets.ClientWebSocket
    $timeout = New-Object Threading.CancellationTokenSource ([TimeSpan]::FromSeconds(10))
    try {
        # Origin оболочки в релизе (WebView2); без него ядро отвечает 403.
        $socket.Options.SetRequestHeader('Origin', 'http://tauri.localhost')
        # Task во время выполнения — Task<VoidTaskResult>: без $null = результат попал бы в вывод функции.
        $null = $socket.ConnectAsync([Uri]"ws://127.0.0.1:$Port/ws", $timeout.Token).GetAwaiter().GetResult()
        $auth = [Text.Encoding]::UTF8.GetBytes((@{ type = 'auth'; token = $Token } | ConvertTo-Json -Compress))
        $null = $socket.SendAsync([ArraySegment[byte]]::new($auth), [Net.WebSockets.WebSocketMessageType]::Text, $true,
            $timeout.Token).GetAwaiter().GetResult()

        $buffer = New-Object byte[] 65536
        $received = New-Object IO.MemoryStream
        do {
            $result = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $timeout.Token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                throw "Ядро закрыло WebSocket: $($result.CloseStatus) $($result.CloseStatusDescription)"
            }
            $received.Write($buffer, 0, $result.Count)
        } until ($result.EndOfMessage)
        return [Text.Encoding]::UTF8.GetString($received.ToArray()) | ConvertFrom-Json
    }
    finally {
        $socket.Dispose()
        $timeout.Dispose()
    }
}

if (-not $CoreDir) {
    $CoreDir = [IO.Path]::Combine((Split-Path -Parent $PSScriptRoot), 'core', 'dist', 'jarvis-core')
}
$exeName = if ($env:OS -eq 'Windows_NT') { 'jarvis-core.exe' } else { 'jarvis-core' }
$exe = Join-Path $CoreDir $exeName
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Не найден $exe — сначала соберите ядро: scripts\build-core.ps1"
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$workDir = Join-Path $tempRoot ('jarvis-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$dataDir = Join-Path $workDir 'data'
$stdoutPath = Join-Path $workDir 'stdout.jsonl'
$stderrPath = Join-Path $workDir 'stderr.log'
$token = [guid]::NewGuid().ToString('N')
$limited = Test-Elevated

Write-Step "Проверка ядра: $exe"
Invoke-Native $exe @('--help') | Out-Null
Write-Host '--help: код 0'

$null = New-Item -ItemType Directory -Path $dataDir -Force
if ($limited) {
    Write-Host 'Сеанс с правами администратора: ядро запускается с маркером обычного пользователя (SAFER)'
    Grant-CurrentUserAccess -Path $CoreDir -Rights 'RX'
    Grant-CurrentUserAccess -Path $dataDir -Rights 'M'
}

# Те же переменные, что передаёт оболочка; после проверки возвращаются прежние значения.
$overrides = @{ JARVIS_IPC_TOKEN = $token; JARVIS_DATA_DIR = $dataDir; PYTHONUTF8 = '1' }
$saved = @{}
foreach ($name in $overrides.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    [Environment]::SetEnvironmentVariable($name, $overrides[$name])
}

$process = $null
$passed = $false
try {
    $started = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Core -Exe $exe -WorkingDirectory $CoreDir -StdoutPath $stdoutPath -StderrPath $stderrPath `
        -Limited $limited
    $ready = Wait-Ready -Process $process -StdoutPath $stdoutPath -TimeoutSeconds $TimeoutSeconds
    if ($ready.protocol -ne 1 -or $ready.port -lt 1 -or $ready.port -gt 65535) {
        throw "Неверное сообщение ready: $($ready | ConvertTo-Json -Compress)"
    }
    Write-Host ("ready за {0:N1} с, порт {1}" -f $started.Elapsed.TotalSeconds, $ready.port)

    $hello = Receive-Hello -Port $ready.port -Token $token
    if ((Get-MessageType $hello) -ne 'hello' -or $hello.protocol -ne 1) {
        throw "После auth ожидался hello протокола 1, получено: $($hello | ConvertTo-Json -Compress -Depth 3)"
    }
    Write-Host "WebSocket: hello, ядро $($hello.core_version), состояние $($hello.state)"

    $process.Kill()
    $null = $process.WaitForExit(5000)

    if (-not (Test-Path -LiteralPath (Join-Path $dataDir 'settings.toml'))) {
        throw 'Ядро не создало settings.toml в папке данных'
    }
    $log = Read-SharedText ([IO.Path]::Combine($dataDir, 'logs', 'core.log'))
    if (-not $log) { throw 'Ядро не записало logs/core.log' }
    if ($log.Contains($token)) { throw 'Токен IPC попал в logs/core.log — фильтр секретов не сработал' }
    $passed = $true
}
catch {
    Write-Host ''
    Write-Host '--- stdout ядра ---'
    Write-Host (Read-SharedText $stdoutPath)
    Write-Host '--- stderr ядра ---'
    Write-Host (Read-SharedText $stderrPath)
    Write-Host "Файлы проверки оставлены в $workDir"
    throw
}
finally {
    if ($null -ne $process -and -not $process.HasExited) {
        $process.Kill()
        $null = $process.WaitForExit(5000)
    }
    foreach ($name in $saved.Keys) {
        [Environment]::SetEnvironmentVariable($name, $saved[$name])
    }
    if ($passed) { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host 'Проверка ядра пройдена' -ForegroundColor Green
