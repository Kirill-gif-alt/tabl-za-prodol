@echo off
chcp 65001 >nul
title КРАСАВИА · Аналитика
cd /d "%~dp0"
if "%KRASAVIA_PORT%"=="" set "KRASAVIA_PORT=8765"

echo.
echo  ========================================
echo   КРАСАВИА · Аналитика
echo   Локальный запуск (копия на Desktop)
echo  ========================================
echo.
echo  Рекомендуется Chrome/Edge + этот сервер
echo  (не file://) — для shared/ и FS Access API.
echo  Адрес: http://127.0.0.1:%KRASAVIA_PORT%
echo  Закройте окно, чтобы остановить сервер.
echo.

rem Вторая модель прогноза: если она обучена, запускаем её службу рядом (свернутым окном).
if exist "%~dp0ml-forecast\artifacts\current.json" start "Модель 2" /min cmd /c ""%~dp0ml-forecast\Start-Forecast.cmd""

where py >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:%KRASAVIA_PORT%/index.html"
  if exist "%~dp0scripts\local-server.py" (
    py -3 "%~dp0scripts\local-server.py"
  ) else (
    py -3 -m http.server %KRASAVIA_PORT% --bind 127.0.0.1
  )
  goto :eof
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" cmd /c "timeout /t 1 /nobreak >nul & start http://127.0.0.1:%KRASAVIA_PORT%/index.html"
  if exist "%~dp0scripts\local-server.py" (
    python "%~dp0scripts\local-server.py"
  ) else (
    python -m http.server %KRASAVIA_PORT% --bind 127.0.0.1
  )
  goto :eof
)

echo  Python не найден. Открываю index.html напрямую (file://).
echo  Часть функций shared/ может не работать из-за ограничений браузера.
echo.
start "" "%~dp0index.html"
pause
