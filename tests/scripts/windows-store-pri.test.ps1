#Requires -Version 7.0
<#
.SYNOPSIS
Tests PRI validation against a completed SDK dump and seven mutated copies.
.DESCRIPTION
Runs no SDK commands. Reads the prepared layout and its sibling SDK evidence,
creates all mutations in one temporary directory, and removes that directory.
Writes a concise JSON result; an unexpected acceptance or error fails the job.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$PreparedDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
  throw 'This test requires Windows and PowerShell 7'
}
$runner = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts/pack-windows-store-test.ps1'))
# Dot-sourcing exposes only helpers; the runner's main invocation guard prevents
# SDK execution. Both mandatory arguments are explicit, with an unused SDK path.
. $runner -PreparedDirectory $PreparedDirectory -SdkBinDirectory 'unused-by-pri-tests'

function Assert-PriMutationRejected {
  param(
    [string]$Name,
    [string]$Manifest,
    [string]$Dump,
    [string]$ExpectedMessagePrefix,
    [bool]$ExpectXmlException
  )
  $caught = $null
  try {
    $ignored = Test-MotrixPriDump $Manifest $Dump
  } catch {
    $caught = $_.Exception
  }
  # Keep assertions outside the catch. Throwing an "expected rejection" error
  # inside the try would incorrectly turn an accepted mutation into a passing test.
  if ($null -eq $caught) { throw "PRI validator accepted mutation: $Name" }
  if ($ExpectXmlException) {
    $cause = $caught
    while ($null -ne $cause -and $cause -isnot [Xml.XmlException]) {
      $cause = $cause.InnerException
    }
    if ($null -eq $cause) {
      throw "Mutation $Name failed for an unexpected non-XML reason: $($caught.Message)"
    }
  } elseif (-not $caught.Message.StartsWith($ExpectedMessagePrefix, [StringComparison]::Ordinal)) {
    throw "Mutation $Name failed for an unexpected reason: $($caught.Message)"
  }
}

$cases = @(
  @{
    name = 'wrong-scale'
    prefix = 'PRI image must have only the Scale=200 qualifier and one literal Value:'
    xmlException = $false
    mutate = {
      param([Xml.XmlDocument]$Document)
      $qualifier = $Document.SelectSingleNode('(//NamedResource/Candidate/QualifierSet/Qualifier[@name="Scale"])[1]')
      $qualifier.SetAttribute('value', '100')
    }
  },
  @{
    name = 'wrong-value-path'
    prefix = 'PRI candidate does not point to the expected scale-200 asset:'
    xmlException = $false
    mutate = {
      param([Xml.XmlDocument]$Document)
      $Document.SelectSingleNode('(//NamedResource/Candidate/Value)[1]').set_InnerText('Assets\Unexpected.scale-200.png')
    }
  },
  @{
    name = 'extra-candidate'
    prefix = 'PRI must contain exactly four image resources with one candidate each'
    xmlException = $false
    mutate = {
      param([Xml.XmlDocument]$Document)
      $candidate = $Document.SelectSingleNode('(//NamedResource/Candidate)[1]')
      [void]$candidate.get_ParentNode().AppendChild($candidate.CloneNode($true))
    }
  },
  @{
    name = 'missing-resource'
    prefix = 'PRI must contain exactly four image resources with one candidate each'
    xmlException = $false
    mutate = {
      param([Xml.XmlDocument]$Document)
      $resource = $Document.SelectSingleNode('(//NamedResource)[1]')
      [void]$resource.get_ParentNode().RemoveChild($resource)
    }
  },
  @{
    name = 'duplicate-resource'
    prefix = 'Unexpected or duplicate PRI logical image:'
    xmlException = $false
    mutate = {
      param([Xml.XmlDocument]$Document)
      $resources = @($Document.SelectNodes('//NamedResource'))
      # Replace a different resource rather than appending: retain four resources
      # and four candidates so this exercises duplicate-name detection itself.
      [void]$resources[1].get_ParentNode().ReplaceChild($resources[0].CloneNode($true), $resources[1])
    }
  },
  @{
    name = 'wrong-map'
    prefix = 'PRI must contain exactly one resource map for Motrix.Store.Test'
    xmlException = $false
    mutate = {
      param([Xml.XmlDocument]$Document)
      $Document.SelectSingleNode('/PriInfo/ResourceMap').SetAttribute('name', 'Example.WrongMap')
    }
  },
  @{
    name = 'dtd'
    prefix = ''
    xmlException = $true
    mutate = {
      param([Xml.XmlDocument]$Document)
      # A well-formed internal DTD, with no external URL or file access. The
      # parser must reject the declaration even though no entity is referenced.
      $doctype = $Document.CreateDocumentType('PriInfo', $null, $null, '<!ENTITY motrixTest "unused">')
      [void]$Document.InsertBefore($doctype, $Document.get_DocumentElement())
    }
  }
)

