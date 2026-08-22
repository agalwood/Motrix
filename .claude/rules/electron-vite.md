---
description: Build outputs, Electron loading policy, pnpm scripts, and native ABI boundaries
paths: ["electron-builder.json", "pnpm-workspace.yaml", "package.json", "Dockerfile", "vite.*.config.ts", "scripts/dev.mjs", "scripts/postinstall.mjs", "scripts/ensure-electron-runtime.mjs", "scripts/ensure-native-abi.mjs", "scripts/native-binary-target.mjs", "scripts/stage-*-app.mjs", "scripts/verify-*-package.mjs", "scripts/before-*-*.mjs", "src/main/index.ts", "src/main/window/renderer-url-policy*", "src/main/window/window-manager*", "src/preload/**"]
---

# Electron + Vite

## Required Artifacts

| Target | Output |
|--------|--------|
| Electron main | `dist/main/index.cjs` |
| preload | `dist/preload/preload.cjs` |
| QuickJS worker | `dist/core/plugin/host/quick-js-worker.cjs` |
| Electron renderer | `dist/renderer/` |
| Node server and CLI | `dist/server/index.mjs`, `dist/server/motrix-admin.mjs` |
| browser renderer | `dist/renderer-web/` |

Because `package.json` declares `"type": "module"`, main, preload, and worker
outputs must remain `.cjs`; server outputs remain `.mjs`. The package `main`
field must match the main artifact. Build entries sharing an output directory
must have unique basenames, and every consuming `build:*` flow must produce
the entries it packages.

## Preload and Renderer URL Policy

At runtime `__dirname` is `dist/main/`, so the preload path is:

```ts
path.join(__dirname, '../preload/preload.cjs')
```

Renaming or moving either artifact requires updating this path. Pass
`VITE_DEV_SERVER_URL` once to `initializeRendererUrlPolicy()` and load every
renderer window through `rendererUrlPolicy.loadWindow(win, route)`. Do not add
feature-local `loadURL()` or `loadFile()` calls that bypass its loopback-origin
and packaged-file checks.

## pnpm and Native ABI

- Project pnpm settings belong in `pnpm-workspace.yaml`. Keep `nodeLinker:
  hoisted` unless the Electron packaging smoke job proves isolated linking
  works.
- Install-script permission is controlled by pnpm 11 `allowBuilds`. Keep
  `electron` allowed for compatibility, but do not rely on `pnpm install` to
  hydrate Electron 43: it exposes `install.js` as a package bin without a
  `postinstall` script. Local workflows that consume Electron or its licenses
  must run `pnpm run ensure:electron-runtime` first; that command validates the
  entire payload and repairs partial installs safely. CI/container workflows
  may invoke `install.js` directly when they immediately validate the result.
- Native modules such as `better-sqlite3` must match the active ABI. Tests use
  the Node ABI; Electron and E2E use the Electron ABI. Preserve the
  `ensure-native-abi.mjs` hooks when changing test or start scripts.
- `postinstall.mjs` independently controls Electron rebuild and aria2 fetch
  through `MOTRIX_SKIP_ELECTRON_REBUILD` and `MOTRIX_SKIP_ENGINE_FETCH`.
  Skipping one must never imply skipping the other.
- If Electron or a native dependency changes, rebuild for the intended target
  and exercise the corresponding Node and Electron paths.

## Server Docker Boundary

The server image uses system aria2 and skips both Electron rebuild and engine
fetch. `stage-server-app.mjs` selects one target-platform `better-sqlite3`
prebuild, and `verify-server-package.mjs` verifies the staged payload. The
runtime image intentionally has no pnpm or build toolchain; never rely on a
runtime native rebuild.
