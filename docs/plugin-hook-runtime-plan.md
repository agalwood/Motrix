# Plugin Hook Runtime Implementation Plan

Status: executable plan for the reviewed
[`plugin-hook-runtime.md`](plugin-hook-runtime.md) specification. No implementation
step may weaken a normative invariant to make an existing test pass.

## 1. Outcome and release gate

The change is done only when Electron and Server construct one shared Hook
runtime; the four Hooks execute through the real `PluginHost` and QuickJS
worker; candidate activation, permissions, DTOs, lanes, finalize recovery, and
post delivery follow H1-H25; the three hash-locked builtins pass real Hook
invocation; and every command in section 10 passes from a clean checkout.

This plan does not copy or cherry-pick PR #2035. Existing code is evidence only.
The locked `.moext` archives remain supply-chain inputs and builtin source is
not modified.

## 2. Dependency graph

```text
P0 native/filesystem feasibility + dependency hydration
  -> P1 shared schemas/protocol
  -> P2 matcher, policy generation, lanes, demand activation
  -> P3 additive database v4 + atomic repositories
  -> P4a finalize planner/committer/recovery
  -> P4b durable post-delivery scheduler
  -> P5 shared runtime/startup coordinator + task integration
  -> P6 Electron/Server assembly
  -> P7 real builtin, compatibility, fault, parity, and full gates
```

P1 and P2 may proceed in parallel after P0. P4a and P4b may proceed in parallel
after their P1/P3 interfaces stabilize. Shell wiring starts only after the core
factory and recovery order are tested.

## 3. Work packages and files

### P0 — Feasibility and baseline

- Hydrate the exact `pnpm-lock.yaml` dependency graph with `pnpm install
  --frozen-lockfile`; never use `npx`.
- Run the current focused Hook/host/finalize/session tests and record pre-existing
  failures before editing.
- Add a platform filesystem helper under `packages/finalize-fs/` only if no
  existing dependency provides held no-follow handles, file/directory fsync,
  strong identity, and atomic no-replace install. Its Rust/native API must expose
  capability-style opaque handles, not arbitrary paths after admission.
- Prove file and directory no-replace behavior on Darwin, Linux, and Windows in
  adapter contract tests. Unsupported primitives return a typed fail-closed
  result; they never fall back to overwrite-capable `rename`.

Gate: a feasibility test demonstrates exclusive target creation, symlink-swap
rejection, directory install, and durability fault injection before persistence
or task code is changed.

### P1 — Shared DTOs, protocol, Worker, and SDK parity

Add/update:

- `src/shared/schemas/plugin-hooks.ts`
- `src/shared/schemas/index.ts`
- `src/shared/types/plugin-hooks.ts`
- `src/core/plugin/host/bridge-protocol.ts`
- `src/core/plugin/host/quick-js-worker.ts`
- `src/core/plugin/host/capability-bridge.ts`
- adjacent schema/protocol/Worker/bridge tests

Implement strict Zod schemas and inferred types for every enter/exit message,
`PluginTaskSnapshotV1`, `ErrorDescriptorV1`, `DeliveryEnvelopeV1`, effects,
metadata operations, limits, and canonical stable payloads. Every
invocation-scoped message carries `invocationId`, call-chain ID, and permission
generation. The Worker exposes pre-Hook six-method and post-Hook four-method
`ctx.metadata`, synchronous read-after-write staging, deterministic Hook exit,
the specified AbortSignal subset, and `ctx.delivery.id`.

Add compiled SDK 2.0 four-Hook and pinned SDK >=2.1 post-delivery fixtures. If
the compatible public SDK minor is unavailable, implementation may continue
behind tests but the release gate remains blocked; do not invent unpublishable
types and call the contract complete.

### P2 — Structured permissions, policy barrier, lanes, and activation

Add/update:

- `src/core/plugin/permissions/host-pattern.ts` and tests
- `src/core/plugin/hooks/eligibility.ts` and tests
- `src/core/plugin/capabilities/http.ts` and redirect/proxy tests
- `src/core/plugin/host/plugin-lane.ts` and tests
- `src/core/plugin/host/plugin-host.ts`
- `src/core/plugin/host/activation-dispatcher.ts`
- `src/core/plugin/plugin-registry.ts`
- `src/core/plugin/grants/grants-manager.ts`
- command graph/invoker tests where call-chain propagation enters

Replace both raw regex paths with one parsed manifest-v1 matcher and one shared
conformance corpus. Reject guest-selected HTTP proxies. Candidate discovery
reads enabled registry entries, not active workers; HTTP source matching applies
only to `beforeCreate`. Hook demand coalesces activation and reactivates recycled
workers.

Create one FIFO lane per plugin for Hooks, commands, lifecycle, and deactivation.
Reject self/cyclic call chains before enqueue. Add a monotonically increasing
live policy generation and exclusive mutation barrier that closes admission,
aborts capability leases, drains/terminates the lane, and then publishes the
new enabled/grant/executable state. Idle disposal requires a drained lane and
zero capability leases.

### P3 — Additive database v4 and atomic repositories

Add/update:

- `src/core/session/migrations/v4.ts`
- `src/core/session/migrations/v4.test.ts`
- `src/core/session/migrations/index.ts`
- `src/core/session/motrix-database.ts`
- `src/core/session/motrix-database.test.ts`
- repository interfaces under `src/core/plugin/runtime/`

Add only new tables/indexes; do not rewrite task tables:

- `plugin_finalize_journals` for plan, artifact identities, phases, quarantine,
  and cleanup state;
- `plugin_post_deliveries` for admitted stable payloads, leases, attempts,
  receipts, permission snapshots, and permanent reasons;
- `plugin_post_quota_ledger` for atomic row/byte reservation;
- `plugin_post_quota_buckets` for bounded daily/lifetime/global rollups;
- a lifecycle coordination journal if registry state cannot join the SQLite
  transaction directly.

Expose one transaction that commits task terminal state, task/instance path
updates, task-file rebasing, plugin metadata, journal `db_committed`, occurrence,
and delivery row or quota tombstone. Foreign keys must not cascade task deletion
into deliveries. Validate persisted JSON on read and quarantine malformed rows.
Migration tests assert the exact schema, fresh install, v3 upgrade, idempotence,
constraint failure rollback, quota reservation, and future-version refusal.

### P4a — Finalize plan, file commit, compensation, and recovery

Add/update:

- `src/core/plugin/finalize/artifact-identity.ts`
- `src/core/plugin/finalize/artifact-mutation-lease.ts`
- `src/core/plugin/finalize/filesystem-adapter.ts`
- `src/core/plugin/finalize/hook-plan.ts`
- `src/core/plugin/finalize/finalize-committer.ts`
- `src/core/plugin/finalize/finalize-recovery.ts`
- `src/core/plugin/hooks/hook-orchestrator.ts`
- `src/core/plugin/hooks/staged-effects.ts`
- `src/core/plugin/hooks/staging-dir.ts`
- `src/core/task/actions/finalize-task.ts`
- focused unit, integration, and fault-injection tests beside those files

The orchestrator only validates effects and returns an immutable HookPlan. The
committer acquires the task artifact mutation lease, must successfully stop the
engine/Host writers, records strong file/tree identities, writes `prepared`, and
performs target-local no-replace install. It revalidates identities around every
action and before commit/delete. Replacement output is installed instead of the
original. All mismatch branches preserve bytes and quarantine.

Recovery runs before task producers and handles every adjacent phase layout.
Cover direct files, single/multi-file BT, empty/large trees, source==target,
case-folding, symlinks/reparse/special files, EXDEV copies, target races,
metadata/DB failure, mutation after each phase, compensation failure, and a
crash before/after every file action/fsync/journal/transaction.

### P4b — Reliable post-Hook delivery