$checks = [Collections.Generic.List[object]]::new()
$sourceHashes = @{}
$failure = $null
$failureDetails = $null
$temporaryDirectory = $null
$temporaryCreated = $false
$temporaryFilesRemoved = $false
$sourceFilesUnchanged = $false
try {
  $prepared = Get-InputDirectory $PreparedDirectory
  if ($null -eq $prepared.Parent) { throw 'The prepared directory must not be a filesystem root' }
  $sdkOutput = Join-Path $prepared.Parent.FullName ($prepared.Name + '.sdk-output')
  $manifest = Join-Path $prepared.FullName 'layout/AppxManifest.xml'
  $sourceDump = Join-Path $sdkOutput 'resources.pri.xml'
  $sdkResultPath = Join-Path $sdkOutput 'sdk-result.json'
  $protectedFiles = @(
    $manifest,
    $sourceDump,
    $sdkResultPath,
    (Join-Path $prepared.FullName 'layout/resources.pri')
  )
  foreach ($path in $protectedFiles) {
    $sourceHashes[$path] = (Get-FileEvidence $path).sha256
  }
  $sdkResult = [IO.File]::ReadAllText($sdkResultPath) | ConvertFrom-Json -AsHashtable -Depth 100
  if ($sdkResult.scope -cne 'windows-test-sdk-smoke' -or
      $sdkResult.status -cne 'completed' -or
      $sdkResult.windowsSdkExecuted -isnot [bool] -or -not $sdkResult.windowsSdkExecuted) {
    throw 'A completed Windows SDK smoke result is required before PRI mutation tests'
  }
  $baseline = Test-MotrixPriDump $manifest $sourceDump
  if ($baseline.ok -isnot [bool] -or -not $baseline.ok -or $baseline.images.Count -ne 4) {
    throw 'The original SDK dump did not validate its four manifest images'
  }
  $checks.Add([ordered]@{ name = 'original-sdk-dump'; ok = $true })

  $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('motrix-pri-tests-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporaryDirectory -ErrorAction Stop | Out-Null
  $temporaryCreated = $true
  foreach ($case in $cases) {
    # Each mutation starts from the unchanged real dump. Fixture construction is
    # outside the rejection assertion so a broken mutation cannot pass as a test.
    $copy = Read-SafeXmlDocument $sourceDump
    & $case.mutate $copy | Out-Null
    $mutatedPath = Join-Path $temporaryDirectory ($case.name + '.pri.xml')
    Write-NewText $mutatedPath $copy.get_OuterXml()
    Assert-PriMutationRejected $case.name $manifest $mutatedPath $case.prefix $case.xmlException
    $checks.Add([ordered]@{ name = $case.name; ok = $true; rejected = $true })
  }
} catch {
  $failure = $_.Exception.Message
  $failureDetails = Get-WindowsStoreErrorDetails $_
} finally {
  try {
    foreach ($path in $sourceHashes.Keys) {
      if ((Get-FileEvidence $path).sha256 -cne $sourceHashes[$path]) {
        throw "Original SDK evidence changed during the test: $path"
      }
    }
    $sourceFilesUnchanged = $sourceHashes.Count -eq 4
  } catch {
    $failure = "Original evidence verification failed: $($_.Exception.Message)"
    $failureDetails = Get-WindowsStoreErrorDetails $_
  }
  try {
    if ($temporaryCreated) {
      Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction Stop
    }
    $temporaryFilesRemoved = $true
  } catch {
    $failure = "Temporary test cleanup failed: $($_.Exception.Message)"
    $failureDetails = Get-WindowsStoreErrorDetails $_
  }
}

$result = [ordered]@{
  schemaVersion = 1
  scope = 'windows-store-pri-mutation-tests'
  ok = $null -eq $failure
  testCount = $checks.Count
  checks = $checks.ToArray()
  sourceFilesUnchanged = $sourceFilesUnchanged
  temporaryFilesRemoved = $temporaryFilesRemoved
  sdkCommandsExecutedByTests = $false
}
if ($null -ne $failure) {
  $result.error = $failure
  $result.diagnostics = $failureDetails
}
$result | ConvertTo-Json -Depth 8 -Compress
if ($null -ne $failure) { throw $failure }
