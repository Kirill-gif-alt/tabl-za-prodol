@echo off
chcp 65001 >nul
title Модель 2 · обучение
cd /d "%~dp0"
rem Использование: перетащите файл SalesHistory.csv на этот файл или запустите и впишите путь.
rem Без файла можно попробовать на выдуманных данных: Train-Forecast.cmd demo
set "FORECAST_ARTIFACTS=%~dp0artifacts"
set "HIST=%~1"
if /i "%HIST%"=="demo" goto demo
if "%HIST%"=="" set /p HIST=Путь к SalesHistory.csv: 
set "PY=python"
where py >nul 2>&1 && set "PY=py -3"
echo.
echo  Обучение занимает несколько минут. Окно не закрывайте.
%PY% -m training.full_train --history "%HIST%" --out "%FORECAST_ARTIFACTS%"
goto end
:demo
set "PY=python"
where py >nul 2>&1 && set "PY=py -3"
%PY% -m training.full_train --synthetic --out "%FORECAST_ARTIFACTS%"
:end
echo.
pause
