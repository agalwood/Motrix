---
description: Engine-neutral domain aggregates, validation, defaults, and errors
paths: ["src/shared/**", "src/core/**"]
---

# Domain Model

## Engine-Neutral Aggregates

Product-level code never exposes aria2 raw types or naming. Aria2 values are
translated at the engine adapter boundary into the aggregates in
`src/shared/types/`:

- `DownloadTask`, `TaskStatus`, and `TaskType` describe task identity and
  lifecycle; `BtExtension` carries BitTorrent-only details.
- `EngineState` and `EngineFeatureReport` describe engine lifecycle and
  detected capabilities without binding consumers to an RPC implementation.
- `AppSettings` is the persisted aggregate; `EngineSettings` and
  `MotrixAppSettings` separate engine-facing and application-facing concerns.
- `GlobalStats` is the cross-engine aggregate used by UI and protocol layers.

Keep managers and stores engine-neutral (`<Domain>Manager`, `<Domain>Store`).
Engine-specific conversion and RPC fields stay under the concrete adapter.

## Schemas and Defaults

- Cross-layer runtime schemas live in `src/shared/schemas/`; core may compose
  them but must not duplicate their constraints.
- Settings schemas use `.catch(safeDefault)` for recoverable persisted values.
- Derive aggregate defaults from the schema, for example
  `const DEFAULTS = schema.parse({})`, so validation and defaults cannot drift.
- Error codes used by settings validation follow
  `settings.{namespace}.{field}` for localization.

## Errors

Use `AppError` and `ErrorCode` from `@shared/errors` for domain failures that
cross a service, transport, or UI boundary. Raw `Error` remains appropriate
for low-level implementation failures that are caught and translated before
leaving their owning layer.
