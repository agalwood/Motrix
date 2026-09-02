# Plugin Hook Runtime Specification

Status: normative for Motrix 2.x plugin Hook execution. Independent design
review passed on 2026-08-31.

This document defines how Motrix discovers, activates, schedules, validates,
commits, recovers, and observes plugin Hooks. The same rules apply to the
Electron and Server hosts.

## 1. Problem statement

Motrix exposes four task lifecycle Hooks: `beforeCreate`, `beforeFinalize`,
`afterComplete`, and `onError`. A reliable implementation has to cross several
boundaries at once: an installed manifest, an inactive or recycled QuickJS
worker, the SDK object seen by guest code, host capabilities, the task and
SQLite lifecycles, and two independently assembled application shells.

Loading a bundle or observing a registration event does not prove that a Hook
works. A conforming runtime must execute the built plugin bundle through the
real `PluginHost` and QuickJS worker, transfer the complete validated context,
apply its effects at the correct commit point, and recover safely after either
the plugin or the host process stops.

This specification closes the following failure classes:

- permissions matched against raw URL text rather than URL structure;
- Hooks silently missed because their plugin was inactive at dispatch time;
- one plugin VM receiving overlapping task contexts;
- SDK methods existing in types but not in the worker object;
- partial or unvalidated Hook DTOs crossing the worker boundary;
- replacement output being overwritten by the original download;
- file, metadata, and task state diverging across a failed finalize;
- post-Hooks being lost, duplicated without an identity, or blocking peers;
- Electron and Server constructing different runtimes.

## 2. Non-goals

- This document does not add new manifest Hook names or role bands.
- It does not grant a capability that is absent from the plugin's effective
  permissions.
- It does not make arbitrary external side effects exactly-once. That is not
  possible across a guest, a remote service, and SQLite without a shared
  transaction. Motrix provides at-least-once delivery and a stable delivery ID;
  plugins must use that ID when an external operation needs deduplication.
- It does not allow a plugin to finalize outside the task save directory or to
  overwrite an unrelated existing path.
- It does not make community plugins trusted. Signature, install consent,
  optional grants, and reserved-role policy remain separate gates.
- It does not change the pinned builtin supply chain. Builtins continue to be
  consumed as signed, hash-locked `.moext` releases.

## 3. Terms

**Candidate**: an enabled installed plugin whose manifest declares the Hook and
whose activation and host-permission predicates match the event.

**Active plugin**: a candidate with a ready QuickJS worker and registered guest
entry points.

**Invocation**: one Hook call identified by a unique `invocationId` from host
admission until the worker exits the Hook.

**Plugin lane**: the FIFO serialization boundary for all host-initiated guest
entries in one plugin VM.

**Working context**: the validated DTO plus accepted effects from earlier
plugins in a serial Hook chain.

**Hook effects**: context patches and metadata operations returned by one
invocation. Effects are data; they are not committed by the worker.

**HookPlan**: the immutable result of a successful `beforeFinalize` chain. It
names the current source artifact, final target, optional replacement artifact,
metadata effects, and attribution.

**Finalize journal**: a durable row recording a HookPlan and the filesystem
phase reached while committing it.

**Occurrence**: the existing durable terminal task event written with the task
transition.

**Post delivery**: a durable `(occurrence, hook, plugin version)` delivery of an
`afterComplete` or `onError` invocation.

**Permission generation**: a monotonically increasing registry value for a
plugin's enabled state, grants, quarantine state, and executable identity. A
guest entry and every capability lease are bound to one generation.

## 4. Architecture boundaries

The host-neutral runtime lives under `src/core/`. It owns candidate discovery,
structured permission matching, per-plugin lanes, DTO validation, Hook
orchestration, finalize plans and recovery, and post-delivery scheduling. It
may depend on shared schemas and injected filesystem/database adapters, but not
on Electron, renderer, or Server modules.

`src/shared/` owns pure Zod schemas and inferred types for wire-visible Hook
DTOs and worker messages. It contains no I/O, timers, or host imports.

`src/main/` and `src/server/` construct the same core runtime factory. Each
shell supplies paths, logging, its capability host, task lookup/persistence,
filesystem operations, and shutdown coordination. A shell must not construct a
second orchestrator inside command handlers.

The QuickJS worker evaluates guest code and exposes the SDK surface. It does
not decide eligibility, permissions, commit order, or recovery. The capability
bridge validates every worker message and binds it to the current invocation.

## 5. State machines and ordering

### 5.1 Plugin lifecycle

```text
Inactive -> Activating -> Active -> Quiescing -> Inactive
                |           |
                +-> Faulted +-> Faulted
```

- Candidate discovery is independent of the active set.
- Admitting a Hook candidate activates it immediately when necessary.
- Concurrent activation requests for one plugin coalesce.
- `Active` is published only after the worker is ready and every declared Hook
  used by the runtime is registered.
- Idle disposal is allowed only when the plugin lane has no running or queued
  guest entry and no owned capability operation is still in flight.
- A recycled plugin can be activated again for finalization or post delivery;
  inactivity never means ineligibility.
- A crash fails only the current plugin invocation, tears down that worker, and
  permits a clean worker to be created for a later retry.

### 5.2 Serial pre-Hook chain

```text
validate input -> discover candidates -> sort by role/id
  -> for each candidate: activate -> enter plugin lane -> invoke -> validate effects
  -> merge into working context -> build result/HookPlan
```

The order is role band, then lexical plugin ID. A later plugin sees the accepted
working context produced by earlier plugins. It never sees another task's
context or an uncommitted effect from a failed plugin.

`pre-resolve`, `resolve`, and `post-process` failures abort the chain.
`enrich` and `audit` failures are isolated and the chain continues. An `audit`
plugin cannot produce mutating effects.

### 5.3 Terminal task and post-Hook sequence

```text
snapshot candidates
  -> terminal task + occurrence + post-delivery rows commit
  -> per-plugin lanes deliver eligible rows
  -> success receipt or retry/dead-letter state
```

Candidate materialization is part of the terminal SQLite transaction; Hook
invocation is asynchronous. The occurrence consumer only schedules already
materialized rows and is never held open by a failing plugin.

