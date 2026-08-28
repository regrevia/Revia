param(
  [ValidateSet('Report', 'Require')]
  [string]$Mode = 'Report'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Executable = if ($env:REVIA_EXECUTABLE) {
  [IO.Path]::GetFullPath($env:REVIA_EXECUTABLE)
} else {
  Join-Path $Root 'bin/revia.ps1'
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "compact determinism probe cannot execute: $Executable"
}
$Base = Join-Path ([IO.Path]::GetTempPath()) ("revia-compact-determinism-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Base | Out-Null

try {
  function Run-Case([string]$CaseName, [string]$CommandName) {
    $work = Join-Path $Base "$CaseName/$CommandName"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Copy-Item -LiteralPath (Join-Path $Root 'examples/agent-review/main.re') -Destination (Join-Path $work 'main.re')

    Push-Location $work
    try {
      switch ($CommandName) {
        'check' {
          & $Executable check main.re *> stdout
          break
        }
        'check-write' {
          & $Executable check --write main.re *> stdout
          break
        }
        'manifest' {
          & $Executable manifest main.re *> manifest.json
          break
        }
        'view' {
          & $Executable view --locale en-US --format html main.re *> view.html
          break
        }
        'build' {
          & $Executable build --out build main.re *> stdout
          break
        }
      }
      if ($LASTEXITCODE -ne 0) { throw "revia $CommandName failed: $LASTEXITCODE" }
      Set-Content -LiteralPath status -NoNewline -Value '0'

      $hashes = Get-ChildItem -File -Recurse |
        Sort-Object { $_.FullName.Substring($work.Length).Replace('\', '/') } |
        ForEach-Object {
          $path = $_.FullName.Substring($work.Length).Replace('\', '/')
          "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  .$path"
        }
      Set-Content -LiteralPath checksums.sha256 -Value $hashes
    } finally {
      Pop-Location
    }
  }

  $different = $false
  foreach ($commandName in @('check', 'check-write', 'manifest', 'view', 'build')) {
    Run-Case 'first' $commandName
    Run-Case 'second' $commandName
    $first = Get-Content -LiteralPath (Join-Path $Base "first/$commandName/checksums.sha256") -Raw
    $second = Get-Content -LiteralPath (Join-Path $Base "second/$commandName/checksums.sha256") -Raw

    if ($first -ceq $second) {
      Write-Output "deterministic $commandName"
    } else {
      [Console]::Error.WriteLine("nondeterministic $commandName")
      $different = $true
    }
  }

  if ($different) {
    [Console]::Error.WriteLine('compact determinism: PENDING')
    if ($Mode -eq 'Require') { exit 1 }
    exit 0
  }

  Write-Output 'compact determinism: VERIFIED'
} finally {
  Remove-Item -LiteralPath $Base -Recurse -Force -ErrorAction SilentlyContinue
}
