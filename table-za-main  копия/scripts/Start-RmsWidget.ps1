# Отдельное окно виджета. Не зависит от окна браузера.
# Данные: shared\rms-widget.json, его пишет сайт после загрузки рейсов.
# Если в файле нет загрузки или ожидаемой, окно читает shared\snapshot.json.
#requires -Version 5.1

$ErrorActionPreference = 'Stop'

function ConvertTo-WidgetDate([string]$DateStr) {
    if ([string]::IsNullOrWhiteSpace($DateStr)) { return $null }
    $parts = $DateStr.Split('.')
    if ($parts.Length -ne 3) { return $null }
    try {
        return Get-Date -Year ([int]$parts[2]) -Month ([int]$parts[1]) -Day ([int]$parts[0]) -Hour 0 -Minute 0 -Second 0
    } catch {
        return $null
    }
}

function Get-WidgetDtd([string]$DateStr) {
    $day = ConvertTo-WidgetDate $DateStr
    if (-not $day) { return $null }
    return [int](($day.Date - (Get-Date).Date).TotalDays)
}

function Get-WidgetPeriod($State) {
    $from = [int]$State.dtdFrom
    $to = [int]$State.dtdTo
    if ($from -gt $to) {
        $swap = $from
        $from = $to
        $to = $swap
    }
    return @{ From = $from; To = $to }
}

function Get-WidgetBase([string]$Code) {
    $n = 0
    [void][int]::TryParse(([string]$Code).Replace('KV-', ''), [ref]$n)
    if (@(151, 351, 355, 455) -contains $n) { return 'KV-155' }
    if (@(152, 352, 356, 456) -contains $n) { return 'KV-156' }
    if ($n -eq 261) { return 'KV-161' }
    if ($n -eq 262) { return 'KV-162' }
    if ($n -eq 253) { return 'KV-153' }
    if ($n -eq 254) { return 'KV-154' }
    if ($n -eq 273) { return 'KV-173' }
    if ($n -eq 274) { return 'KV-174' }
    if ($n -eq 325) { return 'KV-225' }
    if ($n -eq 326) { return 'KV-226' }
    if ($n -eq 347) { return 'KV-247' }
    if ($n -eq 348) { return 'KV-248' }
    if ($n -ge 300 -and $n -le 399) { return ('KV-' + ($n - 200)) }
    if ($n -ge 400 -and $n -le 499) { return ('KV-' + ($n - 300)) }
    return [string]$Code
}

function Get-WidgetCapacity([string]$Aircraft) {
    $t = ([string]$Aircraft).ToUpper()
    if ($t.Contains('ATR-72') -or $t.Contains('AT7')) { return 72 }
    if ($t.Contains('ЯК-42') -or $t.Contains('YK2')) { return 120 }
    return 46
}

function Get-WidgetWeek([datetime]$Day) {
    $yearStart = Get-Date -Year $Day.Year -Month 1 -Day 1 -Hour 0 -Minute 0 -Second 0
    $dow = [int]$yearStart.DayOfWeek
    if ($dow -eq 0) { $monday = $yearStart.AddDays(-6) } else { $monday = $yearStart.AddDays(-($dow - 1)) }
    $diff = [math]::Floor(($Day.Date - $monday.Date).TotalDays)
    $week = [math]::Floor($diff / 7) + 1
    if ($week -lt 1) { return 1 }
    if ($week -gt 52) { return 52 }
    return [int]$week
}

