# Contributing to Motrix

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for contributing to Motrix. Code, tests, documentation, translations, issue reports, and design feedback are all valuable ways to improve the project.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report suspected vulnerabilities privately according to the [Security Policy](SECURITY.md); never disclose them in a public issue, discussion, or pull request.

## Choose the Right Channel

- Search the [open and closed issues](https://github.com/agalwood/Motrix/issues?q=is%3Aissue) before creating a new report.
- Use the repository's [issue forms](https://github.com/agalwood/Motrix/issues/new/choose) for reproducible bugs and focused feature requests.
- Use [GitHub Discussions](https://github.com/agalwood/Motrix/discussions) for support questions, usage guidance, and ideas that are not yet ready to become an issue.
- Discuss significant features, architecture changes, new dependencies, and breaking changes before investing in an implementation.
- Keep each issue and pull request focused on one problem or capability.

## Prepare a Development Environment

Development requires Git, Node.js 22 or later, and the pnpm version declared in the `packageManager` field of `package.json`.

Fork the repository if you do not have write access, then clone your fork and install the dependencies:

```bash
git clone https://github.com/<your-account>/Motrix.git
cd Motrix
pnpm install
pnpm start
```

By default, `pnpm start` uses a separate user-data profile next to the regular Motrix profile (normally `Motrix-dev`), so development does not modify the installed application's data. To select another directory, set `MOTRIX_USER_DATA` to its absolute path before running `pnpm start`.

Create your development branch from the latest `main` and target `main` with your pull request. The legacy `master` branch only preserves the v1 codebase and is frozen; do not submit new changes to it.

Branch names use `<type>/<snake_case_topic>_<YYYYMMDD>`. You may place an issue number before the topic when one is available, for example `fix/1970_conduct_links_20260826`.

## Understand the Architecture

Motrix Turbo has one host-neutral product core behind two application shells: an Electron desktop application and a Node/Web server. The shared renderer runs in both environments. This separation keeps product behavior reusable, prevents Electron concerns from leaking into the server, and allows the download engine to be replaced behind a stable adapter.

### Layer Responsibilities

| Directory | Responsibility | Dependency boundary |
| --- | --- | --- |
| `src/renderer/` | Shared Electron/browser user interface | Imports `@shared/` and renderer-local modules. Product behavior is accessed through `@renderer/lib/transport`. |
| `src/preload/` | Narrow Electron context bridge | Uses Electron and pure protocol values or types from `src/shared/`; it does not contain product behavior. |
| `src/main/` | Electron shell, IPC, windows, menus, and operating-system integration | May compose `src/core/`, `src/shared/`, and Electron-specific adapters. |
| `src/server/` | Node/Docker shell, HTTP/WebSocket endpoints, and server platform integration | May compose `src/core/`, `src/shared/`, and server libraries; it must not import Electron or `src/main/`. |
| `src/core/` | Host-neutral application services, domain behavior, engine orchestration, and plugin policy | May use `src/shared/` and host-neutral libraries; it must not import either application shell. |
| `src/shared/` | Cross-layer schemas, protocol constants, types, locale data, and pure utilities | Must remain free of I/O, timers, network access, Electron APIs, and Node-specific APIs. |
| `packages/native-host/` | Standalone Rust native-messaging host for browser-extension pairing | Communicates through the published bridge contract and does not depend on system Node.js or Electron. |
| `src/test-utils/` | Test-only fixtures and helpers | Must never be imported by production code. |

### Transport and Protocol Flow

The renderer uses the same command, query, and event contract in both hosts:

```text
Electron: renderer -> ElectronTransport -> preload -> main IPC -> core
Browser:  renderer -> HttpWsTransport -> server RPC/events -> core
```

Feature code in the renderer must use `@renderer/lib/transport`; direct `window.motrix` access is limited to the Electron transport and narrowly scoped platform adapters. Channel names and payload contracts belong in `src/shared/protocol/`. Use `Commands`, `Queries`, `Events`, and their `Bridge*` counterparts instead of raw channel strings.

### Engine, Bridge, and Plugin Boundaries

- Product-level code targets `EngineAdapter` in `src/core/engine/engine-adapter.ts`. aria2 RPC types and conversion logic remain inside the concrete aria2 adapter, while `EngineSupervisor` exclusively owns the engine lifecycle.
- MDXP uses JSON-RPC 2.0 over HTTP and WebSocket. The `@motrix/mdxp` package is the source of truth for wire schemas, method constants, error codes, and connection behavior; do not duplicate those contracts locally.
- Host-neutral plugin state, policy, installation, capabilities, and sandbox orchestration live in `src/core/plugin/`. Electron and Node/Docker wiring live in `src/main/plugin/` and `src/server/plugin/`, respectively.
- Plugin guest code runs in a separate QuickJS worker and reaches host behavior only through the typed capability bridge. New host-specific capabilities must be implemented and tested in both capability hosts.

Run `pnpm run check:boundaries` whenever imports or layer responsibilities change. The automated check is a baseline, not a substitute for reviewing the dependency direction described above.

## Follow the Implementation Standards

### Code and Files

- Write code, comments, identifiers, filenames, commit messages, and pull request titles in English.
- Use `kebab-case` for JavaScript, TypeScript, TSX, and stylesheet filenames.
- Use `import type` for type-only imports and the `node:` prefix for Node.js built-ins.
- Prefer the configured alias over deep relative imports, but confirm that the alias is available in the target runtime.
- Add or update tests whenever behavior changes. Production code must not depend on test helpers or generated build output.

### User-Visible Text and Documentation

- Localize all user-visible application and operator text through the existing i18next resources; do not hard-code interface strings.
- Update every registered locale when adding or changing a translation key, and preserve the exact placeholder set across locales.
- When editing one file in an English/Simplified Chinese documentation pair, update the other in the same change. Keep headings, commands, paths, and examples aligned while using idiomatic language in each version.
- Do not commit credentials, private URLs, personal paths, private plans, generated local state, or unrelated changes.

### Commits

Use Conventional Commits:

```text
<type>(<optional-scope>): <imperative summary>
```

Allowed types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, and `style`. Write the summary in lowercase, omit the trailing period, and keep it under 72 characters. Add a body when the rationale is not obvious and a `BREAKING CHANGE:` footer when applicable.

## Validate the Change

Run the required gate before every commit:

```bash
pnpm run check:boundaries
pnpm run lint
pnpm exec tsc --noEmit
```

Run every additional check that matches the change:

- behavior or logic: focused Vitest tests, or `pnpm test` for broad cross-cutting changes;
- covered browser or Electron user flows: `pnpm test:e2e`;
- locale resources or internationalization behavior: `pnpm run check:i18n`;
- added or renamed files: `pnpm run check:file-names`;
- plugin manifest contracts: `pnpm run check:schema-parity`;
- dependencies, bundled assets, or license metadata: `pnpm run check:third-party-notices`;
- native-host Rust code: the formatting, lint, and test commands below.

For native-host Rust changes, run:

```bash
cargo fmt --manifest-path packages/native-host/Cargo.toml --all -- --check
cargo clippy --manifest-path packages/native-host/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path packages/native-host/Cargo.toml --locked --all-targets
```

Review the final diff, run `git diff --check`, and record the exact commands and results in the pull request. Do not suppress failures or discard command exit codes.

## Submit a Pull Request

- Target `main`, link the related issue, and explain both the problem and the chosen solution.
- Complete the pull request template, including the exact validation commands, environments, and results.
- Include screenshots or recordings for visible interface changes.
- Keep generated files and dependency changes limited to what the pull request requires.
- Address review feedback with follow-up commits. Maintainers normally squash feature pull requests when merging.

Contributions are accepted under the repository's [MIT License](LICENSE). Third-party assets may have different terms documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
