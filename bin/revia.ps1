$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  [Console]::Error.WriteLine('Use bin/revia on macOS or Linux.')
  exit 69
}

function Show-Usage {
  @'
Usage: revia <command> [options] <file.re>

Commands:
  check       Validate a Re program.
  run         Execute a checked Re program.
  manifest    Print the machine contract.
  view        Render a semantic review view.
  translate   Print the checked translation.
  build       Emit a self-contained Node demo artifact.
  audit       Print structured audit facts.
  profile     Print the runtime profile.
  patch       Apply a checked patch.
  review-index Query semantic review facts.
  project-check Validate a package project manifest.
  project-run Run a package project fixture.

Run "revia help <command>" or "revia <command> --help" for command usage.
'@
}

function Show-CommandUsage([string]$Command) {
  switch ($Command) {
    'check' { 'Usage: revia check [--format json | --write] <file.re>'; break }
    'run' { 'Usage: revia run [--format json] <file.re> [-- <args>...]'; break }
    'manifest' { 'Usage: revia manifest <file.re>'; break }
    'view' { 'Usage: revia view [--locale zh-CN|en-US] [--format html|svg] <file.re>'; break }
    'translate' { 'Usage: revia translate --format json <file.re>'; break }
    'build' { 'Usage: revia build --out <dir> <file.re>'; break }
    'audit' { 'Usage: revia audit --format json <file.re>'; break }
    'profile' { 'Usage: revia profile <file.re>'; break }
    'patch' { 'Usage: revia patch --patch <patch.json> <file.re>'; break }
    'review-index' { 'Usage: revia review-index [--changed-since <revision>] [--cursor <cursor>] [--limit <n>] [--fact-id <id> --index-revision <revision>] <file.re>'; break }
    'project-check' { 'Usage: revia project-check --format json <project-dir>'; break }
    'project-run' { 'Usage: revia project-run --fixture <fixture.json> <project-dir>'; break }
    default {
      [Console]::Error.WriteLine("Unknown Revia command: $Command")
      exit 64
    }
  }
}

function Get-ReviaRoot {
  $item = Get-Item -LiteralPath $PSCommandPath -Force
  while ($item.LinkType -and $item.Target) {
    $target = @($item.Target)[0]
    if ([IO.Path]::IsPathRooted($target)) {
      $item = Get-Item -LiteralPath $target -Force
    } else {
      $item = Get-Item -LiteralPath (Join-Path $item.DirectoryName $target) -Force
    }
  }
  return (Split-Path -Parent (Split-Path -Parent $item.FullName))
}

function Fail-Runtime([string]$Message) {
  [Console]::Error.WriteLine("Revia runtime error: $Message")
  exit 70
}

try {
  $Root = Get-ReviaRoot
  $Version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -TotalCount 1).Trim()

  if ($args.Count -eq 1 -and ($args[0] -eq '--version' -or $args[0] -eq 'version')) {
    Write-Output "revia $Version"
    exit 0
  }
  if ($args.Count -eq 1 -and ($args[0] -eq '--help' -or $args[0] -eq 'help')) {
    Show-Usage
    exit 0
  }
  if ($args.Count -eq 2 -and $args[0] -eq 'help') {
    Show-CommandUsage $args[1]
    exit 0
  }
  if ($args.Count -eq 2 -and $args[1] -eq '--help') {
    Show-CommandUsage $args[0]
    exit 0
  }

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

  $RawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
  } else {
    $env:PROCESSOR_ARCHITECTURE
  }
  $Platform = switch ($RawArchitecture.ToUpperInvariant()) {
    'ARM64' { 'windows-arm64'; break }
    'AMD64' { 'windows-x64'; break }
    default {
      [Console]::Error.WriteLine("Revia $Version has no Windows binary for $RawArchitecture.")
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
      Fail-Runtime "Missing or duplicate checksum for $Name."
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
        Fail-Runtime "Checksum mismatch for $Asset."
      }
      Expand-Archive -LiteralPath $Archive -DestinationPath $TempDir
      $DownloadedExecutable = Join-Path $TempDir 'revia.exe'
      if (-not (Test-Path -LiteralPath $DownloadedExecutable -PathType Leaf)) {
        Fail-Runtime "Release archive did not contain $BinaryName."
      }
      if ((Get-Sha256 $DownloadedExecutable) -ne $ExpectedBinary) {
        Fail-Runtime "Executable checksum mismatch for $BinaryName."
      }
      New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
      Move-Item -LiteralPath $DownloadedExecutable -Destination $Executable
    } finally {
      Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  if ((Get-Sha256 $Executable) -ne $ExpectedBinary) {
    Fail-Runtime "Cached executable checksum mismatch for $BinaryName."
  }

  & $Executable @args
  exit $LASTEXITCODE
} catch {
  Fail-Runtime $_.Exception.Message
}
