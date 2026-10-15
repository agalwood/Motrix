# AMO reviewer build instructions

This archive contains the human-readable source for Motrix Extension 0.1.12.
The submitted Firefox extension is generated with Vite, CRXJS, TypeScript,
React, and Tailwind CSS, so a source submission is required.

## Environment

- Ubuntu 24.04 LTS (Mozilla's default reviewer environment is suitable)
- Node.js 24.18.0, or another Node.js version satisfying `^22.13.0 || ^24.0.0 || >=26.0.0`
- pnpm 12.4.2
- Network access to the public npm registry during dependency installation

No private registry, environment variable, account, API key, or external
service is required to build the extension.

## Reproduce the Firefox build

From the directory containing this file:

```bash
corepack enable
corepack prepare pnpm@12.4.2 --activate
pnpm install --frozen-lockfile
pnpm run build:firefox
```

The complete unpacked extension is written to `dist/firefox/`. The contents of
that directory match the extension ZIP submitted to AMO. The build command also
runs TypeScript checking and the repository's output verifier.

The Firefox build intentionally excludes the unfinished YouTube adapter. The
same build supports Firefox desktop and Firefox for Android. On Android, where
Native Messaging is unavailable, the UI exposes only the network-based Motrix
Server backend.

## Dependencies and patches

All dependencies are installed from the public npm registry and are pinned by
`pnpm-lock.yaml`. Runtime dependency names and versions are listed in
`package.json`; direct third-party notices are recorded in
`THIRD_PARTY_NOTICES.md`.

The build applies the checked-in
`patches/@crxjs__vite-plugin@2.7.1.patch` and
`patches/@wxt-dev__browser@0.3.0.patch` through pnpm's standard
`patchedDependencies` mechanism. No downloaded or generated files are included
in this source archive.
