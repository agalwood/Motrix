# Safari Native Messaging development harness

This directory provides Safari native transport, a reusable signed XPC bootstrap library, and a Rust-backed desktop bootstrap executable. The default ad-hoc harness supports a validated `ping`/`pong` exchange and returns `bootstrap-unavailable` for bootstrap. The signed client and desktop deployment have completed real Safari cold start, first pairing, credential reconnect after desktop exit, and a verified download. Use the client-only Safari app with the desktop-hosted service for this integration.

The signed and notarized `Motrix Extension for Safari.app` is [available for download](https://github.com/motrixapp/motrix-extension/releases?q=safari&expanded=true) and ready to use with the accompanying Motrix release. See the [installation instructions](../../README.md#install). The build 10 results below record development acceptance on 2026-09-27; they do not describe the current distribution status.

## Build

```sh
pnpm safari:native
```

The command first builds the offline Safari extension, then generates an Xcode project and builds a locally signed app. Full Xcode is required. The script defaults to `/Applications/Xcode.app/Contents/Developer`; set `DEVELOPER_DIR` for another installation. It does not change the system's `xcode-select` setting or use an Apple Developer account.

Output:

- Project: `.cache/safari-native/project/Motrix Extension for Safari/Motrix Extension for Safari.xcodeproj`
- App: `.cache/safari-native/DerivedData/Build/Products/Debug/Motrix Extension for Safari.app`
- App identifier: `app.motrix.safari`
- Extension identifier: `app.motrix.safari.extension`

The first run generates an Xcode project; subsequent runs preserve its signing, capabilities, and other project settings while replacing generated extension resources and native handler sources. Edit this directory's Swift/JavaScript sources and rerun the command. Keep custom files outside the generated extension Resources directory. Packaging copies `dist/safari` into a separate staging directory, adds `nativeMessaging` and the probe entry point there, and leaves the temporary-extension artifact unchanged. Only the packaged build with the declared native permission and API enables backend connections; the temporary extension stays offline.

`AppDelegate.swift` is also generated from this directory. Each build checks that every staged web resource exists in the resulting extension and that JavaScript, JSON, HTML, and CSS match exactly. Xcode's generated project explicitly lists top-level resources: adding one on disk alone does not add it to the target. A missing or stale resource fails the build rather than leaving a signed but incomplete app.

To create or refresh the Xcode project from an existing verified Safari build:

```sh
node scripts/safari-native.mjs
```

For developer-signed builds, configure the same development Team on both targets in Xcode, select Apple Development with automatic signing, then run:

```sh
pnpm safari:native:signed
```

This mode uses the Xcode project's signing configuration and verifies the built app against an Apple-anchored signing requirement; it never falls back to ad-hoc signing. The default `pnpm safari:native` remains an ad-hoc transport harness and omits custom group entitlements. Do not delete the generated project if you want to retain its local signing setup. Account credentials and private keys remain in Xcode/Keychain, outside this repository.

The packaged Safari extension uses the product name `Motrix Extension` in its manifest. Its containing app is `Motrix Extension for Safari`; neither product's display name includes a development-stage label.

### Release archive

With signing configured for both targets, build a universal sandboxed client archive:

```sh
MOTRIX_SAFARI_RELEASE=1 pnpm run build:safari
MOTRIX_SAFARI_RELEASE=1 node scripts/safari-native.mjs --build --signed --bootstrap-client-only --archive
```

This uses the Release configuration for arm64 and x86_64, derives the marketing version from the web manifest, and increments the local build number. The archive is written to `.cache/safari-native/archives/Motrix Extension for Safari-<build>.xcarchive`. It does not install, export, upload, or submit the app. Existing development signing may produce a development-signed archive; App Store distribution signing and validation are separate steps.

Archive mode requires the sandboxed client-only deployment and rejects diagnostic environment variables (`MOTRIX_SAFARI_FEATURE_PROBE`, `MOTRIX_SAFARI_VERIFY_PORT`, and `MOTRIX_DEV_PAIR_BACKOFF_MS`). It checks both staged and packaged resources for source maps, preview pages, HMR and diagnostic probe code. The retained `native-probe.js` resource is an empty module, preserving the existing Xcode resource reference. Compatible desktop bootstrap and protocol packages must be publicly released before shipping an archive built against local integration snapshots.

Bundle identifiers are independent of display names: `app.motrix.safari` for the app and `app.motrix.safari.extension` for the extension. The script normalizes Xcode 27's app-name-derived identifiers when first generating a project, preserving the required parent prefix.

### GitHub Actions: direct distribution

`.github/workflows/safari-direct-release.yml` is a manual, `main`-only workflow for Developer ID distribution, with three separate runners:

1. **Build:** install locked dependencies, test, generate a fresh Xcode project and build an unsigned arm64/x86_64 archive. No Apple credentials or release environment are attached.
2. **Sign:** download the exact artifact ID from this run and load the standalone Python signer from the immutable workflow commit through the GitHub API. No project checkout, package install, build hooks, or artifact-provided scripts execute. Validate source/version/build/team, paths, hashes, bundle identities, IPC configuration, both Mach-O slices and linked libraries before importing credentials. Sign the extension before its app, notarize, staple, verify exact entitlements and run Gatekeeper assessment.
3. **Publish (optional):** verify the final ZIP checksum and receipt, atomically create `safari-v<version>-build.<number>` at the workflow commit, then create a **draft** GitHub Release. Existing tags are never overwritten. If creation of a draft fails after tag creation, inspect the partial result; a retry deliberately refuses to reuse that tag.

Configure Environment `safari-direct-release`, limited to branch `main`, with these secrets:

| Secret | Value |
| --- | --- |
| `MAC_CERTS` | Base64 Developer ID Application PKCS#12, including its private key |
| `MAC_CERTS_PASSWORD` | PKCS#12 export password |
| `API_KEY` | Raw team API key PEM with access to Apple notarization |
| `API_KEY_ID` | Key ID |
| `API_KEY_ISSUER_ID` | Issuer ID |

The certificate must belong to Team `7VMB56CA56`. The keychain password is generated on the signing runner. Private files and keychain are removed on completion/failure; GitHub-hosted runners are discarded on cancellation. For optional publication, configure Environment `github-release`, limited to `main`; it needs no Apple credentials. Only the publish job receives `contents: write`. Apply repository review/protection to workflow and signing-policy changes.

The Team-prefixed macOS App Group `7VMB56CA56.app.motrix.shared` does not require a provisioning profile ([Apple documentation](https://developer.apple.com/documentation/xcode/accessing-app-group-containers)). Both products receive only App Sandbox, network client and this App Group entitlement. Changing teams requires coordinated desktop bootstrap changes. Artifact-provided profiles and entitlements are rejected.

After merging the Safari source and workflow into `main`, select **Actions → Safari direct distribution → Run workflow**, choose an unused build number (1–65535), and leave `publish` false for the first acceptance run. Download `safari-signed-<run>-<attempt>`, extract the distribution ZIP and test installation, Safari activation, native messaging and App/Server pairing on a clean Mac. Signing and notarization do not prove runtime compatibility or replace the desktop bootstrap release. A later accepted build with `publish` enabled prepares a draft for release.

The runner records its selected full Xcode version. PR CI exercises fresh unsigned archives without secrets. Local reproduction:

```sh
MOTRIX_SAFARI_RELEASE=1 pnpm run build:safari
MOTRIX_SAFARI_RELEASE=1 MOTRIX_SAFARI_TEAM_ID=7VMB56CA56 MOTRIX_SAFARI_BUILD_NUMBER=22 \
  node scripts/safari-native.mjs --build --archive --unsigned-archive --bootstrap-client-only
python3 -I scripts/__tests__/safari_release_test.py
```

CI output lives in `.cache/safari-ci`, separate from local signed Xcode settings. The bounded, data-only ZIP uses a complete SHA-256 manifest. Links, traversal, extra executable objects and development probes are rejected. Checksums bind the handoff to a run; they do not prove arbitrary compiled code is benign. Reviewed source, dependency checks and notarization remain distinct controls. The signer uses Python's standard library and `-I` to ignore local Python import/environment overrides.

## Verify in Safari

1. Install the generated app in a stable location, such as `~/Applications/Motrix Extension for Safari.app`. For the signed, sandboxed bootstrap client, use the installer below; other harness variants can be copied and opened manually. Keep one registered copy; opening both the build product and the installed copy can produce duplicate entries and `other version in use` errors. After rebuilding, update the installed copy before testing again.
2. In Safari Settings → Extensions, enable **Motrix Extension**. Ad-hoc builds require Safari's unsigned-extension development setting. The temporary extension and this packaged extension are separate installations.
3. Inspect the packaged extension's background context using Safari's Develop menu. The probe runs when the nonpersistent background page starts and when Safari reports extension installation or browser startup.
4. Inspect the local result in the background console:

```js
await browser.storage.local.get('safariNativeProbe')
```

A completed exchange stores `status: 'ok'`, `protocolVersion: 1`, `bootstrap: false`, an attempt ID, and timestamps. `pending` means the attempt did not finish yet; `error` has a bounded diagnostic code. A build or an old stored success is not proof of a new successful native exchange. Compare the current attempt and timestamps.

The native handler logs only its controlled outcome under subsystem `app.motrix.safari.extension`, category `messaging`. It never logs the incoming message body or pairing material. A native `pong` log proves handler execution; the JavaScript result additionally proves response delivery and correlation.

If a bundle identifier changed while Safari was running, a rebuild and an extension toggle may leave Safari using the previous XPC service name. Check the specific service name in the native error log against the current extension bundle identifier. Restart Safari to refresh its in-memory extension metadata; Safari resets the unsigned-extension setting on exit, so enable it again before retesting. Do not clear browser data or weaken other security settings to troubleshoot this case.

If the extension remains absent after unsigned extensions are allowed, install and open the app from its stable location to trigger discovery. This recovered the local Safari 27 test; an Applications directory is not a platform requirement. If the build-directory copy was already registered, unregister only that exact old `.appex` path with `pluginkit -r`, leaving the installed copy registered. Xcode builds also register their app products with LaunchServices, so rebuilding or running the old copy can register it again. Do not disable all instances by identifier or reset the global registry.

No website access is needed for this transport probe. Actual page discovery and Safari backend pairing require separate validation.

### Repeatable signed client installation

After `node scripts/safari-native.mjs --build --signed --bootstrap-client-only`, run:

```sh
# Read-only preflight; use the same Team configured in Xcode.
node scripts/safari-install.mjs --team TEAMID
# Apply the verified build to ~/Applications/Motrix Extension for Safari.app.
node scripts/safari-install.mjs --team TEAMID --install
```

The installer verifies Apple-anchored signatures, exact app and extension identities, App Group membership, both sandboxes, the signed IPC configuration, and matching build numbers. It accepts only the ordinary client-only app, excluding embedded services and the diagnostic popup. It checks any existing installation against the same Team before replacing it. Use `--source-app PATH` for a different build product.

Before replacing the installed app, the installer stages and re-verifies a full copy on the same filesystem. It retains the previous bundle at the returned hidden `~/Applications/.motrix-safari-install-*/previous.app.disabled` path. Copy, validation, or registration errors trigger restoration of the previous bundle and its registration; recovery errors are reported explicitly and recovery files are preserved. A process crash is not an automatic rollback: inspect the hidden transaction directory and `.motrix-safari-install.lock` before attempting recovery or retrying. Do not open the backup as a second installed copy.

Updates preserve the installed path's registration and refresh it after replacement. Only the exact duplicate build-product path is unregistered; a failed first installation also unregisters its newly placed copy. Global LaunchServices/PlugInKit state is never reset. A verified identical build is a no-op. A changed build must increase `CFBundleVersion`, which the native build script does automatically. The installer does not launch applications, change Safari permissions, or register the desktop bootstrap service. Safari can still require an extension toggle or restart to use updated code; verify its active build and current Origin before pairing.

Local installation of build 7 was verified in Safari as `Motrix Extension 0.1.14.7`, enabled with the ordinary popup. Loopback website access remained Allow and other sites remained Ask. The desktop bootstrap service remained enabled. Keeping the stable path registered did **not** preserve Safari's popup UUID in this local Xcode rebuild/update workflow. Do not assume an Origin survives development updates or reuse credentials across different Origins. This observation does not establish the behavior of App Store updates.

### Verified locally

On 2026-09-27, the installed harness completed a real Safari 27 → Swift → JavaScript exchange. The startup probe stored a fresh `status: 'ok'`; a subsequent console request returned a `pong` with its exact request ID. The same native transport returned `unsupported-version` for version 2 and `bootstrap-unavailable` for a valid bootstrap request with `allowLaunch: false`. The native outcome log also recorded `pong`. These checks establish the development transport only, not Motrix discovery or pairing. They used the earlier harness identity. The renamed, Apple Development-signed installation was separately verified at 18:33 on the same day: after restarting Safari to discard its cached old native service name, the fresh startup probe returned `status: ok` with attempt `46188135-e9e7-4104-bbff-7ac38bbe3c8b` and `checkedAt: 2026-09-27T10:33:19.605Z`. The signed extension remained enabled after restart without re-enabling unsigned extensions.

The renamed app and extension were built through Xcode MCP and the signed CLI workflow using Apple Development from Team `7VMB56CA56`. Both products passed Apple-anchored Team/identifier/App Group requirements and deep signature verification with `7VMB56CA56.app.motrix.shared`. The installed copy is `~/Applications/Motrix Extension for Safari.app`. This validates signing and packaging, not a deployed bootstrap Mach service.

## Tests

```sh
node --test scripts/__tests__/*.test.mjs
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test \
  --package-path native/safari \
  --scratch-path .cache/safari-native-tests
```

The Swift package has no external dependencies. It tests JSON shape and size, action/version validation, UUID correlation, strict Boolean handling, canonical 32-byte base64url public keys, and the unavailable bootstrap path. JavaScript tests cover valid and malformed replies, native failure, timeouts, concurrent lifecycle triggers, packaging, and installation transactions. Installer tests exercise failures before and after replacement, registration rollback, recovery errors, symlink rejection, concurrent installation, and idempotence using temporary bundles and injected registry operations; actual macOS signatures and registration need separate local validation.

The Swift tests also exercise real anonymous `NSXPCConnection` connections using the test executable's designated code-signing requirement. They cover both peer requirements, missing App Group requirements, wrong users, response filtering, cancellation, timeout/reply races, and connection cleanup. A restrictive execution sandbox may prevent anonymous XPC lookup; use a normal local developer shell to run these tests. Do not treat a sandbox failure as a passing test. These same-process endpoint tests do not validate Safari's sandbox access to a deployed Mach service.

After building the optional Rust-backed service, verify the actual Swift/C/Rust link with:

```sh
MOTRIX_NATIVE_HOST_SOURCE=/path/to/Motrix/packages/native-host \
  node scripts/verify-safari-bootstrap-link.mjs
```

This compiles a test-only executable and uses temporary endpoint files plus a disposable IPv4 loopback server. It validates the real Rust response with the Swift codec, independently verifies the ticket MAC, and covers missing attestation fields, insufficient endpoint permissions, a missing endpoint, identity-field injection, and launch suppression. Endpoint permissions that cannot support attestation retain the existing ticketless discovery behavior. The runner captures fixture responses without printing their contents, always disables app launch, and cleans up its server and files. It neither installs an app nor registers a service. The complete link check passed locally; deployed XPC and Safari pairing remain separate acceptance checks.

## Signed bootstrap integration

`Sources/SafariNativeIPC` supplies `BootstrapIPCClient`, `BootstrapIPCService`, and a strict request/response codec. Public constructors require an Apple-anchored signature, an explicit Team ID and bundle IDs, and membership in the configured App Group. Both connection peers must satisfy those signature and group requirements; the service also checks the caller's effective user ID. The supported macOS group naming convention is `TEAMID.reverse.dns`, with the Mach service name derived as `<group>.bootstrap`.

Before sending a bootstrap request, the client completes an empty `authenticate` exchange on the same connection. This is necessary because `setCodeSigningRequirement` validates incoming messages: rejecting an untrusted reply alone does not prevent the initial request from reaching that service. Only the authenticated connection receives the binding key and launch flag. Authentication and bootstrap share one 18-second deadline, below the JavaScript adapter's 20-second deadline.

Requests and replies are limited to 16 KiB. The resolver receives validated fields, without any caller-supplied identity. Responses allow only the versioned handoff, a Safari ticket bound to the request key, or fixed error codes. Raw endpoint tokens, extra fields, and arbitrary error text are rejected. Ticket signature verification remains the backend's responsibility.

The native handler reads an optional `MotrixBootstrapIPC` dictionary from its signed extension `Info.plist`, with exactly these string keys: `TeamIdentifier`, `ClientBundleIdentifier`, `ServiceBundleIdentifier`, and `AppGroupIdentifier`. Missing or invalid configuration, an unsigned process, or missing group membership fails closed. The generated ad-hoc preview deliberately omits this dictionary and group entitlement.

The service library's default resolver still returns `bootstrap-unavailable`. `BootstrapServiceMain.swift` provides the concrete resolver by statically linking the native-host C ABI. Production constructors have no unsigned mode. Anonymous test constructors are internal and excluded from release builds.

### Optional service build and deployment boundary

Use a Motrix native-host source package that includes the `safari-bootstrap` feature and `include/motrix_safari_bootstrap.h`:

```sh
MOTRIX_NATIVE_HOST_SOURCE=/path/to/Motrix/packages/native-host \
  node scripts/safari-native.mjs --build --signed --bootstrap
```

The build compiles a release Rust static library and Swift executable, signs the service as `app.motrix.safari.bootstrap`, embeds the group-scoped LaunchAgent, embeds IPC configuration in the extension, and verifies nested signatures. The group is derived from the Xcode Team as `TEAMID.app.motrix.shared`. Both Xcode targets must already carry that entitlement. This command preserves the container's sandbox entitlements.

The resolver accepts only a canonical binding key and a Boolean launch flag. The Rust entry point fixes the Safari caller identity to `app.motrix.safari.extension`; it does not accept argv identity, caller ID, browser, or endpoint paths from JavaScript. It reuses the owner-checked endpoint reader, liveness/nonce sequence, launch resolver, and ticket MAC implementation. Missing attestation material produces a ticketless handoff; the local token never enters a response. A dedicated serial resolver allows only one native operation at a time.

Register the service from the existing unsandboxed Motrix desktop app. The Safari containing app and extension can both retain their sandboxes. macOS rejected registration from the sandboxed Safari container (`SMAppServiceErrorDomain` code 1). Removing its sandbox for an explicitly authorized development test did not resolve that registration failure, even though the running process reported no sandbox entitlement. The desktop registration path succeeded. App Groups and passing signature checks alone do not establish successful deployment. See [Apple's supported sandbox combinations](https://developer.apple.com/forums/thread/802443).

Prepare a separately signed desktop copy, preserving the source app:

```sh
MOTRIX_NATIVE_HOST_SOURCE=/path/to/Motrix/packages/native-host \
  node scripts/safari-desktop-package.mjs \
  --source-app /path/to/Motrix.app --team TEAMID --identity SIGNING_IDENTITY
```

The source must already be unsandboxed, Apple-signed by the selected Team, and identify as `app.motrix.native`. The output is `.cache/safari-native/desktop/Motrix.app`. The script adds the signed service and `Contents/MacOS/MotrixSafariRegistrar`, preserves framework symlinks, and verifies the completed bundle. It does not install or register the app. Keep the output at a stable path once registered. Rebuilding refuses to replace a registered copy; unregister it first.

```sh
".cache/safari-native/desktop/Motrix.app/Contents/MacOS/MotrixSafariRegistrar" --status
".cache/safari-native/desktop/Motrix.app/Contents/MacOS/MotrixSafariRegistrar" --register
node scripts/safari-native.mjs --build --signed --bootstrap-client-only
```

Install the Safari build separately using the process above. `--bootstrap-client-only` embeds the signed IPC configuration without bundling or registering a helper in the Safari app. It requires `--build --signed` and is mutually exclusive with `--bootstrap`. The registrar checks its own identity and App Group, the containing desktop bundle, and the helper before querying or changing registration. `--unregister` removes the registration; it does not delete the app. If status is `requires-approval`, finish approval in macOS System Settings and query status again. The updated desktop source registers a bundled registrar at bridge startup after verifying its parent and same-Team identity. Apps without this component skip registration. Registration persists when Motrix exits so the service can handle an explicit wake-up request. Safari wake-up validates and opens the desktop bundle containing the running service, using its signed executable location and the compiled Team requirement. Rust discovery always receives `allowLaunch: false`; JavaScript cannot select an executable or trigger the generic host launcher.

On 2026-09-27, desktop registration returned `enabled`. At 21:09:09 local time, the installed Safari client invoked `7VMB56CA56.app.motrix.shared.bootstrap`; the service logged `Authenticated bootstrap request completed` and the extension logged `bootstrap-unavailable`. At 21:19:25, the extension popup displayed that response, confirming delivery back to JavaScript. This establishes real Safari sandbox access and authenticated resolver execution while Motrix was stopped. It does not establish successful endpoint discovery, pairing, or download.

The container's narrow `--register-bootstrap` and `--unregister-bootstrap` commands support local installation testing after that deployment prerequisite is satisfied. They print only status, never endpoint or pairing material. macOS may return `.notFound` before creating the service's first background-task record; registration handles this alongside `.notRegistered`.

For an explicitly chosen local development container, `--bootstrap-development-host` removes only the containing app's sandbox entitlement before re-signing it. The Safari extension remains sandboxed, and Team, bundle identity, App Group, and both XPC peer checks remain required. The flag does not install or run the resulting app. This experimental mode did not solve local registration; use desktop registration with `--bootstrap-client-only` for the verified deployment path.

An opt-in `MOTRIX_SAFARI_VERIFY_PORT` build adds a startup WebSocket probe to a literal `127.0.0.1` port and temporarily replaces the popup with a diagnostic panel. It sends only the extension root URL and a bounded bootstrap status, never pairing material. The toolbar title also exposes diagnostic progress. Use a disposable local listener, and rebuild without the variable immediately afterward. Safari's website settings confirmed `127.0.0.1` is allowed and other sites remain set to Ask. This diagnostic popup is not the product UI.

The real Safari 27 popup handshake on 2026-09-27 showed an uppercase UUID in `runtime.getURL('')`, but a lowercase UUID and no trailing slash in the WebSocket `Origin`. The client derives exactly `safari-web-extension://<lowercase UUID>` for its transcript, with a strict UUID root check. Chromium/Firefox retain their existing behavior. Build 10 subsequently completed pairing and reconnect from the nonpersistent background page using the same Origin rule.

The extension-side `BootstrapProvider` contract separates transport from connection management. `SafariBootstrap` uses `sendNativeMessage`, requires declared `nativeMessaging` permission and a 32-byte wire binding key, and accepts only protocol version 1 and fixed errors. First-pair callers supply their own retained keypair's public half. Endpoint-only discovery, including reconnect wake-up, uses a fresh disposable key when omitted, clears its private half, and discards the returned ticket. It preserves the explicit launch flag and never falls back to an unversioned start request. The provider factory selects `SafariBootstrap` for the packaged Safari extension and retains `NativeBootstrap` for Chromium/Firefox. Safari uses the same background entry as a nonpersistent module page: on the tested Safari 27 build, constructing a WebSocket in its extension service worker blocked inside WebCore’s worker channel semaphore. Download takeover is unavailable through Safari’s missing downloads API. System notifications and automatic popup opening are currently disabled in this implementation. Safari has supported action.openPopup() since version 16; its use needs scenario-specific verification rather than a blanket unsupported classification. Native system notifications are a separate adaptation described in the notification design.

Platform references: [XPC peer code-signing requirements](https://developer.apple.com/documentation/foundation/nsxpcconnection/setcodesigningrequirement(_:)), [code-signing requirement language](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html), and [App Groups IPC](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.application-groups).

The harness uses Apple's generated containing-app UI for development. Public Safari packages use Developer ID signing and notarization. Released Motrix and MDXP packages include Safari support, with strict Origin, ticket, credential, pairing, and reconnect tests.

### End-to-end acceptance

Build 10 was tested against the separately signed `.cache/safari-native/desktop/Motrix.app` with its service registered as `enabled`:

- Starting pairing in Safari woke the desktop bundle that owns the authenticated service. The desktop identified the official Safari extension; completing its one-time code produced a connected Safari session.
- After quitting Motrix, Safari's reconnect action woke the same desktop bundle and restored the connection using the saved credential, without another code. The popup loaded live task state through the encrypted connection.
- The popup's new-task form submitted the public extension repository's `LICENSE` as `motrix-safari-acceptance-20260927.txt`. Motrix displayed `Completed`, and the file in `~/Downloads` was 1,228 bytes with SHA-256 `8cedcdf8065be68ce2e7de71216bb2e48701557aa3307eda92f0bdfe64889ef3`, matching an independently fetched copy.

The initial loopback download fixture was rejected by the existing MDXP `z.httpUrl()` resource contract, which excludes IP-address URLs. That validation was preserved. The native bootstrap still uses its authenticated loopback endpoint; the download resource URL has a separate schema. Website permissions remain per-site and may be requested by Safari when a context-menu download captures cookies for its target. Automatic download takeover, system notifications, and automatic popup opening are outside this Safari implementation.

### Server acceptance

On 2026-09-27, the installed build 10 also paired with an isolated OrbStack Server built from the current Motrix `2.0.0-beta.41` and local MDXP sources. Safari completed code pairing, reused its credential after a container restart, and retained separate App/Server credentials when switching and reconnecting. Remote downloads were enabled for this test Server; request headers, cookies, and authentication forwarding stayed disabled.

The real toolbar popup submitted the public repository's `LICENSE` as `motrix-safari-server-acceptance-20260927.txt`. The popup reported one completed task, and the container's download volume contained the 1,228-byte file with SHA-256 `8cedcdf8065be68ce2e7de71216bb2e48701557aa3307eda92f0bdfe64889ef3`, matching the independent source copy. The operator and extension ports were bound only to loopback (`18080` and `16811`). This actual browser test used WS; it does not establish browser acceptance of a production WSS deployment.

The backend's trusted-WSS-proxy integration test now also exercises Safari Origin binding, unverified remote identity without a native ticket, code pairing, and encrypted MDXP submission. It passed alongside Server bootstrap and Safari identity coverage (40 tests), and backend TypeScript checking passed. A non-blocking finding remains: overlapping automatic recovery and manual reconnect briefly displayed `connection attempt superseded` as a settings save error even though the connection subsequently succeeded.

### Local protocol source build

Until a compatible MDXP package is released, prepare both local consumers before building:

```sh
node scripts/safari-local-mdxp.mjs --source ../mdxp --consumer . --consumer ../Motrix
```

The script compiles the authoritative MDXP source into a content-addressed snapshot, then copies the package, licenses, and runtime dependencies into each consumer's `node_modules`. It preserves the previous entry in a hidden sibling backup and leaves manifests, lockfiles, and package stores unchanged. A normal dependency reinstall restores the published version; rerun this explicit development step afterwards. Do not publish artifacts built with this local snapshot as a protocol release.
