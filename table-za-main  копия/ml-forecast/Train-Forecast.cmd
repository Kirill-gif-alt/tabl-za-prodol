@echo off
chcp 65001 >nul
title Модель 2 · обучение
cd /d "%~dp0"
rem Использование: перетащите SalesHistory.csv (или папку с ним) на этот файл либо запустите и впишите путь.
rem Без своих данных можно попробовать на выдуманных: Train-Forecast.cmd demo
set "PYTHONUTF8=1"
set "FORECAST_ARTIFACTS=%~dp0artifacts"
call "%~dp0_python.cmd" || goto end
set "HIST=%~1"
if /i "%HIST%"=="demo" goto demo
if "%HIST%"=="" set /p HIST=Путь к SalesHistory.csv или к папке с ним: 
set "HIST=%HIST:"=%"
if "%HIST:~-1%"=="\" set "HIST=%HIST:~0,-1%"
echo.
echo  Обучение занимает несколько минут. Окно не закрывайте.
%PY% -m training.full_train --history "%HIST%" --out "%FORECAST_ARTIFACTS%"
goto end
:demo
%PY% -m training.full_train --synthetic --out "%FORECAST_ARTIFACTS%"
:end
echo.
pause
