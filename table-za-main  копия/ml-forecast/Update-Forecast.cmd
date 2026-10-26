@echo off
chcp 65001 >nul
title Модель 2 · дневное дообучение
cd /d "%~dp0"
rem Использование: Update-Forecast.cmd "Tickets_SALE_Last14Days.csv" ["файл доступности.csv"]
set "FORECAST_ARTIFACTS=%~dp0artifacts"
set "PY=python"
where py >nul 2>&1 && set "PY=py -3"
if "%~2"=="" (
  %PY% -m training.incremental --tickets "%~1" --out "%FORECAST_ARTIFACTS%"
) else (
  %PY% -m training.incremental --tickets "%~1" --availability "%~2" --out "%FORECAST_ARTIFACTS%"
)
pause