## 6. Candidate discovery and immediate activation

Candidate discovery reads the current `PluginRegistry`, not `PluginHost`'s
active map. A plugin is a candidate only when all of these are true:

1. it is installed, compatible, enabled, and not quarantined;
2. `contributes.hooks` declares the requested Hook;
3. its effective activation set matches the task type or URL protocol, with
   declared command events handled separately;
4. its manifest Hook role is valid for its trust/category policy;
5. for an HTTP `beforeCreate` resolver, at least one structured
   `hostPermissions` pattern matches the source URL used to select it;
6. required capabilities remain in the plugin's effective permission set.

`beforeFinalize`, `afterComplete`, and `onError` are selected by Hook
declaration, task-type activation, role, and capability grants. Their task
source may be FTP, magnet, or another non-HTTP identifier and is never filtered
through HTTP host patterns. Any HTTP capability call they make is still checked
per request.

The Hook contribution is an implicit demand-activation source. A candidate
that was disposed after `beforeCreate` is activated again for
`beforeFinalize`. Post delivery also activates its recorded candidate before
invocation. Activation failure is classified as that plugin's Hook failure; it
does not make the candidate disappear.

Candidate executable identity is `(pluginId, version, executable digest)`.
Candidate and delivery snapshots separately record `createdGeneration` and the
complete effective permission set at creation; that generation is audit data,
not a future execution lease. Upgrade, enable/disable, quarantine, uninstall,
or grant change
enters an exclusive policy barrier: new guest and capability admission closes,
the generation advances, owned operations are aborted, the lane drains or the
worker is terminated after budget, and only then may the new state activate.
Every capability call either acquires a live generation lease or presents the
current generation; stale live leases fail closed. A post-delivery attempt runs
with `createdEffectivePermissions intersect currentEffectivePermissions`, so a
later grant can never expand a historical delivery's authority.

## 7. Structured host-permission matching

Host permissions are parsed once into structured matchers. Matching never runs
a regular expression against the whole raw URL.

A supported manifest pattern has these components:

```text
scheme://host/path-glob
```

- `scheme` is `http`, `https`, or `*`; `*` means HTTP and HTTPS only.
- `host` is `*`, an exact canonical DNS/IP host, or `*.example.test`.
  A subdomain wildcard matches the suffix host and its subdomains only.
- Manifest v1 patterns have no port component. A matching scheme/host pattern
  matches any valid explicit or default port, preserving released-plugin and
  browser match-pattern semantics. A future port restriction requires a new
  manifest schema version.
- A bracketed IPv6 literal is an exact host; wildcards are forbidden inside it.
- `path-glob` is matched against WHATWG-serialized `pathname + search` after
  uppercasing percent-escape hex digits. It is not percent-decoded, so encoded
  separators cannot become path separators. `*` is the only wildcard and
  cannot alter scheme or host matching.
- `<all_urls>` is equivalent to `*://*/*` and still means HTTP/HTTPS only.

URLs are parsed with the platform URL parser. The matcher lowercases and
IDNA-normalizes DNS names, removes a single trailing DNS dot, normalizes
default ports, rejects embedded credentials, and ignores fragments. Invalid
patterns or URLs fail closed. Exact host matching uses component equality;
`allowed.example.evil` and `evil.example/path/allowed.example` cannot match
`allowed.example`.

The same matcher and conformance corpus are used for `beforeCreate` resolver
eligibility, immediate activation, the initial guest HTTP request, and every
redirect hop. Tests cover host-vs-path confusion, suffix confusion,
credentials, arbitrary/default ports, IPv4/bracketed IPv6, IDNA, percent
encoding, query matching, and redirects.

Host permissions authorize network requests made by the plugin. They do not
authorize or reject a URL returned to the download engine, and they do not
filter non-HTTP lifecycle Hooks. A Hook-produced download URL passes the
independent output policy in section 9.4.

Guest HTTP uses only the Host-managed proxy route. A guest-supplied per-request
proxy is rejected even if it is syntactically valid; target host permission is
not proxy-endpoint permission. Adding guest-selected proxies requires a future
explicit capability, structured endpoint allowlist, credential policy, and
CONNECT/redirect threat review.

Host permissions constrain declared reach; they are not a DNS pinning system.
A broad wildcard is broad authority and must remain visible in consent UI.

## 8. Per-plugin scheduling and context isolation

Every plugin has one FIFO lane shared by Hook calls, command calls, lifecycle
callbacks, and deactivation. Capability responses complete inside the admitted
entry but do not open another guest entry.

Each entry propagates an immutable call-chain ID. Re-entry into a plugin already
present in that chain, including self-command calls and `A -> B -> A`, is
rejected before enqueue with `plugin.runtime.reentrant_call`; it is never left
to deadlock behind the current lane owner. Aborting an outer entry cancels its
queued descendants and invocation-owned capability operations. Forced worker
termination rejects every remaining entry in that chain.

Each worker message produced during a Hook includes `invocationId`. The bridge
accepts an invocation-scoped capability call only when that ID is the lane's
current invocation. Missing, stale, or mismatched IDs fail closed. Hook exit
also carries the ID, so a late exit from an aborted worker cannot settle the
next task.

The runtime stores invocation context by ID, not in a reusable unkeyed slot.
Context is cleared in `finally` after Hook exit, timeout, abort, worker crash,
or validation failure. Idle eviction and manual deactivation wait for the lane
to drain, except forced termination after an abort budget.

Different plugins may run in parallel. Two tasks targeting the same plugin are
serialized. This provides isolation without globally serializing downloads.

## 9. DTO and SDK contract

### 9.1 Validation boundary

Zod schemas in `src/shared/schemas/` are the source of truth for every Hook DTO,
worker enter/exit message, effect list, metadata value, and post-delivery
envelope. The host validates before posting to the worker and validates the
worker result before applying it. Unknown fields in protocol messages are
rejected; explicitly documented additive DTO fields remain allowed by their
schema version.

