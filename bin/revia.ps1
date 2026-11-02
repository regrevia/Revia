$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  [Console]::Error.WriteLine('Use bin/revia on macOS or Linux.')
  exit 69
}

function Show-Usage {
  if ($script:ReviaVersion -eq '1.0.0-rc.1') {
@'
Usage: revia <command> [arguments]

Revia 1.0.0-rc.1 is an evaluation candidate. Native execution is measured
only on macOS arm64; all other targets are explicitly pending (exit 69).

Commands include check, manifest, execute, project-init, project-check,
project-test, project-multi-module-gate, and project-server-gate.

For the bounded, reproducible trials, see experiments/rc1/kit/README.md.
'@
    return
  }

  @'
Revia native release CLI (versioned executable)
Usage: revia <native-command> [arguments]

Native source commands:
  check <file.re>
  lex <file.re>
  digest <file.re>
  canonical <file.re>
  manifest <file.re>
  translate <file.re>
  compile <source.re> <artifact>
  execute <source.re> <input-digest>
  run <graph> <artifact> <input-digest>
  project-check <project-dir>
  project-run <project-dir> <cache> <build> <profile> <toolchain> <module> <input-digest>
  project-translate <project> <cache> <build> <profile-digest> <toolchain-digest> <module>
  [Additional versioned runtime, project, and evidence commands]

This launcher invokes the versioned native executable. It does not invoke Node.
The Node reference CLI has a separate source-oriented surface:
  npm run re -- <command> [arguments]
  npm run re -- run <file.re> [-- <program-args>...]
    [--format json --runtime-receipt | --format json --authority-pin <pin.json>]
  Exactly one program argument collides with native run arity; use the explicit npm command.
  npm run re -- view [--locale zh-CN|en-US] [--format html|svg] <file.re>
  view, audit, profile, patch, review-index, build, project-projection,
  module-surface, project-translate

Use "revia help <command>" for both signatures where they overlap.
'@
}

function Show-CommandUsage([string]$Command) {
  switch ($Command) {
    'check' {
      @'
Native: revia check <file.re>
Reference: npm run re -- check [--format json | --write] <file.re>
'@
      break
    }
    'run' {
      @'
Native: revia run <graph> <artifact> <input-digest>
Reference: npm run re -- run [--format json|text] <file.re> [-- <args>...]
          [--format json --runtime-receipt | --format json --authority-pin <pin.json>]
'@
      break
    }
    'manifest' { 'Native/reference: revia manifest <file.re> / npm run re -- manifest <file.re>'; break }
    'translate' {
      @'
Native: revia translate <file.re>
Reference: npm run re -- translate --format json <file.re>
'@
      break
    }
    'view' { 'Node reference only: npm run re -- view [--locale zh-CN|en-US] [--format html|svg] <file.re>'; break }
    'audit' { 'Node reference only: npm run re -- audit --format json <file.re>'; break }
    'profile' { 'Node reference only: npm run re -- profile <file.re>'; break }
    'patch' { 'Node reference only: npm run re -- patch --patch <patch.json> <file.re>'; break }
    'review-index' { 'Node reference only: npm run re -- review-index [options] <file.re>'; break }
    'build' { 'Node reference only: npm run re -- build --out <dir> <file.re>'; break }
    'project-check' {
      @'
Native: revia project-check <project-dir>
Reference: npm run re -- project-check --format json <project-dir>
'@
      break
    }
    'project-run' {
      @'
Native: revia project-run <project> <cache> <build> <profile> <toolchain> <module> <input-digest>
Reference: npm run re -- project-run --fixture <fixture.json> <project-dir>
'@
      break
    }
    'project-translate' {
      @'
Native: revia project-translate <project> <cache> <build> <profile-digest> <toolchain-digest> <module>
Reference: npm run re -- project-translate [--locale zh-CN|en-US] [--format json|text|html|svg] <project-dir>
'@
      break
    }
    'project-projection' { 'Node reference only: npm run re -- project-projection --routes <routes.json> --out <dir> <project-dir>'; break }
    'module-surface' { 'Node reference only: npm run re -- module-surface --manifest <manifest.json> <file.re>'; break }
    default {
      [Console]::Error.WriteLine("Unknown Revia command: $Command")
      exit 64
    }
  }
}

function Test-SourceFile([string]$Path) {
  return $null -ne $Path -and $Path.EndsWith('.re', [StringComparison]::OrdinalIgnoreCase)
}

function Test-ReferenceOnlyCommand([string]$Command) {
  return @('view', 'audit', 'profile', 'patch', 'review-index', 'build', 'project-projection', 'module-surface') -ccontains $Command
}

function Test-LauncherHelpCommand([string]$Command) {
  return @('check', 'run', 'manifest', 'translate', 'view', 'audit', 'profile', 'patch', 'review-index', 'build', 'project-check', 'project-run', 'project-translate', 'project-projection', 'module-surface') -ccontains $Command
}

function Test-ExactChoice([string]$Value, [string[]]$Choices) {
  return $Choices -ccontains $Value
}

function Test-ReferenceRunForm([string[]]$Arguments) {
  if ($Arguments.Count -eq 3) {
    return $false
  }

  $index = 0
  while ($index -lt $Arguments.Count -and $Arguments[$index].StartsWith('--', [StringComparison]::Ordinal)) {
    $option = $Arguments[$index]
    if ($option -ceq '--format') {
      if ($index + 1 -ge $Arguments.Count) { return $false }
      if (-not (Test-ExactChoice $Arguments[$index + 1] @('json', 'text'))) { return $false }
      $index += 2
    } elseif ($option -ceq '--runtime-receipt') {
      $index++
    } elseif ($option -ceq '--authority-pin') {
      if ($index + 1 -ge $Arguments.Count) { return $false }
      $index += 2
    } else {
      break
    }
  }

  if ($index -ge $Arguments.Count -or -not (Test-SourceFile $Arguments[$index])) { return $false }
  $index++
  if ($index -eq $Arguments.Count) { return $true }
  return $Arguments[$index] -ceq '--' -and ($Arguments.Count - $index) -ge 3
}