Add:

- `src/core/plugin/post/delivery-types.ts`
- `src/core/plugin/post/delivery-materializer.ts`
- `src/core/plugin/post/delivery-scheduler.ts`
- `src/core/plugin/post/delivery-retention.ts`
- `src/core/plugin/post/delivery-observability.ts`
- adjacent deterministic clock/jitter/quota/lifecycle tests

Snapshot candidates under a registry generation lease before the terminal
transaction. The database transaction admits a full row or bounded tombstone.
The scheduler claims fairly by plugin, uses the specified lease/backoff/breaker,
enters the same plugin lane, and records a receipt only for a matching exit.
Expiration returns a row to pending; task deletion cannot remove it.

At execution, permissions are creation snapshot intersect current live grants.
Grant revocation aborts active attempts; upgrade marks old digest rows
`superseded` and never runs old code. Terminal rows compact immediately and all
active/terminal/tombstone row+byte quotas and core reserve limits are enforced
inside the admission transaction.

### P5 — Shared runtime, startup coordinator, and task integration

Add/update:

- `src/core/plugin/runtime/plugin-hook-runtime.ts`
- `src/core/plugin/runtime/startup-coordinator.ts`
- `src/core/plugin/runtime/runtime-factory.ts`
- `src/core/task/create-task-handler.ts`
- `src/core/task/hook-dispatch.ts`
- `src/core/task/occurrences/occurrence-dispatcher.ts`
- `src/core/session/session-manager.ts`
- associated integration/order tests

One factory owns PluginHost, candidate resolver, lanes, orchestrator,
finalization, occurrence materialization, and post scheduler. `beforeCreate`
receives the complete validated request and applies role-ordered effects before
persistence. `beforeFinalize` runs after engine quiescence and before any rename.
Terminal success/error uses the single database transaction; post Hooks never
change terminal status.

The startup coordinator enforces: migrate -> discover/runtime -> register
consumer -> finalize recovery -> task/session restore without producers ->
delivery/occurrence drain -> open polling/completion producers. Shutdown closes
admission, drains within budget, persists leases, and stops workers.

### P6 — Electron and Server symmetry

Update:

- `src/main/index.ts`
- `src/main/ipc/commands.ts`
- `src/main/plugin/capability-host.ts`
- `src/server/index.ts`
- `src/server/ipc/commands.ts`
- `src/server/plugin/capability-host.ts`
- paired assembly and startup-order tests

Both shells call the same runtime factory and startup coordinator and inject the
same instance into create/finalize/error/recovery paths. Remove command-local
orchestrator construction. Production startup fails if required database,
recovery, delivery, or filesystem primitives are missing; only isolated unit
tests may inject a no-op.

### P7 — Real acceptance and regression gates

Update/add:

- `src/core/plugin/host/e2e-builtins.test.ts`
- `src/core/plugin/host/orchestrator.e2e.test.ts`
- `src/core/task/create-task-handler.plugin-hook-e2e.test.ts`
- `src/core/plugin/host/e2e-hook-compatibility.test.ts`
- `src/main/plugin/hook-runtime-assembly.test.ts`
- `src/server/plugin/hook-runtime-assembly.test.ts`
- reusable local HTTP/TLS test server and fault adapters under existing test
  helper conventions

Tests must fetch/read the exact archives from `scripts/builtins.lock.json`, then
assert size, SHA-256, and signature before install. They must invoke the built
bundle through PluginHost/QuickJS:

- scraper-hook performs real loopback HEAD+GET and resolves a nested relative
  archive URL;
- url-resolver performs the Commons page/API flow through a real loopback
  transport that preserves the authorized URL/Host and returns an independently
  accepted `upload.wikimedia.org` URL;
- filename-template synchronously reads `ctx.metadata.getAll()`, renders nested
  values, survives idle recycle, and commits a no-clobber file and BT-directory
  rename.

No fixture callback, registration event, preview command, or source copy counts
as builtin Hook acceptance.

