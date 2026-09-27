# Windows package preparation

[简体中文](windows-store-preparation.zh-CN.md)

Motrix's Windows package support is under development. Preparation tools validate
inputs and assemble a test layout; a separate Windows SDK runner creates an
unsigned test AppX. These tools do not sign, install, submit, or establish
Microsoft Store compatibility. StartupTask, package associations, and notification
activation are implemented for testing. Browser discovery and installation
lifecycle still need work. Windows package runtime verification remains required.

After the SDK check, follow [Windows test package runtime validation](windows-store-runtime-testing.md)
for local test signing, installation, upgrade, and cleanup on a disposable
Windows 11 machine. That manual procedure does not change the unsigned CI workflow.

## Release metadata

Keep release metadata outside the source checkout. Use this shape for a local
test, replacing the two angle-bracket placeholders with the exact values from
`package.json` and `git rev-parse HEAD`:

```json
{
  "schemaVersion": 1,
  "profile": "test",
  "architecture": "x64",
  "productVersion": "<package.json version>",
  "packageVersion": "1.0.0.0",
  "source": { "commit": "<full lowercase commit SHA>" },
  "identity": {
    "name": "Motrix.Store.Test",
    "publisher": "CN=Motrix Store Test",
    "publisherDisplayName": "Motrix Store Test"
  },
  "previousPackageVersions": []
}
```

This fixed identity is reserved for disposable tests. A `store` profile requires
externally supplied Partner Center identity fields, a stable product version,
and an exact `source.tag` of `v<productVersion>`. Known Motrix test identities
are rejected. The optional `storeProductId` is an opaque identifier; supplying
it does not prove a listing exists.

The product version and four-part Windows package version are independent. Each
package-version component is between 0 and 65535. Store submissions additionally
require a nonzero first component and a zero fourth component. Motrix requires
each candidate to exceed every supplied `previousPackageVersions` entry,
including Store-assigned revisions. This monotonic policy does not prove that
the supplied history covers every submission or flight. Confirm the full history
in Partner Center before assigning a release version.

## Check the source checkout

Run from an installed development checkout:

```sh
node scripts/verify-windows-store-source.mjs --repo-root . --metadata /path/to/release-metadata.json
```

The command prints JSON and returns a nonzero exit code on failure. It checks
the actual commit, product version, clean worktree, and an exact tag when
provided. Store mode also requires the source commit to be an ancestor of the
local `refs/remotes/origin/main`. Fetch the required refs beforehand; the
verifier performs no network operations. Run against a clean, complete checkout
without Git replacement refs, grafts, hidden index changes, custom clean/process
filters, or submodules. Ignored build output is permitted.

The verifier ignores global/system Git configuration. For a new Windows build
checkout, use `git clone --config core.autocrlf=false <repository> <new-directory>`
so checkout bytes do not depend on the runner's global CRLF conversion setting.
The Store CI applies that setting before checkout.

A successful local report does **not** prove that remote refs are fresh, a tag
is protected, or an existing application bundle was built from that source.
Those checks still belong to the release workflow and candidate verification.

## Directory build configuration

`createWindowsStoreBuilderConfig` in
`scripts/windows-store-builder-config.mjs` prepares the existing staged Electron
directory build. It preserves runtime resources, licenses, staging hooks, and
fuses, selects Windows x64 `dir`, and disables global/Windows update publication
and executable signing. The output directory must be absolute.

The generated object must be written as a **complete configuration file** and
passed with `--config`, rather than merged as command-line overrides into the
NSIS configuration. Invoke electron-builder with `--win --x64 --publish never`.
This only prepares the directory payload for later Windows SDK packaging; the
ordinary Electron `appId` does not establish an AppX package identity.

## Prepare a directory build

Use a clean Windows x64 development checkout with the repository's Node, pnpm,
and Rust versions. This preparation command joins the metadata, local source
check, and complete builder configuration:

```powershell
$storeBuild = Join-Path $env:TEMP 'motrix-store-build-a'
node scripts/prepare-windows-store-build.mjs --repo-root . --metadata C:\path\release-metadata.json --out $storeBuild
```

The absolute output directory must be new, its parent must already exist, and
it must be outside the checkout. Existing output is never overwritten. The
command writes `electron-builder.json`, `release-metadata.json`,
`source-report.json`, and finally `build-plan.json`. The last file records the
input digests and builder argument array; it is a preparation record, not a
build attestation. No build command runs automatically.

Build and stage the same checkout using the existing Windows package flow:

```powershell
pnpm run ensure:electron-runtime
pnpm run fetch:engine --platform win32 --arch x64
pnpm run build:builtin
pnpm run build:native-host -- --platform win32 --arch x64
pnpm run build:finalize-fs -- --platform win32 --arch x64
pnpm run build:windows-platform --platform win32 --arch x64
pnpm run build:electron
pnpm run stage:electron -- --platform win32 --arch x64
pnpm exec electron-builder --config "$storeBuild\electron-builder.json" --win --x64 --publish never
```

Check each command's exit code and stop on failure. The directory payload is
expected under `payload/win-unpacked` inside the preparation directory. Do not
change source, reuse another checkout's build outputs, or treat an old stage
as evidence of a fresh build. Release workflow provenance and verification of
the final payload are separate requirements.

## Verify the payload and assemble a test layout

```powershell
node scripts/verify-windows-store-payload.mjs --app-dir "$storeBuild\payload\win-unpacked" --metadata "$storeBuild\release-metadata.json"
```

The JSON report combines the existing Electron package checks with Windows
path checks, x64 PE machine checks, product-version comparison, and file hashes.
It rejects links, case collisions, signing-key/certificate files, updater
configuration, and undeclared executables/installers. It reads the actual ASAR
entries as well as the directory. The package version is recorded from metadata;
it has not yet been embedded in an AppX. Successful machine checks do not mean
that an executable has run or its signature has been verified.

For `test` metadata only, assemble the verified payload and existing assets:

```powershell
$storeLayout = Join-Path $env:TEMP 'motrix-store-layout-a'
node scripts/prepare-windows-store-layout.mjs --repo-root . --app-dir "$storeBuild\payload\win-unpacked" --metadata "$storeBuild\release-metadata.json" --out $storeLayout
```

The output must be fresh and outside both source and payload. The command
verifies the copied payload and compares every physical file's digest before
writing its completion record, `layout-report.json`. It also writes the source
and payload reports, metadata, `TEST-ONLY.txt`, and these SDK inputs:

```text
layout/
  AppxManifest.xml
  Assets/*.scale-200.png
  app/                       # unchanged, verified directory payload
pri-root/Assets/             # identical asset files for PRI indexing
priconfig.xml
```

The ordinary test manifest contains one packaged desktop application and `runFullTrust`.
It declares the opt-in `MotrixStartup` task for `app\Motrix.exe`, with
`Enabled="false"` and `--opened-at-login=1`. It also declares the `motrix`, `mo`,
and `magnet` protocols and `.torrent` files. Production native-host alias declarations
await package-aware browser integration; the explicit diagnostic mode below uses
a separate test probe. The configured Windows threshold is
10.0.19045.0; this is not a Windows compatibility test result. The four existing
images are scale-200 resources, referenced by logical paths in the manifest.
The PRI configuration indexes the isolated `pri-root` directory, which contains
only `Assets/`, preserving the `Assets/` segment in logical resource names.
`resources.pri` and the AppX are **not generated** by this command; Windows SDK resource resolution and
pack/unpack verification remain required.

Store profile layout preparation is currently rejected: production asset
variants and package integration remain incomplete. Use test layouts only with
an isolated Windows user or VM. Browser auto-discovery is currently unsupported
in Windows packages; the package does not register or remove the direct
distribution's browser connector.

