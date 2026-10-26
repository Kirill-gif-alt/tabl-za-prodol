@echo off
chcp 65001 >nul
title Модель 2 · дневное дообучение
cd /d "%~dp0"
rem Использование: Update-Forecast.cmd "Tickets_SALE_Last14Days.csv" ["файл доступности.csv"]
set "PYTHONUTF8=1"
set "FORECAST_ARTIFACTS=%~dp0artifacts"
call "%~dp0_python.cmd" || goto end
if "%~2"=="" (
  %PY% -m training.incremental --tickets "%~1" --out "%FORECAST_ARTIFACTS%"
) else (
  %PY% -m training.incremental --tickets "%~1" --availability "%~2" --out "%FORECAST_ARTIFACTS%"
)
:end
pause
