@echo off
chcp 65001 >nul
title Модель 2 · установка
cd /d "%~dp0"
call "%~dp0_python.cmd" || goto end
echo.
echo  Ставлю библиотеки для второй модели прогноза (один раз). Нужен интернет.
echo.
%PY% -m pip install -r requirements.txt
echo.
echo  Готово. Дальше: Train-Forecast.cmd (обучение), потом Start-Forecast.cmd.
:end
pause
