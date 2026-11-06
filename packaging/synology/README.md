# Motrix for Synology DSM

Motrix downloads files and torrents directly on your NAS. This experimental native
SPK includes Node.js, Motrix Server and Web UI, aria2, and the filesystem helper.
It does not need Docker at runtime, download dependencies during installation,
or run npm on the NAS. Author: [Dr_rOot](https://github.com/agalwood).

Install the matching SPK with **Package Center → Manual Install**. This package
has **not** been published to Synology's package store. Do not describe it as a
store listing. Verify its adjacent `.sha256` file before installation.

## Supported scope

The first target is **DSM 7.2.2-72806 or later, x86_64**. It is an
**administrator-shared instance**: all authorized local DSM administrators can
manage the same tasks, settings and plugins. Ordinary, disabled, domain and LDAP
accounts are denied. There is no per-user task isolation or quota accounting.

The current build has Linux simulation and DSM userspace ABI coverage, **not
real-device acceptance**. The minimum version records the toolchain and resource
contract being tested; it is not a claim that every newer DSM release or every
x86_64 model has passed. The Gemini Lake toolchain identifies Linux 4.4.302 and
glibc 2.36. [Node 24's upstream supported Linux kernel baseline](https://github.com/nodejs/node/blob/v24.x/BUILDING.md) is newer than
DSM's 4.4 kernel: successful sysroot loading does not establish kernel or syscall
compatibility. Installation and sustained downloads on the target NAS are a
release gate.

## Use and permissions

Open Motrix from the DSM desktop while signed in as a local administrator. The
entry uses the same DSM host and port, at `/motrix/`, including HTTP, WebSocket
and static asset paths. Web Station is not required; File Station must be available for effective ACL queries. The application has no
separate password and does not collect DSM passwords. The package joins DSM’s `http` group using the official privilege mechanism.
Only the upstream socket is shared as `motrix:http`, mode `0660`, so the
unprivileged Nginx gateway can connect. Private settings and application data
remain owner-only; group membership never replaces session/account authentication.

The `motrix` package account runs the Web service, download engine, plugins and
filesystem helper. No package process is elevated to root; the SPK requests no
setuid program, Linux capability, sudo rule or privileged helper. DSM's resource
workers create the `motrix` shared folder and register the Nginx configuration.
The `http` group also provides access to DSM's existing local SCGI socket. The
adapter calls only fixed vendor routes: `login.cgi` retrieves the current
session's SynoToken, `SYNO.Core.NormalUser.get` identifies its owner, and
`SYNO.Core.User.get` queries that local account's `expired` status. Nonprivileged
`id` queries independently check UID and current membership of group 101.
File Station `List.getinfo` supplies effective ACL rights for the exact requested
path; the returned physical path must match. No API can read file contents or
mutate DSM settings through this adapter. Raw responses and credentials are
never returned in diagnostics.

Downloads are restricted to existing, mounted, canonical configured roots and
the permissions of both the account and the package user. The default root is
resolved from DSM's `/var/packages/Motrix/shares/motrix` link. An unavailable
volume is never created as a replacement directory on the system volume.

Additional roots can be explicitly listed in `var/directories.json` under the
package directory, as `{"roots":["/volume1/motrix","/volume2/Downloads"]}`.
First grant the internal system user `motrix` access in DSM's shared-folder
permissions. Motrix's existing Server folder picker only browses authorized
roots; choosing a path never grants permission. Backend checks apply again to
new tasks, resume, redownload, BT selection, existing output writes and removal.
Local browser `.torrent` uploads are supported. DSM `.torrent` associations and
File Station open/reveal actions are not registered: no stable, tested public
contract has been established for this integration. These actions remain
unavailable rather than invoking fnOS APIs or accepting arbitrary file paths.

Directory grants and account/ACL state are refreshed on admission. Removal uses
the existing descriptor-relative filesystem helper, file identity checks and
persistent removal recovery journal. Revoking a grant does not instantly cancel
an engine file that is already open; stop the package before withdrawing a
background download grant. Device tests must cover DSM ACL inheritance, mount
replacement, offline storage and interrupted finalization.

## Pair clients

The installation wizard selects the CLI/Extension port (default **16802**).
Browser extensions are disabled when their WS/WSS address is empty. To enable
them, set the reachable client WS/WSS address and complete Motrix Web URL,
including `/motrix/`. Displaying codes over HTTP requires explicitly enabling
the trusted-network option. The configured origin and actual browser origin
must agree. An HTTPS address never authorizes displaying a code on an HTTP page.
These options persist in `var/package-settings.json`; stop the package before
editing them, then start it again. Invalid optional Extension configuration
closes that entry without opening an unauthenticated fallback.

The existing CLI device-code protocol and Extension MBP1 protocol are unchanged.
The pairing UI shows the current account and **Pair with current account**.
Next, enter the code in the browser extension. The server checks the page's
expected account against the current trusted account. Shared notifications
contain no pairing code; only the claimant receives it.

Client credentials bind to a local account ID and an account-database generation.
Every client request rechecks authoritative account state. Disable, expiration,
demotion, missing records or an authority failure deny access. Any change to the
root-owned local passwd/group database conservatively invalidates all existing
bindings, including after UID reuse; pair again. Explicit credential revocation
continues to use the existing protocol. DSM session cookies are neither saved in
pairing state nor used as CLI credentials. At most 64 session contexts are kept
in memory for 30 minutes after the last authenticated Web request; every client
operation revalidates the actual DSM session and account. A DSM logout, expired
context or Motrix restart requires the corresponding administrator to reopen
Motrix. Paired credentials and tasks survive an upgrade, but no client is allowed
to act until its account has supplied a fresh verified session. Web event tickets are one-use,
origin-bound and short-lived; connections reauthenticate at least every minute.

If the account cannot be verified, the page shows a bounded diagnostic such as
`account / rejected` or `account / commandFailed / accessDenied`.
The same metadata is available at `/motrix/rpc/auth/status` in the signed-in
browser. It contains no Cookie, token, account name or raw command output.
Session and account checks still fail closed; a diagnostic is not an authorization
fallback. The proxy forwards the CGI scheme and port, while the backend supplies
the bounded host/user-agent context to DSM’s authentication program.

## Lifecycle and retained data

Package lifecycle scripts run as the package user and serialize with `flock`.
PID records include process birth time, boot identity and executable/entrypoint
checks. Stop waits for orderly shutdown and retains the record on timeout.
Upgrade stops the old process before replacement and preserves the DSM FHS
`var` directory: task database, configuration, plugins, pairing bindings and
removal recovery state. Downloads remain in the shared folder.

Uninstall defaults to keeping application data. The explicit **Delete tasks,
settings and paired clients** option deletes only package-owned state after a
successful stop. Downloaded files are always retained. Reinstalling with retained
data restores the same shared instance, subject to current account and directory
permissions. DSM itself owns lifecycle ordering and resource cleanup; real
install, repair, upgrade and uninstall acceptance remains required.

## Build and verification

Use Node 24.18.0, the repository's pinned pnpm and Rust versions, Python 3.12+
(or Python 3.11 with tar extraction filters), and Docker for isolated acceptance.
On a Linux x86_64 builder with the `x86_64-unknown-linux-musl` Rust target:

```sh
MOTRIX_SKIP_ELECTRON_REBUILD=1 MOTRIX_SKIP_ENGINE_FETCH=1 pnpm install --frozen-lockfile
pnpm run fetch:engine -- --platform linux --arch x64
pnpm run build:server
pnpm run stage:server -- --platform linux --arch x64 --libc gnu --strict
pnpm run build:synology -- --output-dir release/synology/project --revision 1
pnpm run verify:synology -- --spk release/synology/Motrix-2.3.0-1-dsm-x64.spk
```

Use a fresh output directory for every build. A higher numeric revision creates
an upgradeable SPK while retaining the application version. Cross-building on
macOS additionally requires building the Linux helper from the locked Rust
source; do not substitute a host binary. The build reuses Server staging,
external-module pruning, engine integrity checks, signed builtin verification
and license generation. Node's archive is pinned by the existing NAS runtime
lock. No Electron, npm, source compiler or toolchain is installed on the NAS.

The SPK builder unpacks the actual outer archive and nested `package.tgz`, rejects
traversal/links/duplicate names/macOS metadata, verifies payload hashes and
executable modes, then reruns Server package verification. It checks every ELF's
architecture, dynamic dependencies and symbol versions against the checksum-pinned
Synology Gemini Lake sysroot. It also loads bundled Node and SQLite through the
DSM loader and exercises SQLite read/write. aria2 and the filesystem helper are
static. The SDK is a build input and is not redistributed inside the SPK.

The build runs ordinary Server smoke and DSM lifecycle simulation against the
**extracted SPK bytes**. A simulated DSM SCGI API exists only inside
a disposable container. It validates integration behavior, not the availability,
output format or permissions of DSM's real API. The package receipt records the source commit and whether the source tree was
dirty. Keep `.abi.json` and test
logs with the SPK and its SHA-256. Do not publish a release or claim device
compatibility based on those reports alone.

## Implementation evidence and limits

Sources reviewed for DSM 7.2.2 and DSM 7.4.1 on 2026-11-06:

| Area | Basis and implementation boundary |
| --- | --- |
| Package layout and metadata | [SPK layout](https://help.synology.com/developer-guide/synology_package/introduction.html), [INFO](https://help.synology.com/developer-guide/synology_package/INFO.html), and [localized fields](https://help.synology.com/developer-guide/synology_package/INFO_optional_fields.html). English fallback plus `chs`/`cht` descriptions and wizard files. |
| Least privilege | [Privilege configuration](https://help.synology.com/developer-guide/privilege/privilege_config.html) and the [official web-package group example](https://help.synology.com/developer-guide/examples/compile_web_package.html). Use `run-as: package` and `join-groupname: http`; root packages require additional Synology authorization. |
| Storage and lifecycle | [DSM FHS](https://help.synology.com/developer-guide/integrate_dsm/fhs.html), [data-share](https://help.synology.com/developer-guide/resource_acquisition/data_share.html), and [wizard contracts](https://help.synology.com/developer-guide/synology_package/wizard/WIZARD_UIFILES_v2.html). FHS data survives upgrades; the resource worker does not delete the download share. |
| Desktop and proxy | [Desktop config](https://help.synology.com/developer-guide/integrate_dsm/config.html), [web-config](https://help.synology.com/developer-guide/resource_acquisition/web_config.html), and [Web Station alternative](https://help.synology.com/developer-guide/resource_acquisition/web_service.html). Use DSM's Nginx worker with a Unix upstream and explicit WebSocket forwarding. No fnOS identity Header. |
| Session identity | [Application authentication](https://help.synology.com/developer-guide/integrate_dsm/web_authentication.html) establishes the cookie/CGI context. Direct `authenticate.cgi` execution and the privileged r4 broker are not used. The `login.cgi` bootstrap and `SYNO.Core.NormalUser.get` read calls were verified with a real DSM 7.4.1 browser session. The local SCGI transport remains version-sensitive and must be tested on each DSM release. |
| Account/ACL status | `SYNO.Core.User.get` with only `additional=["expired"]` was verified on DSM 7.4.1; requesting `groups` additionally returns error 3106. Local UID and administrator membership use nonprivileged `id`. The [official File Station API](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Package/FileStation/All/enu/Synology_File_Station_API_Guide.pdf) documents `List.getinfo` and effective ACL fields; browser requests were verified against two explicitly authorized shares. Those API checks do not establish complete SPK/device acceptance. |
| Architecture | [Official architecture mapping](https://help.synology.com/developer-guide/appendix/platarchs.html) and [model/CPU list](https://kb.synology.com/en-global/DSM/tutorial/What_kind_of_CPU_does_my_NAS_have). DS920+/DS220+ are Gemini Lake; DS220j is RTD1296 (ARMv8), not x86_64. |
| Toolchain | [Official toolchain selection](https://help.synology.com/developer-guide/compile_applications/download_dsm_tool_chain.html), [environment preparation](https://help.synology.com/developer-guide/getting_started/prepare_environment.html), and [spksrc Gemini Lake inputs](https://github.com/SynoCommunity/spksrc/tree/master/toolchain/syno-geminilake-7.2). The exact archive SHA-256 is recorded in `scripts/synology-runtime.lock.json`. |
| Mature packaging reference | [SynoCommunity/spksrc](https://github.com/SynoCommunity/spksrc) and its [Transmission lifecycle](https://github.com/SynoCommunity/spksrc/blob/master/spk/transmission/src/service-setup.sh) informed FHS persistence and isolated package-user execution. No install-time dependency fetching is copied. |

ARM64 is technically plausible: spksrc's [RTD1296 7.2 toolchain](https://github.com/SynoCommunity/spksrc/blob/master/toolchain/syno-rtd1296-7.2/Makefile)
uses GCC 12.2/glibc 2.36 and an AArch64 target. It still needs a separately pinned
sysroot, ELF/SQLite/Node tests, instruction-set checks and real ARM hardware.
ARMv7 needs separate runtime/native module support absent from the current Server
staging matrix. This builder intentionally emits only x86_64; no ARM package or
ARM acceptance is claimed.