DTOs contain JSON values only. Strings, arrays, object depth, collection size,
and total encoded bytes are bounded. Numbers must be finite. Task snapshots are
copied; the guest never receives a live host object.

Schema version 1 uses these inclusive limits, measured after UTF-8 encoding:

| Item | Limit |
|---|---:|
| complete Hook enter or exit JSON message | 2 MiB |
| generic string / filesystem path | 64 KiB / 32 KiB |
| URLs per request / bytes per URL | 128 / 16 KiB |
| headers / header-name bytes / header-value bytes / total header bytes | 256 / 256 / 16 KiB / 256 KiB |
| JSON object depth / keys per object / items per array | 16 / 1,024 / 1,024 |
| metadata entries / key bytes / value bytes / snapshot bytes | 1,024 / 128 / 256 KiB / 1 MiB |
| error code / error message bytes | 128 / 16 KiB |

Values at the limit are valid; one byte or item beyond it is rejected. Shared
constants back both Zod schemas and conformance tests.

### 9.2 Common context

Every Hook receives all fields declared for its schema. The common fields are:

- `schemaVersion`, `invocationId`, and `taskId`;
- `sourceUrl`, `createdBy`, and `requestedAt` where applicable;
- `task`, a stable plugin task snapshot;
- `signal`, local to the invocation;
- `metadata`, scoped to `(taskId, pluginId)`.

The exact `PluginTaskSnapshotV1` public shape is:

```text
{
  schemaVersion: 1
  id, name
  type: "http" | "ftp" | "bt" | "magnet" | "metalink"
  kind: "direct" | "bt" | "hls" | "mux"
  status: "queued" | "fetching_metadata" | "metadata_ready" |
          "downloading" | "finalizing" | "seeding" | "paused" |
          "completed" | "error" | "removed"
  filePath, saveDir, filename
  progress, totalBytes, downloadedBytes, uploadedBytes, sizeWhenDone, fileCount
  createdAt, updatedAt, finishedAt: number | null
  category: string | null
  infoHash: string | null
  error: ErrorDescriptorV1 | null
}
```

All identifier/name/path fields use section 9.1 limits. Counts and byte values
are non-negative safe integers, times are non-negative integer Unix
milliseconds, and progress is finite in `[0, 100]`. `ErrorDescriptorV1` is
`{ code, message, detailKey: string | null, detailParams: Record<string,string>
| null }`; it never includes a stack or raw engine payload. The snapshot keeps
the SDK 2.0 compatibility fields `id`, `filePath`, and `saveDir`, and excludes
URIs, headers, proxy credentials, engine IDs, bridge sessions, mutable instance
payloads, and host objects.

### 9.3 Metadata parity

Pre-Hook `ctx.metadata` implements the complete six-method synchronous SDK
surface:

- `get(key)`, `has(key)`, `getAll()`, and `keys()` read the invocation snapshot;
- `set(key, value)` and `delete(key)` stage writes in pre-Hooks;
- post-Hooks receive the four-method readonly subset: `get`, `has`, `getAll`,
  and `keys`. They do not expose `set` or `delete`.

Staged writes update the worker snapshot immediately, so read-after-write is
deterministic. The worker returns the operations at Hook exit. The host then
validates keys, JSON values, quotas, role, phase, and permissions before adding
them to the chain. No fire-and-forget metadata or `ctx.update` request may race
Hook exit.

The asynchronous metadata operations used by the Worker/Host bridge are an
internal transport capability, not a top-level guest export. The only public
Hook metadata API is `ctx.metadata`, synchronous as required by
`@motrix/plugin-api` 2.0.

The guest `signal` is an invocation-local, readonly `AbortSignal` subset with
`aborted`, `reason`, `onabort`, and `addEventListener`/`removeEventListener` for
the `abort` event. Timeout, task cancellation, policy-generation change,
shutdown, or forced lane termination sets `aborted` once, assigns a bounded
stable reason, queues exactly one abort event before rejecting outstanding
capability promises, and causes later capability calls/effects to fail. Tests
use an injected scheduler to assert this ordering.

### 9.4 Hook-specific DTOs

`beforeCreate` receives the complete HTTP create request: URL list, save
directory, optional filename and connection count, ordered headers, optional
proxy, provenance, and timestamp. Valid effects are limited to those mutable
fields. The final URI list must be non-empty. Returned URLs do not need to match
the plugin's network `hostPermissions`; instead each passes the normal task
source admission policy used for a user-provided URL: supported scheme,
credential rejection, remote-operator/private-network policy, URL limits, and
role permission to mutate the request. Headers and task proxy effects pass the
same secret, proxy, and engine-option policy as a user request. This distinction
allows the locked Commons resolver to call only `commons.wikimedia.org` while
returning an independently validated `upload.wikimedia.org` download URL.

`beforeFinalize` receives:

- `sourceUrl`: a non-empty source identity. For HTTP-like tasks this is the
  admitted source URL. For BT/magnet tasks the Host always replaces any raw
  source with a non-secret canonical identifier: `urn:btih:<infoHash>` for a
  valid 40-hex or 32-base32 info hash, otherwise
  `urn:motrix:bt:<base64url(taskId)>`. Torrent file paths, raw magnet query
  strings, tracker URLs, and credentials never cross this boundary;
- `inputFilePath`: the completed artifact currently owned by Motrix;
- `filePath`: the proposed final target, retained for SDK 2.0 compatibility;
- `targetFilePath`: the same proposed target under its explicit name;
- the complete plugin task snapshot and common context.

Changing `filePath` changes only the target. It never changes the source and
does not itself assert that a replacement artifact exists.

The stable public delivery envelope is exactly:

```text
DeliveryEnvelopeV1 {
  schemaVersion: 1
  id: string
  occurrenceId: string
  occurredAt: number
}
```

`id` is the stable `deliveryId`; it and `occurrenceId` are opaque, non-empty,
at most 128 UTF-8 bytes, and `occurredAt` is a non-negative integer Unix
millisecond timestamp. Attempt number, lease, retry time, and breaker state are
host diagnostics and never enter this stable envelope.

