---
description: Architecture boundaries for the shared desktop and server app
paths: ["src/**/*.ts", "src/**/*.tsx", "scripts/check-boundaries.mjs"]
---

# Architecture

Motrix keeps its product core host-neutral so it can run behind either the
Electron shell or the Node server and remain replaceable by a future engine.

## Layer Matrix

| Directory | Role | Allowed dependencies |
|-----------|------|----------------------|
| `src/renderer/` | Electron/browser frontend | `@shared/`, renderer-local modules |
| `src/core/` | Host-neutral product core | `@shared/`, host-neutral Node/external libraries |
| `src/main/` | Electron shell and IPC | `@core/`, `@shared/`, Electron |
| `src/preload/` | Electron bridge | pure `@shared/` protocol values/types, Electron |
| `src/server/` | Node/Docker shell | `@core/`, `@shared/`, server libraries |
| `src/shared/` | Cross-layer contracts | pure schemas, constants, data, and utilities only |

## Hard Boundaries

- `src/core/` never imports Electron or `src/main/`.
- `src/renderer/` never imports `src/core/`, `src/main/`, or `src/server/`.
- `src/server/` never imports Electron or `src/main/`.
- `src/shared/` never imports an application layer and contains no IO, timers,
  network access, Electron APIs, or Node-specific APIs.
- Production code never imports `src/test-utils/`; generated builtin plugin
  output is never used as source.

`pnpm run check:boundaries` is the automated baseline, but changed imports
must also be reviewed against the matrix because not every exception is
machine-enforced.

## Dual Transport Contract

The same renderer-facing transport contract serves both hosts:

```text
Electron: renderer -> ElectronTransport -> preload -> main IPC -> core
Browser:  renderer -> HttpWsTransport -> server RPC/events -> core
```

Renderer command/query/event traffic uses `@renderer/lib/transport`. Direct
`window.motrix` access is limited to the Electron transport and narrowly scoped
Electron platform adapters; feature code stays behind those abstractions.
Events return through the selected shell and transport, so renderer state must
not depend on a host-specific channel.

All channel names come from `src/shared/protocol/`. Use `Commands`, `Queries`,
`Events`, and their `Bridge*` counterparts instead of raw strings.

## Engine Adapter

Product-level code targets `EngineAdapter` in
`src/core/engine/engine-adapter.ts`, never aria2 RPC types directly. Concrete
engines translate at the adapter boundary. `EngineSupervisor` is the sole
owner of engine start, stop, and restart lifecycle.
