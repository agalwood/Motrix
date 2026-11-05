# Native fnOS package

This package runs Motrix Server under the dedicated `motrix` package account.
It includes a checksum-pinned Node 24 runtime, the existing verified GNU/Linux
Server distribution, aria2 and the native filesystem helper. Installation does
not download dependencies or run npm. Docker is not a runtime dependency.
Root-owned lifecycle scripts prepare a pinned runtime for a local account-state
helper; the Web server and download engine still run as `motrix`. The helper
has no TCP listener and does not return password material.

The first integration is an **administrator-shared instance**. Every fnOS
administrator can manage every task and application setting. Ordinary users are
rejected by the backend, including direct API and WebSocket requests. This is
not a multiuser task-isolation implementation.

## Build

Use a matching Linux x64 or ARM64 build host, Node 24, the repository's pnpm
version, Rust and the corresponding musl Rust target. The filesystem helper is
static; the Server's SQLite prebuild and bundled Node use GNU libc.
Lifecycle acceptance creates disposable accounts, so build either as root in
a disposable Linux container or on a Linux host with Docker available. The
build command automatically isolates these checks in a container on ordinary
hosts. Never run the lifecycle smoke directly on a live NAS.

```sh
MOTRIX_SKIP_ELECTRON_REBUILD=1 MOTRIX_SKIP_ENGINE_FETCH=1 pnpm install --frozen-lockfile
pnpm run fetch:engine -- --platform linux --arch arm64
MOTRIX_FNOS_BUILD=1 pnpm run build:server
pnpm run stage:server -- --platform linux --arch arm64 --libc gnu --strict
pnpm run build:fnos -- --arch arm64
```

Replace `arm64` with `x64` for an x86 fnOS device. The fnOS platform labels are
`arm` and `x86`, respectively. Each package includes only its own architecture.
The version must match the current stable `package.json` version.
For a packaging-only update, pass `--revision 1` (then `2`, `3`, and so on)
to `build:fnos` or `prepare:fnos`. Motrix `2.2.0` with revision `1` produces
FPK version `2.2.0.1`; the bundled Server remains `2.2.0`. The package receipt,
manifest and artifact filename are verified against this revision. Revision
`0` (the default) keeps the original three-part version. Use a larger package
version for an in-place update: fnOS rejects reinstalling the same version.
Uninstalling instead may clear system directory grants even when task data is
retained; reselect those directories before resuming downloads.
The fnOS flag includes the platform SDK only in this Web build. Shared NAS
controls and translations have a bounded Web bundle allowance; startup size
ceilings remain unchanged for Server and Electron builds.

`build:fnos` prepares a new project, validates it, runs both Server and fnOS
lifecycle smoke checks with the **bundled** Node, invokes pinned fnpack, unpacks
the resulting FPK and validates its contents again. Results and SHA-256 files
are written under `release/fnos/`. Choose a fresh `--output-dir` for a repeat
build; preparation never silently removes an existing output directory.

`prepare:fnos` and `verify:fnos` can inspect cross-architecture payloads without
executing them. They are not substitutes for the native build's smoke checks.
The `fnOS native FPK` workflow builds both architectures for pull-request
validation and uploads test artifacts. Stable packages are distributed separately
by `Publish fnOS FPK` after a successful protected-tag `Build/Release` run.
The publication workflow builds the exact released commit on matching Linux
hardware, verifies both packages and their SHA-256 files, and adds the complete
set to the existing GitHub Release. It never overwrites a different existing
asset. This distribution does not submit packages to the fnOS app store.

For direct installation, download `Motrix-<version>-fnos-x64.fpk` for an x86 NAS
or `Motrix-<version>-fnos-arm64.fpk` for an ARM64 NAS, together with its `.sha256`
file, from the matching stable GitHub Release. Check the file before installing:

```sh
sha256sum -c Motrix-<version>-fnos-x64.fpk.sha256
```

The first native 2.3.0 packages are supplemented from the original `v2.3.0`
commit; the application tag and the other release assets remain unchanged.

The locks use official Node SHASUMS256 and observed fnpack binary hashes. At
implementation time the official fnpack page linked 1.2.3 binaries returning
404, while the official 1.2.1 downloads were available; the latter are pinned.

## Runtime integration

- Minimum **API contract**: fnOS 1.2.0401 / mobile app 1.34.0. Actual minimum
  device compatibility still requires fnOS installation testing.
- Entry: `/app/motrix/`, HTTP/RPC/static assets/uploads/WebSocket on
  `${TRIM_APPDEST}/app.sock`. The normal Web TCP listener stays closed. The
  authenticated MDXP CLI listener defaults to port 16802 (configurable in the
  fnOS application wizard), separately from the gateway and Docker default;
  NAS browser cookies are not
  client credentials. A client-port conflict cannot block the gateway Web UI.
  Use the client-pairing setting to disable that listener when it is not needed.
- CLI pairing: approve a request from the fnOS administrator Web UI. Credentials
  bind to that administrator and an opaque account generation. Requests and
  event streams revalidate local account records; account locks/demotion, generation changes
  or lookup failures deny further access. The machine-local bridge token is
  not accepted as a NAS identity.