function Get-WidgetExpected($Table, $Cap, $Base, $Dtd, $Week) {
    if ($null -eq $Table -or $null -eq $Dtd -or $Dtd -lt 0) { return $null }
    $keys = @(
        ('{0}|{1}|{2}|{3}' -f $Cap, $Base, $Dtd, $Week),
        ('{0}|{1}|{2}|{3}' -f $Cap, $Base, ($Dtd - 1), $Week),
        ('{0}|{1}|{2}|{3}' -f $Cap, $Base, ($Dtd + 1), $Week),
        ('{0}|{1}|{2}|{3}' -f $Cap, $Base, $Dtd, ($Week - 1)),
        ('{0}|{1}|{2}|{3}' -f $Cap, $Base, $Dtd, ($Week + 1))
    )
    foreach ($key in $keys) {
        if (-not $Table.ContainsKey($key)) { continue }
        $n = 0.0
        if (-not [double]::TryParse([string]$Table[$key], [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$n)) { continue }
        return [int][Math]::Ceiling($n)
    }
    return $null
}

function Get-WidgetLoadMaps([string]$JsonText) {
    $loads = @{}
    $expected = @{}
    if ([string]::IsNullOrEmpty($JsonText)) { return @{ Loads = $loads; Expected = $expected } }
    $cut = $JsonText.IndexOf('"expectedLoadData"')
    $head = if ($cut -ge 0) { $JsonText.Substring(0, $cut) } else { $JsonText }
    $tail = if ($cut -ge 0) { $JsonText.Substring($cut) } else { '' }
    $rows = [regex]::Matches($head, '\["(KV-[^"]+)","(\d{2}\.\d{2}\.\d{4})","[^"]*","[^"]*","([^"]*)","(-?\d+)","(-?\d+)"')
    foreach ($match in $rows) {
        $key = $match.Groups[1].Value + '|' + $match.Groups[2].Value
        if ($loads.ContainsKey($key)) { continue }
        $sold = 0
        [void][int]::TryParse($match.Groups[5].Value, [ref]$sold)
        if ($sold -lt 0) { $sold = 0 }
        $loads[$key] = @{ Load = $sold; Aircraft = $match.Groups[3].Value }
    }
    if ($tail) {
        $found = [regex]::Matches($tail, '"(\d+)\|(KV-\d+)\|(-?\d+)\|(-?\d+)":(-?\d+(?:\.\d+)?)')
        foreach ($match in $found) {
            $key = '{0}|{1}|{2}|{3}' -f $match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value, $match.Groups[4].Value
            if (-not $expected.ContainsKey($key)) { $expected[$key] = $match.Groups[5].Value }
        }
    }
    return @{ Loads = $loads; Expected = $expected }
}

function Test-WidgetFieldMissing($Flight, [string]$Name) {
    if ($null -eq $Flight) { return $true }
    $value = $null
    $present = $false
    if ($Flight -is [System.Collections.IDictionary]) {
        $present = $Flight.Contains($Name)
        if ($present) { $value = $Flight[$Name] }
    } else {
        $prop = $Flight.PSObject.Properties[$Name]
        if ($null -ne $prop) { $present = $true; $value = $prop.Value }
    }
    if (-not $present -or $null -eq $value) { return $true }
    if ([string]::IsNullOrWhiteSpace([string]$value)) { return $true }
    return $false
}

function Get-WidgetSnapshotCounts($Flight) {
    $result = @{ Load = $null; Expected = $null }
    if ($null -eq $script:loadMaps -or $null -eq $Flight) { return $result }
    $loads = $script:loadMaps.Loads
    $table = $script:loadMaps.Expected
    if ($null -eq $loads) { return $result }
    $code = [string]$Flight.code
    $date = [string]$Flight.date
    $key = $code + '|' + $date
    if (-not $loads.ContainsKey($key)) { return $result }
    $row = $loads[$key]
    $result.Load = [int]$row.Load
    $day = ConvertTo-WidgetDate $date
    $dtd = Get-WidgetDtd $date
    if ($day -and $null -ne $dtd -and $null -ne $table) {
        $cap = Get-WidgetCapacity ([string]$row.Aircraft)
        $base = Get-WidgetBase $code
        $week = Get-WidgetWeek $day
        $result.Expected = Get-WidgetExpected $table $cap $base $dtd $week
    }
    return $result
}

function Test-WidgetNeedsSnapshot {
    if (-not $script:fileOk) { return $false }
    foreach ($flight in @($script:flights)) {
        if (-not $flight) { continue }
        if ((Test-WidgetFieldMissing $flight 'load') -or (Test-WidgetFieldMissing $flight 'expected')) { return $true }
    }
    return $false
}

function Stop-WidgetLoadLookup {
    $shell = $script:loadShell
    $space = $script:loadRunspace
    $script:loadShell = $null
    $script:loadRunspace = $null
    $script:loadJob = $null
    $script:loadReading = $false
    if ($shell) {
        try {
            if ($shell.InvocationStateInfo.State -eq 'Running') { $shell.Stop() }
        } catch { }
        try { $shell.Dispose() } catch { }
    }
    if ($space) {
        try { $space.Close() } catch { }
        try { $space.Dispose() } catch { }
    }
}

function Start-WidgetLoadLookup {
    if ($script:loadReading) { return }
    if (-not (Test-WidgetNeedsSnapshot)) { return }
    if (-not (Test-Path -LiteralPath $snapshotPath)) { return }
    $item = Get-Item -LiteralPath $snapshotPath
    if ($null -ne $script:loadMaps -and $script:loadStamp -eq $item.LastWriteTimeUtc) { return }
    $pendingStamp = $item.LastWriteTimeUtc
    try {
        $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
        $iss.Commands.Add((New-Object System.Management.Automation.Runspaces.SessionStateFunctionEntry('Get-WidgetLoadMaps', ${function:Get-WidgetLoadMaps}.ToString())))
        $space = [runspacefactory]::CreateRunspace($iss)
        $space.Open()
        $shell = [powershell]::Create()
        $shell.Runspace = $space
        [void]$shell.AddScript({
            param($Path)
            $utf8 = New-Object System.Text.UTF8Encoding $false
            $text = [System.IO.File]::ReadAllText($Path, $utf8)
            Get-WidgetLoadMaps $text
        }).AddArgument($snapshotPath)
        $script:loadShell = $shell
        $script:loadRunspace = $space
        $script:loadJob = $shell.BeginInvoke()
        $script:loadReading = $true
        $script:loadStamp = $pendingStamp
        $script:loadMaps = $null
        if ($script:widgetTimer) { $script:widgetTimer.Interval = 500 }
    } catch {
        Stop-WidgetLoadLookup
        $script:loadStamp = $null
        if ($script:widgetTimer) { $script:widgetTimer.Interval = 15000 }
    }
}

function Complete-WidgetLoadLookup {
    if (-not $script:loadReading -or -not $script:loadJob) { return $false }
    if (-not $script:loadJob.IsCompleted) { return $false }
    $ok = $false
    try {
        $out = @($script:loadShell.EndInvoke($script:loadJob))
        if ($out.Count -ge 1 -and $null -ne $out[0]) {
            $script:loadMaps = $out[0]
            $ok = $true
        } else {
            $script:loadStamp = $null
        }
    } catch {
        $script:loadMaps = $null
        $script:loadStamp = $null
    } finally {
        Stop-WidgetLoadLookup
        if ($script:widgetTimer) { $script:widgetTimer.Interval = 15000 }
    }
    return $ok
}

function Format-WidgetCount($Value) {
    if ($null -eq $Value) { return '-' }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return '-' }
    $n = 0.0
    if (-not [double]::TryParse($text, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$n)) { return '-' }
    return ([int][Math]::Round($n)).ToString()
}

