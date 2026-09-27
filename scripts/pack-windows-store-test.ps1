#Requires -Version 7.0
<#
.SYNOPSIS
Runs an unsigned Windows SDK packaging smoke test on a prepared test layout.
.DESCRIPTION
Requires Windows, PowerShell 7, Node.js, and an explicitly selected Windows SDK
bin directory. Creates a fresh sibling <prepared-name>.sdk-output directory.
Never signs, installs, launches, publishes, or accesses signing credentials.
An interrupted or failed run has no sdk-result.json completion record. Prepare
a new layout for a retry; existing output and resources.pri are never replaced.
.EXAMPLE
pwsh -File scripts/pack-windows-store-test.ps1 -PreparedDirectory C:\work\prepared-test -SdkBinDirectory 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PreparedDirectory,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SdkBinDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-NewPath([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    throw "Output already exists; use a fresh preparation: $Path"
  }
}

function Get-RegularFile([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item -isnot [IO.FileInfo] -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $item.Length -eq 0) {
    throw "Expected a nonempty regular file: $Path"
  }
  return $item
}

function Get-InputDirectory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item -isnot [IO.DirectoryInfo] -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Expected a directory without a reparse point: $Path"
  }
  return $item
}

function Write-NewText([string]$Path, [string]$Text) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) }
  finally { $stream.Dispose() }
}

function Write-NewJson([string]$Path, [object]$Value) {
  Write-NewText $Path (($Value | ConvertTo-Json -Depth 64) + "`n")
}

function Get-WindowsStoreErrorDetails([Management.Automation.ErrorRecord]$Record) {
  return [ordered]@{
    message = $Record.Exception.Message
    exceptionType = $Record.Exception.GetType().FullName
    position = if ($null -ne $Record.InvocationInfo) { $Record.InvocationInfo.PositionMessage } else { $null }
    scriptStackTrace = $Record.ScriptStackTrace
  }
}

function Read-SafeXmlDocument([string]$Path) {
  $file = Get-RegularFile $Path
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $settings.MaxCharactersInDocument = 16777216
  $reader = [Xml.XmlReader]::Create($file.FullName, $settings)
  try {
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.Load($reader)
    return ,$document
  } finally { $reader.Dispose() }
}