`AfterCompleteContextV1` contains exactly `schemaVersion`, `invocationId`,
`taskId`, `task: PluginTaskSnapshotV1`, final `filePath`, `delivery:
DeliveryEnvelopeV1`, readonly `metadata`, and `signal`. `OnErrorContextV1` has
the same fields plus `error: ErrorDescriptorV1`. The persisted stable event
payload is `(task, filePath, delivery, error?)` and is byte-identical across
attempts/restart using canonical JSON with lexically sorted object keys;
`invocationId`, `metadata`, and `signal` are freshly bound
invocation wrappers. Protocol version 1 rejects unknown fields. Additive public
fields require a schema-version revision and a backwards-compatible SDK minor.

The `delivery` field is new relative to `@motrix/plugin-api` 2.0. The runtime
pins the published `@motrix/plugin-api` 2.1.0 contract for typed access to this
field. A compile-time fixture against that exact package and a real QuickJS
invocation both read `ctx.delivery.id`; a separate npm alias keeps the fixture
against the exact published 2.0 package. SDK 2.0 plugins remain runtime-compatible
because the field is additive and the locked builtins need no source changes.

### 9.5 Capability phase rules

The capability bridge applies effective permission, phase, invocation, and
path gates in that order. `ctx.update` and metadata writes are staged in
pre-Hooks and disallowed in post-Hooks. Task filesystem reads are unavailable
before creation and are bound to the invocation's task artifact thereafter.
Direct task rename is disallowed in `beforeFinalize`; the finalize commit
protocol owns all target mutations. FFmpeg output under the task save directory
is redirected to the invocation's private staging directory. Plugin storage
output stays within that plugin's storage sandbox. Other output paths fail.

## 10. `beforeFinalize` HookPlan and file commit protocol

### 10.1 HookPlan

A successful chain yields:

```text
HookPlan {
  taskId
  sourcePath
  targetPath
  sourceIdentity: ArtifactIdentity
  replacement?: { pluginId, stagedPath, identity: ArtifactIdentity }
  metadataOps[]
  contributors[]
}
```

`ArtifactIdentity` is a discriminated union:

```text
FileIdentity      { kind: "file", size, sha256, platformFileId? }
DirectoryIdentity { kind: "directory", entryCount, totalBytes, treeSha256,
                    platformFileId? }
```

A directory walk never follows symlinks or reparse points and rejects sockets,
devices, FIFOs, and other special entries. It records empty directories and
regular files. Entries are sorted by platform-tagged component encoding (POSIX
raw name bytes; Windows exact UTF-16LE code units) and hashed as length-prefixed
records: directory records contain type and relative path; file records
additionally contain unsigned 64-bit size and the file's SHA-256. The root
record, platform tag, and algorithm version are included. A target-filesystem
case/normalization collision fails. Open no-follow handles, before/after file
identity/stat checks, and a final tree rescan detect mutation during hashing or
copy; any change aborts or quarantines rather than accepting a mixed snapshot.
The default maximum is 1,000,000 entries;
exceeding it is `plugin.finalize.artifact_too_large`, not a partial plan.

`sourcePath` is captured before Hook execution and never guest-controlled.
`targetPath` must be a descendant of the task save directory and must not be
the save directory itself. The trusted filesystem adapter resolves path
equivalence using platform case rules and operates relative to held directory
handles with no-follow semantics (or a platform-equivalent anti-symlink-swap
primitive). A platform without an equivalent primitive fails closed. A lexical
or one-time `realpath` check alone is insufficient.

Before the first source identity read, finalization acquires an exclusive task
artifact-mutation lease, closes plugin filesystem admission for that task, and
successfully quiesces the engine and every Host-owned writer. A failed engine
stop or an unaccounted writer fails closed; logging and continuing is forbidden.
The lease and held no-follow artifact/directory handles remain owned through
`db_committed` and compensation, and through cleanup for every path cleanup may
delete. The lease coordinates all Motrix/engine writers; external changes are
detected by the identity checks below and are never deleted as known data.

A replacement exists only when one plugin produced a regular artifact through
its invocation-private staging adapter and the adapter recorded the logical
output-to-staged-path mapping. Directory scanning never guesses ownership.
File identities always contain size and SHA-256; directory identities always
contain entry count, total bytes, and tree SHA-256. A digest is never optional.
Zero mapped artifacts means the original source is selected.
More than one selected mapping, a symlink, directory/type mismatch, digest
change, or another plugin's artifact aborts the plan.

Immediately before and after every preserve, rename, copy, install, compensation,
or cleanup action, the adapter revalidates type and the complete recorded strong
identity through the held handles. After install it recomputes the complete
target `ArtifactIdentity` and matches it before writing `target_installed`, then
matches again immediately before the `db_committed` transaction. Any source,
target, rollback, or staging mismatch preserves all bytes, quarantines the
journal, and forbids recursive deletion.

Path branches are explicit:

- `source == target`, with no replacement, performs no file mutation;
- `source == target`, with a replacement, preserves the source before install;
- distinct source and target use no-replace install;
- file-vs-directory conflicts fail, and Windows case-equivalent paths use the
  `source == target` branch;
- cross-device (`EXDEV`) inputs use the target-local copy protocol below,
  never a best-effort rename.

The commit is no-clobber. The filesystem adapter must provide an atomic
no-replace install, such as a same-filesystem link/create-exclusive protocol or
a native rename-without-replace primitive. Node's overwrite-capable `rename`
is not sufficient. An unrelated target appearing at any time fails without
being modified.

The orchestrator builds the plan but performs no promotion or source rename.

### 10.2 Durable phases

The finalize journal uses these durable phases:

```text
prepared -> target_staged -> source_preserved? -> target_installed
  -> db_committed -> cleaned
```

Before filesystem mutation, Motrix durably writes `prepared` with normalized
paths, case-equivalence decisions, expected strong identities, plan identity,
the exact staging mapping, rollback path, and metadata operations. The database
commit/WAL durability point completes before any file action.

