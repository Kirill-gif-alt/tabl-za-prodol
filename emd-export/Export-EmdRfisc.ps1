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
        Start-Process -FilePath $exe -ArgumentList @(
            '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
        ) | Out-Null
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
    try {
        if ($list.Count -eq 0) {
            ($columnList -join ',') | Set-Content -LiteralPath $OutputCsv -Encoding UTF8
        } else {
            $list | Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding UTF8 -Delimiter ','
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

function Show-EmdForm {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $colorHeader = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $colorText = [System.Drawing.Color]::FromArgb(15, 23, 42)
    $colorMuted = [System.Drawing.Color]::FromArgb(71, 85, 105)
    $colorBack = [System.Drawing.Color]::FromArgb(241, 245, 249)
    $colorCard = [System.Drawing.Color]::White
    $colorLine = [System.Drawing.Color]::FromArgb(203, 213, 225)
    $colorAccent = [System.Drawing.Color]::FromArgb(15, 118, 110)
    $colorAccentSoft = [System.Drawing.Color]::FromArgb(240, 253, 250)

    $clientW = 1100
    $margin = 16

    function Update-CardRegion {
        param($Card)
        $w = $Card.Width
        $h = $Card.Height
        $d = 16
        if ($w -lt $d -or $h -lt $d) { return }
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, $d, $d, 180, 90)
        $path.AddArc(($w - $d), 0, $d, $d, 270, 90)
        $path.AddArc(($w - $d), ($h - $d), $d, $d, 0, 90)
        $path.AddArc(0, ($h - $d), $d, $d, 90, 90)
        $path.CloseFigure()
        $old = $Card.Region
        $Card.Region = New-Object System.Drawing.Region($path)
        $path.Dispose()
        if ($old) { $old.Dispose() }
    }

    function New-Surface {
        param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Anchor = 'Top,Left')
        $card = New-Object System.Windows.Forms.Panel
        $card.Location = New-Object System.Drawing.Point($X, $Y)
        $card.Size = New-Object System.Drawing.Size($W, $H)
        $card.Anchor = $Anchor
        $card.BackColor = $colorCard
        $card.Add_Paint({
            $_.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $w = $this.Width - 1
            $h = $this.Height - 1
            $d = 16
            if ($w -lt $d -or $h -lt $d) { return }
            $path = New-Object System.Drawing.Drawing2D.GraphicsPath
            $path.AddArc(0, 0, $d, $d, 180, 90)
            $path.AddArc(($w - $d), 0, $d, $d, 270, 90)
            $path.AddArc(($w - $d), ($h - $d), $d, $d, 0, 90)
            $path.AddArc(0, ($h - $d), $d, $d, 90, 90)
            $path.CloseFigure()
            $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(203, 213, 225))
            $_.Graphics.DrawPath($pen, $path)
            $pen.Dispose()
            $path.Dispose()
        })
        $card.Add_Resize({ Update-CardRegion $this })
        Update-CardRegion $card
        return $card
    }

    function New-Caption {
        param($Parent, [string]$Text, [int]$X, [int]$Y)
        $label = New-Object System.Windows.Forms.Label
        $label.Text = $Text
        $label.AutoSize = $true
        $label.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
        $label.ForeColor = $colorText
        $label.BackColor = $colorCard
        $label.Location = New-Object System.Drawing.Point($X, $Y)
        $Parent.Controls.Add($label)
        return $label
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Выгрузка EMD'
    $form.StartPosition = 'CenterScreen'
    $form.ClientSize = New-Object System.Drawing.Size($clientW, 980)
    $form.BackColor = $colorBack
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
    $form.ForeColor = $colorText
    $form.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($form, $true, $null)

    $header = New-Object System.Windows.Forms.Panel
    $header.Dock = 'Top'
    $header.Height = 72
    $header.BackColor = $colorHeader
    $form.Controls.Add($header)

    $accentLine = New-Object System.Windows.Forms.Panel
    $accentLine.Dock = 'Bottom'
    $accentLine.Height = 3
    $accentLine.BackColor = [System.Drawing.Color]::FromArgb(45, 212, 191)
    $header.Controls.Add($accentLine)

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Выгрузка EMD'
    $title.ForeColor = [System.Drawing.Color]::White
    $title.Font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point(20, 10)
    $header.Controls.Add($title)

    $subtitle = New-Object System.Windows.Forms.Label
    $subtitle.Text = 'Каждый пассажир — своя строка. Несколько услуг в одном EMD — в таблице цена выбранной услуги.'
    $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
    $subtitle.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
    $subtitle.Location = New-Object System.Drawing.Point(22, 42)
    $subtitle.Size = New-Object System.Drawing.Size(1040, 22)
    $header.Controls.Add($subtitle)

    $innerW = $clientW - ($margin * 2)
    $cardSource = New-Surface -X $margin -Y ($header.Height + 12) -W $innerW -H 78 -Anchor 'Top,Left,Right'
    $form.Controls.Add($cardSource)

    $lblRoot = New-Object System.Windows.Forms.Label
    $lblRoot.Text = 'Папка с годами'
    $lblRoot.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $lblRoot.ForeColor = $colorText
    $lblRoot.BackColor = $colorCard
    $lblRoot.AutoSize = $true
    $lblRoot.Location = New-Object System.Drawing.Point(16, 10)
    $cardSource.Controls.Add($lblRoot)

    $hint = New-Object System.Windows.Forms.Label
    $hint.Text = 'Внутри: годы, затем месяцы 01–12 и дни 01–31.'
    $hint.ForeColor = $colorMuted
    $hint.BackColor = $colorCard
    $hint.AutoSize = $true
    $hint.Location = New-Object System.Drawing.Point(148, 12)
    $cardSource.Controls.Add($hint)

    $txtRoot = New-Object System.Windows.Forms.TextBox
    $txtRoot.Text = '\\192.168.10.20\files'
    $txtRoot.Location = New-Object System.Drawing.Point(16, 38)
    $txtRoot.Size = New-Object System.Drawing.Size(780, 26)
    $txtRoot.Anchor = 'Top,Left,Right'
    $cardSource.Controls.Add($txtRoot)

    $btnRoot = New-Object System.Windows.Forms.Button
    $btnRoot.Text = 'Выбрать'
    $btnRoot.Location = New-Object System.Drawing.Point(808, 36)
    $btnRoot.Size = New-Object System.Drawing.Size(112, 32)
    $btnRoot.Anchor = 'Top,Right'
    $cardSource.Controls.Add($btnRoot)

    $btnReload = New-Object System.Windows.Forms.Button
    $btnReload.Text = 'Обновить'
    $btnReload.Location = New-Object System.Drawing.Point(928, 36)
    $btnReload.Size = New-Object System.Drawing.Size(124, 32)
    $btnReload.Anchor = 'Top,Right'
    $cardSource.Controls.Add($btnReload)

    $cardPeriod = New-Surface -X $margin -Y ($cardSource.Bottom + 12) -W $innerW -H 280 -Anchor 'Top,Left,Right'
    $form.Controls.Add($cardPeriod)
    New-Caption -Parent $cardPeriod -Text 'Период' -X 16 -Y 12 | Out-Null

    $cal = New-Object System.Windows.Forms.MonthCalendar
    $cal.Location = New-Object System.Drawing.Point(16, 42)
    $cal.CalendarDimensions = New-Object System.Drawing.Size(2, 1)
    $cal.MaxSelectionCount = 800
    $cal.FirstDayOfWeek = [System.Windows.Forms.Day]::Monday
    $cal.ShowToday = $true
    $cal.ShowTodayCircle = $true
    $cardPeriod.Controls.Add($cal)

    $rx = $cal.Right + 28
    $lblFrom = New-Object System.Windows.Forms.Label
    $lblFrom.Text = 'С'
    $lblFrom.AutoSize = $true
    $lblFrom.BackColor = $colorCard
    $lblFrom.Location = New-Object System.Drawing.Point($rx, 48)
    $cardPeriod.Controls.Add($lblFrom)

    $pickFrom = New-Object System.Windows.Forms.DateTimePicker
    $pickFrom.Format = 'Custom'
    $pickFrom.CustomFormat = 'dd.MM.yyyy'
    $pickFrom.Location = New-Object System.Drawing.Point(($rx + 36), 44)
    $pickFrom.Width = 150
    $cardPeriod.Controls.Add($pickFrom)

    $lblTo = New-Object System.Windows.Forms.Label
    $lblTo.Text = 'По'
    $lblTo.AutoSize = $true
    $lblTo.BackColor = $colorCard
    $lblTo.Location = New-Object System.Drawing.Point($rx, 88)
    $cardPeriod.Controls.Add($lblTo)

    $pickTo = New-Object System.Windows.Forms.DateTimePicker
    $pickTo.Format = 'Custom'
    $pickTo.CustomFormat = 'dd.MM.yyyy'
    $pickTo.Location = New-Object System.Drawing.Point(($rx + 36), 84)
    $pickTo.Width = 150
    $cardPeriod.Controls.Add($pickTo)

    $btnToday = New-Object System.Windows.Forms.Button
    $btnToday.Text = 'Сегодня'
    $btnToday.Location = New-Object System.Drawing.Point($rx, 128)
    $btnToday.Size = New-Object System.Drawing.Size(96, 34)
    $cardPeriod.Controls.Add($btnToday)

    $btnWeek = New-Object System.Windows.Forms.Button
    $btnWeek.Text = 'Неделя'
    $btnWeek.Location = New-Object System.Drawing.Point(($rx + 104), 128)
    $btnWeek.Size = New-Object System.Drawing.Size(96, 34)
    $cardPeriod.Controls.Add($btnWeek)

    $btnMonth = New-Object System.Windows.Forms.Button
    $btnMonth.Text = 'Месяц'
    $btnMonth.Location = New-Object System.Drawing.Point(($rx + 208), 128)
    $btnMonth.Size = New-Object System.Drawing.Size(96, 34)
    $cardPeriod.Controls.Add($btnMonth)

    $btnPrev = New-Object System.Windows.Forms.Button
    $btnPrev.Text = 'Прошлый месяц'
    $btnPrev.Location = New-Object System.Drawing.Point(($rx + 312), 128)
    $btnPrev.Size = New-Object System.Drawing.Size(140, 34)
    $cardPeriod.Controls.Add($btnPrev)

    $lblPreview = New-Object System.Windows.Forms.Label
    $lblPreview.Location = New-Object System.Drawing.Point($rx, 174)
    $lblPreview.Size = New-Object System.Drawing.Size(($innerW - $rx - 20), 76)
    $lblPreview.Anchor = 'Top,Left,Right'
    $lblPreview.BackColor = $colorCard
    $lblPreview.Text = 'Выберите период.'
    $cardPeriod.Controls.Add($lblPreview)
    $cardPeriod.Height = [Math]::Max(($cal.Bottom + 16), ($lblPreview.Bottom + 16))
    Update-CardRegion $cardPeriod

    $tip = New-Object System.Windows.Forms.ToolTip
    $tip.SetToolTip($cal, 'Протяните мышью от первого дня к последнему. Жирным отмечены дни, в которых есть папка.')
    $tip.SetToolTip($btnMonth, 'С 1-го числа по последний день текущего месяца.')
    $tip.SetToolTip($btnPrev, 'Весь предыдущий месяц.')

    $colCardW = 336
    $filterW = $innerW - $colCardW - 12
    $cardsTop = $cardPeriod.Bottom + 12
    $cardFilter = New-Surface -X $margin -Y $cardsTop -W $filterW -H 300 -Anchor 'Top,Left,Right'
    $form.Controls.Add($cardFilter)
    New-Caption -Parent $cardFilter -Text 'Фильтры' -X 16 -Y 12 | Out-Null

    $lblFilterHint = New-Object System.Windows.Forms.Label
    $lblFilterHint.Text = 'Пустой список пропускает всё. «Все» отмечает только значения, которые уже есть в списке.'
    $lblFilterHint.ForeColor = $colorMuted
    $lblFilterHint.BackColor = $colorCard
    $lblFilterHint.AutoSize = $false
    $lblFilterHint.Location = New-Object System.Drawing.Point(110, 14)
    $lblFilterHint.Size = New-Object System.Drawing.Size(($filterW - 126), 34)
    $cardFilter.Controls.Add($lblFilterHint)

    $listType = New-Object System.Windows.Forms.CheckedListBox
    $listOp = New-Object System.Windows.Forms.CheckedListBox
    $listMco = New-Object System.Windows.Forms.CheckedListBox
    $txtTypeAdd = New-Object System.Windows.Forms.TextBox
    $txtOpAdd = New-Object System.Windows.Forms.TextBox
    $txtMcoAdd = New-Object System.Windows.Forms.TextBox
    $btnTypeAdd = New-Object System.Windows.Forms.Button
    $btnOpAdd = New-Object System.Windows.Forms.Button
    $btnMcoAdd = New-Object System.Windows.Forms.Button
    $btnTypeAll = New-Object System.Windows.Forms.Button
    $btnTypeNone = New-Object System.Windows.Forms.Button
    $btnOpAll = New-Object System.Windows.Forms.Button
    $btnOpNone = New-Object System.Windows.Forms.Button
    $btnMcoAll = New-Object System.Windows.Forms.Button
    $btnMcoNone = New-Object System.Windows.Forms.Button

    function New-FilterColumn {
        param($Parent, [string]$Caption, $List, $Box, $Button, $AllButton, $NoneButton, [int]$Left, [int]$Width, [int]$HeaderTop, [int]$ListTop, [int]$ListHeight)
        $label = New-Object System.Windows.Forms.Label
        $label.Text = $Caption
        $label.AutoSize = $true
        $label.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
        $label.ForeColor = $colorText
        $label.BackColor = $colorCard
        $label.Location = New-Object System.Drawing.Point($Left, ($HeaderTop + 4))
        $Parent.Controls.Add($label)

        $AllButton.Text = 'Все'
        $AllButton.Tag = 'link'
        $AllButton.AccessibleName = "Выбрать все: $Caption"
        $AllButton.Size = New-Object System.Drawing.Size(44, 26)
        $AllButton.Location = New-Object System.Drawing.Point(($Left + $Width - 112), $HeaderTop)
        $Parent.Controls.Add($AllButton)

        $NoneButton.Text = 'Снять'
        $NoneButton.Tag = 'link'
        $NoneButton.AccessibleName = "Снять все: $Caption"
        $NoneButton.Size = New-Object System.Drawing.Size(64, 26)
        $NoneButton.Location = New-Object System.Drawing.Point(($Left + $Width - 64), $HeaderTop)
        $Parent.Controls.Add($NoneButton)

        $List.CheckOnClick = $true
        $List.IntegralHeight = $false
        $List.HorizontalScrollbar = $true
        $List.BorderStyle = 'FixedSingle'
        $List.Location = New-Object System.Drawing.Point($Left, $ListTop)
        $List.Size = New-Object System.Drawing.Size($Width, $ListHeight)
        $Parent.Controls.Add($List)

        $addW = 88
        $Box.Location = New-Object System.Drawing.Point($Left, ($ListTop + $ListHeight + 8))
        $Box.Size = New-Object System.Drawing.Size(($Width - $addW - 8), 26)
        $Parent.Controls.Add($Box)
        $Button.Text = 'Добавить'
        $Button.Location = New-Object System.Drawing.Point(($Left + $Width - $addW), ($ListTop + $ListHeight + 6))
        $Button.Size = New-Object System.Drawing.Size($addW, 30)
        $Parent.Controls.Add($Button)
    }

    $colGap = 12
    $colPad = 16
    $colW = [int][Math]::Floor(($filterW - ($colPad * 2) - ($colGap * 2)) / 3)
    $listH = 132
    New-FilterColumn -Parent $cardFilter -Caption 'TYPE' -List $listType -Box $txtTypeAdd -Button $btnTypeAdd -AllButton $btnTypeAll -NoneButton $btnTypeNone -Left $colPad -Width $colW -HeaderTop 48 -ListTop 78 -ListHeight $listH
    New-FilterColumn -Parent $cardFilter -Caption 'OPTYPE' -List $listOp -Box $txtOpAdd -Button $btnOpAdd -AllButton $btnOpAll -NoneButton $btnOpNone -Left ($colPad + $colW + $colGap) -Width $colW -HeaderTop 48 -ListTop 78 -ListHeight $listH
    New-FilterColumn -Parent $cardFilter -Caption 'MCO' -List $listMco -Box $txtMcoAdd -Button $btnMcoAdd -AllButton $btnMcoAll -NoneButton $btnMcoNone -Left ($colPad + (($colW + $colGap) * 2)) -Width $colW -HeaderTop 48 -ListTop 78 -ListHeight $listH
    $cardFilter.Height = 78 + $listH + 8 + 30 + 16
    Update-CardRegion $cardFilter

    $cardCols = New-Surface -X ($margin + $filterW + 12) -Y $cardsTop -W $colCardW -H $cardFilter.Height -Anchor 'Top,Right'
    $form.Controls.Add($cardCols)

    $listCols = New-Object System.Windows.Forms.CheckedListBox
    $txtColAdd = New-Object System.Windows.Forms.TextBox
    $btnColAdd = New-Object System.Windows.Forms.Button
    $btnColAll = New-Object System.Windows.Forms.Button
    $btnColNone = New-Object System.Windows.Forms.Button
    $colInnerW = $colCardW - 32
    New-FilterColumn -Parent $cardCols -Caption 'Столбцы' -List $listCols -Box $txtColAdd -Button $btnColAdd -AllButton $btnColAll -NoneButton $btnColNone -Left 16 -Width $colInnerW -HeaderTop 12 -ListTop 44 -ListHeight ($listH + 34)
    $tip.SetToolTip($txtColAdd, 'Имя поля из XML, если его нет в списке. Несколько значений — через запятую.')
    $tip.SetToolTip($txtTypeAdd, 'Новое значение TYPE. Несколько — через запятую или точку с запятой.')
    $tip.SetToolTip($txtOpAdd, 'Новое значение OPTYPE. Несколько — через запятую или точку с запятой.')
    $tip.SetToolTip($txtMcoAdd, 'rfisc, текст MCO_TYPE или rfic. Несколько — через запятую.')
    $tip.SetToolTip($btnTypeAll, 'Отметить все значения TYPE в списке.')
    $tip.SetToolTip($btnOpAll, 'Отметить все значения OPTYPE в списке.')
    $tip.SetToolTip($btnMcoAll, 'Отметить все значения MCO в списке.')
    $tip.SetToolTip($btnColAll, 'Отметить все столбцы.')
    $tip.SetToolTip($btnTypeNone, 'Снять отметки TYPE. Пустой список — без фильтра по TYPE.')
    $tip.SetToolTip($btnOpNone, 'Снять отметки OPTYPE. Пустой список — без фильтра по OPTYPE.')
    $tip.SetToolTip($btnMcoNone, 'Снять отметки MCO. Пустой список — без фильтра по MCO.')
    $tip.SetToolTip($btnColNone, 'Снять отметки. Для выгрузки нужен хотя бы один столбец.')

    $cardSave = New-Surface -X $margin -Y ($cardFilter.Bottom + 12) -W $innerW -H 64 -Anchor 'Top,Left,Right'
    $form.Controls.Add($cardSave)

    $lblSave = New-Object System.Windows.Forms.Label
    $lblSave.Text = 'CSV'
    $lblSave.AutoSize = $true
    $lblSave.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
    $lblSave.BackColor = $colorCard
    $lblSave.Location = New-Object System.Drawing.Point(16, 22)
    $cardSave.Controls.Add($lblSave)

    $txtCsv = New-Object System.Windows.Forms.TextBox
    $txtCsv.Location = New-Object System.Drawing.Point(58, 18)
    $txtCsv.Size = New-Object System.Drawing.Size(820, 26)
    $txtCsv.Anchor = 'Top,Left,Right'
    $cardSave.Controls.Add($txtCsv)

    $btnCsv = New-Object System.Windows.Forms.Button
    $btnCsv.Text = 'Сохранить как'
    $btnCsv.Location = New-Object System.Drawing.Point(890, 16)
    $btnCsv.Size = New-Object System.Drawing.Size(162, 32)
    $btnCsv.Anchor = 'Top,Right'
    $cardSave.Controls.Add($btnCsv)

    $actionY = $cardSave.Bottom + 12
    $btnGo = New-Object System.Windows.Forms.Button
    $btnGo.Text = 'Собрать CSV'
    $btnGo.Tag = 'primary'
    $btnGo.Location = New-Object System.Drawing.Point($margin, $actionY)
    $btnGo.Size = New-Object System.Drawing.Size(168, 40)
    $form.Controls.Add($btnGo)

    $btnStop = New-Object System.Windows.Forms.Button
    $btnStop.Text = 'Стоп'
    $btnStop.Location = New-Object System.Drawing.Point(($margin + 180), $actionY)
    $btnStop.Size = New-Object System.Drawing.Size(112, 40)
    $btnStop.Enabled = $false
    $form.Controls.Add($btnStop)
    $form.CancelButton = $btnStop

    $lblCols = New-Object System.Windows.Forms.Label
    $lblCols.Text = 'MCO сравнивается с rfisc, текстом тега и rfic.'
    $lblCols.ForeColor = $colorMuted
    $lblCols.BackColor = $colorBack
    $lblCols.AutoSize = $true
    $lblCols.Location = New-Object System.Drawing.Point(($margin + 308), ($actionY + 12))
    $form.Controls.Add($lblCols)

    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.Location = New-Object System.Drawing.Point($margin, ($actionY + 52))
    $bar.Size = New-Object System.Drawing.Size($innerW, 10)
    $bar.Anchor = 'Top,Left,Right'
    $bar.Style = 'Continuous'
    $form.Controls.Add($bar)

    $status = New-Object System.Windows.Forms.Label
    $status.Text = 'Укажите период и файл.'
    $status.Location = New-Object System.Drawing.Point($margin, ($bar.Bottom + 6))
    $status.Size = New-Object System.Drawing.Size($innerW, 22)
    $status.Anchor = 'Top,Left,Right'
    $form.Controls.Add($status)

    $log = New-Object System.Windows.Forms.TextBox
    $log.Multiline = $true
    $log.ReadOnly = $true
    $log.ScrollBars = 'Vertical'
    $log.BorderStyle = 'FixedSingle'
    $log.Location = New-Object System.Drawing.Point($margin, ($status.Bottom + 6))
    $log.Size = New-Object System.Drawing.Size($innerW, 68)
    $log.Anchor = 'Top,Left,Right'
    $log.Font = New-Object System.Drawing.Font('Consolas', 9)
    $log.BackColor = [System.Drawing.Color]::White
    $form.Controls.Add($log)

    $form.ClientSize = New-Object System.Drawing.Size($clientW, ($log.Bottom + 16))
    $chromeW = $form.Width - $form.ClientSize.Width
    $chromeH = $form.Height - $form.ClientSize.Height
    $form.MinimumSize = New-Object System.Drawing.Size(($clientW + $chromeW), ($form.ClientSize.Height + $chromeH))

    $script:updating = $false
    $script:index = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    $script:csvEdited = $false
    $script:running = $false
    $script:sync = $null
    $script:worker = $null
    $script:handle = $null
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
    $defaultColsOn = @('BSONUM', 'FARE', 'PNR', 'FLYDATE', 'OPTYPE', 'TRANS_TYPE', 'RFISC', 'FIO')
    $defaultMcoOn = @('IP1', 'IP2', 'KV0', 'KV1', 'KV2', 'KV3', 'KV4', 'KV5', 'KV6', 'KV7', 'KV8', 'KV9')

    function Fill-CheckList {
        param($List, $Items, $Checked)
        $on = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($c in @($Checked)) { if ($c) { [void]$on.Add([string]$c) } }
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $List.Items.Clear()
        foreach ($item in @($Items)) {
            if (-not $item) { continue }
            $name = $item.ToString().Trim()
            if (-not $name -or -not $seen.Add($name)) { continue }
            [void]$List.Items.Add($name, $on.Contains($name))
        }
    }

    function Add-FlatStrings {
        param($Value, $Out)
        foreach ($item in @($Value)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Collections.IEnumerable] -and -not ($item -is [string])) {
                Add-FlatStrings $item $Out
                continue
            }
            $name = $item.ToString().Trim()
            if ($name -and $name -ne 'System.Object[]') { [void]$Out.Add($name) }
        }
    }

    function Get-FlatStrings {
        param($Value)
        $out = New-Object System.Collections.Generic.List[string]
        Add-FlatStrings $Value $out
        return ,$out.ToArray()
    }

    function Test-CorruptList {
        param($Value)
        foreach ($item in @($Value)) {
            if ($null -eq $item) { continue }
            if ($item -is [System.Collections.IEnumerable] -and -not ($item -is [string])) { return $true }
            if ([string]$item -eq 'System.Object[]') { return $true }
        }
        return $false
    }

    function Get-CheckedArray {
        param($List)
        $arr = New-Object System.Collections.Generic.List[string]
        foreach ($item in @($List.CheckedItems)) {
            $name = [string]$item
            if ($name -and $name -ne 'System.Object[]') { $arr.Add($name) }
        }
        return ,$arr.ToArray()
    }

    function Copy-CheckedValues {
        param($List)
        $raw = (Get-CheckedArray $List)
        $copy = New-Object System.Collections.Generic.List[string]
        if ($raw -is [string]) {
            $name = $raw.Trim()
            if ($name) { [void]$copy.Add($name) }
        } elseif ($null -ne $raw) {
            foreach ($item in $raw) {
                if ($null -eq $item) { continue }
                if ($item -is [System.Collections.IEnumerable] -and -not ($item -is [string])) {
                    foreach ($inner in $item) {
                        $name = ([string]$inner).Trim()
                        if ($name -and $name -ne 'System.Object[]') { [void]$copy.Add($name) }
                    }
                    continue
                }
                $name = ([string]$item).Trim()
                if ($name -and $name -ne 'System.Object[]') { [void]$copy.Add($name) }
            }
        }
        return ,$copy.ToArray()
    }

    function Get-AllItems {
        param($List)
        $arr = New-Object System.Collections.Generic.List[string]
        foreach ($item in @($List.Items)) {
            $name = [string]$item
            if ($name -and $name -ne 'System.Object[]') { $arr.Add($name) }
        }
        return ,$arr.ToArray()
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
        }
        $Box.Clear()
    }

    function Save-UiSettings {
        try {
            $dir = Split-Path -Parent $script:settingsPath
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            $payload = [ordered]@{
                types = (Get-CheckedArray $listType)
                optypes = (Get-CheckedArray $listOp)
                mco = (Get-CheckedArray $listMco)
                columns = (Get-CheckedArray $listCols)
                typeItems = (Get-AllItems $listType)
                opItems = (Get-AllItems $listOp)
                mcoItems = (Get-AllItems $listMco)
                columnItems = (Get-AllItems $listCols)
            }
            $payload | ConvertTo-Json | Set-Content -LiteralPath $script:settingsPath -Encoding UTF8
        } catch { }
    }

    function Import-UiSettings {
        $typeItems = $knownTypes
        $opItems = $knownOps
        $mcoItems = $knownMco
        $colItems = $knownCols
        $typeOn = @('EMD')
        $opOn = @('SALE', 'REFUND')
        $mcoOn = $defaultMcoOn
        $colOn = $defaultColsOn
        if (Test-Path -LiteralPath $script:settingsPath) {
            try {
                $saved = Get-Content -LiteralPath $script:settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($saved.typeItems) { $typeItems = (Get-FlatStrings $saved.typeItems) + $knownTypes }
                if ($saved.opItems) { $opItems = (Get-FlatStrings $saved.opItems) + $knownOps }
                if ($saved.mcoItems) { $mcoItems = (Get-FlatStrings $saved.mcoItems) + $knownMco }
                if ($saved.columnItems) { $colItems = (Get-FlatStrings $saved.columnItems) + $knownCols }
                if ($saved.PSObject.Properties['types']) {
                    $typeOn = (Get-FlatStrings $saved.types)
                    if ($typeOn.Count -eq 0 -and (Test-CorruptList $saved.types)) { $typeOn = @('EMD') }
                }
                if ($saved.PSObject.Properties['optypes']) {
                    $opOn = (Get-FlatStrings $saved.optypes)
                    if ($opOn.Count -eq 0 -and (Test-CorruptList $saved.optypes)) { $opOn = @('SALE', 'REFUND') }
                }
                if ($saved.PSObject.Properties['mco']) {
                    $mcoOn = (Get-FlatStrings $saved.mco)
                    if ($mcoOn.Count -eq 0 -and (Test-CorruptList $saved.mco)) { $mcoOn = $defaultMcoOn }
                }
                if ($saved.PSObject.Properties['columns']) {
                    $colOn = (Get-FlatStrings $saved.columns)
                    if ($colOn.Count -eq 0 -and (Test-CorruptList $saved.columns)) { $colOn = $defaultColsOn }
                }
            } catch { }
        }
        Fill-CheckList -List $listType -Items $typeItems -Checked $typeOn
        Fill-CheckList -List $listOp -Items $opItems -Checked $opOn
        Fill-CheckList -List $listMco -Items $mcoItems -Checked $mcoOn
        Fill-CheckList -List $listCols -Items $colItems -Checked $colOn
    }

    Import-UiSettings

    function Get-ChosenRange {
        $a = $pickFrom.Value.Date
        $b = $pickTo.Value.Date
        if ($a -le $b) { return @{ From = $a; To = $b } }
        return @{ From = $b; To = $a }
    }

    function Update-CsvName {
        if ($script:csvEdited) { return }
        $range = Get-ChosenRange
        $name = 'EMD_{0}_{1}.csv' -f $range.From.ToString('yyyyMMdd'), $range.To.ToString('yyyyMMdd')
        $dir = Get-DefaultCsvDirectory
        if ($txtCsv.Text) {
            $currentDir = Split-Path -Parent $txtCsv.Text
            if ($currentDir) { $dir = $currentDir }
        }
        $script:updating = $true
        $txtCsv.Text = Join-Path $dir $name
        $script:updating = $false
    }

    function Update-Preview {
        $range = Get-ChosenRange
        $total = ($range.To - $range.From).Days + 1
        $found = 0
        $firstPath = ''
        $cursor = $range.From
        while ($cursor -le $range.To) {
            $key = $cursor.ToString('yyyy-MM-dd')
            if ($script:index.ContainsKey($key)) {
                $found++
                if (-not $firstPath) { $firstPath = $script:index[$key] }
            }
            $cursor = $cursor.AddDays(1)
        }
        $example = ''
        if ($firstPath) { $example = "Первая папка:`r`n$firstPath" }
        elseif ($script:index.Count -eq 0) { $example = 'Список дней ещё не прочитан.' }
        else { $example = 'В этом периоде папок с файлами нет.' }
        $lblPreview.Text = ("{0:dd.MM.yyyy} — {1:dd.MM.yyyy}`r`nДней в периоде: {2}`r`nПапок с файлами: {3}`r`n{4}" -f $range.From, $range.To, $total, $found, $example)
    }

    function Set-Period {
        param([datetime]$FromDate, [datetime]$ToDate)
        if ($FromDate.Date -gt $ToDate.Date) {
            $swap = $FromDate
            $FromDate = $ToDate
            $ToDate = $swap
        }
        $min = $pickFrom.MinDate.Date
        $max = $pickFrom.MaxDate.Date
        if ($FromDate.Date -lt $min) { $FromDate = $min }
        if ($ToDate.Date -gt $max) { $ToDate = $max }
        if ($FromDate.Date -gt $ToDate.Date) { $ToDate = $FromDate }
        $script:updating = $true
        $pickFrom.Value = $FromDate.Date
        $pickTo.Value = $ToDate.Date
        $span = ($ToDate.Date - $FromDate.Date).Days + 1
        if ($cal.MaxSelectionCount -lt $span) { $cal.MaxSelectionCount = [Math]::Min(2000, $span) }
        try { $cal.SetSelectionRange($FromDate.Date, $ToDate.Date) } catch { }
        $script:updating = $false
        Update-CsvName
        Update-Preview
    }

    function Apply-DayIndex {
        param($Index)
        $script:index = $Index
        if ($Index.Count -eq 0) {
            $status.Text = 'В папке нет годов. Нужна папка files, внутри которой лежат 2025 и 2026.'
            $lblPreview.Text = 'Папки дней не найдены.'
            $btnGo.Enabled = $false
            return
        }
        $dates = New-Object System.Collections.Generic.List[datetime]
        foreach ($key in $Index.Keys) {
            $dates.Add([datetime]::ParseExact($key, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture))
        }
        $ordered = @($dates | Sort-Object)
        $min = Get-Date -Year $ordered[0].Year -Month 1 -Day 1
        $max = Get-Date -Year $ordered[-1].Year -Month 12 -Day 31
        $today = (Get-Date).Date
        if ($today -lt $min) { $today = $min }
        if ($today -gt $max) { $today = $max }

        $script:updating = $true
        $cal.MaxSelectionCount = 800
        $cal.SetSelectionRange($min, $min)
        $cal.MinDate = $min
        $cal.MaxDate = $max
        $pickFrom.MinDate = $min
        $pickFrom.MaxDate = $max
        $pickTo.MinDate = $min
        $pickTo.MaxDate = $max
        $script:updating = $false
        $cal.BoldedDates = $ordered
        Set-Period -FromDate $today -ToDate $today
        $btnGo.Enabled = -not $script:running
        $status.Text = ("Дней с папками: {0}. Выберите период и нажмите «Собрать CSV»." -f $Index.Count)
    }

    function Load-DayIndex {
        $root = ConvertTo-SharePath $txtRoot.Text
        $btnGo.Enabled = $false
        $btnReload.Enabled = $false
        $form.UseWaitCursor = $true
        $status.Text = 'Читаю список дней...'
        [System.Windows.Forms.Application]::DoEvents()
        try {
            if (-not (Test-Path -LiteralPath $root)) {
                $script:index = New-Object 'System.Collections.Generic.Dictionary[string,string]'
                $status.Text = "Папка не найдена: $root"
                $lblPreview.Text = 'Проверьте путь к папке с годами.'
                return
            }
            $found = Get-DayIndex -Root $root
            Apply-DayIndex -Index $found
        } catch {
            $status.Text = "Не удалось прочитать папки: $($_.Exception.Message)"
        } finally {
            $form.UseWaitCursor = $false
            $btnReload.Enabled = $true
            if (-not $script:running -and $script:index.Count -gt 0) { $btnGo.Enabled = $true }
        }
    }

    function Add-LogLine {
        param([string]$Line)
        if ([string]::IsNullOrEmpty($Line)) { return }
        $log.AppendText($Line + [Environment]::NewLine)
    }

    $cal.Add_DateChanged({
        if ($script:updating) { return }
        $script:updating = $true
        $pickFrom.Value = $cal.SelectionStart.Date
        $pickTo.Value = $cal.SelectionEnd.Date
        $script:updating = $false
        Update-CsvName
        Update-Preview
    })

    $pickFrom.Add_ValueChanged({
        if ($script:updating) { return }
        Set-Period -FromDate $pickFrom.Value -ToDate $pickTo.Value
    })
    $pickTo.Add_ValueChanged({
        if ($script:updating) { return }
        Set-Period -FromDate $pickFrom.Value -ToDate $pickTo.Value
    })

    $btnToday.Add_Click({
        $today = (Get-Date).Date
        Set-Period -FromDate $today -ToDate $today
    })
    $btnWeek.Add_Click({
        $today = (Get-Date).Date
        $delta = ([int]$today.DayOfWeek + 6) % 7
        $monday = $today.AddDays(-$delta)
        Set-Period -FromDate $monday -ToDate $monday.AddDays(6)
    })
    $btnMonth.Add_Click({
        $today = (Get-Date).Date
        $start = Get-Date -Year $today.Year -Month $today.Month -Day 1
        $end = $start.AddMonths(1).AddDays(-1)
        Set-Period -FromDate $start -ToDate $end
    })
    $btnPrev.Add_Click({
        $today = (Get-Date).Date
        $start = (Get-Date -Year $today.Year -Month $today.Month -Day 1).AddMonths(-1)
        $end = $start.AddMonths(1).AddDays(-1)
        Set-Period -FromDate $start -ToDate $end
    })

    $btnRoot.Add_Click({
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Папка, внутри которой лежат годы 2025 и 2026'
        $current = ConvertTo-SharePath $txtRoot.Text
        if (Test-Path -LiteralPath $current) { $dlg.SelectedPath = $current }
        if ($dlg.ShowDialog() -eq 'OK') {
            $txtRoot.Text = $dlg.SelectedPath
            Load-DayIndex
        }
    })
    $btnReload.Add_Click({ Load-DayIndex })

    $txtCsv.Add_TextChanged({
        if (-not $script:updating) { $script:csvEdited = $true }
    })
    $btnCsv.Add_Click({
        $dlg = New-Object System.Windows.Forms.SaveFileDialog
        $dlg.Filter = 'CSV (*.csv)|*.csv'
        $dlg.DefaultExt = 'csv'
        $dlg.AddExtension = $true
        $dlg.OverwritePrompt = $true
        $dlg.Title = 'Куда сохранить CSV'
        if ($txtCsv.Text) {
            $dlg.FileName = [System.IO.Path]::GetFileName($txtCsv.Text)
            $dir = Split-Path -Parent $txtCsv.Text
            if ($dir -and (Test-Path -LiteralPath $dir)) { $dlg.InitialDirectory = $dir }
        }
        if ($dlg.ShowDialog() -eq 'OK') {
            $script:updating = $true
            $txtCsv.Text = $dlg.FileName
            $script:updating = $false
            $script:csvEdited = $true
        }
    })

    function Set-ListChecks {
        param($List, [bool]$On)
        $List.BeginUpdate()
        try {
            for ($i = 0; $i -lt $List.Items.Count; $i++) {
                $List.SetItemChecked($i, $On)
            }
        } finally {
            $List.EndUpdate()
        }
        Save-UiSettings
    }

    function Set-ChoiceInputs {
        param([bool]$On)
        foreach ($control in @(
            $listType, $listOp, $listMco, $listCols,
            $txtTypeAdd, $txtOpAdd, $txtMcoAdd, $txtColAdd,
            $btnTypeAdd, $btnOpAdd, $btnMcoAdd, $btnColAdd,
            $btnTypeAll, $btnTypeNone, $btnOpAll, $btnOpNone,
            $btnMcoAll, $btnMcoNone, $btnColAll, $btnColNone
        )) {
            $control.Enabled = $On
        }
    }

    $btnTypeAdd.Add_Click({ Add-ManualValue -List $listType -Box $txtTypeAdd; Save-UiSettings })
    $btnOpAdd.Add_Click({ Add-ManualValue -List $listOp -Box $txtOpAdd; Save-UiSettings })
    $btnMcoAdd.Add_Click({ Add-ManualValue -List $listMco -Box $txtMcoAdd; Save-UiSettings })
    $btnColAdd.Add_Click({ Add-ManualValue -List $listCols -Box $txtColAdd; Save-UiSettings })
    $btnTypeAll.Add_Click({ Set-ListChecks $listType $true })
    $btnTypeNone.Add_Click({ Set-ListChecks $listType $false })
    $btnOpAll.Add_Click({ Set-ListChecks $listOp $true })
    $btnOpNone.Add_Click({ Set-ListChecks $listOp $false })
    $btnMcoAll.Add_Click({ Set-ListChecks $listMco $true })
    $btnMcoNone.Add_Click({ Set-ListChecks $listMco $false })
    $btnColAll.Add_Click({ Set-ListChecks $listCols $true })
    $btnColNone.Add_Click({ Set-ListChecks $listCols $false })
    $txtTypeAdd.Add_KeyDown({ if ($_.KeyCode -eq 'Enter') { Add-ManualValue -List $listType -Box $txtTypeAdd; Save-UiSettings } })
    $txtOpAdd.Add_KeyDown({ if ($_.KeyCode -eq 'Enter') { Add-ManualValue -List $listOp -Box $txtOpAdd; Save-UiSettings } })
    $txtMcoAdd.Add_KeyDown({ if ($_.KeyCode -eq 'Enter') { Add-ManualValue -List $listMco -Box $txtMcoAdd; Save-UiSettings } })
    $txtColAdd.Add_KeyDown({ if ($_.KeyCode -eq 'Enter') { Add-ManualValue -List $listCols -Box $txtColAdd; Save-UiSettings } })

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 250
    $timer.Add_Tick({
        if (-not $script:sync) { return }
        $status.Text = "День: {0}   файлов: {1}   строк: {2}   ошибок: {3}" -f $script:sync.Day, $script:sync.Files, $script:sync.Rows, $script:sync.Errors
        if ($script:sync.DaysTotal -gt 0) {
            $bar.Maximum = [int]$script:sync.DaysTotal
            $done = [int]$script:sync.DaysDone
            if ($done -gt $bar.Maximum) { $done = $bar.Maximum }
            $bar.Value = $done
        }
        $line = $null
        while ($script:sync.Log.TryDequeue([ref]$line)) {
            Add-LogLine $line
        }
        if ($script:handle -and $script:handle.IsCompleted) {
            $timer.Stop()
            $runError = ''
            $result = $null
            try { $result = $script:worker.EndInvoke($script:handle) }
            catch { $runError = $_.Exception.Message }
            $script:running = $false
            $btnStop.Enabled = $false
            $btnGo.Enabled = ($script:index.Count -gt 0)
            $btnRoot.Enabled = $true
            $btnReload.Enabled = $true
            $pickFrom.Enabled = $true
            $pickTo.Enabled = $true
            $cal.Enabled = $true
            Set-ChoiceInputs $true
            if ($runError) {
                $status.Text = "Сбой: $runError"
                Add-LogLine $runError
                [System.Windows.Forms.MessageBox]::Show($runError, 'Выгрузка EMD', 'OK', 'Error') | Out-Null
            } elseif ($result -and $result.ErrorText) {
                $status.Text = 'Файл не записан.'
                [System.Windows.Forms.MessageBox]::Show($result.ErrorText, 'Выгрузка EMD', 'OK', 'Warning') | Out-Null
            } elseif ($result -and $result.Cancelled) {
                $status.Text = 'Остановлено. Файл не записан.'
            } elseif ($result -and $result.Written) {
                $status.Text = "Готово. Строк: $($result.Rows). $($result.OutputCsv)"
                $ask = [System.Windows.Forms.MessageBox]::Show(
                    "Строк в таблице: $($result.Rows)`r`n$($result.OutputCsv)`r`n`r`nОткрыть папку с файлом?",
                    'Выгрузка EMD',
                    'YesNo',
                    'Information'
                )
                if ($ask -eq 'Yes') {
                    Start-Process explorer.exe -ArgumentList @('/select,', $result.OutputCsv)
                }
            }
            if ($script:worker) { $script:worker.Dispose(); $script:worker = $null }
        }
    })

    $btnStop.Add_Click({
        if ($script:sync) { $script:sync.Cancel = $true }
        $btnStop.Enabled = $false
        $status.Text = 'Останавливаю...'
    })

    $btnGo.Add_Click({
        if ($script:running) { return }
        $range = Get-ChosenRange
        $root = ConvertTo-SharePath $txtRoot.Text
        $csvPath = $txtCsv.Text.Trim().Trim('"')
        if (-not $csvPath) {
            [System.Windows.Forms.MessageBox]::Show('Укажите, куда сохранить CSV.', 'Выгрузка EMD') | Out-Null
            return
        }
        Add-ManualValue -List $listType -Box $txtTypeAdd
        Add-ManualValue -List $listOp -Box $txtOpAdd
        Add-ManualValue -List $listMco -Box $txtMcoAdd
        Add-ManualValue -List $listCols -Box $txtColAdd
        # Не оборачивать в @(): несколько отметок склеивались в одну строку и не совпадали ни с одним документом.
        $pickedTypes = (Copy-CheckedValues $listType)
        $pickedOps = (Copy-CheckedValues $listOp)
        $pickedMco = (Copy-CheckedValues $listMco)
        $pickedCols = (Copy-CheckedValues $listCols)
        if ($pickedCols.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('Отметьте хотя бы один столбец.', 'Выгрузка EMD') | Out-Null
            return
        }
        if ($pickedTypes.Count -eq 0 -and $pickedOps.Count -eq 0 -and $pickedMco.Count -eq 0) {
            $all = [System.Windows.Forms.MessageBox]::Show(
                'Фильтры пустые: в таблицу попадут все документы периода. Продолжить?',
                'Выгрузка EMD',
                'YesNo',
                'Question'
            )
            if ($all -ne 'Yes') { return }
        }
        Save-UiSettings
        $found = 0
        $cursor = $range.From
        while ($cursor -le $range.To) {
            if ($script:index.ContainsKey($cursor.ToString('yyyy-MM-dd'))) { $found++ }
            $cursor = $cursor.AddDays(1)
        }
        if ($found -eq 0) {
            [System.Windows.Forms.MessageBox]::Show('В выбранном периоде нет папок с файлами.', 'Выгрузка EMD', 'OK', 'Information') | Out-Null
            return
        }
        if (Test-Path -LiteralPath $csvPath) {
            $overwrite = [System.Windows.Forms.MessageBox]::Show(
                "Файл уже есть. Заменить?`r`n$csvPath",
                'Выгрузка EMD',
                'YesNo',
                'Question'
            )
            if ($overwrite -ne 'Yes') { return }
        }

        $log.Clear()
        Add-LogLine ("Период {0:dd.MM.yyyy} — {1:dd.MM.yyyy}, папок: {2}" -f $range.From, $range.To, $found)
        Add-LogLine ("TYPE: {0}" -f $(if ($pickedTypes.Count) { $pickedTypes -join ', ' } else { 'все' }))
        Add-LogLine ("OPTYPE: {0}" -f $(if ($pickedOps.Count) { $pickedOps -join ', ' } else { 'все' }))
        Add-LogLine ("MCO_TYPE: {0}" -f $(if ($pickedMco.Count) { $pickedMco -join ', ' } else { 'все' }))
        Add-LogLine ("Столбцы: {0}" -f ($pickedCols -join ', '))
        $bar.Value = 0
        $bar.Maximum = $found
        $script:running = $true
        $btnGo.Enabled = $false
        $btnStop.Enabled = $true
        $btnRoot.Enabled = $false
        $btnReload.Enabled = $false
        $pickFrom.Enabled = $false
        $pickTo.Enabled = $false
        $cal.Enabled = $false
        Set-ChoiceInputs $false

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

        $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
        $entry = New-Object System.Management.Automation.Runspaces.SessionStateFunctionEntry(
            'Export-EmdPeriod',
            ${function:Export-EmdPeriod}.ToString()
        )
        $iss.Commands.Add($entry)
        # Get-DayIndex is not needed: the form already passed the day map.
        $rs = [runspacefactory]::CreateRunspace($iss)
        $rs.Open()
        $script:worker = [powershell]::Create()
        $script:worker.Runspace = $rs
        [void]$script:worker.AddCommand('Export-EmdPeriod')
        [void]$script:worker.AddParameter('Root', $root)
        [void]$script:worker.AddParameter('From', $range.From)
        [void]$script:worker.AddParameter('To', $range.To)
        [void]$script:worker.AddParameter('OutputCsv', $csvPath)
        [void]$script:worker.AddParameter('DayIndex', $script:index)
        [void]$script:worker.AddParameter('Sync', $script:sync)
        if ($null -eq $pickedTypes) { $pickedTypes = New-Object string[] 0 }
        if ($null -eq $pickedOps) { $pickedOps = New-Object string[] 0 }
        if ($null -eq $pickedMco) { $pickedMco = New-Object string[] 0 }
        [void]$script:worker.AddParameter('Types', [string[]]$pickedTypes)
        [void]$script:worker.AddParameter('OpTypes', [string[]]$pickedOps)
        [void]$script:worker.AddParameter('McoValues', [string[]]$pickedMco)
        [void]$script:worker.AddParameter('Columns', [string[]]$pickedCols)
        $script:handle = $script:worker.BeginInvoke()
        $timer.Start()
    })

    $form.Add_Shown({ Load-DayIndex })
    $form.Add_FormClosing({
        if ($script:running -and $script:sync) { $script:sync.Cancel = $true }
        $timer.Stop()
        Save-UiSettings
    })

    function Update-ButtonFace {
        param($Button)
        $kind = [string]$Button.Tag
        $on = $Button.Enabled
        if ($kind -eq 'primary') {
            $Button.FlatAppearance.BorderSize = 0
            $Button.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(17, 94, 89)
            $Button.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(19, 78, 74)
            if ($on) {
                $Button.BackColor = $colorAccent
                $Button.ForeColor = [System.Drawing.Color]::White
            } else {
                $Button.BackColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
                $Button.ForeColor = [System.Drawing.Color]::FromArgb(71, 85, 105)
            }
        } elseif ($kind -eq 'link') {
            $Button.FlatAppearance.BorderSize = 0
            $Button.FlatAppearance.MouseOverBackColor = $colorAccentSoft
            $Button.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(204, 251, 241)
            $Button.BackColor = $colorCard
            if ($on) { $Button.ForeColor = $colorAccent } else { $Button.ForeColor = $colorMuted }
        } else {
            $Button.FlatAppearance.BorderSize = 1
            $Button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
            $Button.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(248, 250, 252)
            $Button.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(241, 245, 249)
            $Button.BackColor = $colorCard
            if ($on) { $Button.ForeColor = $colorText } else { $Button.ForeColor = $colorMuted }
        }
    }

    function Set-ModernControl {
        param($Control)
        if ($Control -is [System.Windows.Forms.Button]) {
            $Control.FlatStyle = 'Flat'
            $Control.UseVisualStyleBackColor = $false
            $Control.Cursor = [System.Windows.Forms.Cursors]::Hand
            $Control.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
            Update-ButtonFace $Control
            $Control.Add_EnabledChanged({ Update-ButtonFace $this })
        } elseif ($Control -is [System.Windows.Forms.TextBox]) {
            $Control.BorderStyle = 'FixedSingle'
            $Control.BackColor = $colorCard
            $Control.ForeColor = $colorText
            if (-not $Control.Multiline) {
                $Control.Font = New-Object System.Drawing.Font('Segoe UI', 10)
            }
        } elseif ($Control -is [System.Windows.Forms.CheckedListBox]) {
            $Control.BorderStyle = 'FixedSingle'
            $Control.BackColor = $colorCard
            $Control.ForeColor = $colorText
            $Control.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
            $Control.IntegralHeight = $false
        } elseif ($Control -is [System.Windows.Forms.DateTimePicker]) {
            $Control.CalendarForeColor = $colorText
            $Control.CalendarTitleBackColor = $colorAccent
            $Control.CalendarTitleForeColor = [System.Drawing.Color]::White
            $Control.CalendarMonthBackground = $colorCard
            $Control.CalendarTrailingForeColor = $colorMuted
        } elseif ($Control -is [System.Windows.Forms.MonthCalendar]) {
            $Control.TitleBackColor = $colorAccent
            $Control.TitleForeColor = [System.Drawing.Color]::White
            $Control.BackColor = $colorCard
            $Control.ForeColor = $colorText
            $Control.TrailingForeColor = $colorMuted
        }
        foreach ($child in @($Control.Controls)) { Set-ModernControl $child }
    }
    Set-ModernControl $form
    $header.BackColor = $colorHeader
    $title.ForeColor = [System.Drawing.Color]::White
    $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)

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
    exit 0
}

Show-EmdForm
