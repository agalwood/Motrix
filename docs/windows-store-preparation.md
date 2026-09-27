# Windows package preparation

[简体中文](windows-store-preparation.zh-CN.md)

Motrix's Windows package support is under development. The tools below validate
build inputs; they do not create an AppX/MSIX, sign it, submit it, or establish
Microsoft Store compatibility. Startup tasks, package associations, browser
integration, and installation lifecycle still require implementation and Windows
verification.

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

Do not treat an unsigned directory build, a valid metadata file, or a successful
local check as a distributable Store package. Actual Windows packaging, package
identity verification, WACK, and installation/update tests remain required.

## References

- [Package identity and version ranges](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/package-identity-overview)
- [Store package and version requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Partner Center identity details](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