An original source on the target filesystem may be installed directly with a
native no-replace file or directory rename after `prepared`; this is the normal
large BitTorrent-directory path. Otherwise the selected artifact is
materialized under an invocation-private name inside the target filesystem.
Same-device regular files may hard-link; cross-device files copy. Directories
copy recursively without following links, use exclusive destination creation,
fsync every completed file, and fsync directories in postorder. Motrix then
recomputes the complete `ArtifactIdentity`, fsyncs the private item's parent,
and durably records `target_staged`. Partial file or directory copies are
private and can never be selected as a target.

When the target is the source path, or another destructive source move is
needed, the source is moved with no-replace semantics to the recorded
target-filesystem rollback path. Its file and affected directories are made
durable before `source_preserved` is recorded. The target-local temporary item
is then atomically installed with no-replace semantics; the target file and
parent directory are made durable before `target_installed` is recorded. For a
replacement, only the replacement temporary item is installed. The original
is never renamed over it. Every phase update occurs after the filesystem state
it names is durable; recovery tolerates a crash between the file action and
phase update by comparing the recorded identities.

For a same-filesystem direct source rename, `target_staged` is skipped and the
strongly identified source is installed no-replace as the target. Files fsync
themselves and the parent; directories fsync the renamed root and affected
parents before `target_installed`. On database failure or recovery compensation,
the adapter renames that exact identity back no-replace. A cross-device source
is retained unchanged until `db_committed` and uses the private-copy path.
When `source == target` and no replacement exists, Motrix revalidates and makes
that artifact durable, then advances directly from `prepared` to
`target_installed` without changing a path.

After target installation, one SQLite transaction commits all of the
following:

- final task path, terminal status, timestamps, and instance paths;
- task-file path rebasing;
- staged plugin metadata operations;
- the terminal occurrence;
- journal phase `db_committed`.

Only after that transaction succeeds may Motrix delete the rollback artifact,
the now-obsolete original source, target-local temporary files, and unused
staging. Each deletion first revalidates the current type and full identity
against the journal through the held handle; mismatch leaves the path untouched
and records cleanup quarantine. It fsyncs affected directories, records
`cleaned` only when all known cleanup is complete (or a mismatch is durably
quarantined), releases the mutation lease, and then removes or retains the
journal as the quarantine policy requires. Cleanup is idempotent.

### 10.3 Compensation and crash recovery

If target staging or installation fails, the source is restored from the
rollback path when necessary and the task remains recoverable. If the database
commit fails, Motrix removes only a target whose strong identity matches the
journal and restores the recorded source. A failed compensation leaves the
journal for startup recovery and never marks the task completed.

Startup recovery runs before polling, engine completion subscriptions, or post
delivery:

- `prepared`: verify source/replacement identities and retry or cancel safely;
- `target_staged`: verify the private temporary item and continue, or discard
  only that identity and recreate it;
- `source_preserved`: restore the source unless the verified install can
  continue;
- `target_installed`: finish the database transaction when target identity
  matches, otherwise compensate;
- `db_committed`: keep the committed target and finish cleanup;
- malformed, ambiguous, or identity-mismatched rows are quarantined and the
  task is marked with a recoverable finalize error without deleting bytes.

Recovery checks both the recorded phase and all possible adjacent-phase file
layouts so a crash before a phase update is unambiguous. Operations are
idempotent. No branch follows a symlink, overwrites an unknown path, or treats
equal size as identity. Fault-injection tests stop before and after every file
action, file/directory fsync, journal write, and SQLite commit on same-device,
cross-device, POSIX-case-sensitive, and Windows-case-folded adapters. The matrix
includes direct files, single-file torrents, multi-file torrent directories,
empty directories, the entry limit, symlink/reparse and special-file rejection,
and crashes during recursive copy and postorder directory fsync. It also injects
tree mutation before/after final rescan, `target_staged`, `target_installed`, the
database transaction, compensation, and every cleanup deletion; a mismatch must
retain bytes and quarantine.

## 11. Reliable `afterComplete` and `onError` delivery

Before the terminal transaction, the runtime snapshots candidates under a
registry generation read lease and validates a self-contained delivery DTO. It
revalidates that generation while entering the transaction, so a concurrent
policy change either precedes the snapshot or waits until commit. The same
SQLite transaction writes the task terminal state, stable occurrence, and,
subject to the bounded admission policy below, one post-delivery row per
snapshotted candidate, including plugin/executable
identity, required grants, the complete effective-permission snapshot,
`createdGeneration`, DTO, stable `deliveryId`, attempt count, next retry, and
status. A quota-rejected candidate updates the bounded tombstone instead.
Candidate
enumeration never happens later from the current registry. A malformed
candidate becomes an observable permanent row rather than disappearing.

The occurrence consumer only schedules rows that already exist and then marks
its own occurrence-consumer receipt. Replaying it is idempotent by the unique
`(occurrenceId, hook, pluginId, version, digest)` key. One failing plugin cannot
keep unrelated consumers or plugins undispatched.

An admitted delivery is at least once. Rows move through:

```text
pending -> delivering -> delivered
                    \-> pending (retryable)
                    \-> dead_letter (permanent/policy limit)
```

An expired `delivering` lease becomes `pending` on startup. Defaults are: a
two-minute lease, 64-row claim batch, eight global delivery workers, one active
delivery per plugin lane, 12 attempts, and a seven-day maximum active age.
Retry delay is `min(1 hour, 1 second * 2^(attempt-1))` multiplied by injected
jitter in `[0.75, 1.25]`. Attempts/age beyond the limit become `dead_letter`.
The scheduler rotates plugin IDs round-robin; one plugin cannot consume a whole
batch. Delivered and dead-letter rows are retained for 30 days, with aggregate
audit counters retained after pruning. These defaults are configurable within
schema-enforced safe bounds and tests use an injected clock and jitter source.

