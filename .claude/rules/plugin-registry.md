---
description: Plugin registry wire, locale, query, consent, and install contracts
paths: ["src/shared/schemas/registry*", "src/core/plugin/registry/**", "src/core/plugin/install/**", "src/core/plugin/manifest/parse*", "src/renderer/routes/plugins/**", "src/main/platform/protocol-manager*", "src/main/ipc/queries.ts", "src/main/ipc/commands.ts", "src/server/ipc/queries.ts", "src/server/plugin/install-service.ts"]
---

# Plugin Registry

The app consumes the registry v2 wire contract published at
`https://dl.motrix.app/registry/plugins.json`. The external registry repository
owns the source schema; this app vendors a tolerant schema, listing resolver,
fixture, and conformance corpus.

## Wire and Conformance

- Published v2 evolution is additive-only. Never rename, retype, or remove a
  field. Coordinate schema changes across the registry publisher, this app,
  and website, including the byte-identical fixture and all conformance
  channels.
- Parse registry data with the vendored Zod schema. Unknown additive fields
  and category slugs remain wire-valid; narrow them only at presentation
  boundaries. Invalid responses preserve the last-good cache rather than
  crashing marketplace UI.
- `listing.defaultLocale` and the open `listing.localizations` map use the
  registry BCP 47 profile independently of the app's `SupportedLocale`.
  Resolve display/search text through the shared field-level resolver and do
  not infer sibling regions such as `zh-TW -> zh-CN`.

## Install and Consent

- Allowlist the initial HTTPS package URL. Accept redirects only with bounded
  streaming, then verify final size and the registry SHA-256 before parsing
  the manifest.
- Parsed manifest `id`, `version`, and `engines.motrix` must equal the registry
  entry. Its required, optional, and host permissions must each be a subset of
  the corresponding registry preview. Any mismatch aborts installation, and
  grants always derive from the parsed manifest.
- Reserved publisher namespaces remain unavailable to community manifests.
  Incompatible entries remain viewable but not installable.
- `motrix://plugins/<id>` is navigation-only. It must not encode or trigger an
  install; every installation requires the in-app consent flow.

## Query Contract

Both Electron and server handlers expose
`Queries.ListRegistryPlugins` / `Queries.GetRegistryPlugin`, delegate to the
same `RegistryClient` semantics, and return compatibility information. Keep
these shared query payloads host-independent; do not create renderer- or
shell-specific mirrors or raw channel names.
