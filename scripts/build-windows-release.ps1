# build-windows-release.ps1
#
# Build and package the Motrix Windows desktop release on this machine.
# Mirrors the Windows matrix job in .github/workflows/release.yml.
#
# Default: produces only the standalone (portable) directory at
#   release/win-unpacked/
# Pass -Full to additionally build the NSIS installer and portable zip.
#
# Examples:
#   .\scripts\build-windows-release.ps1
#   .\scripts\build-windows-release.ps1 -Full
#   .\scripts\build-windows-release.ps1 -SkipBuiltin -SkipVerify
#   .\scripts\build-windows-release.ps1 -DryRun      # preview commands only

[CmdletBinding()]
param(
  # Windows arch; only x64 is configured in electron-builder.json.
  [string]$Arch = 'x64',

  # Also build the NSIS installer and portable zip (default: standalone dir only).
  [switch]$Full,

  # Skip the signed-builtin fetch step (requires network).
  [switch]$SkipBuiltin,

  # Skip the Rust native-host build (requires cargo + MSVC toolchain).
  [switch]$SkipNativeHost,

  # Skip the post-pack verification step.
  [switch]$SkipVerify,

  # Launch the packaged app as a smoke test after verifying (needs a display).
  [switch]$Smoke,

  # Delete the previous packaging outputs (release/, dist/electron-app) first.
  [switch]$Clean,

  # Print the exact commands that would run without executing them.
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Scripts live in <repo>/scripts; the repo root is the parent.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json'))) {
  throw "Not the Motrix repository root: $repoRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'pnpm-workspace.yaml'))) {
  throw 'pnpm-workspace.yaml not found; run this from the Motrix repo.'
}

function Write-Step([string]$message) {
  Write-Host ''
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Assert-Command([string]$name, [string]$hint) {
  if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "'$name' was not found on PATH. $hint"
  }
}

# Run a step expressed as a scriptblock. A literal scriptblock keeps the
# pnpm arguments as separate tokens (no array-splatting), so `pnpm run X`
# is passed exactly as typed. Native exit codes are checked via
# $LASTEXITCODE; $ErrorActionPreference alone does not catch them.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  Write-Step $Name
  if ($DryRun) {
    $preview = $Action.ToString().Replace('$Arch', $Arch)
    Write-Host "    [dry-run] $preview" -ForegroundColor DarkGray
    return
  }
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed with exit code $LASTEXITCODE :`n  $($Action.ToString())"
  }
}

# ── Preflight ─────────────────────────────────────────────
Write-Step 'preflight'
Assert-Command 'node' 'Install Node.js 22+ (https://nodejs.org).'
Assert-Command 'pnpm' 'Install pnpm (corepack enable pnpm, or npm i -g pnpm).'
if (-not $SkipNativeHost) {
  Assert-Command 'cargo' 'Install Rust via rustup: winget install Rustlang.Rustup -e'
}
if ($Arch -ne 'x64') {
  Write-Host "WARNING: only x64 is configured for Windows in electron-builder.json" -ForegroundColor Yellow
}

# ── Optional clean ────────────────────────────────────────
if ($Clean) {
  Write-Step 'clean previous outputs'
  foreach ($path in @('release', 'dist/electron-app')) {
    if (Test-Path -LiteralPath $path) {
      Write-Host "    removing $path"
      if (-not $DryRun) {
        Remove-Item -LiteralPath $path -Recurse -Force
      }
    }
  }
}

# Windows artifacts are unsigned in this repo's flow (README documents the
# SmartScreen warning). Disable automatic code-signing discovery so packaging
# never pauses on a missing certificate.
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

# ── Build + package steps ─────────────────────────────────
$steps = @()
if (-not $SkipBuiltin) {
  $steps += [pscustomobject]@{
    Name   = 'build:builtin (fetch signed builtin plugins)'
    Action = { pnpm run build:builtin }
  }
}
if (-not $SkipNativeHost) {
  $steps += [pscustomobject]@{
    Name   = 'build:native-host (Rust native messaging host)'
    Action = { pnpm run build:native-host -- --platform win32 --arch $Arch }
  }
}
$steps += [pscustomobject]@{
  Name   = 'build:electron (main/preload/worker/renderer)'
  Action = { pnpm run build:electron }
}
$steps += [pscustomobject]@{
  Name   = 'stage:electron (assemble dist/electron-app)'
  Action = { pnpm run stage:electron -- --platform win32 --arch $Arch }
}
if ($Full) {
  $steps += [pscustomobject]@{
    Name   = 'electron-builder (win-unpacked + NSIS + zip)'
    # electron-builder CLI takes arch as a boolean flag (--x64), not --arch.
    Action = { pnpm exec electron-builder --win --$Arch --publish never }
  }
} else {
  $steps += [pscustomobject]@{
    Name   = 'electron-builder (standalone dir only)'
    Action = { pnpm exec electron-builder --win --$Arch --dir --publish never }
  }
}
if (-not $SkipVerify) {
  $steps += [pscustomobject]@{
    Name   = 'verify:electron-package'
    Action = { pnpm run verify:electron-package -- --app-dir release/win-unpacked --platform win32 --arch $Arch }
  }
}
if ($Smoke) {
  $steps += [pscustomobject]@{
    Name   = 'smoke:electron-package'
    Action = { pnpm run smoke:electron-package }
  }
}

foreach ($step in $steps) {
  Invoke-Native -Name $step.Name -Action $step.Action
}

# ── Summary ───────────────────────────────────────────────
$version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
Write-Step 'summary'
$standalone = Join-Path $repoRoot 'release/win-unpacked'
if ($DryRun) {
  Write-Host "dry-run complete; no artifacts produced. Version: $version"
  return
}
if (Test-Path -LiteralPath $standalone) {
  Write-Host "Standalone directory: $standalone" -ForegroundColor Green
  Write-Host "  run: $(Join-Path $standalone 'Motrix.exe')"
} else {
  Write-Host "Standalone directory not found: $standalone" -ForegroundColor Yellow
}
if ($Full) {
  Get-ChildItem -LiteralPath (Join-Path $repoRoot 'release') -File |
    Where-Object { $_.Extension -in @('.exe', '.zip') } |
    ForEach-Object { Write-Host "Artifact: $($_.FullName)" -ForegroundColor Green }
}
