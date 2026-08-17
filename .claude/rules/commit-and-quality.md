---
description: Required commit gate and change-specific validation
---

# Commit & Quality Gate

## Required for Every Commit

Run all three commands and fix failures before committing:

```bash
pnpm run check:boundaries
pnpm run lint
pnpm exec tsc --noEmit
```

`pnpm run lint` (`biome check .`, scoped by biome.json) is the same command
CI runs — do not substitute a narrower path list, and never pipe it in a way
that discards its exit code.

`check:boundaries` is an automated baseline, not a complete architecture
proof. Review changed imports against `architecture.md` as well.

Stage only the intended files or hunks, then inspect `git diff --staged` and
run `git diff --cached --check`. Do not hide failures because a CI job is
non-blocking.

## Change-Specific Checks

Run every check that matches the change:

- Behavior or logic: focused tests with `pnpm exec vitest run <test-path>`;
  use `pnpm test` for broad cross-cutting changes.
- Browser/Electron user flows: `pnpm test:e2e` when the affected flow has E2E
  coverage.
- Locale resources or i18n behavior: `pnpm run check:i18n`.
- Added or renamed files: `pnpm run check:file-names`.
- Plugin manifest contracts or `@motrix/plugin-manifest-schema`:
  `pnpm run check:schema-parity`.
- Dependencies, bundled assets, or license metadata:
  `pnpm run check:third-party-notices`.
- Native host Rust:
  ```bash
  cargo fmt --manifest-path packages/native-host/Cargo.toml --all -- --check
  cargo clippy --manifest-path packages/native-host/Cargo.toml --all-targets --locked -- -D warnings
  cargo test --manifest-path packages/native-host/Cargo.toml --locked --all-targets
  ```
- Packaging or release code: run the focused tests under `tests/scripts/` and
  the relevant verifier. Follow workflow-supplied arguments for checks such as
  `check:update-artifacts`.

Use `pnpm exec biome check --write .` only for reviewed, auto-fixable
issues; re-run the required gate afterward.