function Get-FileEvidence([string]$Path) {
  $file = Get-RegularFile $Path
  return [ordered]@{
    path = $file.FullName
    bytes = $file.Length
    sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Get-SdkToolEvidence([string]$Path) {
  $evidence = Get-FileEvidence $Path
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
  $evidence.fileVersion = $version.FileVersion
  $evidence.productVersion = $version.ProductVersion
  return $evidence
}

function Invoke-CheckedProgram {
  param(
    [string]$Program,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [string]$LogName
  )
  $stdoutPath = Join-Path $WorkingDirectory "$LogName.stdout.log"
  $stderrPath = Join-Path $WorkingDirectory "$LogName.stderr.log"
  Assert-NewPath $stdoutPath
  Assert-NewPath $stderrPath
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Program
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.RedirectStandardInput = $true
  # ArgumentList preserves each argument, including paths containing spaces.
  # No shell, joined command string, or PowerShell native-argument reparsing.
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  $startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  try {
    if (-not $process.Start()) { throw "Could not start: $Program" }
    $process.StandardInput.Close()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
  } finally { $process.Dispose() }
  Write-NewText $stdoutPath $stdout
  Write-NewText $stderrPath $stderr
  if ($exitCode -ne 0) {
    foreach ($captured in @(
      @{ name = 'stdout'; text = $stdout },
      @{ name = 'stderr'; text = $stderr }
    )) {
      if (-not [string]::IsNullOrWhiteSpace($captured.text)) {
        $tailStart = [Math]::Max(0, $captured.text.Length - 4000)
        Write-Host "$LogName $($captured.name) (last 4000 characters at most):"
        Write-Host $captured.text.Substring($tailStart)
      }
    }
    throw "$LogName failed with exit code $exitCode. See $stdoutPath and $stderrPath"
  }
  return [ordered]@{
    program = $Program
    arguments = $Arguments
    exitCode = $exitCode
    startedAtUtc = $startedAt
    completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    stdoutLog = $stdoutPath
    stderrLog = $stderrPath
  }
}

function Invoke-LayoutVerification {
  param(
    [string]$Node,
    [string]$Verifier,
    [string]$Prepared,
    [ValidateSet('prepared', 'indexed', 'unpacked')][string]$Phase,
    [string]$OutputDirectory,
    [string]$UnpackedDirectory
  )
  $arguments = @($Verifier, '--prepared', $Prepared, '--phase', $Phase)
  if ($Phase -eq 'unpacked') { $arguments += @('--layout', $UnpackedDirectory) }
  $command = Invoke-CheckedProgram $Node $arguments $OutputDirectory "verify-$Phase"
  # Only Node's stdout is JSON; SDK stdout and all stderr stay in separate logs.
  $report = [IO.File]::ReadAllText($command.stdoutLog) | ConvertFrom-Json -AsHashtable -Depth 100
  if ($report -isnot [Collections.IDictionary] -or
      $report.ok -isnot [bool] -or -not $report.ok -or $report.phase -cne $Phase) {
    throw "Layout verifier did not return a successful $Phase report"
  }
  $reportPath = Join-Path $OutputDirectory "verify-$Phase.json"
  Write-NewJson $reportPath $report
  return [ordered]@{ phase = $Phase; ok = $true; report = $reportPath; command = $command }
}

function Get-WindowsStoreTestDiagnostics([Collections.IDictionary]$Metadata) {
  if (-not $Metadata.Contains('testDiagnostics')) { return $null }
  if ($Metadata.testDiagnostics -isnot [string] -or
      $Metadata.testDiagnostics -cne 'native-messaging-probe-v1') {
    throw 'Unsupported testDiagnostics mode'
  }
  return $Metadata.testDiagnostics
}

function Test-MotrixPriDump([string]$ManifestPath, [string]$DumpPath, [object]$TestDiagnostics = $null) {
  if ($null -ne $TestDiagnostics -and
      ($TestDiagnostics -isnot [string] -or $TestDiagnostics -cne 'native-messaging-probe-v1')) {
    throw 'Unsupported testDiagnostics mode'
  }
  $diagnosticMode = $null -ne $TestDiagnostics
  $manifest = Read-SafeXmlDocument $ManifestPath
  $namespaces = [Xml.XmlNamespaceManager]::new($manifest.get_NameTable())
  $namespaces.AddNamespace('f', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
  $namespaces.AddNamespace('uap', 'http://schemas.microsoft.com/appx/manifest/uap/windows10')
  $identity = @($manifest.SelectNodes('/f:Package/f:Identity', $namespaces))
  if ($identity.Count -ne 1 -or $identity[0].GetAttribute('Name') -cne 'Motrix.Store.Test') {
    throw 'PRI validation only accepts the fixed Motrix.Store.Test identity'
  }
  $applicationIds = @('Motrix')
  if ($diagnosticMode) { $applicationIds += 'MotrixNativeHostP0' }
  $applications = @($manifest.SelectNodes('/f:Package/f:Applications/f:Application', $namespaces))
  if ($applications.Count -ne $applicationIds.Count -or
      @($manifest.SelectNodes('//*[local-name()="Application"]')).Count -ne $applicationIds.Count) {
    throw 'Unexpected manifest Application set for the selected testDiagnostics mode'
  }
  foreach ($id in $applicationIds) {
    $matches = @($applications | Where-Object { $_.GetAttribute('Id') -ceq $id })
    $executable = if ($id -ceq 'Motrix') { 'app/Motrix.exe' } else { 'diagnostics/motrix-store-p0-probe.exe' }
    if ($matches.Count -ne 1 -or $matches[0].GetAttribute('Executable').Replace('\', '/') -cne $executable) {
      throw "Unexpected manifest Application identity or executable: $id"
    }
    $visuals = @($matches[0].SelectNodes('./uap:VisualElements', $namespaces))
    if ($visuals.Count -ne 1) { throw "Unexpected manifest visual elements: $id" }
    $tiles = @($visuals[0].SelectNodes('./uap:DefaultTile', $namespaces))
    $expectedTileCount = if ($id -ceq 'Motrix') { 1 } else { 0 }
    if ($tiles.Count -ne $expectedTileCount) { throw "Unexpected manifest default tile: $id" }
  }
  # Validate references by fixed Application Id, not by document order. The
  # diagnostic helper reuses two existing images and has no DefaultTile.
  $expected = @(
    @{ xpath = '/f:Package/f:Properties/f:Logo'; path = 'Assets/StoreLogo.png' },
    @{ xpath = '/f:Package/f:Applications/f:Application[@Id="Motrix"]/uap:VisualElements/@Square44x44Logo'; path = 'Assets/Square44x44Logo.png' },
    @{ xpath = '/f:Package/f:Applications/f:Application[@Id="Motrix"]/uap:VisualElements/@Square150x150Logo'; path = 'Assets/Square150x150Logo.png' },
    @{ xpath = '/f:Package/f:Applications/f:Application[@Id="Motrix"]/uap:VisualElements/uap:DefaultTile/@Wide310x150Logo'; path = 'Assets/Wide310x150Logo.png' }
  )
  if ($diagnosticMode) {
    $expected += @(
      @{ xpath = '/f:Package/f:Applications/f:Application[@Id="MotrixNativeHostP0"]/uap:VisualElements/@Square44x44Logo'; path = 'Assets/Square44x44Logo.png' },
      @{ xpath = '/f:Package/f:Applications/f:Application[@Id="MotrixNativeHostP0"]/uap:VisualElements/@Square150x150Logo'; path = 'Assets/Square150x150Logo.png' }
    )
  }
  # Reject additional logo/image references, including unused tile sizes and
  # SplashScreen images, even when they happen to reuse an indexed image.
  $imageReferences = @($manifest.SelectNodes('//*[contains(local-name(), "Logo") or local-name()="Image"] | //@*[contains(local-name(), "Logo") or local-name()="Image"]'))
  if ($imageReferences.Count -ne $expected.Count) {
    throw 'Unexpected manifest image reference count'
  }
  $expectedPaths = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($asset in $expected) {
    $nodes = @($manifest.SelectNodes($asset.xpath, $namespaces))
    # PowerShell's XML adapter returns null for XmlAttribute.InnerText. Invoke
    # the DOM getter directly for both XPath attribute and element results.
    if ($nodes.Count -ne 1 -or $nodes[0].get_InnerText().Replace('\', '/') -cne $asset.path) {
      throw "Unexpected manifest image reference: $($asset.path)"
    }
    $expectedPaths["Files/$($asset.path)"] = $asset.path.Replace('.png', '.scale-200.png')
  }
  if ($expectedPaths.Count -ne 4) { throw 'Expected exactly four unique manifest images' }

  # Microsoft documents the Detailed dump XSD and real Path candidate examples:
  # https://learn.microsoft.com/windows/uwp/app-resources/makepri-exe-format-specific-indexers#priinfo
  # Qualifiers belong to Candidate/QualifierSet, not a text substring in the dump
  # or the alternative Basic dump's qualifiers attribute.
  $dump = Read-SafeXmlDocument $DumpPath
  if ($dump.get_DocumentElement().get_LocalName() -cne 'PriInfo' -or
      @($dump.SelectNodes('//*[namespace-uri() != ""]')).Count -ne 0) {
    throw 'Expected a namespace-free MakePri Detailed PriInfo dump'
  }
  $maps = @($dump.SelectNodes('/PriInfo/ResourceMap'))
  if ($maps.Count -ne 1 -or @($dump.SelectNodes('//ResourceMap')).Count -ne 1 -or
      $maps[0].GetAttribute('name') -ine 'Motrix.Store.Test') {
    throw 'PRI must contain exactly one resource map for Motrix.Store.Test'
  }
  $resources = @($dump.SelectNodes('/PriInfo/ResourceMap//NamedResource'))
  if ($resources.Count -ne 4 -or @($dump.SelectNodes('//NamedResource')).Count -ne 4 -or
      @($dump.SelectNodes('//Candidate')).Count -ne 4) {
    throw 'PRI must contain exactly four image resources with one candidate each'
  }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $verified = [Collections.Generic.List[object]]::new()
  foreach ($resource in $resources) {
    $segments = [Collections.Generic.List[string]]::new()
    $segments.Add($resource.GetAttribute('name'))
    $parent = $resource.get_ParentNode()
    while ($parent -is [Xml.XmlElement] -and $parent.get_LocalName() -ceq 'ResourceMapSubtree') {
      $segments.Insert(0, $parent.GetAttribute('name'))
      $parent = $parent.get_ParentNode()
    }
    $logicalName = $segments -join '/'
    if (-not [object]::ReferenceEquals($parent, $maps[0]) -or
        -not $expectedPaths.ContainsKey($logicalName) -or -not $seen.Add($logicalName)) {
      throw "Unexpected or duplicate PRI logical image: $logicalName"
    }
    $expectedUri = "ms-resource://Motrix.Store.Test/$logicalName"
    if ($resource.GetAttribute('uri') -ine $expectedUri) {
      throw "PRI resource URI does not match its map and subtree: $logicalName"
    }
    $candidates = @($resource.SelectNodes('./Candidate'))
    if ($candidates.Count -ne 1 -or $candidates[0].GetAttribute('type') -cne 'Path') {
      throw "PRI image must have exactly one Path candidate: $logicalName"
    }
    $candidate = $candidates[0]
    $sets = @($candidate.SelectNodes('./QualifierSet'))
    $qualifiers = @($candidate.SelectNodes('./QualifierSet/Qualifier'))
    $values = @($candidate.SelectNodes('./Value'))
    if ($sets.Count -ne 1 -or $qualifiers.Count -ne 1 -or
        @($sets[0].SelectNodes('./*')).Count -ne 1 -or
        @($qualifiers[0].SelectNodes('./*')).Count -ne 0 -or
        $qualifiers[0].GetAttribute('name') -cne 'Scale' -or
        $qualifiers[0].GetAttribute('value') -cne '200' -or
        $values.Count -ne 1 -or @($values[0].SelectNodes('./*')).Count -ne 0 -or
        @($candidate.SelectNodes('./*')).Count -ne 2) {
      throw "PRI image must have only the Scale=200 qualifier and one literal Value: $logicalName"
    }
    $candidatePath = $values[0].get_InnerText().Replace('\', '/')
    if ($candidatePath -ine $expectedPaths[$logicalName]) {
      throw "PRI candidate does not point to the expected scale-200 asset: $logicalName"
    }
    $verified.Add([ordered]@{
      logicalImage = $logicalName.Substring('Files/'.Length)
      uri = $resource.GetAttribute('uri')
      candidateType = 'Path'
      candidateCount = 1
      scale = 200
      candidatePath = $candidatePath
    })
  }
  $result = [ordered]@{
    schemaVersion = 1
    scope = 'windows-test-pri-detailed-dump'
    ok = $true
    resourceMap = $maps[0].GetAttribute('name')
    dump = Get-FileEvidence $DumpPath
    images = $verified.ToArray()
    applicationIds = $applicationIds
    windowsRuntimeVerified = $false
    storeSubmissionReady = $false
  }
  if ($diagnosticMode) { $result.testDiagnostics = $TestDiagnostics }
  return $result
}

function Invoke-WindowsStoreSdkTest([string]$PreparedPath, [string]$SdkPath) {
  if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
    throw 'This SDK runner requires Windows and PowerShell 7'
  }
  $prepared = Get-InputDirectory $PreparedPath
  $sdk = Get-InputDirectory $SdkPath
  if ($null -eq $prepared.Parent) { throw 'The prepared directory must not be a filesystem root' }
  $output = Join-Path $prepared.Parent.FullName ($prepared.Name + '.sdk-output')
  $layout = Join-Path $prepared.FullName 'layout'
  $pri = Join-Path $layout 'resources.pri'
  Assert-NewPath $output
  Assert-NewPath $pri
  $makePri = (Get-RegularFile (Join-Path $sdk.FullName 'makepri.exe')).FullName
  $makeAppx = (Get-RegularFile (Join-Path $sdk.FullName 'makeappx.exe')).FullName
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $verifier = (Get-RegularFile (Join-Path $PSScriptRoot 'verify-windows-store-layout.mjs')).FullName
  $metadataFile = Get-RegularFile (Join-Path $prepared.FullName 'release-metadata.json')
  $metadata = [IO.File]::ReadAllText($metadataFile.FullName) | ConvertFrom-Json -AsHashtable -Depth 100
  if ($metadata -isnot [Collections.IDictionary] -or $metadata.profile -cne 'test' -or
      $metadata.identity -isnot [Collections.IDictionary] -or
      $metadata.identity.name -cne 'Motrix.Store.Test' -or
      $metadata.identity.publisher -cne 'CN=Motrix Store Test' -or
      $metadata.identity.publisherDisplayName -cne 'Motrix Store Test') {
    throw 'Only metadata.profile=test with the fixed experimental identity is supported'
  }
  $testDiagnostics = Get-WindowsStoreTestDiagnostics $metadata
  # New-Item without -Force fails if the sibling output already exists.
  New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
  $preparedCheck = Invoke-LayoutVerification $node $verifier $prepared.FullName 'prepared' $output
  $versionCheck = Invoke-CheckedProgram $node @('--version') $output 'node-version'
  $tools = [ordered]@{
    node = @{ path = $node; version = [IO.File]::ReadAllText($versionCheck.stdoutLog).Trim() }
    makepri = Get-SdkToolEvidence $makePri
    makeappx = Get-SdkToolEvidence $makeAppx
  }
  $manifest = Join-Path $layout 'AppxManifest.xml'
  Assert-NewPath $pri
  # Commands and the /mn identity source are documented here:
  # https://learn.microsoft.com/windows/uwp/app-resources/makepri-exe-command-options
  $indexCommand = Invoke-CheckedProgram $makePri @(
    'new', '/pr', (Join-Path $prepared.FullName 'pri-root'),
    '/cf', (Join-Path $prepared.FullName 'priconfig.xml'),
    '/mn', $manifest, '/of', $pri
  ) $output 'makepri-new'
  $priEvidence = Get-FileEvidence $pri
  $dump = Join-Path $output 'resources.pri.xml'
  $dumpCommand = Invoke-CheckedProgram $makePri @(
    'dump', '/if', $pri, '/of', $dump, '/dt', 'detailed'
  ) $output 'makepri-dump'
  $priReport = Test-MotrixPriDump $manifest $dump $testDiagnostics
  $priReportPath = Join-Path $output 'pri-report.json'
  Write-NewJson $priReportPath $priReport
  $indexedCheck = Invoke-LayoutVerification $node $verifier $prepared.FullName 'indexed' $output
  $package = Join-Path $output "Motrix-Store-Test-$($metadata.packageVersion)-x64.appx"
  Assert-NewPath $package
  # /l skips only the particular localized-package validation needed for qualified
  # assets. It does not disable all semantic validation; never pass /nv.
  # https://learn.microsoft.com/windows/msix/package/create-app-package-with-makeappx-tool
  $packCommand = Invoke-CheckedProgram $makeAppx @(
    'pack', '/h', 'SHA256', '/l', '/no', '/d', $layout, '/p', $package
  ) $output 'makeappx-pack'
  $packageEvidence = Get-FileEvidence $package
  $unpacked = Join-Path $output 'unpacked'
  Assert-NewPath $unpacked
  $unpackCommand = Invoke-CheckedProgram $makeAppx @(
    'unpack', '/no', '/p', $package, '/d', $unpacked
  ) $output 'makeappx-unpack'
  $unpackedCheck = Invoke-LayoutVerification $node $verifier $prepared.FullName 'unpacked' $output $unpacked
  if ((Get-FileEvidence $pri).sha256 -cne $priEvidence.sha256 -or
      (Get-FileEvidence (Join-Path $unpacked 'resources.pri')).sha256 -cne $priEvidence.sha256 -or
      (Get-FileEvidence $package).sha256 -cne $packageEvidence.sha256) {
    throw 'The package or validated PRI changed during packing or verification'
  }
  $result = [ordered]@{
    schemaVersion = 1
    scope = 'windows-test-sdk-smoke'
    status = 'completed'
    completedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    profile = 'test'
    identity = $metadata.identity
    productVersion = $metadata.productVersion
    packageVersion = $metadata.packageVersion
    preparedDirectory = $prepared.FullName
    sdkOutputDirectory = $output
    tools = $tools
    package = $packageEvidence
    pri = $priEvidence
    verification = [ordered]@{
      prepared = $preparedCheck
      indexed = $indexedCheck
      unpacked = $unpackedCheck
      priCandidates = @{ ok = $true; report = $priReportPath; imageCount = 4; scale = 200 }
      makepriNew = $indexCommand
      makepriDump = $dumpCommand
      makeappxPack = $packCommand
      makeappxUnpack = $unpackCommand
    }
    windowsSdkExecuted = $true
    signed = $false
    installed = $false
    windowsRuntimeVerified = $false
    payloadSourceVerified = $false
    storeReady = $false
    storeSubmissionReady = $false
  }
  if ($null -ne $testDiagnostics) { $result.testDiagnostics = $testDiagnostics }
  # The completion marker is created last, exclusively; no successful report is
  # written for a failed SDK command, malformed dump, or failed layout verifier.
  $resultPath = Join-Path $output 'sdk-result.json'
  Write-NewJson $resultPath $result
  Write-Host 'Windows SDK smoke completed. The test package is unsigned and was not installed or launched.'
  Write-Host "SDK result: $resultPath"
}

# Dot-sourcing with explicit arguments exposes the XML/PRI helpers for tests
# without invoking the Windows-only runner or any SDK process.
if ($MyInvocation.InvocationName -ne '.') {
  try {
    Invoke-WindowsStoreSdkTest $PreparedDirectory $SdkBinDirectory
  } catch {
    # PowerShell's default concise error view can show only the outer invocation.
    # Keep the original internal location and stack visible in Windows CI logs.
    $details = Get-WindowsStoreErrorDetails $_
    Write-Host "Windows SDK smoke failed: $($details.message)"
    Write-Host $details.position
    Write-Host $details.scriptStackTrace
    throw
  }
}