Version 1 configuration bounds are exact: lease 30 seconds-10 minutes; claim
batch 1-256; global workers 1-32; attempts 1-32; active age 1 hour-30 days;
base delay 100 ms-1 minute; delay cap 1 minute-24 hours and not below base;
terminal retention 1-90 days; breaker threshold 1-100, window 1 minute-1 hour,
and pause 1 minute-24 hours. Jitter remains the fixed `[0.75, 1.25]` range and
per-plugin concurrency remains one. Quotas may be lowered only: per-plugin
active rows 1-1,000 and bytes 2-64 MiB; global active rows 1,000-10,000 and
bytes 64-512 MiB; per-plugin terminal rows 1-4,000 and bytes 1-4 MiB; global
terminal rows 4,000-40,000 and bytes 4-40 MiB. Cross-field validation requires
each global bound to cover one per-plugin bound. The 1 GiB post hard budget and
128 MiB minimum core reserve cannot be raised/lowered respectively in v1.

Activation/worker crashes and timeouts are retryable; malformed persisted DTOs,
missing or changed executable identities, disabled/uninstalled/quarantined
plugins, and revoked required permissions are permanent and observable. A circuit
breaker opens after five retryable failures in ten minutes, pauses that plugin
for 15 minutes without consuming attempts, then permits one half-open probe;
success closes it and failure reopens it. A plugin failure is caught per row and
never prevents another plugin from running.

Admission reserves row and byte budget atomically in the terminal transaction.
Bytes are the uncompressed UTF-8 payload plus a fixed 512-byte row charge.
Defaults are 1,000 active rows and 64 MiB per plugin, and 10,000 active rows and
512 MiB globally. Terminal receipts are compacted to at most 1 KiB immediately
after delivery/dead-letter, with limits of 4,000 rows/4 MiB per plugin and
40,000 rows/40 MiB globally. The ledger releases exact active bytes on
compaction/prune and is reconciled from table contents at startup.

If either active quota is exhausted, Motrix does not write the full DTO or an
ordinary delivery row. The terminal transaction instead updates a fixed-size
quota tombstone bucket keyed by `(pluginId, hook, reason, UTC day)` with count,
first/last occurrence ID, and times; one bucket is at most 1 KiB. There are at
most 32 daily buckets per plugin/reason plus one lifetime rollup, 8,192 buckets
globally, and one global overflow rollup. Old buckets merge into the rollup, so
rejection reporting is bounded. This is an explicit observable admission
rejection, not a silently lost or falsely delivered Hook.

Terminal receipts normally retain for 30 days. When their row/byte quota is
needed, oldest receipts roll into the same bounded aggregates and are removed;
no active row is pruned. Post-delivery tables have a 1 GiB hard logical budget
and the database adapter reserves at least 128 MiB of configured capacity for
task, finalize-journal, occurrence, and quota-tombstone writes. A plugin payload
can never consume that reserve. At the global post hard cap, all new post
candidates take the bounded tombstone path while unrelated task terminal state
and occurrences still commit. Physical disk failure inside the core reserve is
a system-wide retryable storage error; it is never attributed to or hidden as a
plugin delivery result.

`deliveryId` is stable across attempts. Motrix records a receipt only after a
matching Hook exit. A process crash after the guest side effect but before the
receipt can cause redelivery; plugins that call external systems must use the
delivery ID with `storage.compareAndSet` or the external system's idempotency
facility.

Delivery DTOs do not depend on a live task row. Task deletion uses no cascade to
post deliveries. Upgrade never runs the superseded executable: its barrier
atomically moves that identity's nonterminal rows to permanent `superseded`,
then deletes the old bundle after the lifecycle transaction/journal commits.
Disable, uninstall, quarantine, or required-grant revocation similarly moves
affected rows to an explicit permanent reason. A grant addition may leave a row
pending, but its attempt receives only the intersection of its complete
creation-time permission snapshot and the current set. A same-executable grant
revocation aborts an active attempt and either retries with the reduced
intersection or becomes `permission_revoked` when a required grant is absent.
Row transition, bundle deletion, task deletion, and policy changes share the
registry/database transaction or a journaled two-phase coordinator, so their
order is explicit after restart. Tests cover grant add/revoke, upgrade,
disable, uninstall, and quarantine before claim, while delivering, and after a
guest side effect but before receipt.

## 12. Threat model and security requirements

Guest code, manifests, bundle messages, URLs, metadata, staged files, and
persisted recovery rows are untrusted inputs.

The runtime must defend against:

- host/path/port confusion and redirect escape in host permissions;
- guest-selected proxy endpoints bypassing network authority;
- path traversal, symlink swaps, alternate separators, case behavior, and
  sibling-prefix confusion in save/staging paths;
- stale or forged invocation messages using another task's context;
- a worker retaining references after timeout or idle disposal;
- oversized/deep DTOs, metadata quota evasion, and non-finite numbers;
- replacement/source aliasing and overwrite of existing user data;
- a crash between any filesystem and database phase;
- one plugin exhausting the post-delivery queue or circuit breaker;
- policy revocation racing an already active capability;
- shell-specific assembly accidentally bypassing a gate.

The host revalidates effective permissions for each activation and capability
lease against the live permission generation. Policy mutation uses the
exclusive barrier in section 6. A capability bridge never trusts SDK-side
`available` flags. Audit logs redact sensitive
headers, proxy credentials, secrets, and private source metadata. Absolute user
paths may be logged locally where required for recovery but never enter public
documentation or remote telemetry.

## 13. Error classification

Stable categories are used in logs, audit records, task error descriptors, and
post-delivery rows:

- `plugin.hook.input_invalid` and `plugin.hook.output_invalid`;
- `plugin.hook.not_registered`, `plugin.hook.timeout`, and
  `plugin.hook.worker_crashed`;
- `plugin.hook.permission_denied` and `plugin.http.host_not_permitted`;
- `plugin.hook.concurrent_protocol_violation` for a lane/ID violation;
- `plugin.runtime.reentrant_call` and `plugin.runtime.permission_generation_stale`;
- `plugin.finalize.plan_invalid`, `target_exists`, `staging_invalid`,
  `artifact_too_large`, `file_commit_failed`, `db_commit_failed`, and
  `recovery_quarantined`;
- `plugin.post.retryable`, `plugin.post.permanent`,
  `plugin.post.admission_rejected`, and
  `plugin.post.dead_letter`, including explicit `queue_capacity`,
  `identity_missing`, `superseded`, and `permission_revoked` reasons.

