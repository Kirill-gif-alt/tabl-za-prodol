# Синхронизация продаж из XML в CSV (как HOURLY v2)
# Планировщик Windows запускает этот файл каждые 30 минут.

$rootPath      = "\\192.168.10.20\files\2026"
$outputCsv     = "Y:\Отделы\11 КС\ООРП\Загрузка\csv\Tickets_SALE_Last14Days.csv"
$processedLog  = "Y:\Отделы\11 КС\ООРП\Загрузка\csv\ProcessedFiles.log"
$activeLog     = "Y:\Отделы\11 КС\ООРП\Загрузка\csv\ActiveSales.log"
$runLog        = "Y:\Отделы\11 КС\ООРП\Загрузка\csv\HourlyRun.log"

$cutoffDate    = (Get-Date).AddDays(-14).Date
$startTime     = Get-Date

$processed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
if (Test-Path $processedLog) {
    Get-Content $processedLog -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_) { [void]$processed.Add($_.Trim()) }
    }
}

$Active = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
if (Test-Path $activeLog) {
    Get-Content $activeLog -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_) { [void]$Active.Add($_.Trim()) }
    }
}

$csvData = @{}
if (Test-Path $outputCsv) {
    try {
        Import-Csv $outputCsv -ErrorAction Stop | ForEach-Object {
            $k = "$($_.BSONUM)|$($_.TYPE)|$($_.REIS)|$($_.FIO)"
            if ($k -and $k -ne "|||") { $csvData[$k] = $_ }
        }
    } catch {
        $csvData = @{}
    }
}

$today = Get-Date
$foldersToScan = @()
$currentMonth = Join-Path $rootPath $today.ToString('MM')
if (Test-Path $currentMonth) {
    $foldersToScan += Get-ChildItem -Path $currentMonth -Directory -ErrorAction SilentlyContinue |
                      Where-Object { $_.Name -match '^\d{2}$' }
}
$prevMonth = Join-Path $rootPath $today.AddMonths(-1).ToString('MM')
if (Test-Path $prevMonth) {
    $foldersToScan += Get-ChildItem -Path $prevMonth -Directory -ErrorAction SilentlyContinue |
                      Where-Object { $_.Name -match '^\d{2}$' }
}
$foldersToScan = $foldersToScan | Sort-Object FullName -Descending | Select-Object -First 14

$newFiles = 0
$added    = 0
$removed  = 0

foreach ($folder in $foldersToScan) {
    $files = Get-ChildItem -Path $folder.FullName -Filter "*.xml" -File -ErrorAction SilentlyContinue |
             Sort-Object Name
    foreach ($file in $files) {
        $fileKey = $file.FullName
        if ($processed.Contains($fileKey)) { continue }

        $newFiles++
        $success = $false
        try {
            $xml = [xml][System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
            foreach ($ticket in $xml.SelectNodes("//TICKET")) {
                $bsonum = $ticket.BSONUM
                $type   = $ticket.TYPE
                $fio    = $ticket.FIO
                if (-not $bsonum -or -not $fio) { continue }

                foreach ($segment in $ticket.SelectNodes("SEGMENTS/SEGMENT")) {
                    $reis = if ($segment.REIS) { $segment.REIS } else { "" }
                    $key  = "$bsonum|$type|$reis|$fio"

                    if ($ticket.OPTYPE -eq "REFUND" -or $ticket.TRANS_TYPE -match "REFUND|CANCEL") {
                        if ($Active.Remove($key)) { $removed++ }
                        if ($csvData.ContainsKey($key)) { [void]$csvData.Remove($key) }
                        continue
                    }

                    if ($ticket.TRANS_TYPE -eq "SALE" -or $ticket.OPTYPE -eq "SALE") {
                        $flyStr = $segment.FLYDATE
                        if (-not $flyStr) { continue }
                        if ($flyStr.Length -eq 7) { $flyStr = "0" + $flyStr }
                        if ($flyStr.Length -ne 8) { continue }

                        try {
                            $flyDate = [datetime]::ParseExact($flyStr, 'ddMMyyyy', [System.Globalization.CultureInfo]::InvariantCulture)
                            if ($flyDate -ge $cutoffDate) {
                                $dealStr = $ticket.DEALDATE
                                if ($dealStr -and $dealStr.Length -eq 7) { $dealStr = "0" + $dealStr }
                                $contacts = ($ticket.CONTACTS.SelectNodes("CONTACT") | ForEach-Object { $_.InnerText }) -join "; "
                                $obj = [PSCustomObject]@{
                                    FileDate   = "$($file.Directory.Parent.Name).$($file.Directory.Name).$($file.Directory.Parent.Parent.Name)"
                                    FileName   = $file.Name
                                    BSONUM     = $ticket.BSONUM
                                    FIO        = $ticket.FIO
                                    PNR        = $ticket.PNR
                                    DEALDATE   = $dealStr
                                    FARE       = $ticket.FARE
                                    FLYDATE    = $flyStr
                                    TYPE       = $ticket.TYPE
                                    SEG_BSONUM = $segment.SEG_BSONUM
                                    CITY1      = $segment.CITY1CODE
                                    CITY2      = $segment.CITY2CODE
                                    REIS       = $segment.REIS
                                    BASICFARE  = $segment.BASICFARE
                                    NFARE      = $segment.NFARE
                                    FOP_ORG    = if ($ticket.PSObject.Properties['FOPS'] -and $ticket.FOPS.PSObject.Properties['FOP']) { $ticket.FOPS.FOP.ORG } else { "" }
                                    BIRTH_DATE = $ticket.BIRTH_DATE
                                    CONTACTS   = $contacts
                                }
                                $csvData[$key] = $obj
                                [void]$Active.Add($key)
                                $added++
                            }
                        } catch {}
                    }
                }
            }
            $success = $true
        } catch {}

        if ($success) {
            [void]$processed.Add($fileKey)
            Add-Content -Path $processedLog -Value $fileKey -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    }
}

$cleanData = $csvData.Values | Where-Object {
    $f = $_.FLYDATE
    if ($f) {
        if ($f.Length -eq 7) { $f = "0" + $f }
        if ($f.Length -eq 8) {
            try {
                $d = [datetime]::ParseExact($f, 'ddMMyyyy', [System.Globalization.CultureInfo]::InvariantCulture)
                return $d -ge $cutoffDate
            } catch { return $false }
        }
    }
    return $false
}

# Write to a temp file first, then replace: the app never reads a half-written CSV.
$tmpCsv = "$outputCsv.tmp"
try {
    $cleanData | Export-Csv $tmpCsv -NoTypeInformation -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $tmpCsv -Destination $outputCsv -Force -ErrorAction Stop
} catch {
    try { Remove-Item -LiteralPath $tmpCsv -Force -ErrorAction SilentlyContinue } catch {}
    exit 1
}

try { $Active | Out-File $activeLog -Encoding UTF8 -ErrorAction Stop } catch {}

$duration = (Get-Date) - $startTime
$logEntry = "{0} | Новых: {1} | Добавлено: {2} | Возвратов: {3} | В CSV: {4} | {5:N1} сек" -f `
    (Get-Date -Format 'dd.MM HH:mm'), $newFiles, $added, $removed, $cleanData.Count, $duration.TotalSeconds
Add-Content $runLog $logEntry -Encoding UTF8 -ErrorAction SilentlyContinue