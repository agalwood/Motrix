#Requires -Version 5.1
param(
  [Parameter(Mandatory)][ValidateSet('identity', 'confirm', 'cancel')][string]$Mode,
  [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$TargetPid,
  [Parameter(Mandatory)][ValidateSet('chrome', 'edge')][string]$Browser,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExecutableHash,
  [ValidatePattern('^\d{15,20}$')][string]$StartTicks
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-OwnedBrowser {
  $process = Get-Process -Id $TargetPid -ErrorAction Stop
  $expected = if ($Browser -ceq 'chrome') { 'chrome' } else { 'msedge' }
  if ($process.ProcessName -cne $expected -or
      $process.SessionId -ne (Get-Process -Id $PID).SessionId -or
      ($StartTicks -and $process.StartTime.ToUniversalTime().Ticks.ToString() -cne $StartTicks)) {
    throw 'Browser ownership mismatch.'
  }
  return $process
}

try {
  if ($PSVersionTable.PSEdition -cne 'Desktop') { exit 1 }
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $process = Assert-OwnedBrowser
  if ((Get-FileHash -LiteralPath $process.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExecutableHash) { exit 1 }
  if ($Mode -ceq 'identity') {
    @{ startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress
    exit 0
  }
  if (-not $StartTicks) { exit 1 }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $ownedCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetPid)
  $buttonCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  $report = [ordered]@{ confirmed = $false; cancelled = $false; processIdentityVerified = $true; ownedWindows = 0; openButtons = 0; eligibleDialogs = 0 }
  while ([DateTime]::UtcNow -lt $deadline) {
    $null = Assert-OwnedBrowser
    # Enumerate desktop children only, then inspect this owned browser's UI.
    # No desktop dump, screenshots, raw accessible names or profile data leave
    # this process. Never remember consent or change protocol permissions.
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $ownedCondition)
    $report.ownedWindows = $windows.Count
    $report.openButtons = 0
    $report.eligibleDialogs = 0
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($window in $windows) {
      $buttons = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition)
      foreach ($button in $buttons) {
        if ($button.Current.ProcessId -ne $TargetPid -or $button.Current.IsOffscreen -or -not $button.Current.IsEnabled -or
            $button.Current.Name -cnotin @('Open', 'Open Motrix Store TEST ONLY')) { continue }
        $report.openButtons++
        $parent = $button
        for ($level = 0; $level -lt 4; $level++) {
          $parent = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($parent)
          if ($null -eq $parent -or $parent.Current.ProcessId -ne $TargetPid) { break }
          # Only the test package's exact application name is eligible. A
          # generic Open button, web page or unknown handler must fail closed.
          if ($parent.Current.ControlType -ne [Windows.Automation.ControlType]::Window -and
              $parent.Current.LocalizedControlType -cne 'dialog') { continue }
          if ($parent.Current.Name -cnotin @('Open Motrix Store TEST ONLY?', 'This site is trying to open Motrix Store TEST ONLY.')) { continue }
          $report.eligibleDialogs++
          $cancel = $parent.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.AndCondition]::new($buttonCondition, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Cancel')))
          if ($cancel.Count -eq 1 -and $cancel[0].Current.ProcessId -eq $TargetPid -and
              -not $cancel[0].Current.IsOffscreen -and $cancel[0].Current.IsEnabled) {
            if ($Mode -ceq 'cancel') { $matches.Add($cancel[0]) } else { $matches.Add($button) }
          }
          break
        }
      }
    }
    if ($matches.Count -gt 1) { exit 1 }
    if ($matches.Count -eq 1) {
      $null = Assert-OwnedBrowser
      $pattern = $null
      if (-not $matches[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { exit 1 }
      $pattern.Invoke()
      $report.confirmed = $Mode -ceq 'confirm'
      $report.cancelled = $Mode -ceq 'cancel'
      $report | ConvertTo-Json -Compress
      exit 0
    }
    Start-Sleep -Milliseconds 200
  }
  $report | ConvertTo-Json -Compress
  exit 0
} catch { exit 1 }
