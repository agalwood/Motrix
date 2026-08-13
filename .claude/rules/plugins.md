---
description: Plugin core, sandbox, capability, builtin, and schema boundaries
paths: ["src/core/plugin/**", "src/main/plugin/**", "src/server/plugin/**", "src/renderer/routes/plugins/**", "scripts/fetch-builtins.mjs", "scripts/builtins.lock.json", "scripts/builtins-signing.pub.pem", "vite.worker.config.ts", "Dockerfile"]
---

# Plugins

## Core and Shell Ownership

`src/core/plugin/` owns host-neutral plugin state, policy, manifest/install
logic, capabilities, and sandbox orchestration. Electron adapters and assembly
live in `src/main/plugin/`; Node/Docker equivalents live in
`src/server/plugin/`. Never import a shell into core.

Every shell integration and host-specific capability must be wired and tested
in both capability hosts. Keep a single core implementation when behavior is
host-neutral; differences such as Electron notifications remain adapters.

## QuickJS Sandbox

Guest code executes in the separate QuickJS worker built from
`src/core/plugin/host/quick-js-worker.ts` to
`dist/core/plugin/host/quick-js-worker.cjs` for both Electron and server
bundles. Its Vite target exposes only `@shared` and `@core`; never expose or
import `@main`, `@server`, `@renderer`, Electron, or another host API.

Guest access to host behavior must cross the typed capability bridge, which
owns dispatch classification plus phase and permission checks. Hook circuit
policy stays in the hook orchestrator and circuit-breaker modules. When adding
a capability:

1. define its core contract and bridge classification/dispatch tests;
2. wire and test it in both Electron and server capability hosts;
3. add the manifest permission and run schema parity checks.

## Builtin Supply Chain

Builtin source lives outside this repository and is consumed only as pinned,
signed `.moext` releases. `fetch-builtins.mjs` must verify the lockfile
SHA-256, detached Ed25519 signature against the pinned public key, and lock
record before unpacking. Never trust release metadata as the digest source or
weaken verification to handle an unavailable artifact.

Server builds must carry verified seeds into the runtime image and set
`MOTRIX_BUILTIN_PLUGIN_DIR`; otherwise a missing directory is tolerated and
the image silently starts without builtins. Container builtin updates require
a new image rather than an in-place sync.

## Manifest Schema Parity

`src/core/plugin/manifest/schema.ts` remains a pure re-export of the published
`@motrix/plugin-manifest-schema`. Do not maintain a second host schema. After
changing manifest contracts or bumping the schema package, run:

```bash
pnpm run check:schema-parity
```

Builtin seeds belong in `dist/builtin-plugins/`, verified archives in
`dist/builtin-moext/`, and only the QuickJS worker in
`dist/core/plugin/host/`.
