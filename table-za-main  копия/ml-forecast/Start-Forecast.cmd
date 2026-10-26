@echo off
chcp 65001 >nul
title Модель 2 · служба прогноза
cd /d "%~dp0"
if "%FORECAST_PORT%"=="" set "FORECAST_PORT=8077"
set "PYTHONUTF8=1"
set "FORECAST_ARTIFACTS=%~dp0artifacts"
call "%~dp0_python.cmd" || goto end
echo.
echo  Модель 2 (прогноз загрузки): http://127.0.0.1:%FORECAST_PORT%
echo  Окно не закрывайте, пока нужна вторая модель.
echo.
%PY% -m uvicorn app.main:app --host 127.0.0.1 --port %FORECAST_PORT%
:end
pause
