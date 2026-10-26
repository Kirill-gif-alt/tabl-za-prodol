@echo off
rem Ищет Python 3.10 или новее: лаунчер py, python в PATH, типовые папки установки. Результат — переменная PY.
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if defined PY goto check
for /d %%D in ("%LocalAppData%\Programs\Python\Python3*" "%ProgramFiles%\Python3*" "C:\Python3*") do (
  if exist "%%~D\python.exe" if not defined PY set PY="%%~D\python.exe"
)
:check
if defined PY (
  %PY% -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1
  if errorlevel 1 set "PY="
)
if defined PY exit /b 0
echo.
echo  Не найден Python (нужна версия 3.10 или новее).
echo.
echo  Что сделать:
echo    1. Скачайте Python с https://www.python.org/downloads/
echo    2. При установке отметьте галочку "Add python.exe to PATH".
echo    3. Закройте это окно и запустите файл снова.
echo.
exit /b 1
