# taiji engine and migration

English | [简体中文](./taiji-engine.zh-CN.md)

Desktop and Server use the same bundled taiji engine. The app does not fall back
to aria2 or a system download engine. The engine RPC uses the `taiji.*` namespace;
browser extensions and the Motrix CLI continue to use MDXP.

## Upgrading an existing profile

Back up the profile and download directories, and close the previous Motrix
instance before starting this version. Motrix imports the old `aria2.db` into a
separate `taiji.sqlite3` before starting the new engine. A previously configured
legacy database path is still used as the import source. The source database is
opened read-only; task GIDs, pause intent, output mappings and supported HTTP
request state are retained. Motrix task history remains in `motrix.db`.

Partial HTTP files with a usable checkpoint are adopted under taiji’s `.part`
name. Their bytes are retained. Keep the download backup as well as the old
profile if you need to return to the previous engine.

At startup, taiji holds restored download, verification and seeding queues.
Motrix removes already completed ownership, keeps quarantined tasks paused and
checks Server directory permissions before releasing eligible tasks. Tasks that
were paused remain paused. An interrupted migration can be retried; its receipt
is written only after the import succeeds. A changed source database, unknown
schema, conflicting identity, missing credentials or conflicting partial-file
paths stops migration instead of overwriting existing work.

The new engine owns its SQLite persistence. The old database-enable, database-path
and engine-history-limit controls are no longer editable. Progress checkpoint
interval and RPC settings remain available. An empty legacy RPC secret is replaced
with a generated secret because taiji requires authentication for write operations.
Peer connections and DHT share the listen port. Disk allocation and cache are managed
by taiji; the old allocation and cache controls are no longer shown.

A migration receipt without its taiji database stops startup; restore the database
backup before starting again.

The automatic engine migration reads `aria2.db` schemas 1–6. It does not activate
Motrix 1.x `.aria2` control-file imports: those remain quarantined. SFTP is not
supported by this taiji build; unsupported operations fail without engine fallback.

## Magnet connectivity

Fetching uses TCP and uTP, accepts incoming metadata connections, and supports
PEX and BEP55 `ut_holepunch` before the torrent metadata is available. Preferred
transports get a short head start before the fallback is tried; strict TCP/uTP
policies remain strict. PEX capability hints can trigger an early rendezvous. A peer
that supports introductions can stay connected even when it cannot serve
metadata. When needed, Motrix switches its introducer connection from TCP to
uTP before requesting rendezvous.

Magnet tasks share a session listener and warm IPv4/IPv6 DHT routing state.
Metadata blocks are assembled across peers with a bounded request window,
selective retries and progress-based timeouts. A slow or disconnected peer does
not discard other peers' progress. Verified metadata is cached in memory for the
session (up to 128 entries and 16 MiB); cache reuse applies the new magnet's tracker
list. Explicit HTTP(S) `xs`, `fl` and `as` sources race peer discovery and must pass
identity and required v2 layer checks. No public metadata cache is enabled implicitly.

Metadata-only tasks have four independent admission slots, so a full payload
queue does not prevent file selection. Pause intent and startup holds still apply.
Metadata-only, save/load-metadata, follow-torrent and pause-after-metadata options
are persisted at admission and restored after restart.

Desktop and Server map each actual peer listener through the shared NAT manager.
Gateway grants are returned to taiji so tracker, DHT and peer announcements use
the corresponding external ports. Mapping updates follow socket generations.
Additional listener leases are removed when those listeners stop; Desktop’s shared
primary lease remains owned by its NAT service. The shared metadata listener
stays available for the session, including between individual fetches. NAT traversal still requires reachable
peers or a suitable introducer; it cannot recover an unavailable torrent.

The reproducible NAT test uses Linux network namespaces, two SNAT routers,
libtorrent peers and miniupnpd. With Docker available, run:

```sh
node tests/nat/run.mjs

# Add the latency/fault matrix; a baseline is an optional Linux binary of
# the same architecture, supplied read-only to the test container.
node tests/nat/run.mjs --performance --samples 5 --baseline /path/to/previous/taiji
```

