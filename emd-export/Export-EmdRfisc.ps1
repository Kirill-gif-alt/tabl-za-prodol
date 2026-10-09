# =============================================
# EMD с MCO_TYPE rfisc: IP1, IP2, KV0..KV9
# Корень: \\192.168.10.20\files\ГОД\МЕСЯЦ\ДЕНЬ\*.xml
# В одном файле могут лежать два XML-документа подряд.
# Запуск: Export-EmdRfisc.cmd
# =============================================

param(
    [switch]$NoGui,
    [string]$RootPath,
    [string]$From,
    [string]$To,
    [string]$OutputCsv
)

$ErrorActionPreference = 'Stop'

if (-not $NoGui) {
    $apartment = [System.Threading.Thread]::CurrentThread.ApartmentState
    if ($apartment -ne 'STA') {
        $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        # Start-Process не берёт элементы массива в кавычки: путь с пробелом («11 КС») ломал перезапуск.
        $argLine = '-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $PSCommandPath
        if ($RootPath) { $argLine += ' -RootPath "{0}"' -f $RootPath.Trim().Trim('"').TrimEnd('\') }
        Start-Process -FilePath $exe -ArgumentList $argLine | Out-Null
        return
    }
}

function ConvertTo-SharePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $Path = $Path.Trim().Trim('"')
    if ($Path.StartsWith('\\?\UNC\')) {
        $Path = '\\' + $Path.Substring(8)
    } elseif ($Path.StartsWith('\\?\')) {
        $Path = $Path.Substring(4)
    }
    return $Path.TrimEnd('\')
}

function Get-DayIndex {
    param([string]$Root)
    $Root = ConvertTo-SharePath $Root
    $index = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    if (-not (Test-Path -LiteralPath $Root)) {
        return $index
    }
    foreach ($yearPath in [System.IO.Directory]::EnumerateDirectories($Root)) {
        $yearName = [System.IO.Path]::GetFileName($yearPath)
        if ($yearName -notmatch '^\d{4}$') { continue }
        foreach ($monthPath in [System.IO.Directory]::EnumerateDirectories($yearPath)) {
            $monthName = [System.IO.Path]::GetFileName($monthPath)
            if ($monthName -notmatch '^\d{1,2}$') { continue }
            $monthNo = [int]$monthName
            if ($monthNo -lt 1 -or $monthNo -gt 12) { continue }
            foreach ($dayPath in [System.IO.Directory]::EnumerateDirectories($monthPath)) {
                $dayName = [System.IO.Path]::GetFileName($dayPath)
                if ($dayName -notmatch '^\d{1,2}$') { continue }
                try {
                    $date = New-Object datetime ([int]$yearName), $monthNo, ([int]$dayName)
                } catch {
                    continue
                }
                $index[$date.ToString('yyyy-MM-dd')] = $dayPath
            }
        }
    }
    return $index
}

function Export-EmdPeriod {
    param(
        [string]$Root,
        [datetime]$From,
        [datetime]$To,
        [string]$OutputCsv,
        $DayIndex,
        $Sync,
        [string[]]$Types,
        [string[]]$OpTypes,
        [string[]]$McoValues,
        [string[]]$Columns
    )

    function Split-XmlDocuments {
        param([string]$Text)
        $parts = New-Object System.Collections.Generic.List[string]
        if ([string]::IsNullOrWhiteSpace($Text)) { return $parts }
        $decls = [regex]::Matches($Text, '<\?xml')
        if ($decls.Count -eq 0) {
            $parts.Add($Text.Trim())
            return $parts
        }
        for ($i = 0; $i -lt $decls.Count; $i++) {
            $start = $decls[$i].Index
            $end = if ($i + 1 -lt $decls.Count) { $decls[$i + 1].Index } else { $Text.Length }
            $chunk = $Text.Substring($start, $end - $start).Trim()
            if ($chunk) { $parts.Add($chunk) }
        }
        return $parts
    }

    function Read-XmlDocument {
        param([string]$Chunk)
        $doc = New-Object System.Xml.XmlDocument
        $doc.XmlResolver = $null
        $doc.LoadXml($Chunk)
        return $doc
    }

    function Get-FlyDates {
        param($Ticket)
        $dates = New-Object System.Collections.Generic.List[string]
        foreach ($seg in $Ticket.SelectNodes('SEGMENTS/SEGMENT')) {
            $node = $seg.SelectSingleNode('FLYDATE')
            if (-not $node) { continue }
            $fly = $node.InnerText.Trim()
            if (-not $fly) { continue }
            if ($fly.Length -eq 7) { $fly = '0' + $fly }
            if (-not $dates.Contains($fly)) { $dates.Add($fly) }
        }
        return ($dates -join ';')
    }

    function Get-ChildText {
        param($Parent, [string]$Name)
        $node = Get-DirectChild -Parent $Parent -Name $Name
        if (-not $node) { return '' }
        return $node.InnerText.Trim()
    }

    function Write-ProgressLine {
        param([string]$Message)
        if ($Sync -and $Sync.Log) { $Sync.Log.Enqueue($Message) }
        else { Write-Host $Message }
    }

    function New-FilterSet {
        param($Values)
        if ($null -eq $Values) { return $null }
        $set = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $pending = New-Object System.Collections.Queue
        foreach ($v in @($Values)) { $pending.Enqueue($v) }
        while ($pending.Count -gt 0) {
            $v = $pending.Dequeue()
            if ($null -eq $v) { continue }
            if ($v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) {
                foreach ($inner in $v) { $pending.Enqueue($inner) }
                continue
            }
            $t = $v.ToString().Trim()
            if ($t -and $t -ne 'System.Object[]') { [void]$set.Add($t) }
        }
        return ,$set
    }

    function Test-Selected {
        param($Set, [string]$Value)
        if ($null -eq $Set) { return $true }
        $items = @($Set)
        if ($items.Count -eq 0) { return $true }
        if ([string]::IsNullOrWhiteSpace($Value)) { $Value = '(пусто)' }
        $wanted = $Value.Trim()
        foreach ($item in $items) {
            if ([string]$item -eq $wanted) { return $true }
        }
        return $false
    }

    function Get-NamedChildren {
        param($Parent, [string]$Name)
        $list = New-Object System.Collections.Generic.List[System.Xml.XmlElement]
        if ($Parent -and $Parent.ChildNodes) {
            for ($i = 0; $i -lt $Parent.ChildNodes.Count; $i++) {
                $child = $Parent.ChildNodes.Item($i)
                if ($child.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
                if ($child.LocalName.Equals($Name, [System.StringComparison]::OrdinalIgnoreCase)) {
                    [void]$list.Add($child)
                }
            }
        }
        return ,$list
    }

    function Get-DirectChild {
        param($Parent, [string]$Name)
        $nodes = Get-NamedChildren -Parent $Parent -Name $Name
        if ($nodes.Count -eq 0) { return $null }
        return $nodes[0]
    }

    function Get-AttributeIgnoreCase {
        param($Node, [string]$Name)
        if (-not $Node -or -not $Node.Attributes) { return '' }
        foreach ($attr in @($Node.Attributes)) {
            if ($attr.LocalName.Equals($Name, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $attr.Value.Trim()
            }
        }
        return ''
    }

    function Test-VoidSegment {
        param($Segment)
        $node = Get-DirectChild -Parent $Segment -Name 'IS_VOID'
        if (-not $node) { return $false }
        return $node.InnerText.Trim() -match '^(T|Y|1|TRUE)$'
    }

    function Get-SegmentNodes {
        param($Ticket)
        $parent = Get-DirectChild -Parent $Ticket -Name 'SEGMENTS'
        if (-not $parent) { return ,(New-Object System.Collections.Generic.List[System.Xml.XmlElement]) }
        $nodes = Get-NamedChildren -Parent $parent -Name 'SEGMENT'
        return ,$nodes
    }

    function Normalize-Amount {
        param([string]$Text)
        if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
        $t = $Text.Trim().Replace([string][char]0x00A0, '').Replace([string]' ', '')
        if ($t -match '^\d+(,\d+)?$') { return ($t.Replace(',', '.')) }
        if ($t -match '^\d+\.\d+$' -or $t -match '^\d+$') { return $t }
        return $Text.Trim()
    }

    function Convert-Amount {
        param([string]$Text)
        $t = Normalize-Amount $Text
        $parsed = 0.0
        $ok = [double]::TryParse(
            $t,
            [System.Globalization.NumberStyles]::Float,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [ref]$parsed
        )
        if (-not $ok) { return $null }
        return [double]$parsed
    }

    function Get-MoneyText {
        param($Node)
        if (-not $Node) { return '' }
        $text = $Node.InnerText.Trim()
        if ($text) { return (Normalize-Amount $text) }
        foreach ($attr in @($Node.Attributes)) {
            $attrName = $attr.LocalName
            if ($attrName -match 'vat|rate') { continue }
            if ($attrName -match '^(amount|value|sum|fare)$') {
                if ($attr.Value.Trim()) { return (Normalize-Amount $attr.Value) }
            }
        }
        return ''
    }

    function Get-JoinedSegment {
        param($Ticket, [string]$Name, [int]$SegmentIndex = -1)
        $vals = New-Object System.Collections.Generic.List[string]
        $segs = Get-SegmentNodes -Ticket $Ticket
        $chosen = New-Object System.Collections.Generic.List[System.Xml.XmlElement]
        if ($SegmentIndex -ge 0) {
            if ($SegmentIndex -ge $segs.Count) { return '' }
            $one = $segs[$SegmentIndex]
            if (Test-VoidSegment $one) { return '' }
            [void]$chosen.Add($one)
        } else {
            for ($si = 0; $si -lt $segs.Count; $si++) {
                if (-not (Test-VoidSegment $segs[$si])) { [void]$chosen.Add($segs[$si]) }
            }
            if ($chosen.Count -eq 0) {
                for ($si = 0; $si -lt $segs.Count; $si++) { [void]$chosen.Add($segs[$si]) }
            }
        }
        $moneyName = @('FARE', 'NFARE', 'OFARE', 'VALUE') -contains $Name
        foreach ($seg in $chosen) {
            $node = Get-DirectChild -Parent $seg -Name $Name
            if (-not $node) { continue }
            $v = $node.InnerText.Trim()
            if ($moneyName) { $v = Get-MoneyText $node }
            if ($Name -eq 'FLYDATE' -and $v.Length -eq 7) { $v = '0' + $v }
            if ($v) { [void]$vals.Add($v) }
        }
        return ($vals -join ';')
    }

    function Read-XmlText {
        param([string]$Path)
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
            return [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
        }
        if ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
            return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
        }
        if ($bytes.Length -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
            return [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
        }
        $headLen = [Math]::Min(240, $bytes.Length)
        $head = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $headLen)
        $encName = 'utf-8'
        $declared = [regex]::Match($head, 'encoding\s*=\s*["'']([^"'']+)["'']', 'IgnoreCase')
        if ($declared.Success) { $encName = $declared.Groups[1].Value.Trim() }
        switch ($encName.ToLowerInvariant()) {
            'utf8' { $encName = 'utf-8' }
            'cp1251' { $encName = 'windows-1251' }
            'win-1251' { $encName = 'windows-1251' }
            'windows1251' { $encName = 'windows-1251' }
        }
        $enc = [System.Text.Encoding]::UTF8
        try { $enc = [System.Text.Encoding]::GetEncoding($encName) } catch { }
        $text = $enc.GetString($bytes)
        if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
        return $text
    }

    function Test-FileHasElement {
        param([string]$Text, [string]$Tag, [string]$Value)
        $needle = '<' + $Tag + '>' + $Value + '</' + $Tag + '>'
        if ($Text.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
        $pattern = '<' + [regex]::Escape($Tag) + '(?:\s[^>]*)?>\s*' + [regex]::Escape($Value) + '\s*</' + [regex]::Escape($Tag) + '>'
        return [regex]::IsMatch($Text, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }

    function Get-FieldValue {
        param($Ticket, [string]$Name, [int]$SegmentIndex = -1)
        $mcoNode = Get-DirectChild -Parent $Ticket -Name 'MCO_TYPE'
        if ($Name -eq 'RFISC') {
            if (-not $mcoNode) { return '' }
            return (Get-AttributeIgnoreCase -Node $mcoNode -Name 'rfisc')
        }
        if ($Name -eq 'RFIC') {
            if (-not $mcoNode) { return '' }
            return (Get-AttributeIgnoreCase -Node $mcoNode -Name 'rfic')
        }
        if ($Name -eq 'MCO_TYPE') {
            if (-not $mcoNode) { return '' }
            return $mcoNode.InnerText.Trim()
        }
        $direct = Get-DirectChild -Parent $Ticket -Name $Name
        if ($direct) {
            $v = $direct.InnerText.Trim()
            if ($Name -eq 'FARE' -or $Name -eq 'OFARE') { $v = Get-MoneyText $direct }
            if ($v) {
                if ($Name -eq 'FLYDATE' -and $v.Length -eq 7) { $v = '0' + $v }
                return $v
            }
        }
        $joined = Get-JoinedSegment -Ticket $Ticket -Name $Name -SegmentIndex $SegmentIndex
        if ($joined) { return $joined }
        if ($mcoNode) {
            $attr = Get-AttributeIgnoreCase -Node $mcoNode -Name $Name
            if ($attr) { return $attr }
        }
        return ''
    }

    # Пустой массив из окна означает «не фильтровать». $null бывает только у запуска без окна.
    if (-not $PSBoundParameters.ContainsKey('Types') -or $null -eq $Types) {
        if (-not $PSBoundParameters.ContainsKey('Types')) { $Types = @('EMD') }
        else { $Types = New-Object string[] 0 }
    }
    if (-not $PSBoundParameters.ContainsKey('McoValues') -or $null -eq $McoValues) {
        if (-not $PSBoundParameters.ContainsKey('McoValues')) {
            $McoValues = @(
                'IP1', 'IP2',
                'KV0', 'KV1', 'KV2', 'KV3', 'KV4', 'KV5', 'KV6', 'KV7', 'KV8', 'KV9'
            )
        } else {
            $McoValues = New-Object string[] 0
        }
    }
    if (-not $PSBoundParameters.ContainsKey('OpTypes') -or $null -eq $OpTypes) {
        $OpTypes = New-Object string[] 0
    }
    if (-not $PSBoundParameters.ContainsKey('Columns') -or $null -eq $Columns -or @($Columns).Count -eq 0) {
        $Columns = @('BSONUM', 'FARE', 'PNR', 'FLYDATE', 'OPTYPE', 'TRANS_TYPE', 'RFISC', 'FIO')
    }
    $typeSet = New-FilterSet $Types
    $opSet = New-FilterSet $OpTypes
    $mcoSet = New-FilterSet $McoValues
    $columnList = @($Columns | Where-Object { $_ -and $_.ToString().Trim() } | ForEach-Object { $_.ToString().Trim() })

    if (-not $DayIndex) { $DayIndex = Get-DayIndex -Root $Root }

    $fromDate = $From.Date
    $toDate = $To.Date
    if ($fromDate -gt $toDate) {
        $swap = $fromDate
        $fromDate = $toDate
        $toDate = $swap
    }

    $days = New-Object System.Collections.Generic.List[object]
    $cursor = $fromDate
    while ($cursor -le $toDate) {
        $key = $cursor.ToString('yyyy-MM-dd')
        if ($DayIndex.ContainsKey($key)) {
            $days.Add([PSCustomObject]@{ Date = $cursor; Path = $DayIndex[$key] })
        }
        $cursor = $cursor.AddDays(1)
    }

    if ($Sync) {
        $Sync.DaysTotal = $days.Count
        $Sync.DaysDone = 0
        $Sync.Files = 0
        $Sync.Rows = 0
        $Sync.Errors = 0
    }

    $rows = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    $filesRead = 0
    $docErrors = 0
    $dualFiles = 0
    $cancelled = $false

    foreach ($day in $days) {
        if ($Sync -and $Sync.Cancel) { $cancelled = $true; break }
        try {
            $dayFiles = @([System.IO.Directory]::EnumerateFiles($day.Path, '*.xml') | Sort-Object)
        } catch {
            $docErrors++
            if ($Sync) { $Sync.Errors = $docErrors }
            Write-ProgressLine ("Не открылась папка {0}: {1}" -f $day.Path, $_.Exception.Message)
            if ($Sync) { $Sync.DaysDone = $Sync.DaysDone + 1 }
            continue
        }
        $before = $rows.Count
        if ($Sync) { $Sync.Day = $day.Date.ToString('dd.MM.yyyy') }

        foreach ($file in $dayFiles) {
            if ($Sync -and $Sync.Cancel) { $cancelled = $true; break }
            $filesRead++
            if ($Sync) { $Sync.Files = $filesRead }

            try {
                $text = Read-XmlText -Path $file
            } catch {
                $docErrors++
                if ($Sync) { $Sync.Errors = $docErrors }
                Write-ProgressLine ("Ошибка чтения: {0} — {1}" -f [System.IO.Path]::GetFileName($file), $_.Exception.Message)
                continue
            }

            if ($typeSet -and $typeSet.Count -gt 0) {
                $typeHit = $false
                foreach ($t in $typeSet) {
                    if ($t -eq '(пусто)') { continue }
                    if (Test-FileHasElement -Text $text -Tag 'TYPE' -Value $t) { $typeHit = $true; break }
                }
                if (-not $typeHit -and -not $typeSet.Contains('(пусто)')) { continue }
            }
            if ($opSet -and $opSet.Count -gt 0) {
                $opHit = $false
                foreach ($t in $opSet) {
                    if ($t -eq '(пусто)') { continue }
                    if (Test-FileHasElement -Text $text -Tag 'OPTYPE' -Value $t) { $opHit = $true; break }
                }
                if (-not $opHit -and -not $opSet.Contains('(пусто)')) { continue }
            }
            if ($mcoSet -and $mcoSet.Count -gt 0 -and -not $mcoSet.Contains('(пусто)')) {
                $mcoHit = $false
                $hasShort = $false
                foreach ($t in $mcoSet) {
                    if ($t.Length -lt 2) { $hasShort = $true; continue }
                    if ($text.IndexOf($t, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $mcoHit = $true; break }
                }
                if (-not $mcoHit -and -not $hasShort) { continue }
            }

            $text = $text.TrimStart([char]0xFEFF)
            $chunks = @(Split-XmlDocuments -Text $text)
            if ($chunks.Count -gt 1) { $dualFiles++ }

            foreach ($chunk in $chunks) {
                $documents = New-Object System.Collections.Generic.List[System.Xml.XmlDocument]
                try {
                    $documents.Add((Read-XmlDocument -Chunk $chunk))
                } catch {
                    $pieces = [regex]::Split($chunk, '(?<=</TICKETS>)')
                    $pieceOk = $false
                    foreach ($piece in $pieces) {
                        $piece = $piece.Trim()
                        if (-not $piece) { continue }
                        try {
                            $documents.Add((Read-XmlDocument -Chunk $piece))
                            $pieceOk = $true
                        } catch {
                            $docErrors++
                            if ($Sync) { $Sync.Errors = $docErrors }
                            Write-ProgressLine ("Ошибка XML: {0} — {1}" -f [System.IO.Path]::GetFileName($file), $_.Exception.Message)
                        }
                    }
                    if (-not $pieceOk) { continue }
                }

                $docNo = 0
                foreach ($xml in $documents) {
                    $docNo++
                    $ticketNodes = New-Object System.Collections.Generic.List[System.Xml.XmlElement]
                    if ($xml.DocumentElement) {
                        $ticketNodes = Get-NamedChildren -Parent $xml.DocumentElement -Name 'TICKET'
                        if ($ticketNodes.Count -eq 0 -and $xml.DocumentElement.LocalName.Equals('TICKET', [System.StringComparison]::OrdinalIgnoreCase)) {
                            [void]$ticketNodes.Add($xml.DocumentElement)
                        }
                    }
                    $localNo = 0
                    foreach ($ticket in $ticketNodes) {
                        $localNo++
                        $typeNode = Get-DirectChild -Parent $ticket -Name 'TYPE'
                        $typeValue = ''
                        if ($typeNode) { $typeValue = $typeNode.InnerText.Trim() }
                        if (-not (Test-Selected -Set $typeSet -Value $typeValue)) { continue }
                        $optype = Get-ChildText -Parent $ticket -Name 'OPTYPE'
                        if (-not (Test-Selected -Set $opSet -Value $optype)) { continue }
                        $mco = Get-DirectChild -Parent $ticket -Name 'MCO_TYPE'
                        $rfisc = ''
                        $rfic = ''
                        $mcoText = ''
                        if ($mco) {
                            $rfisc = Get-AttributeIgnoreCase -Node $mco -Name 'rfisc'
                            $rfic = Get-AttributeIgnoreCase -Node $mco -Name 'rfic'
                            $mcoText = $mco.InnerText.Trim()
                        }
                        $coupons = New-Object System.Collections.Generic.List[object]
                        $couponParent = Get-DirectChild -Parent $ticket -Name 'EMDCOUPONS'
                        $couponNodes = New-Object System.Collections.Generic.List[System.Xml.XmlElement]
                        if ($couponParent) { $couponNodes = Get-NamedChildren -Parent $couponParent -Name 'EMDCOUPON' }
                        for ($ci = 0; $ci -lt $couponNodes.Count; $ci++) {
                            $couponNode = $couponNodes[$ci]
                            $reason = Get-DirectChild -Parent $couponNode -Name 'REASON'
                            $couponRfisc = ''
                            if ($reason) { $couponRfisc = Get-AttributeIgnoreCase -Node $reason -Name 'rfisc' }
                            $coupons.Add([PSCustomObject]@{
                                Index = $ci
                                No    = (Get-ChildText -Parent $couponNode -Name 'COUPON_NO')
                                Rfisc = $couponRfisc
                                Value = (Get-MoneyText (Get-DirectChild -Parent $couponNode -Name 'VALUE'))
                            }) | Out-Null
                        }
                        $matchedCoupons = New-Object System.Collections.Generic.List[object]
                        if ($mcoSet -and $mcoSet.Count -gt 0) {
                            $mcoOk = $false
                            foreach ($token in @($rfisc, $mcoText, $rfic)) {
                                if ($token -and $mcoSet.Contains($token)) { $mcoOk = $true; break }
                            }
                            foreach ($coupon in $coupons) {
                                if ($coupon.Rfisc -and $mcoSet.Contains($coupon.Rfisc)) {
                                    $matchedCoupons.Add($coupon) | Out-Null
                                }
                            }
                            if (-not $rfisc -and -not $mcoText -and -not $rfic -and $coupons.Count -eq 0 -and $mcoSet.Contains('(пусто)')) {
                                $mcoOk = $true
                            }
                            if (-not $mcoOk -and $matchedCoupons.Count -eq 0) { continue }
                        }
                        $bsonum = Get-ChildText -Parent $ticket -Name 'BSONUM'
                        $trans = Get-ChildText -Parent $ticket -Name 'TRANS_TYPE'
                        $fio = Get-ChildText -Parent $ticket -Name 'FIO'
                        $pnr = Get-ChildText -Parent $ticket -Name 'PNR'
                        $units = @($null)
                        if ($matchedCoupons.Count -gt 0 -and $coupons.Count -gt 1) {
                            $headerBeyondCoupons = $false
                            if ($mcoText -and $mcoSet -and $mcoSet.Contains($mcoText) -and -not $mcoText.Equals($rfisc, [System.StringComparison]::OrdinalIgnoreCase)) {
                                $headerBeyondCoupons = $true
                            }
                            if ($rfic -and $mcoSet -and $mcoSet.Contains($rfic)) { $headerBeyondCoupons = $true }
                            if ($rfisc -and $mcoSet -and $mcoSet.Contains($rfisc)) {
                                $seenOnCoupon = $false
                                foreach ($coupon in $matchedCoupons) {
                                    if ($coupon.Rfisc.Equals($rfisc, [System.StringComparison]::OrdinalIgnoreCase)) { $seenOnCoupon = $true; break }
                                }
                                if (-not $seenOnCoupon) { $headerBeyondCoupons = $true }
                            }
                            if (-not $headerBeyondCoupons) { $units = @($matchedCoupons.ToArray()) }
                        }
                        if ($units.Count -gt 1 -and $units.Count -eq $coupons.Count) {
                            $sum = 0.0
                            $sumOk = $true
                            foreach ($u in $units) {
                                $n = Convert-Amount $u.Value
                                if ($null -eq $n) { $sumOk = $false; break }
                                $sum += [double]$n
                            }
                            $docFare = Convert-Amount (Get-MoneyText (Get-DirectChild -Parent $ticket -Name 'FARE'))
                            if ($sumOk -and $null -ne $docFare -and [Math]::Abs($sum - [double]$docFare) -gt 0.009) {
                                Write-ProgressLine ("Сумма купонов {0} не равна FARE {1}, билет {2}, {3}" -f $sum, $docFare, $bsonum, [System.IO.Path]::GetFileName($file))
                            }
                        }
                        $segmentCount = (Get-SegmentNodes -Ticket $ticket).Count
                        foreach ($unit in $units) {
                            $segIndex = -1
                            $unitRfisc = $rfisc
                            $unitNo = ''
                            $unitIndex = ''
                            if ($null -ne $unit) {
                                $unitRfisc = $unit.Rfisc
                                $unitNo = $unit.No
                                $unitIndex = [string]$unit.Index
                                if ($segmentCount -eq $coupons.Count) { $segIndex = [int]$unit.Index }
                            }
                            $ordered = [ordered]@{}
                            foreach ($colName in $columnList) {
                                $ordered[$colName] = Get-FieldValue -Ticket $ticket -Name $colName -SegmentIndex $segIndex
                            }
                            if ($null -ne $unit) {
                                if ($ordered.Contains('FARE')) { $ordered['FARE'] = $unit.Value }
                                if ($ordered.Contains('RFISC') -and $unit.Rfisc) { $ordered['RFISC'] = $unit.Rfisc }
                                if ($ordered.Contains('COUPON_NO')) { $ordered['COUPON_NO'] = $unit.No }
                            } elseif ($ordered.Contains('RFISC') -and ($rfisc -or $coupons.Count -gt 0)) {
                                $allCodes = New-Object System.Collections.Generic.List[string]
                                $seenCodes = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                                if ($rfisc -and $seenCodes.Add($rfisc)) { [void]$allCodes.Add($rfisc) }
                                foreach ($coupon in $coupons) {
                                    if ($coupon.Rfisc -and $seenCodes.Add($coupon.Rfisc)) { [void]$allCodes.Add($coupon.Rfisc) }
                                }
                                if ($allCodes.Count -gt 0) { $ordered['RFISC'] = ($allCodes -join ';') }
                            }
                            $keyId = $bsonum
                            if (-not $keyId) {
                                $keyId = '{0}#{1}.{2}' -f [System.IO.Path]::GetFileName($file), $docNo, $localNo
                            }
                            $key = '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}' -f $keyId, $optype.ToUpperInvariant(), $trans.ToUpperInvariant(), $fio, $pnr, $unitIndex, $unitNo, $unitRfisc.ToUpperInvariant()
                            $rows[$key] = [PSCustomObject]$ordered
                        }
                    }
                }
            }
            if ($Sync) { $Sync.Rows = $rows.Count }
        }

        $added = $rows.Count - $before
        Write-ProgressLine ("{0}  {1}  xml: {2}  новых строк: {3}" -f $day.Date.ToString('dd.MM.yyyy'), $day.Path, $dayFiles.Count, $added)
        if ($Sync) {
            $Sync.DaysDone = $Sync.DaysDone + 1
            $Sync.Rows = $rows.Count
        }
        if ($cancelled) { break }
    }

    $result = [PSCustomObject]@{
        Rows       = $rows.Count
        Files      = $filesRead
        Errors     = $docErrors
        DualFiles  = $dualFiles
        Days       = $days.Count
        Cancelled  = [bool]$cancelled
        OutputCsv  = $OutputCsv
        Written    = $false
        ErrorText  = ''
    }

    if ($cancelled) {
        Write-ProgressLine 'Остановлено. Файл не записан.'
        return $result
    }

    if ($columnList -contains 'FLYDATE') {
        $list = @(
            $rows.Values | Sort-Object @{ Expression = {
                $text = [string]$_.FLYDATE
                $first = ''
                if ($text) { $first = ($text -split ';')[0].Trim() }
                if ($first.Length -eq 7) { $first = '0' + $first }
                if ($first.Length -eq 8 -and $first -match '^\d{8}$') {
                    return ($first.Substring(4, 4) + $first.Substring(2, 2) + $first.Substring(0, 2))
                }
                return ('99999999' + $first)
            } }, BSONUM
        )
    } else {
        $list = @($rows.Values | Sort-Object BSONUM)
    }
    $dir = Split-Path -Parent $OutputCsv
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    # В PowerShell 7 'UTF8' пишет без BOM, и Excel показывает кириллицу кракозябрами.
    $csvEncoding = 'UTF8'
    if ($PSVersionTable.PSVersion.Major -ge 6) { $csvEncoding = 'utf8BOM' }
    try {
        if ($list.Count -eq 0) {
            ($columnList -join ',') | Set-Content -LiteralPath $OutputCsv -Encoding $csvEncoding
        } else {
            $list | Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding $csvEncoding -Delimiter ','
        }
        $result.Written = $true
        $result.Rows = $list.Count
        Write-ProgressLine ("Готово. Строк: {0}. Файл: {1}" -f $list.Count, $OutputCsv)
    } catch {
        $result.ErrorText = $_.Exception.Message
        Write-ProgressLine ("Не удалось записать CSV. Закройте файл, если он открыт в Excel. {0}" -f $_.Exception.Message)
    }
    return $result
}

function Get-DefaultCsvDirectory {
    $candidates = @(
        'Y:\Отделы\11 КС\ООРП\Загрузка\csv',
        '\\eternal5d\Corporate\Отделы\11 КС\ООРП\Загрузка\csv'
    )
    foreach ($dir in $candidates) {
        if (Test-Path -LiteralPath $dir) { return $dir }
    }
    return [Environment]::GetFolderPath('Desktop')
}

function Enable-DpiAwareness {
    # Без этого Windows растягивает окно картинкой на 125–150% и всё мылится.
    try {
        if (-not ('EmdNative.Win32' -as [type])) {
            Add-Type -Namespace EmdNative -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
'@
        }
        [void][EmdNative.Win32]::SetProcessDPIAware()
    } catch { }
}

function Set-CueBanner {
    param($TextBox, [string]$Text)
    # Серая подсказка внутри пустого поля (EM_SETCUEBANNER).
    try { [void][EmdNative.Win32]::SendMessage($TextBox.Handle, 0x1501, [IntPtr]1, $Text) } catch { }
}

function New-RoundedPath {
    param([System.Drawing.RectangleF]$Rect, [float]$Radius)
    $d = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
    $path.AddArc(($Rect.Right - $d), $Rect.Y, $d, $d, 270, 90)
    $path.AddArc(($Rect.Right - $d), ($Rect.Bottom - $d), $d, $d, 0, 90)
    $path.AddArc($Rect.X, ($Rect.Bottom - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    return ,$path
}

function Show-EmdForm {
    param([string]$InitialRoot)

    Enable-DpiAwareness
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    # ---------- Палитра ----------
    $colorHeader     = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $colorHeaderText = [System.Drawing.Color]::FromArgb(148, 163, 184)
    $colorText       = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $colorMuted      = [System.Drawing.Color]::FromArgb(100, 116, 139)
    $colorBack       = [System.Drawing.Color]::FromArgb(241, 245, 249)
    $colorCard       = [System.Drawing.Color]::White
    $colorLine       = [System.Drawing.Color]::FromArgb(226, 232, 240)
    $colorField      = [System.Drawing.Color]::FromArgb(248, 250, 252)
    $colorAccent     = [System.Drawing.Color]::FromArgb(13, 148, 136)
    $colorAccentDark = [System.Drawing.Color]::FromArgb(15, 118, 110)
    $colorAccentSoft = [System.Drawing.Color]::FromArgb(240, 253, 250)
    $colorDanger     = [System.Drawing.Color]::FromArgb(220, 38, 38)
    $colorOk         = [System.Drawing.Color]::FromArgb(22, 163, 74)

    $fontBase    = New-Object System.Drawing.Font('Segoe UI', 9.75)
    $fontSmall   = New-Object System.Drawing.Font('Segoe UI', 8.75)
    $fontBold    = New-Object System.Drawing.Font('Segoe UI Semibold', 9.75)
    $fontCaption = New-Object System.Drawing.Font('Segoe UI Semibold', 11.25)
    $fontTitle   = New-Object System.Drawing.Font('Segoe UI Semibold', 16)
    $fontMono    = New-Object System.Drawing.Font('Consolas', 9)

    # Все размеры в пикселях задаются для 100% и пересчитываются под масштаб экрана.
    $probe = New-Object System.Windows.Forms.Form
    $gfx = $probe.CreateGraphics()
    $script:uiScale = [Math]::Max(1.0, $gfx.DpiX / 96.0)
    $gfx.Dispose()
    $probe.Dispose()
    function Px { param([double]$Value) return [int][Math]::Round($Value * $script:uiScale) }
    function Pad {
        param([double]$L, [double]$T = -1, [double]$R = -1, [double]$B = -1)
        if ($T -lt 0) { $T = $L; $R = $L; $B = $L }
        return New-Object System.Windows.Forms.Padding((Px $L), (Px $T), (Px $R), (Px $B))
    }

    function Set-DoubleBuffered {
        param($Control)
        $flags = [Reflection.BindingFlags]'Instance,NonPublic'
        $Control.GetType().GetProperty('DoubleBuffered', $flags).SetValue($Control, $true, $null)
        $Control.GetType().GetProperty('ResizeRedraw', $flags).SetValue($Control, $true, $null)
    }

    # ---------- Фабрики элементов ----------
    function Update-ButtonFace {
        param($Button)
        $kind = [string]$Button.Tag
        $on = $Button.Enabled
        $fa = $Button.FlatAppearance
        switch ($kind) {
            'primary' {
                $fa.BorderSize = 0
                $fa.MouseOverBackColor = $colorAccentDark
                $fa.MouseDownBackColor = [System.Drawing.Color]::FromArgb(17, 94, 89)
                if ($on) {
                    $Button.BackColor = $colorAccent
                    $Button.ForeColor = [System.Drawing.Color]::White
                } else {
                    $Button.BackColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
                    $Button.ForeColor = [System.Drawing.Color]::White
                }
            }
            'danger' {
                $fa.BorderSize = 1
                $fa.MouseOverBackColor = [System.Drawing.Color]::FromArgb(254, 242, 242)
                $fa.MouseDownBackColor = [System.Drawing.Color]::FromArgb(254, 226, 226)
                if ($on) {
                    $fa.BorderColor = [System.Drawing.Color]::FromArgb(252, 165, 165)
                    $Button.ForeColor = $colorDanger
                } else {
                    $fa.BorderColor = $colorLine
                    $Button.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
                }
                $Button.BackColor = $colorCard
            }
            'link' {
                $fa.BorderSize = 0
                $fa.MouseOverBackColor = $colorAccentSoft
                $fa.MouseDownBackColor = [System.Drawing.Color]::FromArgb(204, 251, 241)
                $Button.BackColor = $colorCard
                if ($on) { $Button.ForeColor = $colorAccentDark } else { $Button.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225) }
            }
            'header' {
                $fa.BorderSize = 1
                $fa.BorderColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
                $fa.MouseOverBackColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
                $fa.MouseDownBackColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
                $Button.BackColor = $colorHeader
                $Button.ForeColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
            }
            default {
                $fa.BorderSize = 1
                $fa.BorderColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
                $fa.MouseOverBackColor = $colorField
                $fa.MouseDownBackColor = $colorBack
                $Button.BackColor = $colorCard
                if ($on) { $Button.ForeColor = $colorText } else { $Button.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225) }
            }
        }
    }

    function New-Button {
        param([string]$Text, [string]$Kind = 'secondary', [double]$Width = 0, [double]$Height = 32)
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $Text
        $b.Tag = $Kind
        $b.FlatStyle = 'Flat'
        $b.UseVisualStyleBackColor = $false
        $b.Cursor = [System.Windows.Forms.Cursors]::Hand
        $b.Font = $fontBase
        if ($Kind -eq 'primary') { $b.Font = $fontBold }
        if ($Kind -eq 'link') { $b.Font = $fontSmall }
        $b.Margin = Pad 4 0 0 0
        if ($Width -gt 0) {
            $b.Size = New-Object System.Drawing.Size((Px $Width), (Px $Height))
        } else {
            $b.AutoSize = $true
            $b.AutoSizeMode = 'GrowAndShrink'
            $b.Padding = Pad 10 0 10 0
            $b.MinimumSize = New-Object System.Drawing.Size(0, (Px $Height))
        }
        Update-ButtonFace $b
        $b.Add_EnabledChanged({ Update-ButtonFace $this })
        return $b
    }

    function New-Text {
        param([string]$Text, $Font = $fontBase, $Color = $colorText, $Back = $colorCard)
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $Text
        $l.AutoSize = $true
        $l.Font = $Font
        $l.ForeColor = $Color
        $l.BackColor = $Back
        $l.Anchor = 'Left'
        $l.Margin = Pad 0 0 8 0
        return $l
    }

    function New-Input {
        param([string]$Text = '', [string]$Cue = '')
        $t = New-Object System.Windows.Forms.TextBox
        $t.Text = $Text
        $t.BorderStyle = 'FixedSingle'
        $t.BackColor = $colorField
        $t.ForeColor = $colorText
        $t.Font = $fontBase
        $t.Anchor = 'Left,Right'
        $t.Margin = Pad 0
        if ($Cue) { $t.Add_HandleCreated({ Set-CueBanner $this $this.AccessibleDescription }); $t.AccessibleDescription = $Cue }
        return $t
    }

    function New-Grid {
        param([double[]]$Columns, [string]$Dock = 'Fill')
        # Ширины столбцов: 0 — по содержимому, 0<x<=1 — доля, >1 — пиксели.
        $g = New-Object System.Windows.Forms.TableLayoutPanel
        $g.Dock = $Dock
        $g.BackColor = $colorCard
        $g.Margin = Pad 0
        $g.Padding = Pad 0
        $g.ColumnCount = $Columns.Count
        $g.RowCount = 0
        foreach ($c in $Columns) {
            if ($c -eq 0) { [void]$g.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('AutoSize'))) }
            elseif ($c -le 1) { [void]$g.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent', [single]($c * 100)))) }
            else { [void]$g.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute', [single](Px $c)))) }
        }
        return $g
    }

    function Add-GridRow {
        param($Grid, [object[]]$Cells, [double]$Height = 0, [double]$Gap = 0)
        # Высота: 0 — по содержимому, 0<x<=1 — доля, >1 — пиксели.
        $row = $Grid.RowCount
        $Grid.RowCount = $row + 1
        if ($Height -eq 0) { [void]$Grid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize'))) }
        elseif ($Height -le 1) { [void]$Grid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', [single]($Height * 100)))) }
        else { [void]$Grid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Absolute', [single](Px $Height)))) }
        $col = 0
        foreach ($cell in $Cells) {
            if ($null -ne $cell) {
                if ($Gap -gt 0) { $cell.Margin = New-Object System.Windows.Forms.Padding($cell.Margin.Left, (Px $Gap), $cell.Margin.Right, $cell.Margin.Bottom) }
                $Grid.Controls.Add($cell, $col, $row)
                if ($Cells.Count -eq 1 -and $Grid.ColumnCount -gt 1) { $Grid.SetColumnSpan($cell, $Grid.ColumnCount) }
            }
            $col++
        }
    }

    function New-Card {
        param([string]$Title, [string]$Note, [double[]]$Columns = @(1))
        $card = New-Object System.Windows.Forms.Panel
        $card.Dock = 'Fill'
        $card.Margin = Pad 6
        $card.Padding = Pad 16 12 16 14
        $card.BackColor = $colorBack
        Set-DoubleBuffered $card
        $card.Add_Paint({
            if ($this.Width -lt 24 -or $this.Height -lt 24) { return }
            $g = $_.Graphics
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $rect = New-Object System.Drawing.RectangleF(0.5, 0.5, ($this.Width - 1.5), ($this.Height - 1.5))
            $path = New-RoundedPath $rect (8 * $script:uiScale)
            $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
            $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(226, 232, 240))
            $g.FillPath($brush, $path)
            $g.DrawPath($pen, $path)
            $brush.Dispose(); $pen.Dispose(); $path.Dispose()
        })
        $grid = New-Grid $Columns
        $card.Controls.Add($grid)
        if ($Title) {
            $head = New-Object System.Windows.Forms.FlowLayoutPanel
            $head.AutoSize = $true
            $head.WrapContents = $false
            $head.BackColor = $colorCard
            $head.Margin = Pad 0 0 0 8
            $head.Dock = 'Fill'
            $cap = New-Text $Title $fontCaption
            $cap.Margin = Pad 0 0 10 0
            $head.Controls.Add($cap)
            if ($Note) {
                $n = New-Text $Note $fontSmall $colorMuted
                $n.Margin = Pad 0 5 0 0
                $head.Controls.Add($n)
            }
            Add-GridRow $grid @($head)
        }
        return $card
    }

    # ---------- Окно ----------
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Выгрузка EMD'
    $form.StartPosition = 'CenterScreen'
    $form.AutoScaleMode = 'None'
    $form.BackColor = $colorBack
    $form.Font = $fontBase
    $form.ForeColor = $colorText
    $form.KeyPreview = $true
    Set-DoubleBuffered $form
    $work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.ClientSize = New-Object System.Drawing.Size(([Math]::Min((Px 1220), $work.Width - 40)), ([Math]::Min((Px 760), $work.Height - 60)))
    $form.MinimumSize = New-Object System.Drawing.Size(([Math]::Min((Px 1020), $work.Width)), ([Math]::Min((Px 700), $work.Height)))

    $tip = New-Object System.Windows.Forms.ToolTip
    $tip.AutoPopDelay = 15000

    # Основная сетка: слева период, справа фильтры и журнал.
    $main = New-Grid @(372, 1)
    $main.BackColor = $colorBack
    $main.Padding = Pad 10 8 10 4
    $form.Controls.Add($main)

    # Шапка.
    $header = New-Object System.Windows.Forms.Panel
    $header.Dock = 'Top'
    $header.Height = Px 64
    $header.BackColor = $colorHeader
    $header.Padding = Pad 22 0 18 0
    $form.Controls.Add($header)

    $headGrid = New-Grid @(0, 1, 0)
    $headGrid.BackColor = $colorHeader
    $header.Controls.Add($headGrid)
    $titleBox = New-Object System.Windows.Forms.FlowLayoutPanel
    $titleBox.FlowDirection = 'TopDown'
    $titleBox.AutoSize = $true
    $titleBox.WrapContents = $false
    $titleBox.BackColor = $colorHeader
    $titleBox.Anchor = 'Left'
    $titleBox.Margin = Pad 0
    $title = New-Text 'Выгрузка EMD' $fontTitle ([System.Drawing.Color]::White) $colorHeader
    $title.Margin = Pad 0
    $subtitle = New-Text 'MCO_TYPE rfisc → CSV. Каждый пассажир — своя строка; если в EMD несколько услуг, берётся цена выбранной.' $fontSmall $colorHeaderText $colorHeader
    $subtitle.Margin = Pad 2 0 0 0
    $titleBox.Controls.Add($title)
    $titleBox.Controls.Add($subtitle)
    $btnSettings = New-Button 'Сбросить настройки' 'header'
    $btnSettings.Anchor = 'Right'
    $tip.SetToolTip($btnSettings, 'Вернуть списки и отметки по умолчанию.')
    Add-GridRow $headGrid @($titleBox, $null, $btnSettings) 1

    # Подвал: статус, прогресс, кнопки.
    $footer = New-Object System.Windows.Forms.Panel
    $footer.Dock = 'Bottom'
    $footer.Height = Px 68
    $footer.BackColor = $colorCard
    $footer.Padding = Pad 22 10 22 10
    $footer.Add_Paint({
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(226, 232, 240))
        $_.Graphics.DrawLine($pen, 0, 0, $this.Width, 0)
        $pen.Dispose()
    })
    $form.Controls.Add($footer)

    $footGrid = New-Grid @(1, 0, 0)
    $footer.Controls.Add($footGrid)
    $statusBox = New-Grid @(1) 'None'
    $statusBox.Anchor = 'Left,Right'
    $statusBox.AutoSize = $true
    $statusBox.Margin = Pad 0 0 24 0
    $status = New-Text 'Читаю список дней…'
    $status.AutoSize = $false
    $status.AutoEllipsis = $true
    $status.Anchor = 'Left,Right'
    $status.Height = Px 22
    $bar = New-Object System.Windows.Forms.Panel
    $bar.Height = Px 6
    $bar.Anchor = 'Left,Right'
    $bar.Margin = Pad 0 4 0 0
    $bar.BackColor = $colorCard
    $bar.Tag = 0.0
    Set-DoubleBuffered $bar
    $bar.Add_Paint({
        if ($this.Width -lt 12 -or $this.Height -lt 2) { return }
        $g = $_.Graphics
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $r = [float]($this.Height / 2.0)
        $track = New-Object System.Drawing.RectangleF(0, 0, ($this.Width - 1), ($this.Height - 1))
        $path = New-RoundedPath $track $r
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(226, 232, 240))
        $g.FillPath($brush, $path)
        $brush.Dispose(); $path.Dispose()
        $ratio = [double]$this.Tag
        if ($ratio -gt 0) {
            $w = [float][Math]::Max($this.Height, ($this.Width - 1) * [Math]::Min(1.0, $ratio))
            $fill = New-Object System.Drawing.RectangleF(0, 0, $w, ($this.Height - 1))
            $path = New-RoundedPath $fill $r
            $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(13, 148, 136))
            $g.FillPath($brush, $path)
            $brush.Dispose(); $path.Dispose()
        }
    })
    Add-GridRow $statusBox @($status)
    Add-GridRow $statusBox @($bar)
    $btnStop = New-Button 'Стоп' 'danger' 112 40
    $btnStop.Enabled = $false
    $btnStop.Anchor = 'Right'
    $btnGo = New-Button 'Собрать CSV' 'primary' 176 40
    $btnGo.Anchor = 'Right'
    $btnGo.Margin = Pad 10 0 0 0
    $btnGo.Enabled = $false
    $tip.SetToolTip($btnGo, 'Собрать CSV за выбранный период (Ctrl+Enter).')
    $tip.SetToolTip($btnStop, 'Остановить сбор (Esc). Файл не будет записан.')
    Add-GridRow $footGrid @($statusBox, $btnStop, $btnGo) 1

    # ---------- Карточка «Источник и файл» ----------
    $cardPaths = New-Card 'Источник и результат' 'Внутри папки: годы → месяцы 01–12 → дни 01–31 → *.xml' @(0, 1, 0)

    $txtRoot = New-Input '\\192.168.10.20\files'
    $btnRoot = New-Button 'Обзор…' 'secondary' 104
    $btnReload = New-Button 'Обновить' 'secondary' 104
    $rootButtons = New-Object System.Windows.Forms.FlowLayoutPanel
    $rootButtons.AutoSize = $true
    $rootButtons.WrapContents = $false
    $rootButtons.BackColor = $colorCard
    $rootButtons.Margin = Pad 8 0 0 0
    $rootButtons.Controls.AddRange(@($btnRoot, $btnReload))
    $lblRootCap = New-Text 'Папка с годами' $fontBold
    $lblRootCap.Margin = Pad 0 0 14 0
    Add-GridRow $cardPaths.Controls[0] @($lblRootCap, $txtRoot, $rootButtons)

    $txtCsv = New-Input
    $btnCsv = New-Button 'Сохранить как…' 'secondary' 212
    $btnCsv.Margin = Pad 12 0 0 0
    $lblCsvCap = New-Text 'Файл CSV' $fontBold
    Add-GridRow $cardPaths.Controls[0] @($lblCsvCap, $txtCsv, $btnCsv) 0 8
    $tip.SetToolTip($btnReload, 'Перечитать список дней в папке (F5).')

    # Высота карточки — по содержимому сетки (строка основной сетки AutoSize берёт её как есть).
    $pathsHeight = $cardPaths.Controls[0].GetPreferredSize((New-Object System.Drawing.Size((Px 800), 0))).Height
    $cardPaths.Height = [Math]::Max((Px 120), $pathsHeight) + $cardPaths.Padding.Vertical

    $main.RowCount = 2
    [void]$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize')))
    [void]$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 100)))
    $main.Controls.Add($cardPaths, 0, 0)
    $main.SetColumnSpan($cardPaths, 2)

    # ---------- Карточка «Период» ----------
    $cardPeriod = New-Card 'Период' '' @(1)

    $pickFrom = New-Object System.Windows.Forms.DateTimePicker
    $pickTo = New-Object System.Windows.Forms.DateTimePicker
    foreach ($p in @($pickFrom, $pickTo)) {
        $p.Format = 'Custom'
        $p.CustomFormat = 'dd.MM.yyyy'
        $p.Width = Px 124
        $p.Anchor = 'Left'
        $p.Margin = Pad 0
        $p.Font = $fontBase
        $p.CalendarTitleBackColor = $colorAccent
        $p.CalendarTitleForeColor = [System.Drawing.Color]::White
        $p.CalendarForeColor = $colorText
        $p.CalendarMonthBackground = $colorCard
        $p.CalendarTrailingForeColor = $colorMuted
    }
    $pickRow = New-Grid @(0, 0, 0, 0, 1) 'Fill'
    $pickRow.AutoSize = $true
    $lblFrom = New-Text 'с' $fontBase $colorMuted
    $lblTo = New-Text 'по' $fontBase $colorMuted
    $lblTo.Margin = Pad 10 0 8 0
    Add-GridRow $pickRow @($lblFrom, $pickFrom, $lblTo, $pickTo, $null)
    Add-GridRow $cardPeriod.Controls[0] @($pickRow)

    # Фиксированная высота на два ряда: AutoSize-панель с переносом в таблице считает высоту как для одного ряда.
    $chips = New-Object System.Windows.Forms.FlowLayoutPanel
    $chips.WrapContents = $true
    $chips.Dock = 'Fill'
    $chips.BackColor = $colorCard
    $chips.Margin = Pad 0 10 0 2
    $btnToday = New-Button 'Сегодня' 'secondary' 0 28
    $btnYesterday = New-Button 'Вчера' 'secondary' 0 28
    $btnWeek = New-Button 'Неделя' 'secondary' 0 28
    $btnMonth = New-Button 'Месяц' 'secondary' 0 28
    $btnPrev = New-Button 'Прошлый месяц' 'secondary' 0 28
    foreach ($b in @($btnToday, $btnYesterday, $btnWeek, $btnMonth, $btnPrev)) {
        $b.Font = $fontSmall
        $b.Margin = Pad 0 0 6 6
        $chips.Controls.Add($b)
    }
    Add-GridRow $cardPeriod.Controls[0] @($chips) 80

    $cal = New-Object System.Windows.Forms.MonthCalendar
    $cal.MaxSelectionCount = 2000
    $cal.FirstDayOfWeek = [System.Windows.Forms.Day]::Monday
    $cal.ShowToday = $true
    $cal.ShowTodayCircle = $true
    $cal.TitleBackColor = $colorAccent
    $cal.TitleForeColor = [System.Drawing.Color]::White
    $cal.TrailingForeColor = $colorMuted
    $cal.Anchor = 'Top'
    $cal.Margin = Pad 0 4 0 8
    Add-GridRow $cardPeriod.Controls[0] @($cal)

    $preview = New-Object System.Windows.Forms.Panel
    $preview.Dock = 'Fill'
    $preview.BackColor = $colorAccentSoft
    $preview.Padding = Pad 12 8 12 8
    $preview.Margin = Pad 0
    $previewText = New-Object System.Windows.Forms.Label
    $previewText.Dock = 'Fill'
    $previewText.AutoEllipsis = $true
    $previewText.BackColor = $colorAccentSoft
    $previewText.ForeColor = $colorText
    $previewText.Font = $fontBase
    $previewText.Text = 'Выберите период.'
    $preview.Controls.Add($previewText)
    Add-GridRow $cardPeriod.Controls[0] @($preview) 1
    $main.Controls.Add($cardPeriod, 0, 1)

    $tip.SetToolTip($cal, 'Протяните мышью от первого дня к последнему. Жирным отмечены дни, для которых есть папка.')
    $tip.SetToolTip($btnWeek, 'Текущая неделя, с понедельника по воскресенье.')
    $tip.SetToolTip($btnMonth, 'С 1-го по последний день текущего месяца.')
    $tip.SetToolTip($btnPrev, 'Весь предыдущий месяц.')

    # ---------- Правая колонка: фильтры + журнал ----------
    $right = New-Grid @(1)
    $right.BackColor = $colorBack
    $main.Controls.Add($right, 1, 1)

    $cardFilter = New-Card 'Фильтры и столбцы' 'Пустой список — без фильтра. MCO сравнивается с rfisc, текстом MCO_TYPE и rfic.' @(0.21, 0.21, 0.29, 0.29)
    $right.RowCount = 2
    [void]$right.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 64)))
    [void]$right.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent', 36)))
    $right.Controls.Add($cardFilter, 0, 0)

    function New-ChoiceColumn {
        param([string]$Caption, [string]$Cue)
        $col = New-Grid @(1)
        $col.Margin = Pad 0 0 12 0

        $head = New-Grid @(0, 1, 0, 0) 'Fill'
        $head.AutoSize = $true
        $head.Margin = Pad 0 0 0 4
        $cap = New-Text $Caption $fontBold
        $cap.Margin = Pad 0 0 6 0
        # Счётчик сжимается с многоточием, если столбец узкий.
        $count = New-Text '' $fontSmall $colorMuted
        $count.AutoSize = $false
        $count.AutoEllipsis = $true
        $count.Dock = 'Fill'
        $count.TextAlign = 'MiddleLeft'
        $count.Margin = Pad 0
        $count.Height = Px 24
        $all = New-Button 'все' 'link' 0 24
        $none = New-Button 'снять' 'link' 0 24
        foreach ($b in @($all, $none)) { $b.Padding = Pad 1 0 1 0; $b.Margin = Pad 0; $b.Anchor = 'Right' }
        $tip.SetToolTip($all, "Отметить все значения: $Caption")
        $tip.SetToolTip($none, "Снять все отметки: $Caption. Пустой список — без фильтра.")
        Add-GridRow $head @($cap, $count, $all, $none)

        $list = New-Object System.Windows.Forms.CheckedListBox
        $list.Dock = 'Fill'
        $list.CheckOnClick = $true
        $list.IntegralHeight = $false
        $list.HorizontalScrollbar = $true
        $list.BorderStyle = 'FixedSingle'
        $list.BackColor = $colorField
        $list.ForeColor = $colorText
        $list.Font = $fontBase
        $list.Margin = Pad 0
        $list.Tag = $count
        $list.Add_ItemCheck({
            $n = $this.CheckedItems.Count
            $now = $_.NewValue -eq [System.Windows.Forms.CheckState]::Checked
            $was = $_.CurrentValue -eq [System.Windows.Forms.CheckState]::Checked
            if ($now -and -not $was) { $n++ } elseif ($was -and -not $now) { $n-- }
            $this.Tag.Text = '{0} из {1}' -f $n, $this.Items.Count
        })

        $addRow = New-Grid @(1, 0) 'Fill'
        $addRow.AutoSize = $true
        $box = New-Input '' $Cue
        $add = New-Button '+' 'secondary' 30 26
        $add.Font = $fontBold
        $add.Margin = Pad 4 0 0 0
        $tip.SetToolTip($add, 'Добавить и отметить (Enter). Несколько значений — через запятую.')
        Add-GridRow $addRow @($box, $add)

        Add-GridRow $col @($head)
        Add-GridRow $col @($list) 1
        Add-GridRow $col @($addRow) 0 6
        # По имени обработчики кнопок находят свой столбец.
        foreach ($c in @($list, $box, $add, $all, $none)) { $c.Name = $Caption }
        return [PSCustomObject]@{ Panel = $col; List = $list; Box = $box; Add = $add; All = $all; None = $none; Count = $count }
    }

    $colType = New-ChoiceColumn 'TYPE' 'новый TYPE'
    $colOp = New-ChoiceColumn 'OPTYPE' 'новый OPTYPE'
    $colMco = New-ChoiceColumn 'MCO' 'rfisc / rfic'
    $colCols = New-ChoiceColumn 'Столбцы' 'поле из XML'
    $colCols.Panel.Margin = Pad 0
    $choiceCols = @($colType, $colOp, $colMco, $colCols)
    Add-GridRow $cardFilter.Controls[0] @($colType.Panel, $colOp.Panel, $colMco.Panel, $colCols.Panel) 1
    $listType = $colType.List
    $listOp = $colOp.List
    $listMco = $colMco.List
    $listCols = $colCols.List

    $tip.SetToolTip($colMco.Box, 'rfisc, текст MCO_TYPE или rfic. Несколько — через запятую.')
    $tip.SetToolTip($colCols.Box, 'Имя поля из XML, если его нет в списке. Несколько — через запятую.')
    $tip.SetToolTip($colCols.None, 'Снять отметки. Для выгрузки нужен хотя бы один столбец.')

    $cardLog = New-Card 'Журнал' '' @(1)
    $log = New-Object System.Windows.Forms.TextBox
    $log.Multiline = $true
    $log.ReadOnly = $true
    $log.WordWrap = $false
    $log.ScrollBars = 'Both'
    $log.BorderStyle = 'None'
    $log.Dock = 'Fill'
    $log.Margin = Pad 0
    $log.Font = $fontMono
    $log.BackColor = $colorField
    $log.ForeColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
    $logWrap = New-Object System.Windows.Forms.Panel
    $logWrap.Dock = 'Fill'
    $logWrap.Margin = Pad 0
    $logWrap.Padding = Pad 8 6 4 4
    $logWrap.BackColor = $colorField
    $logWrap.Controls.Add($log)
    Add-GridRow $cardLog.Controls[0] @($logWrap) 1
    $right.Controls.Add($cardLog, 0, 1)

    # ---------- Данные и настройки ----------
    $script:updating = $false
    $script:index = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    $script:csvEdited = $false
    $script:running = $false
    $script:sync = $null
    $script:exportJob = $null
    $script:indexJob = $null
    $script:defaultCsvDir = $null
    $script:settingsPath = Join-Path $env:LOCALAPPDATA 'Krasavia\emd-export-ui.json'

    $knownTypes = @('EMD', 'ETICKET', 'EINSURCAR')
    $knownOps = @('SALE', 'REFUND')
    $knownMco = @(
        'IP1', 'IP2',
        'KV0', 'KV1', 'KV2', 'KV3', 'KV4', 'KV5', 'KV6', 'KV7', 'KV8', 'KV9',
        '027', '09U', '0A0', '0AA', '0AI', '0AN', '0AX', '0B5', '0CC', '0CD', '0DG', '0ED', '0FN',
        '0G6', '0G9', '0GP', '0HF', '0JV', '0LQ', '98J', '993', '995',
        'B02', 'BF3', 'BR1', 'CHL', 'CMF', 'FNA', 'L03', 'L05', 'NTC',
        'O30', 'O7L', 'OA5', 'PEL', 'PN3', 'PN7', 'PN8', 'RNA',
        'S01', 'S02', 'SAS', 'SR1', 'STX', 'SW2', 'SW3', 'TG1',
        'Y20', 'Y21', 'Y55', 'Y68',
        'SERVICE', 'EXC_BAGG', 'PENALTY', 'RECEIPT', 'REF_NOTICE', 'USED_NOTICE',
        'A', 'C', 'D', 'E', 'G', 'I',
        '(пусто)'
    )
    $knownCols = @(
        'BSONUM', 'FARE', 'PNR', 'FLYDATE', 'OPTYPE', 'TRANS_TYPE', 'RFISC',
        'TYPE', 'RFIC', 'MCO_TYPE', 'FIO', 'SURNAME', 'NAME',
        'DEALDATE', 'DEALTIME', 'REIS', 'CARRIER', 'CITY1CODE', 'CITY2CODE',
        'CLASS', 'NFARE', 'BASICFARE', 'PNR_LAT', 'EX_BSONUM', 'CURRENCY',
        'BIRTH_DATE', 'PASSENGER_TYPE', 'GENERAL_CARRIER', 'COUPON_NO'
    )
    $defaultTypeOn = @('EMD')
    $defaultOpOn = @('SALE', 'REFUND')
    $defaultColsOn = @('BSONUM', 'FARE', 'PNR', 'FLYDATE', 'OPTYPE', 'TRANS_TYPE', 'RFISC', 'FIO')
    $defaultMcoOn = @('IP1', 'IP2', 'KV0', 'KV1', 'KV2', 'KV3', 'KV4', 'KV5', 'KV6', 'KV7', 'KV8', 'KV9')

    function Update-ChoiceCount {
        param($List)
        $List.Tag.Text = '{0} из {1}' -f $List.CheckedItems.Count, $List.Items.Count
    }

    function Fill-CheckList {
        param($List, $Items, $Checked)
        $on = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($c in @($Checked)) { if ($c) { [void]$on.Add([string]$c) } }
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $List.BeginUpdate()
        $List.Items.Clear()
        foreach ($item in @($Items)) {
            if (-not $item) { continue }
            $name = $item.ToString().Trim()
            if (-not $name -or -not $seen.Add($name)) { continue }
            [void]$List.Items.Add($name, $on.Contains($name))
        }
        $List.EndUpdate()
        Update-ChoiceCount $List
    }

    function Add-FlatStrings {
        param($Value, $Out)
        foreach ($item in @($Value)) {
            if ($null -eq $item) { continue }
            if ($item -isnot [string] -and $item.PSObject.Properties['value']) {
                # Старый файл настроек: PowerShell 5.1 сохранял массив как {"value":[...],"Count":N}.
                Add-FlatStrings $item.value $Out
                continue
            }
            if ($item -is [System.Collections.IEnumerable] -and $item -isnot [string]) {
                Add-FlatStrings $item $Out
                continue
            }
            $name = $item.ToString().Trim()
            if ($name -and $name -ne 'System.Object[]' -and -not $name.StartsWith('@{')) { [void]$Out.Add($name) }
        }
    }

    function Get-FlatStrings {
        param($Value)
        $out = New-Object System.Collections.Generic.List[string]
        Add-FlatStrings $Value $out
        return ,$out.ToArray()
    }

    # Возвращают List[string]; у вызывающего — .ToArray(), чтобы получить «чистый» string[]:
    # массив, прошедший через вывод функции, PowerShell 5.1 сериализует в JSON как {"value":..,"Count":..}.
    function Get-CheckedNames {
        param($List)
        $arr = New-Object System.Collections.Generic.List[string]
        foreach ($item in $List.CheckedItems) {
            $name = ([string]$item).Trim()
            if ($name) { $arr.Add($name) }
        }
        return ,$arr
    }

    function Get-AllNames {
        param($List)
        $arr = New-Object System.Collections.Generic.List[string]
        foreach ($item in $List.Items) {
            $name = ([string]$item).Trim()
            if ($name) { $arr.Add($name) }
        }
        return ,$arr
    }

    function Add-ManualValue {
        param($List, $Box)
        if (-not $Box.Text) { return }
        foreach ($part in ($Box.Text -split '[,;]')) {
            $name = $part.Trim()
            if (-not $name) { continue }
            $found = -1
            for ($i = 0; $i -lt $List.Items.Count; $i++) {
                if ([string]::Equals([string]$List.Items[$i], $name, 'OrdinalIgnoreCase')) { $found = $i; break }
            }
            if ($found -lt 0) { $found = $List.Items.Add($name) }
            $List.SetItemChecked($found, $true)
            $List.TopIndex = [Math]::Max(0, $found - 2)
        }
        $Box.Clear()
        Update-ChoiceCount $List
    }

    function Save-UiSettings {
        try {
            $dir = Split-Path -Parent $script:settingsPath
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            $csvDir = ''
            try { if ($txtCsv.Text) { $csvDir = Split-Path -Parent $txtCsv.Text.Trim().Trim('"') } } catch { }
            $payload = [ordered]@{
                root        = $txtRoot.Text.Trim()
                csvDir      = [string]$csvDir
                types       = (Get-CheckedNames $listType).ToArray()
                optypes     = (Get-CheckedNames $listOp).ToArray()
                mco         = (Get-CheckedNames $listMco).ToArray()
                columns     = (Get-CheckedNames $listCols).ToArray()
                typeItems   = (Get-AllNames $listType).ToArray()
                opItems     = (Get-AllNames $listOp).ToArray()
                mcoItems    = (Get-AllNames $listMco).ToArray()
                columnItems = (Get-AllNames $listCols).ToArray()
            }
            $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $script:settingsPath -Encoding UTF8
        } catch { }
    }

    function Import-UiSettings {
        param([switch]$Defaults)
        $typeItems = $knownTypes
        $opItems = $knownOps
        $mcoItems = $knownMco
        $colItems = $knownCols
        $typeOn = $defaultTypeOn
        $opOn = $defaultOpOn
        $mcoOn = $defaultMcoOn
        $colOn = $defaultColsOn
        if (-not $Defaults -and (Test-Path -LiteralPath $script:settingsPath)) {
            try {
                $saved = Get-Content -LiteralPath $script:settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($saved.typeItems) { $typeItems = (Get-FlatStrings $saved.typeItems) + $knownTypes }
                if ($saved.opItems) { $opItems = (Get-FlatStrings $saved.opItems) + $knownOps }
                if ($saved.mcoItems) { $mcoItems = (Get-FlatStrings $saved.mcoItems) + $knownMco }
                if ($saved.columnItems) { $colItems = (Get-FlatStrings $saved.columnItems) + $knownCols }
                if ($saved.PSObject.Properties['types']) { $typeOn = Get-FlatStrings $saved.types }
                if ($saved.PSObject.Properties['optypes']) { $opOn = Get-FlatStrings $saved.optypes }
                if ($saved.PSObject.Properties['mco']) { $mcoOn = Get-FlatStrings $saved.mco }
                if ($saved.PSObject.Properties['columns']) { $colOn = Get-FlatStrings $saved.columns }
                if (@($colOn).Count -eq 0) { $colOn = $defaultColsOn }
                if ($saved.root -and -not $InitialRoot) { $txtRoot.Text = [string]$saved.root }
                if ($saved.csvDir) { $script:defaultCsvDir = [string]$saved.csvDir }
            } catch { }
        }
        Fill-CheckList -List $listType -Items $typeItems -Checked $typeOn
        Fill-CheckList -List $listOp -Items $opItems -Checked $opOn
        Fill-CheckList -List $listMco -Items $mcoItems -Checked $mcoOn
        Fill-CheckList -List $listCols -Items $colItems -Checked $colOn
    }

    if ($InitialRoot) { $txtRoot.Text = $InitialRoot }
    Import-UiSettings

    # ---------- Период ----------
    function Get-ChosenRange {
        $a = $pickFrom.Value.Date
        $b = $pickTo.Value.Date
        if ($a -le $b) { return @{ From = $a; To = $b } }
        return @{ From = $b; To = $a }
    }

    function Get-CsvDirectory {
        # Сетевые пути проверяются один раз, а не при каждом щелчке по календарю.
        if (-not $script:defaultCsvDir -or -not (Test-Path -LiteralPath $script:defaultCsvDir)) {
            $script:defaultCsvDir = Get-DefaultCsvDirectory
        }
        return $script:defaultCsvDir
    }

    function Update-CsvName {
        if ($script:csvEdited) { return }
        $range = Get-ChosenRange
        $name = 'EMD_{0}_{1}.csv' -f $range.From.ToString('yyyyMMdd'), $range.To.ToString('yyyyMMdd')
        $dir = $null
        if ($txtCsv.Text) {
            try { $dir = Split-Path -Parent $txtCsv.Text } catch { $dir = $null }
        }
        if (-not $dir) { $dir = Get-CsvDirectory }
        $script:updating = $true
        $txtCsv.Text = Join-Path $dir $name
        $script:updating = $false
    }

    function Get-FoundDays {
        param($Range)
        $found = 0
        $firstPath = ''
        $cursor = $Range.From
        while ($cursor -le $Range.To) {
            $key = $cursor.ToString('yyyy-MM-dd')
            if ($script:index.ContainsKey($key)) {
                $found++
                if (-not $firstPath) { $firstPath = $script:index[$key] }
            }
            $cursor = $cursor.AddDays(1)
        }
        return [PSCustomObject]@{ Days = $found; First = $firstPath }
    }

    function Update-Preview {
        $range = Get-ChosenRange
        $total = ($range.To - $range.From).Days + 1
        $found = Get-FoundDays $range
        if ($found.First) { $example = "Первая папка: $($found.First)" }
        elseif ($script:index.Count -eq 0) { $example = 'Список дней ещё не прочитан.' }
        else { $example = 'В этом периоде папок с файлами нет.' }
        $previewText.Text = ("{0:dd.MM.yyyy} — {1:dd.MM.yyyy}`r`nДней: {2}   ·   с файлами: {3}`r`n{4}" -f $range.From, $range.To, $total, $found.Days, $example)
        if ($found.Days -gt 0) {
            $preview.BackColor = $colorAccentSoft
        } else {
            $preview.BackColor = [System.Drawing.Color]::FromArgb(254, 252, 232)
        }
        $previewText.BackColor = $preview.BackColor
    }

    function Set-Period {
        param([datetime]$FromDate, [datetime]$ToDate)
        $FromDate = $FromDate.Date
        $ToDate = $ToDate.Date
        if ($FromDate -gt $ToDate) { $FromDate, $ToDate = $ToDate, $FromDate }
        $min = $pickFrom.MinDate.Date
        $max = $pickFrom.MaxDate.Date
        # Обе даты прижимаем к границам: «Сегодня» может оказаться позже последнего года с папками.
        if ($FromDate -lt $min) { $FromDate = $min }
        if ($FromDate -gt $max) { $FromDate = $max }
        if ($ToDate -lt $min) { $ToDate = $min }
        if ($ToDate -gt $max) { $ToDate = $max }
        $script:updating = $true
        try {
            $pickFrom.Value = $FromDate
            $pickTo.Value = $ToDate
            $span = ($ToDate - $FromDate).Days + 1
            if ($cal.MaxSelectionCount -lt $span) { $cal.MaxSelectionCount = $span }
            try { $cal.SetSelectionRange($FromDate, $ToDate) } catch { }
        } finally {
            $script:updating = $false
        }
        Update-CsvName
        Update-Preview
    }

    function Set-DateBounds {
        param([datetime]$Min, [datetime]$Max)
        # Сначала раздвигаем границы до предела: иначе новая MinDate может оказаться больше старой MaxDate.
        $script:updating = $true
        try {
            foreach ($c in @($pickFrom, $pickTo)) {
                $c.MinDate = [System.Windows.Forms.DateTimePicker]::MinimumDateTime
                $c.MaxDate = [System.Windows.Forms.DateTimePicker]::MaximumDateTime
                $c.MinDate = $Min
                $c.MaxDate = $Max
            }
            $cal.MinDate = [datetime]::new(1753, 1, 1)
            $cal.MaxDate = [datetime]::new(9998, 12, 31)
            $cal.MinDate = $Min
            $cal.MaxDate = $Max
        } finally {
            $script:updating = $false
        }
    }

    function Apply-DayIndex {
        param($Index)
        $script:index = $Index
        if ($Index.Count -eq 0) {
            Set-Status 'В папке нет годов с днями. Нужна папка, внутри которой лежат, например, 2025 и 2026.' 'warn'
            $cal.BoldedDates = New-Object datetime[] 0
            Update-Preview
            return
        }
        $dates = New-Object System.Collections.Generic.List[datetime]
        foreach ($key in $Index.Keys) {
            $dates.Add([datetime]::ParseExact($key, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture))
        }
        $dates.Sort()
        # Get-Date -Year/-Month/-Day сохраняет текущее время суток — из-за этого 1 января не выбиралось.
        $min = [datetime]::new($dates[0].Year, 1, 1)
        $max = [datetime]::new($dates[$dates.Count - 1].Year, 12, 31)
        $keepFrom = $pickFrom.Value.Date
        $keepTo = $pickTo.Value.Date
        Set-DateBounds $min $max
        $cal.BoldedDates = $dates.ToArray()
        if ($script:periodChosen) {
            Set-Period -FromDate $keepFrom -ToDate $keepTo
        } else {
            $today = (Get-Date).Date
            Set-Period -FromDate $today -ToDate $today
        }
        Set-Status ("Дней с папками: {0} ({1:dd.MM.yyyy} — {2:dd.MM.yyyy}). Выберите период и нажмите «Собрать CSV»." -f $Index.Count, $dates[0], $dates[$dates.Count - 1]) 'ok'
    }

    function Set-Status {
        param([string]$Text, [string]$Kind = 'info')
        $status.Text = $Text
        switch ($Kind) {
            'ok'    { $status.ForeColor = $colorOk }
            'warn'  { $status.ForeColor = [System.Drawing.Color]::FromArgb(180, 83, 9) }
            'error' { $status.ForeColor = $colorDanger }
            default { $status.ForeColor = $colorText }
        }
    }

    function Set-Progress {
        param([double]$Ratio)
        $bar.Tag = $Ratio
        $bar.Invalidate()
    }

    function Add-LogLine {
        param([string]$Line)
        if ([string]::IsNullOrEmpty($Line)) { return }
        $log.AppendText(('{0:HH:mm:ss}  {1}' -f (Get-Date), $Line) + [Environment]::NewLine)
    }

    function Update-Controls {
        $busy = $script:running -or ($null -ne $script:indexJob)
        $btnGo.Enabled = (-not $busy) -and $script:index.Count -gt 0
        $btnStop.Enabled = $script:running
        foreach ($c in @($btnRoot, $btnReload, $txtRoot, $txtCsv, $btnCsv, $btnSettings)) { $c.Enabled = -not $busy }
        foreach ($c in @($pickFrom, $pickTo, $cal, $btnToday, $btnYesterday, $btnWeek, $btnMonth, $btnPrev)) { $c.Enabled = -not $script:running }
        foreach ($col in $choiceCols) {
            foreach ($c in @($col.List, $col.Box, $col.Add, $col.All, $col.None)) { $c.Enabled = -not $script:running }
        }
        $form.UseWaitCursor = ($null -ne $script:indexJob)
    }

    # ---------- Фоновые задачи ----------
    function Start-EmdWorker {
        param([string]$Script, [hashtable]$Arguments)
        $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
        foreach ($name in @('ConvertTo-SharePath', 'Get-DayIndex', 'Export-EmdPeriod')) {
            $body = (Get-Command -Name $name -CommandType Function).ScriptBlock.ToString()
            $iss.Commands.Add((New-Object System.Management.Automation.Runspaces.SessionStateFunctionEntry($name, $body)))
        }
        $rs = [runspacefactory]::CreateRunspace($iss)
        $rs.Open()
        $ps = [powershell]::Create()
        $ps.Runspace = $rs
        [void]$ps.AddScript($Script)
        foreach ($key in $Arguments.Keys) { [void]$ps.AddParameter($key, $Arguments[$key]) }
        return [PSCustomObject]@{ Shell = $ps; Runspace = $rs; Handle = $ps.BeginInvoke() }
    }

    function Complete-EmdWorker {
        param($Job)
        $output = $null
        $fail = ''
        try {
            $output = $Job.Shell.EndInvoke($Job.Handle)
        } catch {
            $ex = $_.Exception
            while ($ex.InnerException) { $ex = $ex.InnerException }
            $fail = $ex.Message
        }
        $warnings = @($Job.Shell.Streams.Error | ForEach-Object { $_.ToString() })
        $Job.Shell.Dispose()
        $Job.Runspace.Dispose()
        $last = $null
        if ($output -and $output.Count -gt 0) { $last = $output[$output.Count - 1] }
        return [PSCustomObject]@{ Result = $last; Error = $fail; Warnings = $warnings }
    }

    function Start-IndexLoad {
        if ($script:indexJob -or $script:running) { return }
        $root = ConvertTo-SharePath $txtRoot.Text
        if (-not $root) {
            Set-Status 'Укажите папку с годами.' 'warn'
            return
        }
        Set-Status "Читаю список дней: $root …"
        Set-Progress 0
        $script:indexJob = Start-EmdWorker -Script @'
param($Root)
$exists = $false
try { $exists = Test-Path -LiteralPath $Root } catch { }
$found = $null
if ($exists) { $found = Get-DayIndex -Root $Root }
[PSCustomObject]@{ Root = $Root; Exists = $exists; Index = $found }
'@ -Arguments @{ Root = $root }
        Update-Controls
        $timer.Start()
    }

    function Complete-IndexLoad {
        $done = Complete-EmdWorker $script:indexJob
        $script:indexJob = $null
        Update-Controls
        if ($done.Error) {
            Set-Status "Не удалось прочитать папки: $($done.Error)" 'error'
            Add-LogLine "Ошибка чтения папок: $($done.Error)"
        } elseif (-not $done.Result -or -not $done.Result.Exists) {
            $script:index = New-Object 'System.Collections.Generic.Dictionary[string,string]'
            Set-Status "Папка не найдена или недоступна: $(ConvertTo-SharePath $txtRoot.Text)" 'error'
            Update-Preview
        } else {
            Apply-DayIndex -Index $done.Result.Index
        }
        Update-Controls
    }

    function Complete-Export {
        $done = Complete-EmdWorker $script:exportJob
        $script:exportJob = $null
        $script:running = $false
        $line = $null
        while ($script:sync.Log.TryDequeue([ref]$line)) { Add-LogLine $line }
        foreach ($w in $done.Warnings) { Add-LogLine "Предупреждение: $w" }
        Update-Controls
        $result = $done.Result
        if ($done.Error) {
            Set-Status "Сбой: $($done.Error)" 'error'
            Add-LogLine "Сбой: $($done.Error)"
            [System.Windows.Forms.MessageBox]::Show($form, $done.Error, 'Выгрузка EMD', 'OK', 'Error') | Out-Null
        } elseif ($result -and $result.ErrorText) {
            Set-Status 'Файл не записан. Закройте его, если он открыт в Excel, и повторите.' 'error'
            [System.Windows.Forms.MessageBox]::Show($form, $result.ErrorText, 'Выгрузка EMD', 'OK', 'Warning') | Out-Null
        } elseif ($result -and $result.Cancelled) {
            Set-Status 'Остановлено. Файл не записан.' 'warn'
        } elseif ($result -and $result.Written) {
            Set-Progress 1
            $errNote = ''
            if ($result.Errors -gt 0) { $errNote = "   ·   ошибок: $($result.Errors) (см. журнал)" }
            Set-Status ("Готово: строк {0}, файлов {1}{2}" -f $result.Rows, $result.Files, $errNote) 'ok'
            $ask = [System.Windows.Forms.MessageBox]::Show(
                $form,
                "Строк в таблице: $($result.Rows)`r`n$($result.OutputCsv)`r`n`r`nОткрыть папку с файлом?",
                'Выгрузка EMD',
                'YesNo',
                'Information'
            )
            if ($ask -eq 'Yes') {
                Start-Process explorer.exe -ArgumentList ('/select,"{0}"' -f $result.OutputCsv)
            }
        } else {
            Set-Status 'Сбор завершился без результата.' 'warn'
        }
    }

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 200
    $timer.Add_Tick({
        try {
            if ($script:indexJob -and $script:indexJob.Handle.IsCompleted) { Complete-IndexLoad }
            if ($script:exportJob -and $script:sync) {
                $s = $script:sync
                if (-not $s.Cancel) {
                    Set-Status ("Обработка {0}   ·   дней {1} из {2}   ·   файлов: {3}   ·   строк: {4}   ·   ошибок: {5}" -f $s.Day, $s.DaysDone, $s.DaysTotal, $s.Files, $s.Rows, $s.Errors)
                }
                if ($s.DaysTotal -gt 0) { Set-Progress ([double]$s.DaysDone / [double]$s.DaysTotal) }
                $line = $null
                while ($s.Log.TryDequeue([ref]$line)) { Add-LogLine $line }
                if ($script:exportJob.Handle.IsCompleted) { Complete-Export }
            }
            if (-not $script:indexJob -and -not $script:exportJob) { $timer.Stop() }
        } catch {
            $timer.Stop()
            $script:running = $false
            $script:exportJob = $null
            $script:indexJob = $null
            Update-Controls
            Set-Status "Сбой интерфейса: $($_.Exception.Message)" 'error'
        }
    })

    function Start-Export {
        if ($script:running -or $script:indexJob) { return }
        $range = Get-ChosenRange
        $root = ConvertTo-SharePath $txtRoot.Text
        $csvPath = $txtCsv.Text.Trim().Trim('"')
        if (-not $csvPath) {
            [System.Windows.Forms.MessageBox]::Show($form, 'Укажите, куда сохранить CSV.', 'Выгрузка EMD', 'OK', 'Information') | Out-Null
            return
        }
        if (-not $csvPath.EndsWith('.csv', [StringComparison]::OrdinalIgnoreCase)) { $csvPath += '.csv' }
        foreach ($col in $choiceCols) { Add-ManualValue -List $col.List -Box $col.Box }
        $pickedTypes = (Get-CheckedNames $listType).ToArray()
        $pickedOps = (Get-CheckedNames $listOp).ToArray()
        $pickedMco = (Get-CheckedNames $listMco).ToArray()
        $pickedCols = (Get-CheckedNames $listCols).ToArray()
        if ($pickedCols.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show($form, 'Отметьте хотя бы один столбец.', 'Выгрузка EMD', 'OK', 'Information') | Out-Null
            return
        }
        if ($pickedTypes.Count -eq 0 -and $pickedOps.Count -eq 0 -and $pickedMco.Count -eq 0) {
            $all = [System.Windows.Forms.MessageBox]::Show(
                $form,
                'Фильтры пустые: в таблицу попадут все документы периода. Продолжить?',
                'Выгрузка EMD', 'YesNo', 'Question'
            )
            if ($all -ne 'Yes') { return }
        }
        Save-UiSettings
        $found = (Get-FoundDays $range).Days
        if ($found -eq 0) {
            [System.Windows.Forms.MessageBox]::Show($form, 'В выбранном периоде нет папок с файлами.', 'Выгрузка EMD', 'OK', 'Information') | Out-Null
            return
        }
        if (Test-Path -LiteralPath $csvPath) {
            $overwrite = [System.Windows.Forms.MessageBox]::Show(
                $form, "Файл уже есть. Заменить?`r`n$csvPath", 'Выгрузка EMD', 'YesNo', 'Question'
            )
            if ($overwrite -ne 'Yes') { return }
        }

        $log.Clear()
        Add-LogLine ("Период {0:dd.MM.yyyy} — {1:dd.MM.yyyy}, папок: {2}" -f $range.From, $range.To, $found)
        Add-LogLine ("TYPE: {0}" -f $(if ($pickedTypes.Count) { $pickedTypes -join ', ' } else { 'все' }))
        Add-LogLine ("OPTYPE: {0}" -f $(if ($pickedOps.Count) { $pickedOps -join ', ' } else { 'все' }))
        Add-LogLine ("MCO_TYPE: {0}" -f $(if ($pickedMco.Count) { $pickedMco -join ', ' } else { 'все' }))
        Add-LogLine ("Столбцы: {0}" -f ($pickedCols -join ', '))
        Set-Progress 0

        $script:sync = [hashtable]::Synchronized(@{
            Cancel    = $false
            Files     = 0
            Rows      = 0
            Errors    = 0
            Day       = ''
            DaysDone  = 0
            DaysTotal = $found
            Log       = (New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]')
        })
        $script:running = $true
        Update-Controls
        $script:exportJob = Start-EmdWorker -Script @'
param($Root, $From, $To, $OutputCsv, $DayIndex, $Sync, [string[]]$Types, [string[]]$OpTypes, [string[]]$McoValues, [string[]]$Columns)
Export-EmdPeriod -Root $Root -From $From -To $To -OutputCsv $OutputCsv -DayIndex $DayIndex -Sync $Sync `
    -Types $Types -OpTypes $OpTypes -McoValues $McoValues -Columns $Columns
'@ -Arguments @{
            Root      = $root
            From      = $range.From
            To        = $range.To
            OutputCsv = $csvPath
            DayIndex  = $script:index
            Sync      = $script:sync
            Types     = [string[]]$pickedTypes
            OpTypes   = [string[]]$pickedOps
            McoValues = [string[]]$pickedMco
            Columns   = [string[]]$pickedCols
        }
        $timer.Start()
    }

    # ---------- События ----------
    $script:periodChosen = $false

    # DateSelected, а не DateChanged: DateChanged срабатывал и при листании месяцев стрелками.
    $cal.Add_DateSelected({
        if ($script:updating) { return }
        $script:periodChosen = $true
        Set-Period -FromDate $cal.SelectionStart -ToDate $cal.SelectionEnd
    })
    $pickFrom.Add_ValueChanged({
        if ($script:updating) { return }
        $script:periodChosen = $true
        Set-Period -FromDate $pickFrom.Value -ToDate $pickTo.Value
    })
    $pickTo.Add_ValueChanged({
        if ($script:updating) { return }
        $script:periodChosen = $true
        Set-Period -FromDate $pickFrom.Value -ToDate $pickTo.Value
    })

    $btnToday.Add_Click({
        $script:periodChosen = $true
        $d = (Get-Date).Date
        Set-Period -FromDate $d -ToDate $d
    })
    $btnYesterday.Add_Click({
        $script:periodChosen = $true
        $d = (Get-Date).Date.AddDays(-1)
        Set-Period -FromDate $d -ToDate $d
    })
    $btnWeek.Add_Click({
        $script:periodChosen = $true
        $today = (Get-Date).Date
        $monday = $today.AddDays(-((([int]$today.DayOfWeek) + 6) % 7))
        Set-Period -FromDate $monday -ToDate $monday.AddDays(6)
    })
    $btnMonth.Add_Click({
        $script:periodChosen = $true
        $today = (Get-Date).Date
        $start = [datetime]::new($today.Year, $today.Month, 1)
        Set-Period -FromDate $start -ToDate $start.AddMonths(1).AddDays(-1)
    })
    $btnPrev.Add_Click({
        $script:periodChosen = $true
        $today = (Get-Date).Date
        $start = [datetime]::new($today.Year, $today.Month, 1).AddMonths(-1)
        Set-Period -FromDate $start -ToDate $start.AddMonths(1).AddDays(-1)
    })

    $btnRoot.Add_Click({
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Папка, внутри которой лежат годы (2025, 2026, …)'
        $current = ConvertTo-SharePath $txtRoot.Text
        try { if ($current -and (Test-Path -LiteralPath $current)) { $dlg.SelectedPath = $current } } catch { }
        if ($dlg.ShowDialog($form) -eq 'OK') {
            $txtRoot.Text = $dlg.SelectedPath
            Start-IndexLoad
        }
        $dlg.Dispose()
    })
    $btnReload.Add_Click({ Start-IndexLoad })
    $txtRoot.Add_KeyDown({
        if ($_.KeyCode -eq 'Enter') { $_.SuppressKeyPress = $true; Start-IndexLoad }
    })

    $txtCsv.Add_TextChanged({
        if (-not $script:updating) { $script:csvEdited = [bool]$txtCsv.Text }
    })
    $btnCsv.Add_Click({
        $dlg = New-Object System.Windows.Forms.SaveFileDialog
        $dlg.Filter = 'CSV (*.csv)|*.csv'
        $dlg.DefaultExt = 'csv'
        $dlg.AddExtension = $true
        $dlg.OverwritePrompt = $false
        $dlg.Title = 'Куда сохранить CSV'
        if ($txtCsv.Text) {
            try {
                $dlg.FileName = [System.IO.Path]::GetFileName($txtCsv.Text)
                $dir = Split-Path -Parent $txtCsv.Text
                if ($dir -and (Test-Path -LiteralPath $dir)) { $dlg.InitialDirectory = $dir }
            } catch { }
        }
        if ($dlg.ShowDialog($form) -eq 'OK') {
            $script:updating = $true
            $txtCsv.Text = $dlg.FileName
            $script:updating = $false
            $script:csvEdited = $true
        }
        $dlg.Dispose()
    })

    function Set-ListChecks {
        param($List, [bool]$On)
        $List.BeginUpdate()
        try {
            for ($i = 0; $i -lt $List.Items.Count; $i++) { $List.SetItemChecked($i, $On) }
        } finally {
            $List.EndUpdate()
        }
        Update-ChoiceCount $List
        Save-UiSettings
    }

    $script:choiceByName = @{}
    foreach ($col in $choiceCols) {
        $script:choiceByName[$col.List.Name] = $col
        $col.All.Add_Click({ Set-ListChecks $script:choiceByName[$this.Name].List $true })
        $col.None.Add_Click({ Set-ListChecks $script:choiceByName[$this.Name].List $false })
        $col.Add.Add_Click({
            $c = $script:choiceByName[$this.Name]
            Add-ManualValue -List $c.List -Box $c.Box
            Save-UiSettings
        })
        $col.Box.Add_KeyDown({
            if ($_.KeyCode -eq 'Enter') {
                $_.SuppressKeyPress = $true
                $c = $script:choiceByName[$this.Name]
                Add-ManualValue -List $c.List -Box $c.Box
                Save-UiSettings
            }
        })
    }

    $btnSettings.Add_Click({
        $ask = [System.Windows.Forms.MessageBox]::Show(
            $form, 'Вернуть списки TYPE, OPTYPE, MCO и столбцов к значениям по умолчанию?',
            'Выгрузка EMD', 'YesNo', 'Question'
        )
        if ($ask -ne 'Yes') { return }
        Import-UiSettings -Defaults
        Save-UiSettings
        Set-Status 'Настройки сброшены.'
    })

    $btnStop.Add_Click({
        if ($script:sync) { $script:sync.Cancel = $true }
        $btnStop.Enabled = $false
        Set-Status 'Останавливаю…' 'warn'
    })

    $btnGo.Add_Click({
        try {
            Start-Export
        } catch {
            $script:running = $false
            Update-Controls
            Set-Status "Сбой: $($_.Exception.Message)" 'error'
            [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Выгрузка EMD', 'OK', 'Error') | Out-Null
        }
    })

    $form.Add_KeyDown({
        if ($_.KeyCode -eq 'F5' -and $btnReload.Enabled) { $_.Handled = $true; Start-IndexLoad }
        elseif ($_.KeyCode -eq 'Escape' -and $btnStop.Enabled) { $_.Handled = $true; $btnStop.PerformClick() }
        elseif ($_.Control -and $_.KeyCode -eq 'Enter' -and $btnGo.Enabled) { $_.Handled = $true; $_.SuppressKeyPress = $true; $btnGo.PerformClick() }
    })

    $form.Add_Shown({
        Update-Preview
        Update-CsvName
        Start-IndexLoad
    })
    $form.Add_FormClosing({
        if ($script:running) {
            $ask = [System.Windows.Forms.MessageBox]::Show(
                $form, 'Сбор ещё идёт. Остановить и закрыть окно?', 'Выгрузка EMD', 'YesNo', 'Warning'
            )
            if ($ask -ne 'Yes') { $_.Cancel = $true; return }
            if ($script:sync) { $script:sync.Cancel = $true }
        }
        $timer.Stop()
        Save-UiSettings
    })

    Update-Controls
    [void]$form.ShowDialog()
    $form.Dispose()
}

if ($NoGui) {
    if (-not $RootPath -or -not $From -or -not $To -or -not $OutputCsv) {
        Write-Host 'Нужны -RootPath -From yyyy-MM-dd -To yyyy-MM-dd -OutputCsv'
        exit 2
    }
    $index = Get-DayIndex -Root (ConvertTo-SharePath $RootPath)
    $fromDate = [datetime]::ParseExact($From, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    $toDate = [datetime]::ParseExact($To, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
    $result = Export-EmdPeriod -Root $RootPath -From $fromDate -To $toDate -OutputCsv $OutputCsv -DayIndex $index
    Write-Host ("ROWS={0} FILES={1} ERRORS={2} DAYS={3} WRITTEN={4}" -f $result.Rows, $result.Files, $result.Errors, $result.Days, $result.Written)
    if ($result.Written) { exit 0 } else { exit 1 }
}

try {
    Show-EmdForm -InitialRoot $RootPath
} catch {
    # Окно запускается без консоли, поэтому ошибку показываем диалогом.
    $message = $_.Exception.Message + [Environment]::NewLine + [Environment]::NewLine + $_.InvocationInfo.PositionMessage
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, 'Выгрузка EMD — ошибка', 'OK', 'Error') | Out-Null
    } catch {
        Write-Host $message
    }
    exit 1
}