function Get-WidgetLineText($Flight) {
    $bits = New-Object System.Collections.Generic.List[string]
    $dtd = Get-WidgetDtd ([string]$Flight.date)
    if ($null -ne $dtd) { $bits.Add(('через {0} дн.' -f $dtd)) }
    if ($null -ne $Flight.pct -and [string]$Flight.pct -ne '') { $bits.Add(('ЗПК {0}%' -f $Flight.pct)) }
    $loadValue = $null
    $expectedValue = $null
    $needLoad = Test-WidgetFieldMissing $Flight 'load'
    $needExpected = Test-WidgetFieldMissing $Flight 'expected'
    if (-not $needLoad) { $loadValue = $Flight.load }
    if (-not $needExpected) { $expectedValue = $Flight.expected }
    if ($needLoad -or $needExpected) {
        $snap = Get-WidgetSnapshotCounts $Flight
        if ($needLoad -and $null -ne $snap.Load) { $loadValue = $snap.Load }
        if ($needExpected -and $null -ne $snap.Expected) { $expectedValue = $snap.Expected }
    }
    $bits.Add(('Загрузка {0}' -f (Format-WidgetCount $loadValue)))
    $bits.Add(('Ожидаемая {0}' -f (Format-WidgetCount $expectedValue)))
    if ($null -eq $Flight.pickup -or [string]$Flight.pickup -eq '') { $bits.Add('Pickup —') }
    else { $bits.Add(('Pickup {0}' -f $Flight.pickup)) }
    if ($Flight.route) { $bits.Add([string]$Flight.route) }
    if ($bits.Count -eq 0) { return '' }
    return ($bits.ToArray() -join ' · ')
}

function Test-WidgetAlert($Flight, $State) {
    if ($null -ne $Flight.pct -and [string]$Flight.pct -ne '' -and [double]$Flight.pct -lt [double]$State.lf) { return $true }
    if ($State.pickupZero -eq $true -and $null -ne $Flight.pickup -and [string]$Flight.pickup -ne '' -and [int]$Flight.pickup -eq 0) { return $true }
    return $false
}

function Select-WidgetAlerts($Flights, $State) {
    $period = Get-WidgetPeriod $State
    $hits = New-Object System.Collections.Generic.List[object]
    foreach ($flight in @($Flights)) {
        if (-not $flight) { continue }
        if ($State.routeType -and $State.routeType -ne 'all' -and [string]$flight.routeType -ne [string]$State.routeType) { continue }
        $dtd = Get-WidgetDtd ([string]$flight.date)
        if ($null -eq $dtd -or $dtd -lt $period.From -or $dtd -gt $period.To) { continue }
        if ($State.alertsOnly -eq $true -and -not (Test-WidgetAlert $flight $State)) { continue }
        $pctSort = 9999
        if ($null -ne $flight.pct -and [string]$flight.pct -ne '') { $pctSort = [double]$flight.pct }
        $text = '{0}  {1} · {2}' -f $flight.code, $flight.date, (Get-WidgetLineText $flight)
        $hits.Add([pscustomobject]@{
            Text = $text
            DtdSort = $dtd
            PctSort = $pctSort
        }) | Out-Null
    }
    return @($hits | Sort-Object DtdSort, PctSort)
}

function Get-WidgetRouteCount($Flights, [string]$RouteType) {
    $n = 0
    foreach ($flight in @($Flights)) {
        if (-not $flight) { continue }
        if (-not $RouteType -or $RouteType -eq 'all' -or [string]$flight.routeType -eq $RouteType) { $n++ }
    }
    return $n
}

function Test-WidgetOriginUsable([int]$X, [int]$Y, [int]$W, [int]$H) {
    if ($X -le -32000 -or $Y -le -32000) { return $false }
    if ($W -lt 200 -or $H -lt 120) { return $false }
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
        $area = $screen.WorkingArea
        $visW = [Math]::Min($X + $W, $area.Right) - [Math]::Max($X, $area.Left)
        $visH = [Math]::Min($Y + $H, $area.Bottom) - [Math]::Max($Y, $area.Top)
        if ($visW -ge 80 -and $visH -ge 40) { return $true }
    }
    return $false
}

