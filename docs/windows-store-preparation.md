# Windows package preparation

[简体中文](windows-store-preparation.zh-CN.md)

Motrix's Windows package support is under development. Preparation tools validate
inputs and assemble a test layout; a separate Windows SDK runner creates an
unsigned test AppX. These tools do not sign, install, submit, or establish
Microsoft Store compatibility. StartupTask integration is implemented for testing;
package associations, browser integration, and installation lifecycle still need
work. Windows package runtime verification remains required.

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

The manifest contains one packaged desktop application and `runFullTrust`.
It declares the opt-in `MotrixStartup` task for `app\Motrix.exe`, with
`Enabled="false"` and `--opened-at-login=1`. Protocol, file association, and
native-host alias declarations await their runtime implementations. The configured Windows threshold is
10.0.19045.0; this is not a Windows compatibility test result. The four existing
images are scale-200 resources, referenced by logical paths in the manifest.
The PRI configuration indexes the isolated `pri-root` directory, which contains
only `Assets/`, preserving the `Assets/` segment in logical resource names.
`resources.pri` and the AppX are **not generated** by this command; Windows SDK resource resolution and
pack/unpack verification remain required.

Store profile layout preparation is currently rejected: production asset
variants and package integration remain incomplete. Use test layouts only with
an isolated Windows user or VM. Existing browser registration still uses direct
distribution paths and needs package-aware behavior, even without a native-host
alias declaration.

## Windows startup integration

The Store directory build includes `bin/motrix-windows-platform.exe`. The helper
checks its actual Windows package identity before using WinRT `StartupTask`.
It accepts only a bounded, versioned JSON request for the fixed `MotrixStartup`
task. Electron calls the helper from its packaged resource path, serializes
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

The `Windows Store package check` workflow performs this test on a Windows
runner from the checked-out commit, using the fixed test identity and package
version. It builds its own payload and consumes no signing or submission
credentials. Its artifact contains only JSON/XML reports and process logs, with no images or
AppX upload. A green job establishes the SDK checks for that commit only.

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
