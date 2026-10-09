@echo off
rem Starts the EMD export window without a console.
start "" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Export-EmdRfisc.ps1" %*