## 4. Implementation boundaries and integration order

Keep the work packages separated by subsystem so their security contracts stay
reviewable:

- **Protocol and schema** covers P1 DTO, Worker, Host, and SDK parity files.
- **Host policy** covers P2 matching, permissions, lanes, and capability gates.
- **Finalize** covers `packages/finalize-fs/`, P4a files, and
  `finalize-task.ts`.
- **Post-delivery** covers P4b and depends only on the published repository
  interfaces.

Database migrations and shell integration land after those interfaces are
stable. A change that crosses a boundary must update the shared interface and
its integration tests in the same change. No package may weaken another
package's invariant to simplify integration.

## 5. Migration, recovery, and rollback

- Database v4 is additive. Startup creates a timestamped pre-v4 backup before
  migration and verifies it before deleting no data.
- On migration failure, the transaction rolls back and the app remains on v3;
  no Hook runtime or task producer starts.
- Finalize recovery is forward-only and runs before sessions/producers. Unknown
  or corrupt journal rows quarantine without deleting bytes.
- A code rollback to a v3-only binary must restore the verified pre-v4 backup;
  an older binary must refuse a future schema rather than guessing. Post-v4 task
  changes must be exported/reconciled explicitly before such a rollback.
- Feature rollback inside the v4 binary stops new Hook admission but continues
  recovery and delivery/quarantine draining; it never abandons a journal.
- Upgrade/uninstall/grant lifecycle operations use the durable barrier so a
  crash cannot leave old code executable with new grants.

## 6. Observability and operator proof

Add structured invocation, lane, permission-generation, finalize phase,
recovery, delivery lease/retry/dead-letter/quota, and shell startup events using
the names/fields in the specification. Redact headers, proxy credentials,
secrets, private source metadata, and public-doc absolute paths. Tests assert
event parity between Electron and Server and stable error categories.

## 7. Definition of done by stage

- P1: schema/Worker/Host/SDK field parity and synchronous metadata tests pass.
- P2: one matcher corpus, registry candidate discovery, reactivation, lane,
  policy-revocation, proxy, and cycle tests pass.
- P3: v4 migration and atomic terminal/delivery/finalize transaction tests pass.
- P4a: all file/directory fault and mutation injection tests pass with no byte
  loss or overwrite.
- P4b: restart, duplicate, fairness, breaker, quota, lifecycle, and idempotency
  tests pass.
- P5/P6: one runtime per shell and exact startup/shutdown order tests pass.
- P7: all three locked builtin real Hooks plus SDK 2.0/2.1 fixtures pass.
- Final independent reviewer finds no unresolved correctness, security, data
  integrity, SDK, or shell-drift defect.

## 8. Test commands during development

Run the smallest affected `./node_modules/.bin/vitest run <files...>` after each package,
then the package cluster after every merge. Native helper changes also run its
format/lint/unit tests. Never hide a red test by weakening assertions or using a
mock in place of the required real QuickJS/HTTP/filesystem boundary.

## 9. Rollout order

1. Land dormant schemas, matcher, lanes, repositories, and migration.
2. Land finalize recovery and post scheduler behind the shared factory.
3. Wire both shells in one change with parity tests; no one-shell rollout.
4. Enable real Hook admission only after startup recovery passes.
5. Run builtin/compatibility/fault suites, then all gates.
6. Obtain independent final review, fix findings, rerun affected and full gates.

## 10. Required final commands

```text
./node_modules/.bin/vitest run <all focused Hook/runtime/finalize/post/shell suites>
pnpm run build:builtin
pnpm run check:schema-parity
pnpm run check:file-names
pnpm run check:boundaries
pnpm run lint
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
pnpm run build:electron
pnpm run build:server
pnpm run docs:check
```

Also run the native filesystem package's own tests/build on every supported
host available in CI. Exact commands and pass/fail counts belong in the final
report; skipped platform evidence remains an explicit residual risk.