function Get-WidgetDefaultOrigin([int]$W, [int]$H) {
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $x = $area.Right - $W - 16
    $y = $area.Top + 72
    if ($x -lt $area.Left) { $x = $area.Left + 16 }
    if (($y + $H) -gt $area.Bottom) { $y = $area.Bottom - $H - 16 }
    if ($y -lt $area.Top) { $y = $area.Top + 16 }
    return New-Object System.Drawing.Point($x, $y)
}

if ($env:KRASAVIA_WIDGET_SELFTEST -eq '1') {
    $origin = Get-Date
    $fmt = { param($n) $origin.Date.AddDays($n).ToString('dd.MM.yyyy') }
    $flights = @(
        @{ code = 'KV-101'; date = (& $fmt 3); pct = 20; pickup = 1; routeType = 'krai'; route = 'Абакан' },
        @{ code = 'KV-201'; date = (& $fmt 4); pct = 20; pickup = 1; routeType = 'interregional'; route = 'Москва' },
        @{ code = 'KV-301'; date = (& $fmt 20); pct = 90; pickup = 5; routeType = 'krai'; route = 'Далеко' },
        @{ code = 'KV-401'; date = (& $fmt 2); pct = 80; pickup = $null; load = 0; expected = 15; routeType = 'krai'; route = 'Без файла' }
    )
    $flights += @{ code = 'KV-501'; date = (& $fmt 10); pct = 90; pickup = 5; routeType = 'krai'; route = 'Период' }
    $flights += @{ code = 'KV-701'; date = (& $fmt 7); pct = 50; pickup = 2; routeType = 'krai'; route = 'Край от' }
    $flights += @{ code = 'KV-140'; date = (& $fmt 14); pct = 50; pickup = 2; routeType = 'krai'; route = 'Край до' }
    $state = @{ lf = 40; dtdFrom = 2; dtdTo = 4; pickupZero = $true; routeType = 'all'; alertsOnly = $false }
    $all = @(Select-WidgetAlerts $flights $state)
    $krai = @(Select-WidgetAlerts $flights (@{ lf = 40; dtdFrom = 2; dtdTo = 4; pickupZero = $true; routeType = 'krai'; alertsOnly = $false }))
    $band = @(Select-WidgetAlerts $flights (@{ lf = 40; dtdFrom = 7; dtdTo = 14; pickupZero = $true; routeType = 'all'; alertsOnly = $false }))
    $alarm = @(Select-WidgetAlerts $flights (@{ lf = 40; dtdFrom = 7; dtdTo = 14; pickupZero = $true; routeType = 'all'; alertsOnly = $true }))
    $codes = @($all | ForEach-Object { ($_.Text -split ' ')[0] })
    $bandCodes = @($band | ForEach-Object { ($_.Text -split ' ')[0] })
    $fail = @()
    if (@($all).Count -ne 3) { $fail += 'all-count' }
    if ($codes -notcontains 'KV-101' -or $codes -notcontains 'KV-201' -or $codes -notcontains 'KV-401') { $fail += 'all-codes' }
    if ($codes -contains 'KV-301' -or $codes -contains 'KV-501') { $fail += 'outside-period' }
    if ($bandCodes -notcontains 'KV-501' -or $bandCodes -notcontains 'KV-701' -or $bandCodes -notcontains 'KV-140' -or @($band).Count -ne 3) { $fail += 'band-7-14' }
    $swapped = @(Select-WidgetAlerts $flights (@{ lf = 40; dtdFrom = 14; dtdTo = 7; pickupZero = $true; routeType = 'all'; alertsOnly = $false }))
    if (@($swapped).Count -ne 3) { $fail += 'swap' }
    if (@($alarm).Count -ne 0) { $fail += 'alarm-hides-healthy' }
    $nullPickup = @($all | Where-Object { $_.Text -like 'KV-401*' })
    if (-not $nullPickup.Count -or $nullPickup[0].Text -notlike '*через 2 дн.*' -or $nullPickup[0].Text -like '*Pickup 0*') { $fail += 'null-pickup' }
    if ($nullPickup[0].Text -notlike '*Загрузка 0*' -or $nullPickup[0].Text -notlike '*Ожидаемая 15*') { $fail += 'load-numbers' }
    $plain = @($all | Where-Object { $_.Text -like 'KV-101*' })
    if (-not $plain.Count -or $plain[0].Text -notlike '*Загрузка -*' -or $plain[0].Text -notlike '*Ожидаемая -*') { $fail += 'load-dash' }
    if (@($krai).Count -ne 2) { $fail += 'krai' }
    if ((Get-WidgetRouteCount $flights 'interregional') -ne 1) { $fail += 'count' }
    if ((Get-WidgetBase 'KV-301') -ne 'KV-101' -or (Get-WidgetBase 'KV-129') -ne 'KV-129') { $fail += 'base' }
    if ((Get-WidgetCapacity 'AT7-Y72') -ne 72 -or (Get-WidgetCapacity 'AN4-Y48/Y48') -ne 46) { $fail += 'cap' }
    if ((Get-WidgetWeek (Get-Date -Year 2026 -Month 10 -Day 2)) -ne 40) { $fail += 'week' }
    $sample = '{"data":{"allData":[["KV-129","02.10.2026","1-2 KJA-TOF","KJA-TOF","AN4-Y48/Y48","48","32","32","2"],["KV-301","02.10.2026","x","x","AT7-Y72","72","10","1","0"]],"expectedLoadData":{"46|KV-129|1|40":30.2,"72|KV-101|1|40":11.1}}}'
    $maps = Get-WidgetLoadMaps $sample
    if ($maps.Loads['KV-129|02.10.2026'].Load -ne 32) { $fail += 'snap-load' }
    if ((Get-WidgetExpected $maps.Expected 46 'KV-129' 1 40) -ne 31) { $fail += 'snap-exp' }
    if ((Get-WidgetExpected $maps.Expected 72 'KV-101' 2 40) -ne 12) { $fail += 'snap-neighbor' }
    if ($null -ne (Get-WidgetExpected $maps.Expected 46 'KV-999' 1 40)) { $fail += 'snap-miss' }
    $neg = Get-WidgetLoadMaps '{"data":{"allData":[["KV-1","01.10.2026","a","b","AN4","46","-3","0","0"]]}}'
    if ($neg.Loads['KV-1|01.10.2026'].Load -ne 0) { $fail += 'neg-sold' }
    $day = (Get-Date).Date.AddDays(1)
    $dateStr = $day.ToString('dd.MM.yyyy')
    $week = Get-WidgetWeek $day
    $expKey = '46|KV-129|1|{0}' -f $week
    $live = '{"data":{"allData":[["KV-129","' + $dateStr + '","seg","KJA-TOF","AN4-Y48/Y48","48","32","32","2"],["KV-302","' + $dateStr + '","x","x","AT7-Y72","72","0","1","0"],["KV-401","' + $dateStr + '","x","x","AN4","46","9","1","0"]],"expectedLoadData":{"' + $expKey + '":30.2}}}'
    $script:loadMaps = Get-WidgetLoadMaps $live
    $filled = @{ code = 'KV-129'; date = $dateStr; pct = 70; pickup = 2; routeType = 'krai'; route = 'T' }
    $kept = @{ code = 'KV-401'; date = $dateStr; pct = 80; pickup = $null; load = 0; expected = 15; routeType = 'krai'; route = 'T' }
    $zero = @{ code = 'KV-302'; date = $dateStr; pct = 10; pickup = 1; routeType = 'krai'; route = 'T' }
    $none = @{ code = 'KV-999'; date = $dateStr; pct = 10; pickup = 1; routeType = 'krai'; route = 'T' }
    $probe = @(Select-WidgetAlerts @($filled, $kept, $zero, $none) @{ lf = 40; dtdFrom = 0; dtdTo = 2; pickupZero = $false; routeType = 'all'; alertsOnly = $false })
    $by = @{}
    foreach ($row in $probe) { $by[($row.Text -split ' ')[0]] = $row.Text }
    if ($by['KV-129'] -notlike '*Загрузка 32*' -or $by['KV-129'] -notlike '*Ожидаемая 31*') { $fail += 'fill-129' }
    if ($by['KV-401'] -notlike '*Загрузка 0*' -or $by['KV-401'] -notlike '*Ожидаемая 15*') { $fail += 'fill-keep' }
    if ($by['KV-302'] -notlike '*Загрузка 0*' -or $by['KV-302'] -notlike '*Ожидаемая -*') { $fail += 'fill-zero' }
    if ($by['KV-999'] -notlike '*Загрузка -*' -or $by['KV-999'] -notlike '*Ожидаемая -*') { $fail += 'fill-miss' }
    $obj = [pscustomobject]@{ code = 'KV-129'; date = $dateStr; pct = 70; pickup = 2; route = 'T' }
    $objText = Get-WidgetLineText $obj
    if ($objText -notlike '*Загрузка 32*' -or $objText -notlike '*Ожидаемая 31*') { $fail += 'psobj' }
    $script:loadMaps = $null
    $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
    $iss.Commands.Add((New-Object System.Management.Automation.Runspaces.SessionStateFunctionEntry('Get-WidgetLoadMaps', ${function:Get-WidgetLoadMaps}.ToString())))
    $space = [runspacefactory]::CreateRunspace($iss)
    $space.Open()
    $shell = [powershell]::Create()
    $shell.Runspace = $space
    [void]$shell.AddScript({ param($Text) Get-WidgetLoadMaps $Text }).AddArgument($sample)
    $handle = $shell.BeginInvoke()
    if (-not $handle.AsyncWaitHandle.WaitOne(20000)) { $fail += 'runspace-timeout' }
    else {
        $out = @($shell.EndInvoke($handle))
        if (-not $out.Count -or $out[0].Loads['KV-129|02.10.2026'].Load -ne 32) { $fail += 'runspace-load' }
    }
    $shell.Dispose()
    $space.Close()
    $space.Dispose()
    if (Test-WidgetOriginUsable -32000 -32000 420 560) { $fail += 'offscreen' }
    $many = @()
    for ($i = 0; $i -lt 40; $i++) { $many += @{ code = ('KV-{0}' -f $i); date = (& $fmt 8); pct = 10; pickup = 1; routeType = 'krai'; route = 'X' } }
    if (@(Select-WidgetAlerts $many @{ lf = 40; dtdFrom = 7; dtdTo = 14; pickupZero = $false; routeType = 'all'; alertsOnly = $false }).Count -ne 40) { $fail += 'no-cap' }
    if ($fail.Count) {
        Write-Output ('FAIL ' + ($fail -join ','))
        exit 1
    }
    Write-Output 'PASS'
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutex = New-Object System.Threading.Mutex($false, 'Local\KrasaviaRmsWidget')
if (-not $mutex.WaitOne(0, $false)) { exit 0 }

$root = Split-Path -Parent $PSScriptRoot
$dataPath = Join-Path $root 'shared\rms-widget.json'
$snapshotPath = Join-Path $root 'shared\snapshot.json'
$uiDir = Join-Path $env:LOCALAPPDATA 'Krasavia'
$uiPath = Join-Path $uiDir 'rms-widget-ui.json'
New-Item -ItemType Directory -Force -Path $uiDir | Out-Null

$ui = @{
    lf = 40
    dtdFrom = 0
    dtdTo = 14
    pickupZero = $true
    alertsOnly = $false
    routeType = 'all'
    topMost = $true
    x = $null
    y = $null
    w = 420
    h = 560
}
if (Test-Path -LiteralPath $uiPath) {
    try {
        $saved = Get-Content -LiteralPath $uiPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved.lf -ge 0 -and $saved.lf -le 100) { $ui.lf = [int]$saved.lf }
        if ($null -ne $saved.dtdFrom -and $saved.dtdFrom -ge 0 -and $saved.dtdFrom -le 90) { $ui.dtdFrom = [int]$saved.dtdFrom }
        if ($null -ne $saved.dtdTo -and $saved.dtdTo -ge 0 -and $saved.dtdTo -le 90) { $ui.dtdTo = [int]$saved.dtdTo }
        elseif ($null -ne $saved.dtd -and $saved.dtd -ge 0 -and $saved.dtd -le 90) { $ui.dtdTo = [int]$saved.dtd; $ui.dtdFrom = 0 }
        if ($null -ne $saved.pickupZero) { $ui.pickupZero = [bool]$saved.pickupZero }
        if ($null -ne $saved.alertsOnly) { $ui.alertsOnly = [bool]$saved.alertsOnly }
        if ($saved.routeType -in @('all', 'krai', 'interregional')) { $ui.routeType = [string]$saved.routeType }
        if ($null -ne $saved.topMost) { $ui.topMost = [bool]$saved.topMost }
        if ($null -ne $saved.x) { $ui.x = [int]$saved.x }
        if ($null -ne $saved.y) { $ui.y = [int]$saved.y }
        if ($saved.w -ge 300) { $ui.w = [int]$saved.w }
        if ($saved.h -ge 220) { $ui.h = [int]$saved.h }
    } catch { }
}

