@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title КРАСАВИА · Обновление
cd /d "%~dp0"

echo.
echo  ========================================
echo   КРАСАВИА · Установка обновления
echo  ========================================
echo.

rem какая версия стоит сейчас
set "CUR=0"
if exist "%~dp0version.txt" set /p CUR=<"%~dp0version.txt"
set /a CUR=CUR+0 2>nul

rem архив: перетащили на этот файл, либо самый новый krasavia-update-vNN.zip рядом с сайтом,
rem в папке выше, в Загрузках или на рабочем столе
set "ZIP="
set "NEW=0"
if not "%~1"=="" if exist "%~1" (
  set "ZIP=%~f1"
  set "NEW=999999"
)
if not defined ZIP (
  for %%D in ("%~dp0." "%~dp0.." "%USERPROFILE%\Downloads" "%USERPROFILE%\Desktop") do (
    for /f "delims=" %%F in ('dir /b /a-d "%%~fD\krasavia-update-v*.zip" 2^>nul') do (
      set "NM=%%~nF"
      set "NM=!NM:krasavia-update-v=!"
      for /f "tokens=1 delims= (-_." %%N in ("!NM!") do set "NUM=%%N"
      set /a NUM=NUM+0 2>nul
      if !NUM! GTR !NEW! (
        set "NEW=!NUM!"
        set "ZIP=%%~fD\%%F"
      )
    )
  )
)

if not defined ZIP (
  echo  Архив обновления не найден.
  echo  Положите файл krasavia-update-vNN.zip рядом с этим файлом
  echo  или в папку "Загрузки" и запустите снова.
  echo.
  pause
  exit /b 1
)

if "%~1"=="" if !NEW! LEQ !CUR! (
  echo  Сейчас стоит версия v!CUR!. Архива новее не найдено.
  echo  Самый новый найденный: !ZIP!
  echo.
  pause
  exit /b 0
)

echo  Сейчас стоит: v!CUR!
echo  Архив:        !ZIP!
echo.
echo  Общая папка shared (данные, профили, отметки) не меняется.
echo.
set "ANS="
set /p ANS=" Установить? Нажмите Enter, чтобы продолжить, или закройте окно: "

rem распаковка во временную папку
set "KTMP=%TEMP%\krasavia-upd-%RANDOM%%RANDOM%"
set "KZIP=!ZIP!"
mkdir "!KTMP!" >nul 2>&1
echo.
echo  Распаковка...
tar -xf "!KZIP!" -C "!KTMP!" >nul 2>&1
if not exist "!KTMP!\index.html" (
  powershell -NoProfile -Command "Expand-Archive -LiteralPath $env:KZIP -DestinationPath $env:KTMP -Force" >nul 2>&1
)
if not exist "!KTMP!\index.html" goto :badzip
if not exist "!KTMP!\js\script.js" goto :badzip
if not exist "!KTMP!\scripts\local-server.py" goto :badzip

rem копия нынешних файлов сайта (без данных): _backup\vNN, храним три последние
set "BK=%~dp0_backup\v!CUR!"
if exist "!BK!" rd /s /q "!BK!" >nul 2>&1
echo  Копия нынешней версии: _backup\v!CUR!
robocopy "%~dp0." "!BK!" /E /XD shared tools ml-forecast secrets _backup .git /XF *.zip /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul
if errorlevel 8 (
  echo  Не удалось сохранить копию нынешней версии. Обновление не установлено.
  rd /s /q "!KTMP!" >nul 2>&1
  pause
  exit /b 1
)
for /f "skip=3 delims=" %%B in ('dir /b /ad /o-d "%~dp0_backup" 2^>nul') do rd /s /q "%~dp0_backup\%%B" >nul 2>&1

rem новые файлы поверх; общую папку и служебные папки не трогаем, этот файл обновим последним
echo  Установка...
robocopy "!KTMP!" "%~dp0." /E /XD shared tools ml-forecast secrets _backup /XF Update-Krasavia.cmd /NFL /NDL /NJH /NJS /NP /R:2 /W:1 >nul
if errorlevel 8 (
  echo.
  echo  Не все файлы удалось заменить. Закройте окно "КРАСАВИА · Аналитика" и браузер
  echo  и запустите обновление ещё раз. Прежняя версия лежит в _backup\v!CUR!.
  rd /s /q "!KTMP!" >nul 2>&1
  pause
  exit /b 1
)

set "NOW=?"
if exist "%~dp0version.txt" set /p NOW=<"%~dp0version.txt"
echo.
echo  Готово: установлена версия v!NOW!.
echo  Закройте окно "КРАСАВИА · Аналитика" (если открыто) и запустите Start-Krasavia заново.
echo  В браузере нажмите Ctrl+F5.
echo.
rem замена самого себя — последней строкой: после неё файл больше не читается
if exist "!KTMP!\Update-Krasavia.cmd" (copy /y "!KTMP!\Update-Krasavia.cmd" "%~f0" >nul) & rd /s /q "!KTMP!" >nul 2>&1 & pause & exit /b 0

:badzip
echo.
echo  Это не архив обновления сайта или он повреждён:
echo  !ZIP!
echo  Ничего не изменено.
rd /s /q "!KTMP!" >nul 2>&1
echo.
pause
exit /b 1