Series Hook errors retain their role-dependent fail-open/fail-closed policy.
Post-Hook errors never change a terminal task's status. Error messages exposed
to plugins are bounded and do not include another plugin's details.

## 14. Compatibility

The runtime supports `@motrix/plugin-api` 2.0 context shapes. Existing plugins
that return the context object continue to work; effects are taken from
`ctx.update` and metadata operations. New additive DTO fields do not change the
meaning of existing fields.

Manifest v1 keeps its released browser-pattern port behavior: a pattern without
a port matches explicit and default ports. Changing that behavior or adding a
port grammar requires a new manifest schema version. The public SDK continues
to expose metadata only through Hook context: six methods in pre-Hooks and four
readonly methods in post-Hooks.

Reliable post delivery is an additive runtime feature for SDK 2.0 plugins, but
typed access to `ctx.delivery` requires the pinned compatible SDK minor defined
in section 9.4. Runtime protocol schemas, Worker objects, generated declarations,
and the public package version must pass one field-parity test before release.

`ctx.filePath` in `beforeFinalize` remains the proposed final target, matching
the published filename-template plugin. `inputFilePath` and `targetFilePath`
make the previously implicit distinction explicit.

Plugins that do not declare Hooks keep their activation and command behavior.
Missing optional runtime components may remain a no-op only in isolated unit
tests. Production Electron and Server assembly must provide the runtime,
database, recovery, and delivery dependencies or fail startup.

## 15. Observability

Every invocation emits structured start/finish records with Hook, task ID,
plugin ID/version, invocation ID, role, queue delay, activation time, runtime,
duration, outcome, error category, and effect counts. Sensitive payload values
are not logged.

Finalize audit records include plan ID, source/target classification,
replacement owner, journal phase, promoted/discarded bytes, compensation, and
recovery result. Post-delivery metrics include pending/delivering/delivered/
dead-letter counts, attempt latency, retries, and oldest pending age.

Electron and Server use the same event names and field meanings. Tests assert
both assembly paths, not merely the core factory.

## 16. Electron and Server assembly

Each shell performs this order:

1. open and migrate the database;
2. discover plugins and create the capability host and `PluginHost`;
3. create exactly one shared plugin Hook runtime;
4. register the runtime's occurrence consumer;
5. recover finalize journals;
6. restore task/session state without opening producers;
7. inject the same runtime into create, finalize, media, recovery, and error
   paths;
8. drain materialized deliveries and occurrences, then open polling and engine
   completion producers;
9. on shutdown, stop admission, drain accepted work within budget, persist
   leases, then stop plugin workers.

The shells may differ in notification adapters and path-policy inputs, but not
in Hook eligibility, DTOs, scheduling, commit, recovery, or delivery policy.
Both call one shared startup coordinator; ordering tests assert its exact events.

## 17. Builtin acceptance matrix

Tests use the build output fetched from `scripts/builtins.lock.json`, never a
rewritten fixture or source copy.

| Plugin | Locked release | Required real Hook acceptance |
|---|---:|---|
| `motrix.scraper-hook` | 1.0.0 | `beforeCreate` performs HEAD and GET through the real HTTP capability and rewrites a nested relative archive URL. |
| `motrix.url-resolver` | 1.0.0 | `beforeCreate` keeps its API requests and redirects inside Commons host permission, then rewrites to the returned `upload.wikimedia.org` URL after independent output-policy validation. |
| `motrix.filename-template` | 1.1.1 | `beforeFinalize` reads `ctx.metadata.getAll()`, renders nested metadata, and commits an automatic no-clobber rename. |

The matrix also covers idle disposal followed by finalization, restart
recovery, two tasks completing concurrently through the same plugin, complete
`afterComplete`/`onError` DTOs, replacement output not overwritten by the
original, transaction failure/compensation, crash recovery, malicious
host-vs-path URLs, and Electron/Server assembly parity.

Because the locked builtins do not declare post-Hooks, a separately built SDK
2.0 compatibility plugin must execute all four Hooks through real QuickJS
without reading `delivery`; the SDK >=2.1 fixture executes both post-Hooks and
reads stable `ctx.delivery.id`. These are runtime bundles, not mocked callbacks.

## 18. Normative invariants

- **H1**: a Hook candidate is never derived only from the active plugin set.
- **H2**: at most one host-initiated guest entry runs in a plugin VM.
- **H3**: every invocation-scoped worker message carries the current
  `invocationId` and cannot act on another invocation.
- **H4**: every Hook DTO and result is runtime-validated at both trust
  boundaries.
- **H5**: one canonical structured matcher governs HTTP `beforeCreate`
  resolver selection and every guest HTTP request/redirect.
- **H6**: later plugins see only validated effects from successful earlier
  plugins.
- **H7**: pre-Hook `ctx.metadata` implements get/has/getAll/keys/set/delete with
  deterministic read-after-write behavior; post-Hooks expose only the four
  readonly methods.
- **H8**: before its first identity read the source is quiesced under an
  exclusive task artifact-mutation lease, held through commit/compensation and
  identity-checked cleanup; unknown changed bytes are never deleted.
- **H9**: the orchestrator never promotes staging or renames the source.
- **H10**: a finalize commit never overwrites an unrelated existing target.
- **H11**: a replacement is installed instead of, never underneath, the
  original source rename.
- **H12**: task terminal state, task-file paths, plugin metadata, occurrence,
  and journal commit phase change in one SQLite transaction.
- **H13**: every filesystem-crossing finalize has a durable pre-mutation
  journal and an idempotent recovery path.
- **H14**: an admitted post-Hook delivery has stable identity and survives
  restart until delivered or explicitly dead-lettered; a quota rejection is
  represented only by the bounded observable tombstone contract.
- **H15**: one plugin's post-Hook failure cannot block another plugin or an
  unrelated occurrence consumer.
- **H16**: Electron and Server construct and inject the same core runtime.
- **H17**: Hook-produced download URLs use normal task-source output policy,
  never the plugin HTTP host-permission predicate.
- **H18**: finalizer and post-Hook eligibility never depends on an HTTP source
  URL or the active plugin set.
