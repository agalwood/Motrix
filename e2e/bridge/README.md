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
- The other specs here — `pair-and-submit`, `receiver-direct`, `revoke` — are
  `test.skip` stubs for the **browser-extension WebSocket** pairing path
  (deferred), which is distinct from this CLI **HTTP** path.