$script:flights = @()
$script:updatedAt = $null
$script:loadedStamp = $null
$script:fileOk = $false
$script:loadMaps = $null
$script:loadJob = $null
$script:loadRunspace = $null
$script:loadShell = $null
$script:loadStamp = $null
$script:loadReading = $false

function Read-WidgetData {
    if (-not (Test-Path -LiteralPath $dataPath)) {
        $script:fileOk = $false
        $script:flights = @()
        $script:updatedAt = $null
        return
    }
    $item = Get-Item -LiteralPath $dataPath
    if ($script:loadedStamp -eq $item.LastWriteTimeUtc -and $script:fileOk) { return }
    try {
        $utf8 = New-Object System.Text.UTF8Encoding $false
        $text = [System.IO.File]::ReadAllText($dataPath, $utf8)
        $data = $text | ConvertFrom-Json
        $script:flights = @($data.flights)
        $script:updatedAt = $data.updatedAt
        $script:loadedStamp = $item.LastWriteTimeUtc
        $script:fileOk = $true
    } catch {
        $script:fileOk = $false
        $script:flights = @()
    }
}

function Get-UiState {
    $route = 'all'
    switch ($combo.SelectedIndex) {
        1 { $route = 'krai' }
        2 { $route = 'interregional' }
    }
    return @{
        lf = [int]$numLf.Value
        dtdFrom = [int]$numFrom.Value
        dtdTo = [int]$numTo.Value
        pickupZero = [bool]$chkPickup.Checked
        alertsOnly = [bool]$chkAlerts.Checked
        routeType = $route
    }
}

