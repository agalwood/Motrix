# CLAUDE.md

## Project

`@motrix/torrent` is a host-neutral ESM library for bounded bencode, BitTorrent
v1/v2/hybrid metainfo and magnet URIs. Motrix consumes the published npm package;
application IO, engine support, filesystem policy and UI belong in Motrix.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

`pnpm check` runs repository lint, strict source/test types, Node tests, the ESM
build, and a packed-package consumer check. Browser evidence goes in ignored
`output/playwright/`. Keep all protocol fixtures and license notices intact.

## Boundaries

- `src/` has no Node, filesystem, network, Buffer or WebCrypto requirement.
- Keep SHA implementations in `@noble/hashes`; do not write new hash primitives.
- Identity hashes use original info bytes. Retain raw path components and
  unknown extensions; do not silently normalize them or imply download support.
- Keep decoding/encoding budgets, exact bigint arithmetic, duplicate detection,
  complete piece-layer verification and hybrid layout checks. Never relax a
  validator to accommodate a malformed test fixture.
- Never copy or eagerly expand full piece tables when a borrowed view suffices.
- Test package exports using packed ESM artifacts as well as source-level tests.

## Workflow

Use Conventional Commits in English without automatic AI attribution. Speak
Chinese with the maintainer; code, identifiers and comments are English.
Keep English and Chinese README files aligned. Never commit credentials,
private notes, machine-specific paths, node_modules or build outputs.

Run `pnpm check` before commits and browser CI before releases. Publish only
when the user explicitly requests it, from a tested commit with a matching
`v<version>` tag. Never overwrite a published version or merge an application
PR as an incidental part of a package release. The initial release uses the
maintainer's authenticated npm CLI; subsequent releases can use the trusted
publisher workflow once npm trust is configured.