The command builds the locked engine source in an isolated privileged container,
runs enabled/disabled comparisons, checks metadata identity and verifies a
conflicting external port grant, renewal and cleanup. Container privileges are
used for its network namespaces and firewall; host routing is unchanged. Evidence
and packet captures are saved under `output/taiji-nat-lab/`. This covers the tested
SNAT topology, not every router or symmetric-NAT configuration.

## Editing download sources

The task inspector’s Overview tab lets you edit HTTP/FTP sources and BitTorrent
Web Seeds. Enter one URL per line. HTTP/FTP tasks need at least one source serving
the same file; clearing a torrent’s Web Seeds leaves peer downloads enabled.
Changes keep the task identity and reconnect an active transfer. HTTP checkpoints
are reused only after the engine verifies the resource and output identity.

The edited list survives restart and task recovery. A cleared Web Seed list stays
empty when a torrent is re-added; its original metadata and infohash do not change.
Magnet `ws=` sources carry into the torrent after metadata resolves. Editing is
available after metadata has resolved and while the task is queued, paused,
downloading or seeding. Imported quarantined tasks and completed history are
read-only. If another client changes the list, reload it before applying again.
Desktop and Server use the same behavior; Server requires permission to write the
task’s download directory.

Tracker editing preserves the torrent’s original announce tiers, manual additions
and excluded supplements. Magnet file selection installs the approved supplemental
trackers before payload downloading starts.

## Renaming torrent files

In a torrent task’s Files tab, choose Rename file beside a payload file. Rename
is available for queued, paused, downloading and seeding tasks. Active transfers
briefly reconnect; their task identity, torrent metadata and downloaded pieces
are preserved. Padding entries and tasks awaiting file selection are not editable.
Completed history is read-only; start seeding again to rename its files.

Enter a filename without a folder path. The engine refuses occupied destinations.
Motrix shows success after the engine confirms the new file path. The names survive
restart, retry and reseeding, including recovery after an interrupted app response.
The same controls work in Server, subject to its operator and directory permissions.
Use the existing storage controls to move a torrent’s whole output folder.

Motrix uses task-owned tracker defaults and disables taiji’s global tracker hot
updates with `bt-tracker-apply-existing=false`. The engine’s private-torrent
exemption remains active.

## Building from source

Install the Node.js and pnpm versions required by the project, Git, Rust 1.94.1 or
later, and the target Rust standard library. Linux builds require `musl-tools`
for the C dependencies. Standard development and packaging commands build the
pinned engine through `pnpm run fetch:engine`.

```sh
# Fetch the pinned upstream commit and build release.
pnpm run fetch:engine

# Use an existing local taiji checkout as the source of the pinned commit.
node scripts/build-taiji.mjs --source /path/to/taiji

# Debug binary for local engine tests; packaging requires a release receipt.
node scripts/build-taiji.mjs --source /path/to/taiji --debug
pnpm exec vitest run src/core/engine/taiji
```

The build never changes the supplied checkout. It creates an isolated source
cache and verifies the upstream commit and Cargo lock. Motrix builds taiji's
canonical source directly, without a downstream patch. `scripts/taiji-source.lock.json`
pins that source; `scripts/engine.lock.json` defines the ordinary SemVer engine
version and target matrix. Both repositories maintain the same fixed RPC contract.

The output directory is `extra/<platform>/<arch>/`. It contains `taiji`
(`taiji.exe` on Windows), `taiji-build.json` and `taiji-licenses.txt`. Package
verification checks the source identity, release profile, native architecture,
binary digest and license digest. Server uses `MOTRIX_TAIJI_BIN` for an explicit
engine location; the selected binary must implement the pinned Motrix contract.

The Server artifact budget is 64 MiB, including the source-built engine and its
licenses (the local macOS arm64 stage measures about 55.9 MiB). Dependency and
native-library budgets remain independently enforced.
