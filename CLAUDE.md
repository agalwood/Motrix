# CLAUDE.md

## Project

Motrix Turbo is an Electron and Node/Web download manager. Keep `src/core/`
host-neutral so it can be reused by both shells and replaced independently.

Development happens on **`main`**. The frozen **`master`** branch is the legacy
Electron 22/Vue 2 application. Branch from and target PRs at `main`, never
`master`.

## Core Commands

```bash
pnpm start                         # Electron development runner
pnpm start:server                  # Built Node/Web server
pnpm test                          # Vitest suite
pnpm exec vitest run <test-path>   # Focused test
pnpm run lint                      # Biome over the repository
pnpm exec tsc --noEmit             # Type-check
pnpm build                         # Desktop production build
pnpm build:server                  # Node/Web production build
pnpm test:e2e                      # Playwright suite
```

Use `pnpm exec`, not `npx`. The authoritative commit gate is
`.claude/rules/commit-and-quality.md`.

## Architecture Boundaries

1. `src/core/` never imports `electron` or `src/main/`.
2. `src/renderer/` never imports `src/core/`, `src/main/`, or `src/server/`;
   use `@renderer/lib/transport` with shared protocol constants.
3. `src/shared/` contains pure cross-layer contracts and descriptive runtime
   data only: no IO, timers, network, Electron, or Node-specific APIs.
4. Use `Commands`, `Queries`, `Events`, and their `Bridge*` counterparts from
   `src/shared/protocol/`; never use raw transport channel strings.

## Rule Routing

Rules without `paths` frontmatter are global. Load path-scoped rules only when
their patterns match the files under inspection or modification.

| Rule | Scope |
|---|---|
| `commit-and-quality.md` | Required checks and conditional validation |
| `git-workflow.md` | Commits, branches, PRs, and releases |
| `language-and-docs.md` | Language and public/private documentation |
| `architecture.md` | Layer boundaries and transport flow |
| `electron-vite.md` | Build, packaging, native ABI, and pnpm |
| `code-style.md` | TypeScript, React, CSS, and file naming |
| `renderer.md` | Renderer state, components, forms, and transport |
| `panel-layout.md` | Viewport height and scrolling layout |
| `i18n.md` | Locale catalogs and user-visible strings |
| `domain-model.md` | Shared domain types, validation, and errors |
| `plugins.md` | Plugin sandbox, capabilities, and builtins |
| `plugin-registry.md` | Registry compatibility and install integrity |
| `bridge.md` | MDXP pairing, dispatch, and transports |