## Windows startup integration

The Store directory build includes `bin/motrix-windows-platform.exe`. The helper
checks its actual Windows package identity before using WinRT `StartupTask`.
Startup operations use a bounded, versioned JSON request for the fixed
`MotrixStartup` task. Electron calls the helper from its packaged resource path, serializes
requests, and limits execution time and output size. A helper failure never
falls back to traditional login-item registration.

Package startup reads the Windows state without applying the saved preference.
General settings displays the five Windows states, requests changes only after
an explicit edit and Save, and directs user-disabled or policy-controlled tasks
to Windows startup settings. Returning to Motrix refreshes the state. Changes to
“Show main window at login” alone do not request startup activation. Errors keep
the committed settings snapshot and the startup-specific explanation for retry.
Unpackaged Windows and macOS retain the existing Electron login-item behavior.

The declaration uses the documented [desktop extension parameters](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-desktop-extension)
and [StartupTask opt-in attribute](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-desktop-startuptask).
Compilation and unit tests do not prove package identity inheritance, WinRT
activation, or login behavior. Windows 11 validation must cover:

- Fresh install and first launch: disabled by default; opening settings does not enable it.
- Explicit enable/disable: Windows and Motrix agree, including after restarting the app.
- Disable in Windows settings: returning to Motrix respects that choice and discards a conflicting unsaved edit.
- Policy-controlled states, when available: the app cannot override the system choice.
- Sign out/in with startup enabled: `--opened-at-login=1` reaches the launcher and the saved window preference is respected.
- Upgrade between two increasing package versions and uninstall: startup registration follows the package lifecycle.

Record text logs and observed states for those checks. The SDK workflow uploads
only JSON/XML/log evidence; it does not install the package or execute this matrix.

## Windows links and default applications