function Save-WidgetUi {
    $state = Get-UiState
    $bounds = $form.Bounds
    if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Minimized) {
        $bounds = $form.RestoreBounds
    }
    $x = [int]$bounds.X
    $y = [int]$bounds.Y
    $w = [int]$bounds.Width
    $h = [int]$bounds.Height
    if (-not (Test-WidgetOriginUsable $x $y $w $h)) {
        $w = [Math]::Max(400, [int]$ui.w)
        $h = [Math]::Max(220, [int]$ui.h)
        $origin = Get-WidgetDefaultOrigin $w $h
        $x = $origin.X
        $y = $origin.Y
    }
    $payload = [ordered]@{
        lf = $state.lf
        dtdFrom = $state.dtdFrom
        dtdTo = $state.dtdTo
        pickupZero = $state.pickupZero
        alertsOnly = $state.alertsOnly
        routeType = $state.routeType
        topMost = [bool]$form.TopMost
        x = $x
        y = $y
        w = $w
        h = $h
    }
    $json = $payload | ConvertTo-Json
    $utf8 = New-Object System.Text.UTF8Encoding $true
    [System.IO.File]::WriteAllText($uiPath, $json, $utf8)
}

function Update-AlertList {
    $state = Get-UiState
    $alerts = @(Select-WidgetAlerts $script:flights $state)
    $list.BeginUpdate()
    $list.Items.Clear()
    if (-not $script:fileOk) {
        [void]$list.Items.Add('Нет файла данных.')
        [void]$list.Items.Add('Откройте сайт, нажмите «Загрузить»')
        [void]$list.Items.Add('и подключите папку приложения.')
    } elseif (-not @($script:flights).Count) {
        [void]$list.Items.Add('В файле нет предстоящих рейсов.')
    } elseif (-not $alerts.Count) {
        $typed = Get-WidgetRouteCount $script:flights $state.routeType
        if ($state.routeType -ne 'all' -and $typed -eq 0) {
            [void]$list.Items.Add('Нет рейсов этого типа.')
        } else {
            $period = Get-WidgetPeriod $state
            [void]$list.Items.Add(('В периоде от {0} до {1} дней рейсов нет.' -f $period.From, $period.To))
        }
    } else {
        foreach ($row in @($alerts)) { [void]$list.Items.Add($row.Text) }
    }
    $list.EndUpdate()
    $caption = 'КРАСАВИА · Виджет'
    if ($alerts.Count) { $caption = '{0} · {1}' -f $caption, $alerts.Count }
    $form.Text = $caption

    if (-not $script:fileOk) {
        $status.Text = 'Файл ещё не создан'
        return
    }
    $when = $null
    try { if ($script:updatedAt) { $when = [datetime]$script:updatedAt } } catch { $when = $null }
    if ($when) {
        $line = 'Данные на {0:dd.MM.yyyy HH:mm}' -f $when.ToLocalTime()
        $count = Get-WidgetRouteCount $script:flights $state.routeType
        $kind = ''
        if ($state.routeType -eq 'krai') { $kind = ', краевые' }
        elseif ($state.routeType -eq 'interregional') { $kind = ', межрегиональные' }
        $period = Get-WidgetPeriod $state
        $line = '{0} · показано {1} · период {2}–{3} дн. · в файле {4}{5}' -f $line, @($alerts).Count, $period.From, $period.To, $count, $kind
        if (((Get-Date) - $when.ToLocalTime()).TotalHours -gt 6) {
            $line = $line + ' · сайт давно не обновлял'
        }
        if ($script:loadReading) { $line = $line + ' · дочитываю загрузку' }
        $status.Text = $line
    } else {
        $status.Text = 'Файл данных без даты'
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'КРАСАВИА · Виджет'
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.BackColor = [System.Drawing.Color]::White
$form.ForeColor = [System.Drawing.Color]::FromArgb(1, 42, 74)
$form.MinimumSize = New-Object System.Drawing.Size(400, 280)
$formWidth = [Math]::Max(400, [int]$ui.w)
$formHeight = [Math]::Max(220, [int]$ui.h)
$form.Size = New-Object System.Drawing.Size($formWidth, $formHeight)
$form.TopMost = [bool]$ui.topMost
$form.ShowInTaskbar = $true
$form.StartPosition = 'Manual'
$form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
if ($null -ne $ui.x -and $null -ne $ui.y -and (Test-WidgetOriginUsable ([int]$ui.x) ([int]$ui.y) $formWidth $formHeight)) {
    $form.Location = New-Object System.Drawing.Point([int]$ui.x, [int]$ui.y)
} else {
    $form.Location = Get-WidgetDefaultOrigin $formWidth $formHeight
}

$header = New-Object System.Windows.Forms.Label
$header.Text = '  Сводка и тревожная лента'
$header.Dock = 'Top'
$header.Height = 36
$header.TextAlign = 'MiddleLeft'
$header.BackColor = [System.Drawing.Color]::FromArgb(1, 42, 74)
$header.ForeColor = [System.Drawing.Color]::White
$header.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)

$controls = New-Object System.Windows.Forms.Panel
$controls.Dock = 'Top'
$controls.Height = 164
$controls.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 4)

