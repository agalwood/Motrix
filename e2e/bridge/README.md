# Bridge E2E — `motrix-cli` ↔ Electron / Server

End-to-end acceptance for the **MDXP bridge** as exercised by the real
[`motrix` CLI](https://github.com/motrixapp/cli) — the published `@motrix/cli`
npm package, consumed here as a devDependency — covering the two halves the
product promises — **device-code pairing** and **download invocation** —
against **both** runtime shells:

| Leg | File | Runner | Shell under test |
|-----|------|--------|------------------|
| Electron | [`cli-pair-and-download.spec.ts`](./cli-pair-and-download.spec.ts) | Playwright | packaged Electron app (`dist/main/index.cjs`) |
| Server | [`server-leg.mjs`](./server-leg.mjs) | standalone `node` | headless Node shell (`dist/server/index.mjs`) |

Both drive the **real CLI binary** and a **real `aria2`** download (a local,
throttled, deterministic HTTP fixture — no public network), and assert the full
arc: pair → approve → token → `download/add` → `completed` → on-disk bytes →
`watch` SSE, plus adversarial probes (wrong token → exit 4, one-time token
delivery, deny, and — on the server — the Spec 9 self-approval-bypass).

> **Why two different forms?** The Electron app and the Node server need
> **opposite `better-sqlite3` native ABIs** and cannot share one `node_modules`.
> The Electron leg lives in the standard Playwright suite; the server leg is a
> standalone `.mjs` run against a separate **node-ABI build** (a git worktree).

---

## Prerequisites

- `pnpm install` has been run at least once in the main checkout.
- **`aria2`**: the bundled binary at `extra/<platform>/<arch>/aria2c` is used
  automatically (on macOS/arm64 nothing else is needed). Override with
  `MOTRIX_ARIA2_BIN` if you want a system `aria2c`.
- The `@motrix/cli` CLI: installed automatically by `pnpm install` (it is a
  devDependency). The E2E resolves its bundled bin from `node_modules` — there
  is no in-tree build step for the CLI anymore.

---

## Electron leg (Playwright)

The main checkout must carry the **Electron** `better-sqlite3` ABI (the default
after `pnpm install` / `pnpm start`). If you have previously run
`pnpm start:server` in this checkout, restore it first:

```bash
pnpm run rebuild:for-electron
```

Build and run:

```bash
pnpm build:electron                       # dist/{main,preload,renderer,worker}
pnpm exec playwright test e2e/bridge/cli-pair-and-download.spec.ts
```

Notes:

- The spec launches the **real** Electron app per test and approves pairing via
  `window.motrix.invoke('bridge:resolvePair', …)` — the exact IPC the
  PendingApprovalsSection "Approve" button calls.
- Electron opens **headed** windows during the run. On a desktop macOS session
  this is fine; on Linux CI use `xvfb-run`.
- `pnpm test:e2e` (the full suite) also picks this spec up via the `*.spec.ts`
  glob.

---

## Server leg (standalone driver)

### One-time: build a node-ABI server in a sibling worktree

Keeps the main checkout on its Electron ABI; the worktree carries the Node ABI.

```bash
git worktree add --detach ../motrix-turbo-srv HEAD
cd ../motrix-turbo-srv
MOTRIX_SKIP_ELECTRON_REBUILD=1 pnpm --config.dangerouslyAllowAllBuilds=true install
pnpm build:server                         # dist/server + dist/renderer-web
cd -
```

`--config.dangerouslyAllowAllBuilds=true` makes the install run
`better-sqlite3`'s own build script under Node (→ Node ABI) and satisfies
pnpm 11's deps-check, so `build:server` does not silently reinstall and revert
the ABI. `MOTRIX_SKIP_ELECTRON_REBUILD=1` skips the Electron rebuild in
`postinstall`.

### Run (repeatable)

```bash
node e2e/bridge/server-leg.mjs
```

Exit `0` = all checks passed, `1` = a check failed, `2` = the server build is
missing (rebuild the worktree).

---

## Remote browser Extension leg (Chromium + Firefox)

This gate starts the real Server MBP1 runtime behind a local HTTPS/WSS reverse
proxy and drives the production Extension builds in both browsers. It covers
fresh pair, authority-scoped consent, sensitive header/Cookie stripping,
browser restart reconnect, Server restart reconnect, durable revoke, and
re-pair through both a `/bridge` reverse-proxy prefix and the proxy root. A
separate Chromium case keeps two independent Servers paired in one persistent
profile, proves consent does not leak between them, and verifies submissions
follow the selected authority. The Firefox assertion also requires the
ticketless remote identity to remain `unverified`.

Build both Extension variants in the Extension checkout, then run from Motrix:

```bash
pnpm --filter @motrix/extension build:chromium
pnpm --filter @motrix/extension build:firefox

MOTRIX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/chromium \
MOTRIX_FIREFOX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/firefox \
pnpm test:e2e:remote-extension
```

Before Playwright starts, the command verifies
`remote-extension-threat-evidence.json`: every T01–T29 threat must retain at
least one mapped test file and title across the two repositories. The Extension
checkout is inferred from `MOTRIX_EXTENSION_BUILD`; set
`MOTRIX_EXTENSION_REPO` explicitly only when the build lives outside its
checkout. A removed/renamed test, missing threat, unsafe path, or symlinked
evidence file fails the gate.

Optional executable overrides are `MOTRIX_CHROMIUM_EXECUTABLE` and
`MOTRIX_FIREFOX_EXECUTABLE`. The Firefox runner uses WebDriver BiDi's standard
temporary-extension install command. Browser certificate bypasses are confined
to this local test profile; the separate WSS integration suite proves trusted
CA success and unknown-CA, expired, and wrong-host rejection without bypasses.
Use Playwright's matching Chrome-for-Testing/Chromium build for Chromium. Some
stable Google Chrome releases ignore automated unpacked-extension flags and
will time out waiting for the Extension service worker; an explicit executable
override must still point to a build that supports that test mode.

### Pinning the compatible repository revisions

The browser harness is a cross-repository contract. Do not record the current
working-tree `HEAD` values before the implementation changes are committed.
Create one implementation commit in each repository first, then copy
`remote-extension-compatibility.example.json` to
`remote-extension-compatibility.json` and replace both placeholders with those
full 40-character lowercase commit SHAs. Verify the resulting pin from Motrix:

```bash
pnpm check:remote-extension-compatibility \
  --manifest e2e/bridge/remote-extension-compatibility.json \
  --motrix-repo . \
  --extension-repo /absolute/path/to/motrix-extension
```

The verifier rejects placeholders, short or uppercase SHAs, protocol drift,
fewer than five browser cases, a commit from the wrong repository, and any pin
that is not an ancestor of the corresponding checkout's `HEAD`. Commit the
verified manifest in a later Motrix commit; this avoids a self-referential
Motrix SHA and makes the exact implementation pair reviewable.

### Beta soak

The soak runner repeats the same threat-gated five-case suite; one failing
repetition fails the command. Its default is 20 repetitions / 100 browser
cases, bounded to 100 repetitions so a bad environment cannot accidentally
create an unbounded job:

```bash
MOTRIX_CHROMIUM_EXECUTABLE=/path/to/chrome-for-testing \
MOTRIX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/chromium \
MOTRIX_FIREFOX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/firefox \
MOTRIX_REMOTE_EXTENSION_SOAK_REPEATS=20 \
pnpm test:e2e:remote-extension:soak
```

Archive the full output together with OS, browser versions, both implementation
SHAs, repeat count, start/end time, and any proxy/network fault injection. A
single ordinary E2E pass is regression evidence, not completion of the beta
soak gate.

For the release gate, use the evidence-producing wrapper after the compatible
SHA manifest has been committed:

```bash
MOTRIX_CHROMIUM_EXECUTABLE=/path/to/chrome-for-testing \
MOTRIX_FIREFOX_EXECUTABLE=/path/to/firefox \
MOTRIX_EXTENSION_REPO=/absolute/path/to/motrix-extension \
MOTRIX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/chromium \
MOTRIX_FIREFOX_EXTENSION_BUILD=/absolute/path/to/motrix-extension/packages/ext/dist/firefox \
MOTRIX_REMOTE_EXTENSION_SOAK_EVIDENCE_DIR=/absolute/archive/remote-extension-soak \
MOTRIX_REMOTE_EXTENSION_SOAK_FAULTS=none \
pnpm test:e2e:remote-extension:release-soak
```

Release mode requires exactly 20 repetitions, clean repositories, Extension
`HEAD` equal to its pin, and no Motrix changes after its implementation pin
except the compatibility-manifest commit. After that source preflight it
rebuilds both Extension variants from the pinned checkout, rejects build paths
outside their expected repository directories or symbolic links, and hashes
the fresh output. It records explicit browser versions and OS details, and
writes `evidence.json` plus the full Playwright `playwright-report.json`. The
report must parse to exactly 100 passed browser cases with no top-level or case
errors. A failed browser run is archived as failed; a zero exit with a missing
or invalid JSON report is archived as incomplete and still fails the gate. The
evidence directory must not already exist, so a later run cannot overwrite an
earlier record.

## Server leg maintenance

### Env overrides (all optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `MOTRIX_SERVER_DIR` | `../motrix-turbo-srv` | node-ABI build dir |
| `MOTRIX_E2E_WEB_PORT` | `8090` | web / operator control-plane port |
| `MOTRIX_E2E_MDXP_PORT` | `16801` | MDXP bridge port |
| `MOTRIX_ARIA2_BIN` | bundled | `aria2c` binary |

### Refresh the worktree after pulling new code

```bash
cd ../motrix-turbo-srv
git fetch && git checkout --detach origin/main      # or the branch under test
pnpm build:server                                   # re-run the install above if deps changed
cd -
```

### Cleanup

```bash
git worktree remove --force ../motrix-turbo-srv
```

---

## Gotchas

- **CLI auto-discovery is darwin-hardcoded** to
  `~/Library/Application Support/Motrix/bridge/endpoint.json` — it only finds the
  **Electron** bridge, never the server. The server leg therefore always passes
  `--endpoint http://127.0.0.1:<mdxp-port> --token <localToken>` explicitly.
- **Pairing approval is a deliberate human step** (no headless auto-approve).
  The tests drive the *real* approval surface: `bridge:resolvePair` IPC on
  Electron, and the operator-gated `POST /rpc/command/bridge:resolvePair` on the
  server.
- `remote-extension-wss.spec.ts` and
  `remote-extension-firefox-wss.spec.ts` are the active browser-extension WSS
  lifecycle gates. The older `pair-and-submit`, `receiver-direct`, and `revoke`
  files remain narrow placeholder scenarios and are not used as coverage proof.
