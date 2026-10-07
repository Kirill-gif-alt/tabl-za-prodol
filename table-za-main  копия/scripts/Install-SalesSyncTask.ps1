# Регистрирует задачу Планировщика: синхронизация продаж каждые 30 минут.
# Запускать от имени пользователя с доступом к Y: и \\192.168.10.20\files\2026

$taskName = 'KRASAVIA_SyncTicketsSales'
$scriptPath = Join-Path $PSScriptRoot 'Sync-TicketsSales.ps1'

if (-not (Test-Path $scriptPath)) {
    Write-Error "Не найден: $scriptPath"
    exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 60) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Задача '$taskName' создана: каждые 30 минут" -ForegroundColor Green
Write-Host "Скрипт: $scriptPath"
Write-Host "CSV: Y:\Отделы\11 КС\ООРП\Загрузка\csv\Tickets_SALE_Last14Days.csv"
Write-Host ""
Write-Host "Проверка: Get-ScheduledTask -TaskName '$taskName'"
Write-Host "Ручной запуск: Start-ScheduledTask -TaskName '$taskName'"