$lblType = New-Object System.Windows.Forms.Label
$lblType.Text = 'Тип рейса'
$lblType.Location = New-Object System.Drawing.Point(10, 6)
$lblType.AutoSize = $true

$combo = New-Object System.Windows.Forms.ComboBox
$combo.DropDownStyle = 'DropDownList'
$combo.Location = New-Object System.Drawing.Point(110, 2)
$combo.Width = 210
$combo.Items.AddRange(@('Все', 'Краевые', 'Межрегиональные'))
$combo.SelectedIndex = 0
if ($ui.routeType -eq 'krai') { $combo.SelectedIndex = 1 }
elseif ($ui.routeType -eq 'interregional') { $combo.SelectedIndex = 2 }

$lblFrom = New-Object System.Windows.Forms.Label
$lblFrom.Text = 'От, дней'
$lblFrom.Location = New-Object System.Drawing.Point(10, 36)
$lblFrom.AutoSize = $true
$numFrom = New-Object System.Windows.Forms.NumericUpDown
$numFrom.Minimum = 0
$numFrom.Maximum = 90
$numFrom.Value = [decimal]$ui.dtdFrom
$numFrom.Location = New-Object System.Drawing.Point(78, 32)
$numFrom.Width = 58

$lblTo = New-Object System.Windows.Forms.Label
$lblTo.Text = 'До, дней'
$lblTo.Location = New-Object System.Drawing.Point(148, 36)
$lblTo.AutoSize = $true
$numTo = New-Object System.Windows.Forms.NumericUpDown
$numTo.Minimum = 0
$numTo.Maximum = 90
$numTo.Value = [decimal]$ui.dtdTo
$numTo.Location = New-Object System.Drawing.Point(214, 32)
$numTo.Width = 58

