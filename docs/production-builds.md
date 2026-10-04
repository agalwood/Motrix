# Production builds

Motrix builds six JavaScript targets: Electron main, preload, the plugin worker,
the desktop renderer, the web renderer, and the Node server with its operator CLI.
Their Vite configurations share `scripts/vite-production-output.ts`.

## Output policy

- Production JavaScript is minified, including whitespace in the server's ES
  library output. Renderer CSS is minified with Lightning CSS.
- Source documentation and optimizer annotations are removed from emitted
  JavaScript. Legal comments and the packaged third-party notices are retained.
- Published builds do not emit source maps. The server preserves function and
  class names for diagnostics; runtime logging remains available.
- Main, preload, and worker entry points remain CommonJS `.cjs` files. Server
  and CLI entry points remain ES `.mjs` files. Native modules and external
  dependencies continue to use the existing packaging rules.

## Deferred resources

English and Simplified Chinese translations are loaded with the application.
The other 24 supported languages are separate chunks shipped inside the desktop
package and served locally by Motrix Server. Desktop language switching does not
require an internet connection.

The host and renderer load the requested translation before applying a language
change. Concurrent requests for the same resource share a load, failed loads can
be retried, and a slower renderer request cannot overwrite a newer selection.
The operator CLI loads its selected locale before creating its translator.
Plugin-provided translations keep their existing lifecycle.

The ELK graph layout engine loads when plugin diagnostics first needs a graph
layout. Cached graph layouts do not load or run the engine again.

Code splitting reduces the JavaScript parsed at startup. It does not remove
languages or features from the installed application; extra chunk wrappers can
slightly increase the total renderer output size.

## Measurement and verification

From the repository root, run:

```bash
NODE_ENV=production node scripts/measure-production-bundles.mjs
pnpm exec vitest run tests/scripts/production-build.test.ts
pnpm build
pnpm test:e2e e2e/unit-localization.spec.ts e2e/plugin-call-graph.spec.ts
```

The measurement command builds all six targets in memory and reports raw and
gzip JavaScript bytes, chunk counts, bundled locales, and startup dependencies.
Initial bytes include all entry chunks and their transitive static imports;
dynamic imports are excluded. For the server, this is the combined server and
CLI entry closure, not a measurement of one running process. Gzip bytes sum the
independently compressed chunks and do not represent an installer size.

CI checks startup and total JavaScript budgets, includes all 26 languages,
excludes deferred languages and ELK from initial chunks, and rejects emitted
source maps. The server fixture test also checks that source documentation is
removed while legal attribution, diagnostic names, and executable behavior
survive compression. Platform package verification and runtime smoke tests
remain the authority for installed sizes and native runtime compatibility.
