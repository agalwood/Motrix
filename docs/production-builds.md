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
- Only renderer builds copy `public/` icons and images. Host, preload and worker
  builds exclude these browser assets to avoid duplicate packaged files.
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

The ELK graph layout engine runs in a dedicated, locally bundled browser Worker.
Its code stays out of the initial renderer bundle, and parsing and layout do not
block the UI thread. The engine is shared for the lifetime of the window;
matching cached graph layouts skip another layout request. Worker errors and
30-second request timeouts invalidate the engine so the existing Retry action
can recreate it.

On desktop, entering the plugins page schedules preparation after a 200 ms
settling delay and an idle opportunity. Pointing at, focusing, or pressing the
diagnostics link starts preparation immediately. Preparation includes a tiny
two-node layout and shares initialization with navigation. Leaving the page
cancels work that has not started; hidden windows skip speculative loading.
Web clients load the Worker on demand. Dashboard, downloads, settings, and plugin
routes remain eager; opening the app does not preload every language or feature.

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
Total JavaScript bytes include Worker assets, which Vite emits separately from
application chunks.
Initial bytes include all entry chunks and their transitive static imports;
dynamic imports are excluded. For the server, this is the combined server and
CLI entry closure, not a measurement of one running process. Gzip bytes sum the
independently compressed chunks and do not represent an installer size.

CI checks startup and total JavaScript budgets, includes all 26 languages,
excludes deferred languages and ELK from initial chunks, and rejects emitted
source maps or public assets copied into host builds. The server fixture test
also checks that source documentation is removed while legal attribution,
diagnostic names, and executable behavior survive compression. Platform package
verification and runtime smoke tests remain the authority for installed sizes
and native runtime compatibility.

The migration assistant brings the complete main-process JavaScript output to
approximately 5.09 MiB, including its services and translations in all 26
languages. Its total budget is 5.25 MiB; the startup budget remains 2 MiB.
Budgets for the other five targets are unchanged.

## Desktop navigation comparison

Build each revision with `pnpm build:electron` in a separate checkout with its
own dependencies. Then run from the candidate checkout:

```bash
pnpm measure:desktop-navigation --variant baseline=../Motrix-baseline --variant optimized=. --samples 5 --cpu-rates 1,4
```

The baseline checkout must remain unchanged during the run. Both applications
run with the same Electron runtime from the candidate checkout. Each observation
uses a fresh process and temporary profile seeded with the same 48-node,
90-edge call history. Variant order alternates each round. The report preserves
all samples at `output/playwright/manual/desktop-navigation/results.json`,
including application artifact hashes, startup time, settings/downloads/plugins
navigation, first and repeat graph openings, long tasks, and frame gaps.

Three scenarios distinguish a direct click, pointer intent with 300 ms lead
time, and 500 ms spent idle on the plugins page. Navigation timing starts at
programmatic link activation and ends after visible graph nodes and a paint
opportunity; it excludes automation round trips. The preparation interval is
measured separately to detect work merely shifted before the click. Renderer
blocking time sums the portions of long tasks above 50 ms. Frame gaps measure
`requestAnimationFrame` spacing, not input-to-paint latency.

CPU throttling starts after the shell is ready. It stresses the renderer main
thread; it does not reproduce slower disks, IPC, or uniformly slower Worker
execution on a low-end computer. OS file caches are not flushed. Five samples
per case support a local comparison, not a tail-latency or no-jank guarantee.

Measured on 2026-10-04 with Apple M4 / macOS arm64, Electron 44.5.0 and production
React. The baseline is `62207e06` (language/code splitting already enabled); the
candidate adds the dedicated Worker and desktop preparation. There are 60 fresh
process observations: 5 per variant, CPU rate, and scenario. Times below are
milliseconds, shown as **median / observed maximum**.

| CPU | First graph scenario | Baseline visible | Optimized visible | Baseline blocking | Optimized blocking |
| --- | --- | ---: | ---: | ---: | ---: |
| 1× | Direct click | 145.8 / 145.9 | 129.1 / 129.3 | 12 / 13 | 0 / 0 |
| 1× | Pointer intent | 169.7 / 172.0 | 95.6 / 103.9 | 13 / 14 | 0 / 0 |
| 1× | Idle on plugins page | 145.5 / 171.7 | 93.4 / 107.2 | 12 / 15 | 0 / 0 |
| 4× | Direct click | 488.9 / 491.1 | 241.9 / 256.2 | 213 / 220 | 10 / 11 |
| 4× | Pointer intent | 490.8 / 491.5 | 191.0 / 192.3 | 211 / 213 | 9 / 11 |
| 4× | Idle on plugins page | 491.8 / 492.0 | 191.5 / 205.6 | 214 / 221 | 9 / 10 |

Normal pages aggregate 15 observations per variant and CPU rate:

| CPU | Page | Baseline visible | Optimized visible |
| --- | --- | ---: | ---: |
| 1× | Settings | 31.9 / 34.8 | 28.9 / 35.0 |
| 1× | Downloads | 29.4 / 30.6 | 29.5 / 29.9 |
| 1× | Plugins | 29.1 / 30.7 | 29.2 / 29.8 |
| 4× | Settings | 35.8 / 41.1 | 34.7 / 50.1 |
| 4× | Downloads | 57.7 / 75.0 | 57.4 / 77.5 |
| 4× | Plugins | 39.0 / 41.3 | 40.2 / 44.0 |

No main-thread long tasks were observed during the measured preparation intervals
or normal-page navigation. Optimized preparation frame gaps peaked at 18.7 ms.
For direct graph opening under 4× throttle, the median largest frame gap fell
from 266.8 to 66.6 ms; graph rendering still contributes work on the main thread.
Repeat graph opening in that scenario fell from 223.7 / 224.0 to 122.9 / 127.1 ms.
Startup medians stayed around 559–567 ms. This run supports keeping ordinary
routes eager while moving graph computation off-thread; it does not establish
zero stutter across all devices.