- Browser Extension pairing is opt-in under fnOS **Application settings**.
  Set the reachable WS/WSS client address and the complete Motrix Web address
  (including `/app/motrix/`), then restart the application. HTTP code delivery
  requires explicit consent for a trusted network. The browser origin must
  match the configured Web address; choosing an HTTPS URL does not enable
  code delivery on an HTTP page. Invalid Extension settings close its routes
  while the gateway UI and CLI continue to work.
  The shared inbox contains no code: an administrator must explicitly claim
  the request. Only that administrator can retrieve the code, and the client
  must still prove it through MBP1. Credentials bind to that account and are
  revalidated on reconnect and during both directions of message delivery.
- Account authority: only the package group can connect to its root-owned
  socket under `/run/motrix-account-authority`. The persistent generation key
  lives in the root-only `${TRIM_PKGVAR}/.nas-account-authority` directory.
  The launcher copies a bounded Node snapshot into the root-owned
  `cmd/.authority-runtime` metadata directory, checks the checksum pinned in
  root-owned metadata, and clears the privileged process's environment. This
  keeps executables off fnOS's `noexec` `/run` mount. It never executes package-writable JavaScript as root.
- Authentication: gateway-provided administrator identity is accepted only on
  the configured Unix listener. The socket is mode `0600`, accessible to the
  package account and root. Verify that the device's gateway can access it;
  do not work around a failed installation by making it world-writable.
- Event connections are renewed every minute through the gateway to bound
  stale authentication. Browser foreground checks also refresh the session.
  The gateway can rewrite `Host` without its external port. HTTP mutations
  therefore require a non-safelisted browser-origin marker, with matching
  `Origin` when present; this listener never enables cross-origin preflights.
  Events use a one-use ticket issued through authenticated HTTP and bound to
  that exact browser origin. Tickets expire after 30 seconds and travel in a
  WebSocket subprotocol, never a URL. This also supports gateway versions that
  omit identity headers during WebSocket upgrades. Explicit non-admin or
  conflicting upgrade identities are still rejected.
- Private state: `${TRIM_PKGVAR}/motrix`. Download files: the declared
  `motrix/downloads` share, plus directories explicitly granted through fnOS
  shared authorization. Empty or failed grant queries never become unrestricted
  access. An unavailable share is not recreated on an unmounted volume.
- Additional download directories use the official fnOS picker. The backend
  independently queries grants, resolves paths and checks the current user's
  ACL before accepting the result. Standalone authorization uses a same-origin
  callback with exact popup, method, application and state checks.
- `.torrent` associations open an editable Add Task draft. The source must
  already be inside an authorized shared directory and readable by the user.
  A file association never implicitly grants its parent directory. Local
  browser torrent uploads remain available for other sources.
- File actions obtain the published task path from the backend, check scope
  and read permission, then invoke the fnOS file or file-manager action.
- System theme/language preferences follow the fnOS host. Explicit Motrix
  preferences remain explicit. Mobile/standalone sessions refresh on focus;
  only embedded Web hosts subscribe to SDK theme/language events.

The backend reads `TRIM_API_TOKEN` from the running environment on every API
call. It is not written to package receipts, settings or browser responses.
`MOTRIX_FNOS_API_SOCKET` is a test/integration override; an installed FPK uses
the platform's `/var/run/trim_open_gateway_apiscope.socket` by default.

## Lifecycle and validation boundary

Lifecycle callbacks serialize operations with `flock`. Process records include
the PID, Linux process birth time and boot identity; executable and command
identity are checked before sending a signal. Stop waits for orderly Server
shutdown and reports a timeout without discarding the process record. Upgrade
and uninstall stop the service first. Scripts never remove download shares or
private task data; fnOS owns its uninstall data-retention choice.

Before starting a stopped service, the privileged launcher restores ownership
of the application payload and its private state after fnOS installs them as
root. The walk does not follow symlinks or include download shares, account
authority keys or backup directories. The application retains its existing
supplementary groups, including the group required to call fnOS's API socket.
Repeated starts do not walk a running application's state.

The Linux lifecycle smoke uses a **simulated fnOS file API** and real disposable
Linux account records. It checks service UID separation, CLI pairing and account
revocation, downloads and denied filesystem operations, start/status/stop/restart,
persistence, gateway authentication, stale PID handling, helper crash recovery
and rejection of tampered privileged code/runtime. It does not establish real
NAS account-disable semantics or device compatibility. Before a
release, test installation, gateway socket permissions, system pickers,
mobile/FN Connect, downloads during stop/upgrade, missing storage, ownership
and ACL inheritance on real x86 and ARM fnOS devices.

User isolation, per-user quota accounting
and continuously revocable authorization throughout background download and
finalization are outside this first administrator integration. Revoking a grant
blocks subsequent path validation; it does not promise immediate cancellation
of an already-open engine file. Stop the service before removing a download
grant until that background authorization lifecycle is implemented.

## References

- [Official native application example](https://developer.fnnas.com/docs/examples/native/)
- [Gateway and identity contract](https://developer.fnnas.com/docs/core-concepts/gateway-registration/)
- [Environment variables](https://developer.fnnas.com/docs/core-concepts/environment-variables/)
- [Shared authorization](https://developer.fnnas.com/api/authorization/shared-access/)
- [File ACL](https://developer.fnnas.com/api/authorization/file-acl/)
- [SDK and API calls](https://developer.fnnas.com/api/calling/)
- [LangBot packaging reference](https://github.com/langbot-app/LangBot/tree/46231488175fb8a27f8413a503437312deb68478/packaging/fnos): compared package-user execution,
  persistent paths and process-group lifecycle. Motrix's implementation reuses
  its own staging/integrity checks and does not copy runtime patching or
  install-time dependency downloads from that example.
