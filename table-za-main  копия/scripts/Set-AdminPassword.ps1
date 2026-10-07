# Сброс пароля admin (PBKDF2, 120000 итераций, SHA-256) — как в js/profiles.js
param(
    [string]$Password = '123',
    [string]$AppRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $AppRoot) {
    $AppRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    if (-not (Test-Path (Join-Path $AppRoot 'index.html'))) {
        $AppRoot = Split-Path $PSScriptRoot -Parent
    }
}

$profilesPath = Join-Path $AppRoot 'shared\profiles.json'
if (-not (Test-Path -LiteralPath $profilesPath)) {
    # создать минимальный файл
    $sharedDir = Join-Path $AppRoot 'shared'
    if (-not (Test-Path -LiteralPath $sharedDir)) {
        New-Item -ItemType Directory -Path $sharedDir | Out-Null
    }
    $profilesPath = Join-Path $sharedDir 'profiles.json'
    $empty = @{
        version   = 1
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        profiles  = @()
    }
    $empty | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $profilesPath -Encoding UTF8
}

function New-SaltHex {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-Pbkdf2Hex([string]$Password, [string]$Salt, [int]$Iterations = 120000) {
    $saltBytes = [System.Text.Encoding]::UTF8.GetBytes($Salt)
    $pbkdf2 = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
        $Password,
        $saltBytes,
        $Iterations,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    )
    try {
        $hash = $pbkdf2.GetBytes(32)
        return ($hash | ForEach-Object { $_.ToString('x2') }) -join ''
    } finally {
        $pbkdf2.Dispose()
    }
}

$raw = Get-Content -LiteralPath $profilesPath -Raw -Encoding UTF8
$data = $raw | ConvertFrom-Json
if (-not $data.profiles) { $data | Add-Member -NotePropertyName profiles -NotePropertyValue @() -Force }

$salt = New-SaltHex
$hash = Get-Pbkdf2Hex -Password $Password -Salt $salt
$admin = $data.profiles | Where-Object { $_.id -eq 'admin' } | Select-Object -First 1

if ($admin) {
    $admin.salt = $salt
    $admin.hash = $hash
    $admin | Add-Member -NotePropertyName hashVer -NotePropertyValue 2 -Force
} else {
    $newAdmin = [pscustomobject]@{
        id          = 'admin'
        name        = 'Administrator'
        isAdmin     = $true
        permissions = @('*')
        salt        = $salt
        hash        = $hash
        hashVer     = 2
    }
    $data.profiles = @($newAdmin) + @($data.profiles)
}

$data.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
$data | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $profilesPath -Encoding UTF8

Write-Host "OK: admin password set to '$Password'"
Write-Host "File: $profilesPath"
Write-Host "hashVer=2 salt=$salt"
Write-Host "Сбросьте кэш браузера (Ctrl+Shift+Delete) или откройте в режиме инкогнито."