function Get-ReferenceCommand([string]$Command, [string[]]$Arguments) {
  if ($Version -cne '1.0.0-rc.2.2.1') { return $null }
  switch -CaseSensitive ($Command) {
    { Test-ReferenceOnlyCommand $_ } { return $Command }
    'run' {
      if (Test-ReferenceRunForm $Arguments) { return $Command }
    }
    'check' {
      if (($Arguments.Count -eq 2 -and $Arguments[0] -ceq '--write'
          -and (Test-SourceFile $Arguments[1])) -or
        ($Arguments.Count -eq 3 -and $Arguments[0] -ceq '--format'
          -and $Arguments[1] -ceq 'json' -and (Test-SourceFile $Arguments[2]))) {
        return $Command
      }
    }
    'translate' {
      if ($Arguments.Count -eq 3 -and $Arguments[0] -ceq '--format'
        -and $Arguments[1] -ceq 'json' -and (Test-SourceFile $Arguments[2])) {
        return $Command
      }
    }
    'project-check' {
      if ($Arguments.Count -eq 3 -and $Arguments[0] -ceq '--format' -and $Arguments[1] -ceq 'json') { return $Command }
    }
    'project-run' {
      if ($Arguments.Count -eq 3 -and $Arguments[0] -ceq '--fixture') { return $Command }
    }
    'project-translate' {
      if ($Arguments.Count -eq 1) { return $Command }
      if ($Arguments.Count -eq 3 -and $Arguments[0] -ceq '--locale'
        -and (Test-ExactChoice $Arguments[1] @('zh-CN', 'en-US'))) { return $Command }
      if ($Arguments.Count -eq 3 -and $Arguments[0] -ceq '--format'
        -and (Test-ExactChoice $Arguments[1] @('json', 'text', 'html', 'svg'))) { return $Command }
      if ($Arguments.Count -eq 5
        -and $Arguments[0] -ceq '--locale'
        -and (Test-ExactChoice $Arguments[1] @('zh-CN', 'en-US'))
        -and $Arguments[2] -ceq '--format'
        -and (Test-ExactChoice $Arguments[3] @('json', 'text', 'html', 'svg'))) { return $Command }
      if ($Arguments.Count -eq 5
        -and $Arguments[0] -ceq '--format'
        -and (Test-ExactChoice $Arguments[1] @('json', 'text', 'html', 'svg'))
        -and $Arguments[2] -ceq '--locale'
        -and (Test-ExactChoice $Arguments[3] @('zh-CN', 'en-US'))) { return $Command }
    }
  }
  return $null
}

function Stop-ForReferenceCommand([string]$Command) {
  [Console]::Error.WriteLine("Revia native release CLI $Version does not accept this source-form invocation.")
  switch -CaseSensitive ($Command) {
    'run' { [Console]::Error.WriteLine('Use the Node reference CLI: npm run re -- run <file.re> [-- <program-args>...]') }
    default { Show-CommandUsage $Command | ForEach-Object { [Console]::Error.WriteLine($_) } }
  }
  exit 64
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
  $script:ReviaVersion = $Version

  if ($args.Count -eq 1 -and ($args[0] -ceq '--version' -or $args[0] -ceq 'version')) {
    Write-Output "revia $Version"
    exit 0
  }
  if ($args.Count -eq 1 -and ($args[0] -ceq '--help' -or $args[0] -ceq 'help')) {
    Show-Usage
    exit 0
  }
  if ($args.Count -gt 2 -and $args[0] -ceq 'help') {
    [Console]::Error.WriteLine('Usage: revia help <command>')
    exit 64
  }
  if ($args.Count -eq 2 -and $args[0] -ceq 'help') {
    if (Test-LauncherHelpCommand $args[1]) {
      Show-CommandUsage $args[1]
      exit 0
    }
  }
  if ($args.Count -eq 2 -and $args[1] -ceq '--help') {
    if (Test-LauncherHelpCommand $args[0]) {
      Show-CommandUsage $args[0]
      exit 0
    }
  }

  if ($args.Count -gt 0) {
    $referenceCommand = Get-ReferenceCommand $args[0] @($args | Select-Object -Skip 1)
    if ($referenceCommand) {
      Stop-ForReferenceCommand $referenceCommand
    }
  }

  if ($Version -eq '1.0.0-rc.1') {
    $RawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
      $env:PROCESSOR_ARCHITEW6432
    } else {
      $env:PROCESSOR_ARCHITECTURE
    }
    $PendingTarget = switch ($RawArchitecture.ToUpperInvariant()) {
      'ARM64' { 'windows-arm64'; break }
      'AMD64' { 'windows-x64'; break }
      default { "windows-$($RawArchitecture.ToLowerInvariant())"; break }
    }
    [Console]::Error.WriteLine("Revia $Version has a pending target: $PendingTarget. Only darwin-arm64 is measured for this RC.")
    [Console]::Error.WriteLine("See $Root/docs/compatibility.md for the current support matrix.")
    exit 69
  }

  $Repository = if ($env:REVIA_REPOSITORY) { $env:REVIA_REPOSITORY } else { 'regrevia/Revia' }
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