The test manifest uses [desktop protocol and file associations](https://learn.microsoft.com/windows/apps/desktop/modernize/desktop-to-uwp-extensions)
with a quoted `%1` argument. `Document` selection mode activates the application
once for each selected torrent file. The launcher forwards subsequent activations
to the running instance. `mo://` and `motrix://` share route validation; links
prefill the add-task form or open existing task/plugin details. They do not
submit downloads or install plugins. Resource URLs are excluded from the local
torrent-file scan to prevent duplicate dispatch.

For packaged Windows, the helper verifies the main `Motrix` application's AUMID
against the current package's app entries. It queries `.torrent` and `magnet`
defaults through [AssocQueryStringW](https://learn.microsoft.com/windows/win32/api/shlwapi/nf-shlwapi-assocquerystringw)
and compares the returned AUMID. An unreadable result, including a traditional
handler without an AUMID, remains unknown. A main app entry does not prove that
each association extension was registered. Traditional installer registration
and UserChoice registry reads are not used in this package branch, and no default
choice is written. The UI validates responses and clears stale status on failure.

On supported Windows 11 builds, the settings button uses the verified main AUMID
in the [application-specific Default Apps link](https://learn.microsoft.com/windows/apps/develop/launch/launch-default-apps-settings).
Earlier systems or an unverifiable identity use the general Default Apps page.
The current manifest retains its configured `MaxVersionTested` of 19045. An OS
upgrade may require raising that value to reindex the application for this link;
this must be decided together with actual Windows testing.

Windows 11 validation must also cover:

- Cold and running-app activation for all three schemes and torrent files, including spaces, Unicode paths, and multiple selected files.
- Malformed links produce no task, plugin installation, or duplicate file dispatch.
- Defaults changed in Windows settings refresh correctly on return to Motrix; unreadable defaults remain unknown.
- Direct and packaged installations coexist without silently changing the user's default choices; upgrade and uninstall remove only their own declarations.
- The application-specific settings page works after a fresh install and an OS upgrade. Record the OS build, package identity, and observed destination.

SDK packing alone does not execute any of these activation or association checks.

## Windows package notifications

The package uses one fixed toast activator CLSID from
`src/shared/config/windows-package.json` for both Electron and the manifest's
COM/toast declarations. Electron receives this CLSID before notification
initialization. The package initializes its notification presenter after app
readiness so a notification can activate the COM server even before a new toast
has been shown. Direct distributions retain their existing initialization.

Persistent notification clicks may have empty arguments. The package queues a
bounded request to show the main window until startup finishes; it does not
interpret activation arguments as a URL, file path, or task command. Live
business notification clicks retain their existing task/reveal behavior. An
instance click takes priority over a global fallback in the same event-loop
turn; this is not a guarantee against duplicate events delivered later. Plugin
notification clicks in the package also open the main window. Shutdown discards
pending activation work.

This follows the pinned Electron notification implementation and Microsoft's
[toast activation](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-desktop-toastnotificationactivation)
and [COM executable server](https://learn.microsoft.com/uwp/schemas/appxpackage/uapmanifestschema/element-com-exeserver)
contracts. The manifest does not use Windows App SDK-specific activation
arguments. On Windows 11, verify delivery, live clicks, notification-center clicks
after restart or process exit, clicks during startup, repeated events, and
coexistence with the direct installation. Also exercise plugin notification
replacement and dismissal while observing package identity. Neither
`Notification.isSupported()` nor SDK packing proves those runtime behaviors.

## Browser registration isolation

Windows packages report an `unsupported` Native Messaging registration policy.
The installer returns before resolving a host path or touching manifests,
development sidecars, or browser registry keys. This applies to registration,
standalone cleanup, startup rollback, and trusted-extension changes. The native
host path resolver also rejects Windows package use. Direct distributions keep
their existing registration; Flatpak keeps its externally managed policy.

Settings queries this policy independently of the bridge, so the Windows package
limitation remains visible while browser integration is off. It hides extension
installation cards and Native Messaging recovery advice for this package, while
retaining the switch, paired-client list, and revocation controls. A running MDXP
bridge does not prove Native Messaging is available; its authentication is
unchanged.

The Rust host now selects its profile from OS package identity. Only confirmed absence of package identity permits traditional profiles, environment overrides, development sidecars, or EXE launch discovery. A packaged host requires the same family’s `MotrixNativeHost` application identity and uses system Roaming AppData with `Motrix-Store/bridge`; custom data-directory overrides are rejected. Package query failures never fall back to the direct installation. Packaged cold launch invokes the fixed sibling Windows platform helper, which activates only the unique main app entry in the current package. Enumeration and activation share a four-second deadline; the host bounds its helper to five seconds and then uses the existing endpoint-readiness polling. There is no traditional EXE or default-protocol fallback. The production alias, actual Electron/Rust profile parity, and production MBP1 still require installed-package validation, so settings continue to report unsupported automatic discovery.

This isolation does not implement Store browser support. A stable package host,
correct profile discovery, browser stdio behavior, cold launch, upgrade before
first launch, uninstall, and coexistence still require Windows 11 evidence and
coordination with the browser extensions. Do not expose the production Store alias before profile, activation, and lifecycle validation is complete.

## Native Messaging diagnostic process check

The SDK workflow also compiles a separate x64 diagnostic console executable
with the Windows .NET Framework compiler and tests its binary stdin/stdout.
The probe accepts only a fixed public challenge; it does not read a Motrix
profile, endpoint, credentials, or registry entries, and does not launch Motrix.
It is excluded from the ordinary test AppX and is never uploaded as a binary artifact.

To run the same process checks in PowerShell 7 on Windows, use a new directory:

```powershell
$probeOutput = Join-Path $env:TEMP 'motrix-store-native-messaging-probe'
./scripts/build-windows-store-native-messaging-probe.ps1 -OutputDirectory $probeOutput
./tests/scripts/windows-store-native-messaging-probe.test.ps1 -ProbePath (Join-Path $probeOutput 'motrix-store-p0-probe.exe') -ReportPath (Join-Path $probeOutput 'direct-stdio-report.json')
```

Stop if either command fails. `build-report.json` records the source/executable
hashes and x64 console checks. `direct-stdio-report.json` records `ok: true` and
`directStdioVerified: true` only after the response framing, child exit codes,
malformed-input rejection, and timeout checks pass. A failed check can write an
`ok: false` report and still fails the command; report existence is not success.
Successful direct execution must report no package identity.
Browser-shaped arguments are synthetic test inputs, not real browser launches.

These reports establish compilation and direct process behavior only. They keep
`packagedActivationVerified`, `browserNativeMessagingVerified`, and
`mbp1Verified` false. The probe expects the fixed `Motrix.Store.Test` package
identity when installed through the diagnostic mode below. The ordinary test
manifest has no diagnostic application or alias. Package activation, external registration visibility, three-browser
behavior, upgrade before first launch, and MBP1 pairing remain separate work.

### Assemble a diagnostic test package

The optional metadata field `testDiagnostics: "native-messaging-probe-v1"` is
accepted only with the fixed test identity. Store metadata rejects this field.
After compiling the probe from the same clean checkout, create a separate
metadata file and layout:

```powershell
$diagnosticMetadata = Get-Content -LiteralPath "$storeBuild\release-metadata.json" -Raw | ConvertFrom-Json -AsHashtable
$diagnosticMetadata.testDiagnostics = 'native-messaging-probe-v1'
$diagnosticMetadataFile = Join-Path $env:TEMP 'motrix-store-diagnostic-input.json'
$diagnosticMetadata | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $diagnosticMetadataFile -Encoding utf8NoBOM -NoClobber
$diagnosticLayout = Join-Path $env:TEMP 'motrix-store-diagnostic-layout'
node scripts/prepare-windows-store-layout.mjs --repo-root . --app-dir "$storeBuild\payload\win-unpacked" --metadata $diagnosticMetadataFile --out $diagnosticLayout --probe-build-dir $probeOutput
```

Both output paths must be unused. Pass `$diagnosticLayout` as the prepared
directory to the SDK command below. The layout checks the probe's actual x64
console headers and hashes, binds its build-report source hash to the checkout,
and rechecks the copied bytes. It retains `diagnostic-build-report.json` outside
the package as a build association record, not a signed attestation.

The diagnostic manifest adds the hidden `MotrixNativeHostP0` application and
`motrix-store-p0-native-host.exe` execution alias, both pointing to
`diagnostics/motrix-store-p0-probe.exe`. The Electron payload stays unchanged;
it still rejects undeclared executables. A second hidden `MotrixNativeHost`
application points to the existing `app/resources/bin/motrix-native-host.exe`
through the test-only `motrix-store-p0-profile-host.exe` alias. Both helpers
share the existing icons.
The prepared, indexed, and unpacked checks require the exact extra file and
manifest, and the SDK checks all three application references against the same four
PRI resources.

After upgrading to B, hosted CI invokes the actual Rust host with
`allowLaunch:false`. A temporary loopback fixture must be reachable through a
bridge-directory override by the unpackaged executable both before and after
the alias cases. The packaged alias must refuse that override without connecting
to the fixture; without an endpoint it must report `motrix-not-running`. The
checker binds installed bytes to the prepared layout and requires fixture
cleanup. These checks do not prove Electron/Rust profile parity, successful
AUMID resolution, MBP1, or browser integration with the production host.

The same explicit diagnostic mode adds the GUI alias `motrix-store-p0-main.exe`
to the existing `Motrix` application. It does not change ordinary test or Store
manifests, application payloads, or Electron fuses. After the diagnostic browser
cases, disposable hosted CI launches this alias with a loopback renderer CDP
port, verifies the process executable, OS package identity, AUMID and listener
ownership, and follows the normal first-run disclaimer UI. The actual Rust alias
must then discover an endpoint whose listener belongs to that main process.
Only booleans, byte counts and digests are retained; nonces, profile files, raw
Electron output and images are never retained. This checks bridge startup and
endpoint interoperability, not production extension MBP1, full application acceptance
or equality of the two processes' filesystem paths. Process cleanup is required.
After that first normal launch has been closed, CI separately requires the actual
Rust host to leave the application closed for `allowLaunch:false`, activate it for
`allowLaunch:true`, and return an endpoint owned by a newly created same-package
main process. It closes that verified process and repeats the no-launch check.
The cold-launch transport has a 25-second budget for helper activation and the
existing 15-second endpoint wait. It does not seed consent or change profiles.
Cold-launch and MBP1 results are recorded separately.

The same experiment also uses the existing Node MBP1 test client to consume the
actual Rust host's nonce, read the normal pairing-code UI in memory, and complete
the PAKE, credential exchange, encrypted initialization and an empty task-list
read. After cold activation it must reconnect using that original credential.
Credentials remain only in the controller's memory and are never included in
reports. `installedMbp1TransportVerified` records this narrower transport check;
`syntheticMbp1Client` remains true and the production `mbp1Verified` flag remains
false. A supplied Node Origin does not prove real browser provenance, production
extension behavior or the production browser registration lifecycle.

The controller also generates a one-use Ed25519 binding key for the actual Rust
host's `bootstrap` request. Without caller arguments the response must omit a
ticket; with fixed synthetic Chromium caller arguments it must return a ticket
that the server accepts with the controller's binding proof during pairing.
The private key stays in memory and is cleared after pairing or disposal.
`installedBootstrapTicketProofVerified` requires both checks, transport success
and cleanup. This does not establish real browser-supplied arguments or Windows
endpoint ACL protection: the existing Windows reader retains ticket fields from
the selected user-data namespace. No endpoint token or ticket is read into the
report or generated by the CI controller.

This diagnostic package uses the same identity as the ordinary test package;
they do not install side by side. For A-to-B testing, prepare two increasing
package versions using the same identity, helper, and alias. Follow the
[test signing and installation guide](windows-store-runtime-testing.md), then
verify alias activation and browser discovery separately. The direct-process
test above expects no package identity and cannot validate the installed alias.
No browser host registration or MBP1 connection is implemented by this mode.

## CLI integration boundary

This Windows package does not yet support default CLI discovery. Its private
profile is separate from the direct installation, so finding a global `motrix`
executable does not prove that it can select or connect to this package.

The package reports CLI integration as unsupported before shell or executable
probing and rejects application-initiated CLI installation through every package
manager. Settings displays the limitation without installation commands or
automatic-connection claims. A null CLI version or path in this state means it
was not inspected; it does not mean no CLI is installed. Direct distributions and
the server retain their existing behavior.

This is a limit of the current integration, not a claim that Microsoft prohibits
CLI tools. Existing MDXP authentication, pairing approval, and revocation remain
available. Package-aware CLI target selection, coexistence, activation, and
external access to the package profile need a compatible CLI release and Windows
validation before automatic discovery can be advertised.

## Run the Windows SDK package check

In PowerShell 7 on Windows, select an installed x64 SDK directory containing `makepri.exe` and
`makeappx.exe`, then run:

```powershell
./scripts/pack-windows-store-test.ps1 -PreparedDirectory $storeLayout -SdkBinDirectory 'C:\Program Files (x86)\Windows Kits\10\bin\<installed-sdk-version>\x64'
```

The SDK runner requires a fresh layout with no `resources.pri`, and creates a
new sibling directory named `<layout-directory-name>.sdk-output`. It checks the
prepared inputs, generates and dumps the PRI, verifies the logical image paths
and scale-200 candidates, packs an unsigned AppX, unpacks it, and compares the
actual manifest, assets, payload, and PRI digests. It writes `sdk-result.json`
only after those steps succeed. Partial output remains for diagnosis; use a
new preparation directory for a retry.

The pack command uses `/l` for qualified resources. That option skips a specific
localization check; it does not prove all manifest semantics. The runner never
passes `/nv`. MakeAppx validation is limited, and a successful pack/unpack does
not prove installation, runtime behavior, WACK, or Store certification.

To inspect a layout independently, the read-only validator supports these
phases and prints a JSON report:

```powershell
node scripts/verify-windows-store-layout.mjs --prepared $storeLayout --phase prepared
# After indexing; the first command deliberately rejects an existing PRI:
node scripts/verify-windows-store-layout.mjs --prepared $storeLayout --phase indexed
node scripts/verify-windows-store-layout.mjs --prepared $storeLayout --phase unpacked --layout "$storeLayout.sdk-output\unpacked"
```

The `Windows Store package check` workflow performs these checks on a Windows
runner from the checked-out commit, using the fixed test identity and package
version. It builds its own payload and uses no publisher signing or submission
credentials. Its artifact contains only JSON/XML reports and process logs, with
no images, packages, or certificates.

A manual workflow dispatch additionally prepares diagnostic versions A
(`1.0.0.0`) and B (`1.0.1.0`) from the same payload and source, with B recording A
in its supplied version history. Both pass the SDK and PRI checks before
installation. A Windows PowerShell 5.1 wrapper requires the disposable hosted
CI environment, creates one non-exportable temporary test key, signs and verifies
new copies, installs A for the current runner account, and invokes the
[installed-alias checker](windows-store-runtime-testing.md#check-the-installed-diagnostic-alias).
It then upgrades to B without uninstalling A or starting Motrix, and checks that
the same alias and application identity activate B immediately. Separate reports
retain each version's observations. Before removing B, a separate
[browser checker](windows-store-runtime-testing.md#check-diagnostic-native-messaging-in-real-browsers)
tests the diagnostic host with installed Chrome, Edge, and Firefox using fresh
profiles and temporary current-user test registrations. Firefox uses an explicit ordinary PE relay to invoke the fixed alias; Chrome and Edge invoke the alias directly. Reports identify the launch mode, without claiming production relay deployment or lifecycle support. Each browser must reject
the absent host, connect while registered, and reject it after registration removal.
Registration ownership and profile cleanup are required for a successful report.
A final, separate main-runtime check follows the first-run UI and verifies actual
Rust endpoint discovery. Its result is bound to B and does not extend the earlier
before-main-launch upgrade claim.
The wrapper removes only its own installed package,
certificate/trust entries, and temporary signed copies, and verifies cleanup.
Both unsigned SDK packages stay unchanged.
Pull request runs skip this installation step. No publisher certificate, PFX,
private key export, or Store submission is involved.

The runtime report records the actual runner image, OS, account context, and
individual results. GitHub's Windows hosted runners use an administrator account;
this Server baseline cannot establish Windows 11 standard-user behavior,
production MBP1, main-application data migration, or Store
certification. The upgrade experiment changes the package version while keeping
the payload fixed; it proves only the recorded diagnostic alias behavior.
An SDK result remains an SDK result; installed-alias and real-browser diagnostic
claims require their own successful reports. The browser checks run at B and do
not establish browser behavior across an upgrade. See [supported MSIX platforms](https://learn.microsoft.com/windows/msix/supported-platforms)
and [hosted-runner privileges](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges).

Do not treat an unsigned directory build, a valid metadata file, or a successful
local check as a distributable Store package. Actual Windows packaging, package
identity verification, WACK, and installation/update tests remain required.

## References

- [Package identity and version ranges](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/package-identity-overview)
- [Store package and version requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Partner Center identity details](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
- [Desktop package manifest](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)
- [App icon asset requirements](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)
- [PRI configuration](https://learn.microsoft.com/en-us/windows/uwp/app-resources/makepri-exe-configuration)
- [MakeAppx commands and validation limits](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)
