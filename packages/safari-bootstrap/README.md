# Safari desktop bootstrap

This package belongs to **Motrix.app**, not the independently distributed Safari
extension container. Its original IPC implementation comes from
[motrix-extension](https://github.com/motrixapp/motrix-extension/tree/4dc7d53abc048705a2edcebe2b327ec7b713032f/native/safari)
(MIT, Copyright 2026-present Dr_rOot). The desktop owns this implementation and
its release cadence; the existing Safari bootstrap wire interface remains v1.

## Build and distribution

On macOS with Xcode and the matching Rust target installed:

```sh
pnpm run build:safari-bootstrap -- --arch arm64
pnpm run build:safari-bootstrap -- --arch x64
swift test --package-path packages/safari-bootstrap
```

Builds need no certificate or adjacent checkout. They produce two unsigned
executables in `dist/darwin-<arch>/`. Electron Builder embeds them at:

- `Contents/Library/LaunchServices/MotrixSafariBootstrap`
- `Contents/MacOS/MotrixSafariRegistrar`
- `Contents/Library/LaunchAgents/app.motrix.safari.bootstrap.plist`

The existing CI and release macOS matrices build each architecture separately.
The isolated signing job receives binaries as data and hash-pinned signing
policy, not Swift/Rust source or a build hook. `scripts/sign-macos.mjs` runs with
the existing pinned Electron Builder dependency closure and Developer ID
certificate. Only the two exact helper paths receive the App Group entitlement;
Electron retains its existing per-file signing policy. Signing checks the fixed
Team, identifiers and exact helper entitlements before the complete app enters
the existing notarization, stapling, DMG/ZIP and updater publication gates.

`configuration.json`, the two build plists, and the signing policy pin the
production Team and group. The group uses macOS's Team-prefixed convention;
there is no new CI secret or private provisioning profile in this package.
See Apple's [app group guidance](https://developer.apple.com/documentation/xcode/accessing-app-group-containers).
Changing the Team requires coordinated changes to the independently signed
Safari extension and these reviewed distribution inputs.

## Registration and upgrades

The packaged desktop verifies its own signature and same-Team registrar before
invoking `--register`. The registrar verifies the bundled helper, then asks the
running service for its signed executable location and code-directory hash over
a separate, read-only `.registration` Mach endpoint. This endpoint accepts only
the same-user, same-Team signed registrar with the expected App Group. The
Safari `.bootstrap` endpoint retains its extension-only identity requirement.
Neither interface accepts an application path supplied by JavaScript.

A matching service is left running, including during a Safari cold launch.
An absent, unresponsive or mismatched service is reconciled through
`SMAppService`: unregister the old registration when enabled, register the
current bundle, then verify its running identity. At most two registration
cycles bound recovery attempts. Registration failures are reported as failures,
not `enabled`.
`requires-approval` is preserved; the app never overrides the user's disabled
background-item choice. `--status` reports the OS registration state only;
`--register` additionally verifies the owner. `--unregister` removes this service
without deleting an app or its user data.

Every changed signed build must use a fresh `CFBundleVersion`. Both the unsigned
build and isolated signing jobs already use `github.run_number.github.run_attempt.0`.
In migration testing, macOS retained the old launch constraint when Development
and Developer ID copies reused a build number; retries alone did not repair it.
Using a new build number allowed the new signed copy to take ownership. Local
signed rebuilds must also advance their build number.

After installing/updating, open the intended Motrix.app once. This is what
establishes ownership on the user's Mac; CI cannot register a service for that
user. Explicitly launching another signed copy can intentionally change the
registered owner. Merely downloading a new app does not update registration.
The helper launches only its verified containing desktop bundle, and pairing
still requires MBP1 authentication against the discovered running instance.

## Release acceptance

CI checks Swift IPC/registration policy, both architectures, embedded locations,
fixed LaunchAgent contents, signing-input tampering and finalized package layout.
Before promotion, verify on a real Mac:

1. Install and launch the signed build, and approve the background item if macOS
   requests it. Query its registrar and confirm registration succeeds.
2. Quit Motrix, request connection in Safari, and verify the current installed
   app starts, the engine is ready, and engine diagnostics run.
3. Upgrade an already registered build, then repeat cold launch and paired
   reconnection. Cover relocation and migration from a Development-signed copy.
4. Disable the background item and confirm launching Motrix does not silently
   re-enable it. Re-enable it explicitly before continuing testing.

Never delete the database or pairing credentials to repair an old launch target.
Unsigned/ad-hoc development builds cannot establish this production trust chain.
