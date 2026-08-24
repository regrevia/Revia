$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  [Console]::Error.WriteLine('Use bin/revia on macOS or Linux.')
  exit 69
}

$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$Version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -TotalCount 1).Trim()
$Repository = if ($env:REVIA_REPOSITORY) { $env:REVIA_REPOSITORY } else { 'tangshuang631/Revia' }
$ReleaseBaseUrl = if ($env:REVIA_RELEASE_BASE_URL) {
  $env:REVIA_RELEASE_BASE_URL.TrimEnd('/')
} else {
  "https://github.com/$Repository/releases/download/v$Version"
}
$CacheRoot = if ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'Revia'
} else {
  Join-Path $HOME '.cache/revia'
}

$Platform = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  'Arm64' { 'windows-arm64' }
  'X64' { 'windows-x64' }
  default {
    [Console]::Error.WriteLine("Revia $Version has no Windows binary for $($_).")
    exit 69
  }
}

$Asset = "revia-$Version-$Platform.zip"
$BinaryName = $Asset.Substring(0, $Asset.Length - '.zip'.Length)
$Checksums = Get-Content -LiteralPath (Join-Path $Root 'runtime/checksums.txt')

function Get-ExpectedSha256([string]$Name) {
  $escapedName = [Regex]::Escape($Name)
  $entry = $Checksums | Where-Object { $_ -match "^([0-9a-f]{64})  $escapedName$" }
  if (@($entry).Count -ne 1) {
    [Console]::Error.WriteLine("Missing or duplicate checksum for $Name.")
    exit 70
  }
  return ([Regex]::Match($entry, '^([0-9a-f]{64})').Groups[1].Value)
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$ExpectedArchive = Get-ExpectedSha256 $Asset
$ExpectedBinary = Get-ExpectedSha256 $BinaryName
$InstallDir = Join-Path $CacheRoot "$Version/$Platform"
$Executable = Join-Path $InstallDir 'revia.exe'

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  $TempDir = Join-Path ([IO.Path]::GetTempPath()) ("revia-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $TempDir | Out-Null
  try {
    $Archive = Join-Path $TempDir $Asset
    Write-Host "Downloading Revia $Version for $Platform..." -ForegroundColor DarkGray
    Invoke-WebRequest -Uri "$ReleaseBaseUrl/$Asset" -OutFile $Archive -UseBasicParsing
    if ((Get-Sha256 $Archive) -ne $ExpectedArchive) {
      throw "Checksum mismatch for $Asset."
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $TempDir
    $DownloadedExecutable = Join-Path $TempDir 'revia.exe'
    if ((Get-Sha256 $DownloadedExecutable) -ne $ExpectedBinary) {
      throw "Executable checksum mismatch for $BinaryName."
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Move-Item -LiteralPath $DownloadedExecutable -Destination $Executable
  } finally {
    Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ((Get-Sha256 $Executable) -ne $ExpectedBinary) {
  [Console]::Error.WriteLine("Cached executable checksum mismatch for $BinaryName.")
  exit 70
}

& $Executable @args
exit $LASTEXITCODE
