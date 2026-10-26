@echo off
chcp 65001 >nul
title Модель 2 · установка
cd /d "%~dp0"
echo.
echo  Ставлю библиотеки для второй модели прогноза (один раз).
echo.
where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -3 -m pip install -r requirements.txt
) else (
  python -m pip install -r requirements.txt
)
echo.
echo  Готово. Дальше: Train-Forecast.cmd (обучение), потом Start-Forecast.cmd.
pause
