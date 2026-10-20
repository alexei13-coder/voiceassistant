@echo off
rem Двойной щелчок по этому файлу запускает start-dev.ps1 в Windows PowerShell.
rem -ExecutionPolicy Bypass действует только на этот запуск: системная политика не меняется.
rem При ошибке окно не закрывается, чтобы можно было прочитать сообщение.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
