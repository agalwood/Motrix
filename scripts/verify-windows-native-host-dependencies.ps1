param(
  [Parameter(Mandatory = $true)]
  [string]$Binary
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
  throw "Native host is not a file: $Binary"
}
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path

$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
if ($null -eq $dumpbin) {
  if ([string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
    throw 'ProgramFiles(x86) is unavailable; cannot locate Visual Studio'
  }
  $vswhere = Join-Path `
    ${env:ProgramFiles(x86)} `
    'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw 'dumpbin.exe is unavailable and vswhere.exe was not found'
  }

  $installationPath = & $vswhere `
    -latest `
    -products '*' `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($installationPath)) {
    throw 'Could not locate a Visual Studio installation with MSVC tools'
  }

  $dumpbin = Get-ChildItem `
    -Path (Join-Path $installationPath 'VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe') `
    -File |
    Sort-Object -Property FullName -Descending |
    Select-Object -First 1
  if ($null -eq $dumpbin) {
    throw "dumpbin.exe was not found below $installationPath"
  }
}

$dumpbinPath = if ($dumpbin.PSObject.Properties.Name -contains 'Source') {
  $dumpbin.Source
} else {
  $dumpbin.FullName
}
$output = & $dumpbinPath /DEPENDENTS $binaryPath 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "dumpbin.exe failed for ${binaryPath}:`n$($output -join "`n")"
}

$dependencies = @(
  $output |
    ForEach-Object {
      if ($_ -match '^\s+([A-Za-z0-9._-]+\.dll)\s*$') {
        $Matches[1]
      }
    } |
    Sort-Object -Unique
)
if ($dependencies.Count -eq 0) {
  throw "dumpbin.exe reported no PE imports for $binaryPath"
}

$forbiddenPatterns = @(
  '^VCRUNTIME.*\.dll$',
  '^MSVCP.*\.dll$',
  '^CONCRT.*\.dll$',
  '^UCRTBASE\.dll$',
  '^api-ms-win-crt-.*\.dll$'
)
$forbidden = @(
  $dependencies |
    Where-Object {
      $dependency = $_
      $forbiddenPatterns |
        Where-Object { $dependency -match $_ } |
        Select-Object -First 1
    }
)
if ($forbidden.Count -gt 0) {
  throw (
    'Native host depends on a dynamic MSVC/UCRT runtime: ' +
    ($forbidden -join ', ')
  )
}

Write-Host "Verified static Windows CRT for $binaryPath"
Write-Host "Remaining OS imports: $($dependencies -join ', ')"
