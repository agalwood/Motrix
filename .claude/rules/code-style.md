---
description: TypeScript naming, import, alias, and schema conventions
paths: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.css", "*.config.ts"]
---

# Code Style

Biome owns formatting and general lint rules; do not duplicate its settings
here. The conventions below cover repository-specific boundaries.

## Naming

- JavaScript, TypeScript, TSX, and stylesheet files use `kebab-case`.
- Conventional qualifiers remain lowercase: `.test`, `.spec`, `.e2e`,
  `.integration`, `.darwin`, and `.win32`.
- Exported classes and React components remain PascalCase even though their
  filenames are kebab-case.
- Rust and Python use `snake_case`; Cargo binary entrypoints may use
  kebab-case to match the executable name.
- Run `pnpm run check:file-names` after adding or renaming files.

## Imports and Aliases

- Use `import type` for type-only imports and `node:` for Node builtins.
- Prefer the configured alias over a deep relative import; local sibling or
  parent imports may remain relative.
- Alias availability is target-specific. Application builds expose
  `@shared`, `@core`, `@renderer`, and `@main` as appropriate; server targets
  may expose `@server`, and tests may expose `@test-utils`.
- Do not assume aliases cross targets: Vitest intentionally has no `@main`,
  and the QuickJS worker exposes only `@shared` and `@core`. Check the target's
  TypeScript and Vite configuration before using an alias.

## Shared Runtime Contracts

Use Zod from `zod` for untrusted external data and cross-layer payloads. A
shared schema is the source of truth for its runtime constraints, inferred
type, and defaults; do not create parallel interfaces or hand-written
validators for the same contract. Pure cross-layer schemas belong in
`src/shared/schemas/`; host-specific validation stays in its owning layer.

## Comments Describe What Exists

A comment in the present tense is a claim about the current code, and readers
act on it. Describe an intended-but-unwritten consumer in the conditional, or
as a `TODO`, and say plainly that nothing does it yet.

This matters most for comments that assert a safety property. Two distinct
bugs shipped behind such comments: a writer documented a "backstop" that
reported failures which nothing reported, and a socket wedged silently
forever; and a getter pair was documented as being read by a wiring layer that
decided when to reconnect, when the only readers were tests. In both cases the
comment was the reason no one looked.

When a guard's justification depends on a case, check that it covers every
case the code now reaches — a rationale that was true when written and is
false for a later-added branch argues for the bug.
