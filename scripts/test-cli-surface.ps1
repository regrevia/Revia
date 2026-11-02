param(
  [Parameter(Mandatory = $true)]
  [string]$NativeExecutable
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$corpus = Get-Content -LiteralPath (Join-Path $root 'test/fixtures/cli-command-surface.json') -Raw |
  ConvertFrom-Json
$version = (Get-Content -LiteralPath (Join-Path $root 'VERSION') -TotalCount 1).Trim()
if ($version -ne $corpus.historical_native_version) {
  throw "CLI surface guard version mismatch: VERSION=$version expected=$($corpus.historical_native_version)"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ("revia-cli-surface-" + [Guid]::NewGuid().ToString('N'))
$project = Join-Path $temp 'project'
$bin = Join-Path $project 'bin'
$runtime = Join-Path $project 'runtime'
$cache = Join-Path $temp 'cache'
$tools = Join-Path $temp 'tools'
$marker = Join-Path $temp 'curl-called'
$stderrFile = Join-Path $temp 'stderr.txt'
$originalLocalAppData = $env:LOCALAPPDATA
New-Item -ItemType Directory -Force -Path $bin, $runtime, $tools | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $root 'bin/revia.ps1') -Destination (Join-Path $bin 'revia.ps1')
  Set-Content -LiteralPath (Join-Path $project 'VERSION') -Value "$version`n" -NoNewline
  $env:LOCALAPPDATA = $cache
  Set-Content -LiteralPath (Join-Path $project 'runtime/checksums.txt') -Value (
    ('a' * 64) + "  revia-$version-windows-x64.zip`n" + ('b' * 64) + "  revia-$version-windows-x64`n"
  ) -NoNewline
  $nativeBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $NativeExecutable).Path)
  $nativeDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($nativeBytes)).ToLowerInvariant()
  (Get-Content -LiteralPath (Join-Path $project 'runtime/checksums.txt') -Raw).Replace(('b' * 64), $nativeDigest) |
    Set-Content -LiteralPath (Join-Path $project 'runtime/checksums.txt') -NoNewline

  $native = Join-Path $cache "Revia/$version/windows-x64/revia.exe"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $native) | Out-Null
  Copy-Item -LiteralPath (Resolve-Path -LiteralPath $NativeExecutable).Path -Destination $native

  $helpCases = @(
    '--help',
    'help',
    'help|run',
    'help|view',
    'help|build',
    'help|project-translate',
    'view|--help',
    'help|lex',
    'lex|--help'
  )
  foreach ($helpCase in $helpCases) {
    $helpArgs = $helpCase.Split('|')
    if ($helpCase -eq '--help') { $helpArgs = @('--help') }
    $output = & (Join-Path $bin 'revia.ps1') @helpArgs 2> $stderrFile | Out-String
    $stderr = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { throw "help failed: $($helpArgs -join ' ')" }
    if ($stderr) { throw "help wrote an unexpected diagnostic: $stderr" }
    if ($helpArgs.Count -eq 2 -and $helpArgs[0] -eq 'help' -and $helpArgs[1] -eq 'run') {
      if ($output -notmatch 'Native:' -or $output -notmatch 'Reference:') {
        throw 'help run must show native and reference signatures'
      }
    } elseif ($helpArgs.Count -eq 2 -and $helpArgs[0] -eq 'help' -and $helpArgs[1] -eq 'project-translate') {
      if ($output -notmatch 'Native: revia project-translate' -or
        $output -notmatch 'Reference: npm run re -- project-translate') {
        throw 'project-translate help must show native and reference signatures'
      }
    } elseif (($helpArgs.Count -eq 2 -and $helpArgs[0] -eq 'help' -and $helpArgs[1] -eq 'view') -or
        ($helpArgs.Count -eq 2 -and $helpArgs[0] -eq 'view' -and $helpArgs[1] -eq '--help')) {
      if ($output -notmatch 'Node reference only') { throw 'view help must identify the Node reference CLI' }
    } elseif ($helpArgs.Count -eq 2 -and $helpArgs[0] -eq 'help' -and $helpArgs[1] -eq 'build') {
      if ($output -notmatch 'Node reference only') { throw 'build help must identify the Node reference CLI' }
    } elseif (($helpArgs.Count -eq 2 -and $helpArgs[0] -eq 'help' -and $helpArgs[1] -eq 'lex') -or
        ($helpArgs.Count -eq 2 -and $helpArgs[0] -eq 'lex' -and $helpArgs[1] -eq '--help')) {
      if ($output -notmatch 'revia lex <file>') { throw 'native command help must reach the native executable' }
    } elseif ($output -notmatch 'native release CLI' -or $output -notmatch 'npm run re --') {
      throw "launcher help does not distinguish CLI surfaces: $($helpArgs -join ' ')"
    }
  }
  foreach ($invalidHelpCase in @('help|check|extra', 'help|a|b')) {
    $invalidHelp = $invalidHelpCase.Split('|')
    $output = & (Join-Path $bin 'revia.ps1') @invalidHelp 2> $stderrFile | Out-String
    $stderr = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 64 -or $output -or $stderr -notmatch 'Usage: revia help <command>') {
      throw "invalid help arity was not rejected locally: $($invalidHelp -join ' ')"
    }
  }
  if (Test-Path -LiteralPath $marker) { throw 'help attempted a release download' }

  $source = Join-Path $project 'examples/hello.re'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $source) | Out-Null
  Set-Content -LiteralPath $source -Value 'source fixture' -NoNewline
  $cases = @()
  foreach ($case in $corpus.source_form) {
    $cases += ,[pscustomobject]@{ Name = $case.id; Args = [string[]]$case.args }
  }
  $cases += [pscustomobject]@{ Name = 'run-absolute'; Args = [string[]]@('run', $source) }
  $cases += [pscustomobject]@{ Name = 'run-authority-option'; Args = [string[]]@('run', '--authority-pin', 'pin.json', 'examples/hello.re') }
  $cases += [pscustomobject]@{ Name = 'run-relative-program-arguments'; Args = [string[]]@('run', 'examples/hello.re', '--', 'one', 'two') }
  $cases += [pscustomobject]@{ Name = 'run-mixed-case-extension'; Args = [string[]]@('run', 'examples/hello.Re') }

  function Invoke-WebRequest {
    Set-Content -LiteralPath $marker -Value attempted
    throw 'download sentinel intercepted an unexpected request'
  }
  foreach ($case in $cases) {
    $name = $case.Name
    $arguments = [string[]]$case.Args
    $env:LOCALAPPDATA = $cache
    $output = & (Join-Path $bin 'revia.ps1') @arguments 2> $stderrFile | Out-String
    $stderr = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 64) { throw "$name expected exit 64, got $LASTEXITCODE`: $output" }
    if ($output) { throw "$name wrote unexpected stdout: $output" }
    if ($stderr -notmatch 'npm run re --') { throw "$name missing reference command: $stderr" }
    if ($stderr -match 'Downloading Revia') { throw "$name attempted a download" }
  }
  if (Test-Path -LiteralPath $marker) { throw 'source-form rejection attempted a release download' }

  $nativeThree = & (Join-Path $bin 'revia.ps1') run 'missing.graph.re' 'missing.artifact' ('sha256:' + ('a' * 64)) 2>&1 | Out-String
  if ($nativeThree -match 'npm run re --') { throw 'native run diagnostic was replaced by Node guidance' }
  $nativeTwo = & (Join-Path $bin 'revia.ps1') run 'graph.re' 'artifact' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 64 -or $nativeTwo -match 'npm run re --') {
    throw "incomplete native run did not retain native usage: exit=$LASTEXITCODE output=$nativeTwo"
  }
  $emptySeparator = & (Join-Path $bin 'revia.ps1') run 'examples/hello.re' '--' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 64 -or $emptySeparator -match 'npm run re --') {
    throw "empty argument separator was misclassified as reference source form: exit=$LASTEXITCODE output=$emptySeparator"
  }
  $oneArgumentRun = & (Join-Path $bin 'revia.ps1') run 'examples/hello.re' '--' 'one' 2>&1 | Out-String
  if ($oneArgumentRun -match 'npm run re --') {
    throw 'three-operand run collision must preserve native precedence'
  }
  $nativeProjectTranslate = @('project', 'cache', 'build', 'profile', 'toolchain', 'module')
  $nativeProjectOutput = & (Join-Path $bin 'revia.ps1') project-translate @nativeProjectTranslate 2>&1 | Out-String
  if ($nativeProjectOutput -match 'npm run re --') {
    throw "native project-translate signature was intercepted: exit=$LASTEXITCODE output=$nativeProjectOutput"
  }
  foreach ($nativeCase in @(
    'project-check|--format|json|project|extra',
    'project-run|--fixture|fixture.json|project|extra',
    'RUN|examples/hello.re',
    'VIEW|examples/hello.re',
    'project-translate|--locale|en-us|project',
    'run|--FORMAT|json|examples/hello.re'
  )) {
    $nativeArgs = $nativeCase.Split('|')
    $nativeOutput = & (Join-Path $bin 'revia.ps1') @nativeArgs 2>&1 | Out-String
    if ($nativeOutput -match 'npm run re --') {
      throw "non-exact source form was intercepted: $($nativeArgs -join ' ')"
    }
  }
  Write-Output 'PowerShell CLI surface contract passed.'
} finally {
  if ($null -eq $originalLocalAppData) {
    Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue
  } else {
    $env:LOCALAPPDATA = $originalLocalAppData
  }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