- **H19**: every destructive file action is preceded by a durable strong
  identity and followed by file/directory durability before its journal phase.
- **H20**: terminal task state, occurrence, and every candidate's delivery row
  or bounded quota-admission decision are committed together.
- **H21**: permission generation changes close admission and abort stale
  capability leases before the new policy is published.
- **H22**: lane call cycles fail before enqueue and cannot deadlock.
- **H23**: regular files and directory trees have discriminated strong
  identities and equally journaled same-device/cross-device recovery.
- **H24**: active payloads, terminal receipts, and quota tombstones have atomic
  per-plugin/global row and byte bounds; post data cannot consume core reserve.
- **H25**: a historical delivery can use only creation-time permissions
  intersected with a live generation lease, and an upgrade never runs old code.

## 19. Acceptance criteria

Implementation is complete only when:

1. all invariants above have focused positive and negative tests;
2. the three locked builtin archives first pass locked size, SHA-256, and
   signature assertions, then pass the real Hook matrix through `PluginHost`,
   QuickJS, and the runtime;
3. real compiled SDK 2.0 four-Hook and pinned SDK >=2.1 delivery fixtures pass
   Worker/Host/schema field-parity and QuickJS invocation tests;
4. permission-confusion, idle/reactivation, concurrency, restart, file and BT
   directory replacement/rename, same/cross-device database failure,
   crash-phase, historical-grant/upgrade, post-delivery quota, and shell-parity
   tests pass;
5. schema parity, boundary, filename, lint, type-check, complete unit test,
   Electron build, and Server build gates pass;
6. an independent adversarial review finds no unresolved correctness,
   security, data-integrity, SDK-contract, or shell-drift issue.

## 20. Initial adversarial design review record

An independent read-only reviewer returned **FAIL** on 2026-08-31. All eleven
findings were accepted; none were rejected. This table records disposition and
rationale rather than hiding the failed first pass.

| ID | Severity | Disposition | Resolution and rationale |
|---|---|---|---|
| C1 | Critical | Resolved — accepted | Network `hostPermissions` now govern guest requests only; Hook output URLs use independent task-source policy, allowing the locked Commons resolver safely. |
| H2 | High | Resolved — accepted | HTTP source matching selects only `beforeCreate` resolvers; finalizer/post candidates use task activation and per-call capability checks, so FTP/BT are not lost. |
| H3 | High | Resolved — accepted | Strong mandatory identities, recorded staging mappings, no-follow handles, no-replace install, target-local cross-device copies, fsync points, path-equivalence branches, and adjacent-phase recovery are normative. |
| H4 | High | Resolved — accepted | Candidate snapshots and delivery rows now commit with terminal state; exact executable retention and lifecycle/deletion ordering are defined. |
| H5 | High | Resolved — accepted | Startup restores journals and task/session state before draining post deliveries; both shells use one ordered coordinator. |
| H6 | High | Resolved — accepted | Guest-selected HTTP proxies are rejected; only Host-managed proxy routing is allowed. |
| H7 | High | Resolved — accepted | Manifest v1 omits a port and matches any valid port; IPv6, query, percent encoding, and a shared matcher corpus are explicit. |
| H8 | High | Resolved — accepted | A permission-generation barrier closes admission, cancels leases, drains/terminates the lane, and rejects stale messages. |
| M9 | Medium | Resolved — accepted | Call-chain propagation rejects self/cyclic plugin re-entry before queueing and defines cancellation propagation. |
| M10 | Medium | Resolved — accepted | Pre/post metadata surfaces are distinguished, bridge metadata is internal, exact DTO limits and QuickJS AbortSignal ordering are specified. |
| M11 | Medium | Resolved — accepted | Lease, backoff, fairness, attempt/age limits, circuit breaker, queue cap, retention, task independence, and deterministic test controls are specified. |

The review also found the English and Chinese drafts substantively equivalent.

### First re-review

The same independent reviewer returned **FAIL** after the first revision. It
kept C1, H2, H5-H7, and M9 closed, but reopened H3/H4/H8/M10/M11 as four
concrete High findings. All four were accepted; none were rejected.

| ID | Severity | Disposition | Resolution and rationale |
|---|---|---|---|
| N1 | High | Resolved — accepted | `ArtifactIdentity` now covers files and deterministic directory trees; same/cross-device no-replace install, recursive durability/recovery, and real multi-file BT cases are explicit. |
| N2 | High | Resolved — accepted | Creation generation is audit-only; historical authority is the creation/current permission intersection, while upgrade atomically supersedes old rows and never runs old code. |
| N3 | High | Resolved — accepted | The stable delivery envelope, post contexts, task/error snapshots, strict schema/version behavior, minimum public SDK minor, compile fixture, and real QuickJS assertion are exact. |
| N4 | High | Resolved — accepted | Atomic per-plugin/global row and byte quotas cover active and terminal data; terminal payloads compact, cap hits use bounded tombstones, and plugin storage cannot consume the core reserve. |

A second re-review is required after these paired revisions; implementation
planning remains blocked until it returns PASS.

### Second re-review

The reviewer closed every original and N1-N4 finding but returned **FAIL** for
one new High. It was accepted; no finding was rejected.

| ID | Severity | Disposition | Resolution and rationale |
|---|---|---|---|
| N5 | High | Resolved — accepted | Finalization now requires successful engine/Host quiescence and an exclusive artifact-mutation lease before identity capture; complete identities are rechecked around every action and before commit/delete, while mismatches preserve bytes and quarantine. Mutation-injection, exact config-boundary, and SDK 2.0 post compatibility tests were also added. |

A third re-review is required; implementation planning remains blocked until it
returns PASS.

### Third re-review and gate result

The independent reviewer returned **PASS**. C1, H2-H8, M9-M11, and N1-N5 are
all closed with no new Critical or High finding. The reviewer confirmed paired
language equivalence and deterministic acceptance expectations. The residual
implementation risk is platform support for held no-follow handles, directory
durability, and atomic no-replace primitives; the specification requires an
unsupported platform to fail closed. The design-review gate is therefore
closed and implementation planning may begin.