$lblLf = New-Object System.Windows.Forms.Label
$lblLf.Text = 'ЗПК ниже, %'
$lblLf.Location = New-Object System.Drawing.Point(10, 68)
$lblLf.AutoSize = $true
$numLf = New-Object System.Windows.Forms.NumericUpDown
$numLf.Minimum = 0
$numLf.Maximum = 100
$numLf.Value = [decimal]$ui.lf
$numLf.Location = New-Object System.Drawing.Point(100, 64)
$numLf.Width = 58

$chkAlerts = New-Object System.Windows.Forms.CheckBox
$chkAlerts.Text = 'Только тревоги'
$chkAlerts.Location = New-Object System.Drawing.Point(170, 66)
$chkAlerts.AutoSize = $true
$chkAlerts.Checked = [bool]$ui.alertsOnly

$chkPickup = New-Object System.Windows.Forms.CheckBox
$chkPickup.Text = 'В тревоге: pickup ровно 0'
$chkPickup.Location = New-Object System.Drawing.Point(10, 98)
$chkPickup.AutoSize = $true
$chkPickup.Checked = [bool]$ui.pickupZero

$chkTop = New-Object System.Windows.Forms.CheckBox
$chkTop.Text = 'Поверх всех окон'
$chkTop.Location = New-Object System.Drawing.Point(10, 124)
$chkTop.AutoSize = $true
$chkTop.Checked = [bool]$ui.topMost

$controls.Controls.AddRange(@($lblType, $combo, $lblFrom, $numFrom, $lblTo, $numTo, $lblLf, $numLf, $chkAlerts, $chkPickup, $chkTop))

$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Top'
$status.Height = 36
$status.Padding = New-Object System.Windows.Forms.Padding(10, 4, 10, 0)
$status.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)

$hint = New-Object System.Windows.Forms.Label
$hint.Dock = 'Bottom'
$hint.Height = 34
$hint.Padding = New-Object System.Windows.Forms.Padding(10, 0, 10, 6)
$hint.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
$hint.Text = 'Период — дни до вылета, например от 7 до 14. Список прокручивается целиком. Если загрузки или ожидаемой нет, стоит дефис. Прочерк в pickup — нет файла, это не ноль.'

$list = New-Object System.Windows.Forms.ListBox
$list.Dock = 'Fill'
$list.BorderStyle = 'None'
$list.IntegralHeight = $false
$list.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$list.HorizontalScrollbar = $true

$form.Controls.Add($list)
$form.Controls.Add($hint)
$form.Controls.Add($status)
$form.Controls.Add($controls)
$form.Controls.Add($header)

$onChange = {
    $form.TopMost = $chkTop.Checked
    Save-WidgetUi
    Update-AlertList
}
$combo.Add_SelectedIndexChanged($onChange)
$numFrom.Add_ValueChanged($onChange)
$numTo.Add_ValueChanged($onChange)
$numLf.Add_ValueChanged($onChange)
$chkAlerts.Add_CheckedChanged($onChange)
$chkPickup.Add_CheckedChanged($onChange)
$chkTop.Add_CheckedChanged($onChange)
$form.Add_FormClosing({ Save-WidgetUi })
$form.Add_FormClosed({
    try { if ($script:widgetTimer) { $script:widgetTimer.Stop() } } catch { }
    Stop-WidgetLoadLookup
    try { $mutex.ReleaseMutex() | Out-Null } catch { }
    $mutex.Dispose()
})

$timer = New-Object System.Windows.Forms.Timer
$script:widgetTimer = $timer
$timer.Interval = 15000
$timer.Add_Tick({
    $before = $script:loadedStamp
    Read-WidgetData
    $finished = Complete-WidgetLoadLookup
    if (-not $script:loadReading) { Start-WidgetLoadLookup }
    if ($finished -or $script:loadedStamp -ne $before -or -not $script:fileOk) { Update-AlertList }
})
$timer.Start()

Read-WidgetData
Start-WidgetLoadLookup
Update-AlertList
[void]$form.ShowDialog()
$timer.Stop()
Stop-WidgetLoadLookup
