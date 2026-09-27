# Windows test package runtime validation

[简体中文](windows-store-runtime-testing.zh-CN.md)

Use this guide after [Windows package preparation](windows-store-preparation.md)
has completed on Windows. It covers **local test signing and manual installation**
for `Motrix.Store.Test` / `CN=Motrix Store Test`, in a disposable Windows 11 x64
VM or dedicated test machine. The examples are instructions to execute and record;
they are not evidence that any runtime check has passed. Production Store identity,
Microsoft signing, WACK, and Store submission remain separate release gates.

The SDK workflow uploads text evidence only. Build the actual package locally
from the intended clean commit; a downloaded CI report does not provide a package.
Use PowerShell 7 for the preparation scripts, then **64-bit Windows PowerShell
5.1** (`powershell.exe`) for PKI and Appx commands below. This avoids differences
in [PowerShell 7 module compatibility](https://learn.microsoft.com/powershell/windows/module-compatibility). Replace all paths and placeholders explicitly.
Do not run these blocks as one unattended script.

## 1. Check the package and preserve an unsigned original

Use the same elevated 64-bit Windows PowerShell 5.1 session under the signing
user for sections 1 and 2. Set the prepared directory from the successful SDK run,
an installed x64 SDK containing SignTool, a new output directory outside the
checkout, and the intended source commit. Its parent directory must exist.
The checks tie the package bytes to the local preparation records; they do not
prove release provenance. Keep the original SDK records unchanged.

```powershell
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$prepared = 'C:\path\motrix-store-layout-a'
$sdkBin = 'C:\Program Files (x86)\Windows Kits\10\bin\<installed-sdk-version>\x64'
$lab = 'C:\path\motrix-store-runtime-a'
$expectedCommit = '<full lowercase source commit SHA>'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) {
  throw 'Use 64-bit Windows PowerShell 5.1 for these steps'
}
if ($expectedCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'Set the expected source commit' }
$metadata = Get-Content -LiteralPath "$prepared\release-metadata.json" -Raw | ConvertFrom-Json
$source = Get-Content -LiteralPath "$prepared\source-report.json" -Raw | ConvertFrom-Json
$sdk = Get-Content -LiteralPath "$prepared.sdk-output\sdk-result.json" -Raw | ConvertFrom-Json
if ($metadata.profile -cne 'test' -or $sdk.profile -cne 'test' -or
    $metadata.identity.name -cne 'Motrix.Store.Test' -or
    $metadata.identity.publisher -cne 'CN=Motrix Store Test' -or
    $sdk.identity.name -cne $metadata.identity.name -or
    $sdk.identity.publisher -cne $metadata.identity.publisher -or
    $metadata.source.commit -cne $expectedCommit -or
    $source.ok -ne $true -or $source.observed.commit -cne $expectedCommit -or
    $source.observed.productVersion -cne $metadata.productVersion -or
    $sdk.productVersion -cne $metadata.productVersion -or
    $metadata.packageVersion -notmatch '^\d+\.\d+\.\d+\.\d+$' -or
    $sdk.packageVersion -cne $metadata.packageVersion -or
    $sdk.status -cne 'completed' -or $sdk.signed -ne $false) {
  throw 'The local test metadata and completed SDK evidence do not match'
}
$unsigned = Join-Path "$prepared.sdk-output" "Motrix-Store-Test-$($metadata.packageVersion)-x64.appx"
$unsignedHash = (Get-FileHash -LiteralPath $unsigned -Algorithm SHA256).Hash.ToLowerInvariant()
if ($unsignedHash -cne $sdk.package.sha256) { throw 'Unsigned package hash mismatch' }
$signTool = Join-Path $sdkBin 'signtool.exe'
if (-not (Test-Path -LiteralPath $signTool -PathType Leaf)) { throw 'SignTool was not found' }
if (Test-Path -LiteralPath $lab) { throw 'Choose a new runtime output directory' }
New-Item -ItemType Directory -Path $lab | Out-Null
$signed = Join-Path $lab ([IO.Path]::GetFileName($unsigned))
[IO.File]::Copy($unsigned, $signed, $false)
```

## 2. Create a temporary signing certificate and sign the copy

Continue in the **same signing session** so the setup variables remain available.
If that session was closed, restore its recorded paths and values without
recreating or overwriting the output directory. The certificate
is an end entity with code-signing EKU, not a CA. The private key remains
non-exportable in that user's `CurrentUser\My`; export only the public CER.
The subject must exactly match the manifest Publisher. This follows Microsoft's
[package certificate requirements](https://learn.microsoft.com/windows/msix/package/create-certificate-package-signing)
and [public certificate export](https://learn.microsoft.com/powershell/module/pki/export-certificate).

```powershell
$cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=Motrix Store Test' `
  -FriendlyName 'Motrix Store Test - disposable lab only' `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 `
  -HashAlgorithm SHA256 -KeyUsage DigitalSignature -KeyExportPolicy NonExportable `
  -NotAfter (Get-Date).AddDays(30) `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$thumbprint = $cert.Thumbprint
Export-Certificate -Cert $cert -FilePath (Join-Path $lab 'motrix-store-test.cer') -Type CERT -NoClobber | Out-Null
$thumbprint | Set-Content -LiteralPath (Join-Path $lab 'certificate-thumbprint.txt')
$thumbprint
```

For upgrade B, reuse A's unexpired certificate instead of running certificate
creation again: run `$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\<recorded-thumbprint>"`. Run signing as the same Windows user that owns its private key.

SignTool selects the exact thumbprint from the user Personal store. `/sha1`
identifies the certificate; `/fd SHA256` sets the package signature digest to
match MakeAppx. Do not use `/sm`, automatic certificate selection, or a PFX.
There is no timestamp service in this short-lived lab procedure; finish testing
before expiry. See [SignTool](https://learn.microsoft.com/windows/win32/seccrypto/signtool)
and [package signing](https://learn.microsoft.com/windows/msix/package/sign-app-package-using-signtool).

```powershell
if ($cert.Subject -cne 'CN=Motrix Store Test' -or -not $cert.HasPrivateKey -or
    $cert.NotAfter -le (Get-Date)) { throw 'A matching, unexpired private signing certificate is required' }
& $signTool sign /sha1 $cert.Thumbprint /s My /fd SHA256 $signed
if ($LASTEXITCODE -ne 0) { throw 'Test package signing failed' }
$signedHash = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{
  sourceCommit = $expectedCommit
  productVersion = $metadata.productVersion
  packageVersion = $metadata.packageVersion
  unsignedSha256 = $unsignedHash
  signedSha256 = $signedHash
  certificateThumbprint = $cert.Thumbprint
  signed = $true
  installed = $false
  windowsRuntimeVerified = $false
  storeReady = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lab 'signing-record.json')
```

## 3. Trust the public certificate on the test machine

In an **administrator** Windows PowerShell 5.1 session on the disposable target,
set the same output path and independently copy the thumbprint shown by the signing
session. If signing and testing use separate machines, transfer only the signed
AppX, public CER, and text records. Compare the signed SHA-256 over a trusted channel.
Do not transfer a private key.

This imports trust for all users of this machine into `LocalMachine\TrustedPeople`.
It does not add a root CA. Record whether trust already existed so cleanup does not
remove someone else's entry. Microsoft documents
[Import-Certificate](https://learn.microsoft.com/powershell/module/pki/import-certificate).

```powershell
$ErrorActionPreference = 'Stop'
$lab = 'C:\path\motrix-store-runtime-a'
$expectedThumbprint = '<thumbprint displayed in the signing session>'
if ($expectedThumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Set the exact certificate thumbprint' }
$cer = Join-Path $lab 'motrix-store-test.cer'
$publicCert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($cer)
if ($publicCert.Subject -cne 'CN=Motrix Store Test' -or
    $publicCert.Thumbprint -ine $expectedThumbprint -or $publicCert.HasPrivateKey) {
  throw 'Unexpected public certificate'
}
$trustPath = "Cert:\LocalMachine\TrustedPeople\$expectedThumbprint"
$trustRecord = Join-Path $lab 'trust-record.json'
if (Test-Path -LiteralPath $trustRecord) { throw 'Keep the original trust record; do not overwrite it' }
[ordered]@{
  thumbprint = $expectedThumbprint
  existedBefore = (Test-Path -LiteralPath $trustPath)
} | ConvertTo-Json | Set-Content -LiteralPath $trustRecord
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
```

## 4. Verify, install, and launch as the test user

Return to a **non-elevated** Windows PowerShell 5.1 session as the intended test user.
Each account has its own package registration. Save the SignTool result and package
identity as text. If deployment fails, retain its error code and ActivityId; retrieve
that operation's log with `Get-AppxLog -ActivityID '<reported-guid>'`, then redact
user paths before sharing. Do not bypass signature checks or force a downgrade.

```powershell
$ErrorActionPreference = 'Stop'
$lab = 'C:\path\motrix-store-runtime-a'
$sdkBin = 'C:\Program Files (x86)\Windows Kits\10\bin\<installed-sdk-version>\x64'
$record = Get-Content -LiteralPath (Join-Path $lab 'signing-record.json') -Raw | ConvertFrom-Json
$signed = Join-Path $lab "Motrix-Store-Test-$($record.packageVersion)-x64.appx"
if ((Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash -ine $record.signedSha256) {
  throw 'Signed package hash mismatch'
}
& (Join-Path $sdkBin 'signtool.exe') verify /pa /v $signed
if ($LASTEXITCODE -ne 0) { throw 'Signature/trust verification failed; do not install' }
$before = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($before.Count -ne 0) { throw 'This is not a clean install; use the upgrade procedure instead' }
Add-AppxPackage -Path $signed -ErrorAction Stop
$packages = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($packages.Count -ne 1) { throw 'Expected exactly one current-user test package' }
$installed = $packages[0]
if ($installed.Publisher -cne 'CN=Motrix Store Test' -or
    $installed.Version.ToString() -cne $record.packageVersion -or
    $installed.Status.ToString() -cne 'Ok') { throw 'Installed package identity/version/status mismatch' }
$installed | Select-Object Name, Publisher, Version, PackageFullName, PackageFamilyName, Architecture, SignatureKind, Status | Format-List
```

### Check the installed diagnostic alias

For a package built with `testDiagnostics: "native-messaging-probe-v1"`, run this
optional diagnostic check after installation and before launching Motrix. Use
Node 24 and the locked dependencies in the same checkout used for preparation,
and supply that package's indexed preparation directory. Select the installed
four-part package version explicitly and a new JSON report path with an existing
parent directory. The tool runs as the current test user and performs no signing,
installation, browser registration, or application startup.

```powershell
$diagnosticLayout = 'C:\path\motrix-store-diagnostic-layout'
$expectedPackageVersion = '1.0.0.0'
$aliasReport = 'C:\path\motrix-store-runtime-a\alias-report.json'
node scripts/test-windows-store-native-messaging-alias.mjs --prepared $diagnosticLayout --expected-package-version $expectedPackageVersion --report $aliasReport
if ($LASTEXITCODE -ne 0) { throw 'Installed diagnostic alias verification failed' }
```

The checker verifies the installed manifest and probe bytes against the prepared
records, then launches the absolute WindowsApps alias with a fixed public
challenge. It requires one bounded frame, empty stderr, the expected version,
and SHA-256 matches for the full package name and helper AUMID reported by the
probe. Those hashes are comparison data, not authentication credentials. It
checks the installed package again after the three cases to reject an upgrade
during the test. An error produces a failed report and a nonzero exit.

Chromium- and Firefox-shaped arguments in this check are simulations. A successful
report establishes the diagnostic alias's activation, identity, and pipes in the
recorded environment; it does not establish real browser discovery, MBP1, main
application behavior, or a Store-signed installation. For an upgrade-before-first-
launch experiment, run it again after installing B, with B's prepared directory
and version, before starting the main application.

The manual hosted CI uses this sequence with a fixed payload: three alias cases
on A, an in-place upgrade to B, then the same three cases before any main-app
launch. Its `alias-report-a.json` and `alias-report-b.json` must show the expected
versions, different full package names, and the same family/helper application
identity. This isolates alias retargeting across package versions; it does not
test application data migration or real browser connections. The runtime report
records that narrow result separately from general upgrade acceptance.

### Check diagnostic Native Messaging in real browsers

The separate browser checker opens the installed Google Chrome, Microsoft Edge,
and Mozilla Firefox in new temporary profiles. Run it only on the disposable test
account with the diagnostic package already installed. It temporarily registers
the fixed `app.motrix.bridge.store.p0` host for the current user; it does not use
the regular Motrix host. Supply a new output directory with an existing parent:

```powershell
$diagnosticLayout = 'C:\path\motrix-store-diagnostic-upgrade-layout'
$expectedPackageVersion = '1.0.1.0'
$browserOutput = 'C:\path\motrix-store-runtime-b\browser'
$relayBuild = 'C:\path\motrix-store-firefox-relay'
pwsh -NoProfile -File scripts/build-windows-store-firefox-alias-relay.ps1 -OutputDirectory $relayBuild
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic relay build failed' }
node scripts/test-windows-store-native-messaging-browser.mjs --prepared $diagnosticLayout --expected-package-version $expectedPackageVersion --output-directory $browserOutput --firefox-relay-build-dir $relayBuild
if ($LASTEXITCODE -ne 0) { throw 'Diagnostic browser verification failed' }
```

This explicit experiment registers an ordinary PE relay for Firefox, which invokes the fixed diagnostic alias; Chrome and Edge invoke the alias directly. The relay forwards one fixed challenge, without reading profiles or connecting to MBP1. The checker binds the source, build report and actual executable digests, and records `hostLaunchMode`. Omit `--firefox-relay-build-dir` to reproduce the direct Firefox alias path; these modes are distinct evidence. The relay uses a temporary directory, so this does not establish production relay deployment, continuity across upgrades, or uninstall cleanup.

Each browser must fail to connect before registration, return the fixed diagnostic
reply after registration, and fail again after removal. The checker rejects any
existing test-host registration, including other registry views and Edge fallback
locations. It only removes registrations and files whose ownership still matches
this run. It uses an unpacked test extension in Chrome/Edge and a temporary add-on
in Firefox, without accessing existing browser profiles or signing into accounts.
A missing browser or unsupported extension loader is a failure; another browser
cannot substitute for the requested brand.
Chrome and Edge use headed CDP sessions; Firefox uses a headless BiDi session.
The report records the automation mode alongside the actual browser version.

The reply must match the installed package version and full package/helper
identity hashes. Browser evidence records extension messages and disconnects;
raw stdio framing and process exit codes belong to the separate alias checker.
Only `browser-report.json` is retained as CI evidence, with browser versions,
hashes, case results, and cleanup results. No screenshots or profile files are
uploaded. Manual hosted CI runs this checker after B's alias checks, before
uninstalling B. This tests diagnostic browser discovery at B, not a browser
connection surviving an upgrade, the production MBP1 host, or Windows 11
standard-user acceptance.

### Check the production extension build with the installed application

Manual runs of `windows-store.yml` also build the production extension from the
immutable commit pinned in the workflow. The build uses its frozen lockfile and
must leave its source checkout clean. `main-runtime-report.json` records the
extension source commit, complete build digest, browser brand/version and separate
`runtime.extensionRuntimes.chrome` and `runtime.extensionRuntimes.edge` results.
The diagnostic extensions described above cannot satisfy these checks.

Each browser gets a new disposable profile and loads the unchanged Web Store
build through CDP as an unpacked extension. The driver selects **Motrix · Microsoft
Store** and the installed application's candidate through the normal popup UI,
enters the pairing code shown by that application's renderer, and waits for
authenticated connection. It then closes and reopens the same browser profile;
reconnection must use the retained credential without another pairing code.
The driver does not preseed credentials or application consent, or copy a user's
existing browser profile. The application's first-run consent uses its normal UI.

The Edge case additionally closes the application and checks that no Motrix
process or endpoint remains. It clicks the extension's normal **Connect** or
**View tasks** action and accepts the browser's normal confirmation for the test
package. UI Automation is restricted to the owned browser process, start time,
binary digest and fixed test application name. It does not pre-authorize protocol
origins or remember permission. The native host only observes with
`allowLaunch: false`; package activation must originate from the extension action.
The new application's package identity, process generation and loopback listener
must match before the extension reconnects using its original credential.

Accept a result only when pairing, browser restart, and cleanup all pass for both
browsers. Edge also requires `protocolActivationVerified`, confirmed browser
consent, and every `protocolLaunch` ownership/no-launch/cleanup check. Chrome's
protocol flag remains false because that phase currently runs only in Edge.
Failure-stage codes and bounded UI control counts support diagnosis without
retaining page text, pairing material, screenshots, videos or traces. Profiles
are deleted, and CI retains only its existing JSON/XML/log evidence allowlist.

These checks exercise production code loaded unpacked, not a browser-store
installation. They do not establish Firefox production pairing, Chrome protocol
activation, permission cancellation, missing-handler behavior, download takeover,
service-worker restart in isolation, or connection continuity across application
upgrades/uninstallation. Record these separately, together with Windows 11
standard-user acceptance, WACK and the actual Microsoft-signed Store flight.
A hosted Windows Server result cannot replace those gates; global `mbp1Verified`
and `storeReady` remain false. A configured test is not a passing observation:
inspect the run's source-bound report and cleanup results before claiming success.

### Launch Motrix and record runtime scenarios

```powershell
Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($installed.PackageFamilyName)!Motrix"
```

Launching `app\Motrix.exe` directly from the unpacked build does not establish
package activation. Use the installed AUMID above or its Start menu entry.
`Add-AppxPackage` success alone does not prove any application behavior. Record the
Windows edition/build, x64 architecture, app product version, source commit, both
package hashes, certificate thumbprint, package version, and observed AUMID.

Run and record each relevant scenario as `pass`, `fail`, `not-run`, or
`not-applicable`, with actual observations; the latter two require a reason:

| Area | Required observations |
|---|---|
| First launch and coexistence | No system Node/pnpm requirement; Store and direct profiles, settings, credentials, locks, and task records remain separate. Both default to the system Downloads folder; select different disposable download directories for this test. |
| Download/runtime | HTTPS and authorized torrent/magnet transfers, pause/resume/restart, Unicode paths, SQLite writes, aria2 and filesystem helper operation. |
| Startup | Disabled by default; opening settings does not enable it; explicit save respects OS/user policy; logout/login obeys the window preference. |
| Activation/default apps | Cold/hot motrix, mo, magnet, and torrent activation, multiple Unicode paths, malformed links, default-app refresh and targeted Settings page. Links only prefill or navigate. |
| Notifications | Completion/error routing, delayed duplicate callbacks, historical toast cold start, startup/exit races, plugin replace/close/click and direct-app coexistence. |
| Browser/CLI limitations | Package settings report unsupported automatic discovery; no direct host registry/file changes, CLI probing or in-app installation; existing pairing/revocation remains manageable. This does not prove browser/CLI support. |
| Updates | Package mode does not start the NSIS updater; installed identity, startup, associations, notifications, and test data survive A to B. |

Return text observations and redacted logs only. Do not include screenshots,
profile databases, endpoint files, pairing codes, tokens, credentials, private keys,
or private download URLs. Missing observations remain unverified.

## 5. Upgrade within the same test family

Close Motrix normally. Prepare B from a clean intended commit using a new build,
layout, SDK output, and runtime directory. Increase the four-part package version
(for example `1.0.0.0` to `1.0.1.0`), include A in `previousPackageVersions`, preserve
Name/Publisher/architecture, and reuse A's certificate. Do not modify a completed
layout or reuse stale staged output. Repeat sections 1 and 2 for B, skipping new
certificate creation and trust import. Copy the verification portion of section 4
(up to and including the SignTool exit-code check), and **replace the `$lab = ...`
assignment inside that copied block with B's directory**. Execute that portion,
then run the following upgrade block instead of the clean-install block. Microsoft requires the same package family for
[Add-AppxPackage updates](https://learn.microsoft.com/powershell/module/appx/add-appxpackage).

```powershell
# Set $lab to the new B runtime directory. Repeat the signed hash and
# SignTool verification from the install section before this block.
$before = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($before.Count -ne 1 -or $before[0].Publisher -cne 'CN=Motrix Store Test') {
  throw 'Expected the existing test package'
}
if ([version]$record.packageVersion -le [version]$before[0].Version) {
  throw 'Upgrade requires a strictly higher package version'
}
$previousFamily = $before[0].PackageFamilyName
Add-AppxPackage -Path $signed -ErrorAction Stop
$after = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($after.Count -ne 1 -or $after[0].PackageFamilyName -cne $previousFamily -or
    $after[0].Version.ToString() -cne $record.packageVersion -or
    $after[0].Status.ToString() -cne 'Ok') { throw 'Upgrade identity/version/status mismatch' }
```

Launch the installed package again and rerun the affected scenarios. Preserve
A/B observations separately. Test persistence using only disposable downloads,
settings, and pairing data; do not infer successful migration from installation.

## 6. Uninstall and remove only this lab's certificate

After recording the uninstall baseline and closing Motrix, run the following as
the same non-elevated test user. Uninstall may remove test app data. Do not remove
other users' packages, use wildcard package removal, or manually delete profiles.
Record remaining registrations and files before any subsequent cleanup.

```powershell
$ErrorActionPreference = 'Stop'
$packages = @(Get-AppxPackage -Name 'Motrix.Store.Test')
if ($packages.Count -ne 1 -or $packages[0].Publisher -cne 'CN=Motrix Store Test') {
  throw 'Expected exactly the current-user Motrix test package'
}
Remove-AppxPackage -Package $packages[0].PackageFullName -ErrorAction Stop
if (@(Get-AppxPackage -Name 'Motrix.Store.Test').Count -ne 0) { throw 'Test package is still registered' }
```

After every test package using this certificate has been removed, remove trust in
an administrator session using **A's original trust record**:

```powershell
$ErrorActionPreference = 'Stop'
$lab = 'C:\path\motrix-store-runtime-a'
$trust = Get-Content -LiteralPath (Join-Path $lab 'trust-record.json') -Raw | ConvertFrom-Json
if ($trust.thumbprint -notmatch '^[0-9A-Fa-f]{40}$' -or $trust.existedBefore -ne $false) {
  throw 'Do not remove pre-existing trust or an unrecognized certificate'
}
$trustPath = "Cert:\LocalMachine\TrustedPeople\$($trust.thumbprint)"
$trusted = Get-Item -LiteralPath $trustPath
if ($trusted.Subject -cne 'CN=Motrix Store Test') { throw 'Unexpected certificate subject' }
Remove-Item -LiteralPath $trustPath -ErrorAction Stop
```

Finally, in the original signing user's session, delete the certificate and its
private key by the recorded thumbprint. This prevents further upgrade signing with
that key. Keep text evidence, and remove disposable output separately when no
longer needed. The certificate provider's
[`-DeleteKey`](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/about/about_certificate_provider)
option removes the associated private key as well:

```powershell
$thumbprint = '<the same recorded certificate thumbprint>'
if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Set the exact certificate thumbprint' }
$keyPath = "Cert:\CurrentUser\My\$thumbprint"
$cert = Get-Item -LiteralPath $keyPath
if ($cert.Subject -cne 'CN=Motrix Store Test') { throw 'Unexpected certificate subject' }
Remove-Item -LiteralPath $keyPath -DeleteKey -ErrorAction Stop
```
