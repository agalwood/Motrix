---
description: MDXP bridge lifecycle, authorization, transports, and protocol boundaries
paths: ["src/core/bridge/**", "src/core/bridge-receiver/**", "src/main/bridge/**", "src/server/bridge/**", "src/shared/protocol/bridge.ts", "src/shared/config/native-messaging-extensions.json", "packages/native-host/**", "package.json"]
---

# Bridge (MDXP / JSON-RPC 2.0)

The bridge uses JSON-RPC 2.0 over WebSocket and HTTP. The
[`@motrix/mdxp`](https://github.com/motrixapp/mdxp) package is the source of
truth for wire schemas, method constants, types, errors, and connection
behavior; its version comes from `package.json`. Do not recreate MDXP schemas,
numeric error codes, or the removed legacy frame protocol in this repository.
Import `ErrorCodes` and `makeMdxpError` from the package.

## Pairing and session lifecycle

- Extension WebSockets speak MBP1 (`docs/bridge-pairing-protocol.md`), which
  authenticates *below* MDXP. `/pair?nonce=...` runs the §6 first-pair
  handshake and `/v1` the §8 challenge–response; `/v1` carries **no**
  credential in its URL and a `?token=` query is ignored. Only once a route
  authenticates does MDXP start, inside the §10 AEAD envelope, and
  `motrix/initialize` is the client's first request there.
- `WebSocketBridgeServer` always owns and registers `motrix/initialize`.
  Shell-provided download handlers are registered separately and must be wired
  before `server.start()`; never expose a listener with incomplete handlers.
- Authorization and readiness are different states. Every extension WebSocket
  session is authorized **at the transport**: `adoptAuthenticatedSession` marks
  the connection before registering a handler, and `motrix/initialize` is a
  capabilities exchange that grants nothing and never returns a `pairToken`.
  The `authorizedDispatch` gate over control-plane and download methods stays
  as defence in depth. Unary HTTP separately requires its bearer-token and
  agent-facing gates.
- The six MBP1 `BridgeServerOptions` (`instanceId`, `serverGeneration`,
  `appVersion`, `credentials`, `isOfficialId`, `queueMbp1Dialog`) resolve as a
  unit. A server missing any one of them has no extension WebSocket surface at
  all: both upgrades are refused rather than falling back to an
  unauthenticated one.
- A connection becomes ready only after the peer sends the
  `motrix/initialized` notification. Providers passed to
  `UrlResolutionService` must filter to ready connections before sending
  server-initiated `url/probe` or `url/resolve` requests.
- The connection close handler removes its own current session and disposes the
  connection. Do not mutate the server's session map from feature code.

Pair nonces are one-shot, expire after 60 seconds, and are consumed only by
`/pair` — before the route does anything else, so a refused upgrade never
reaches a session or a dialog. Never persist them. `endpoint.json` contains
discovery information and a separate local CLI bearer token. The nonce route is
now `POST /nonce` and requires `X-Motrix-Bridge: 1`; the former `GET /nonce` is
gone and 404s.

While bound to a loopback host, every route and upgrade rejects a `Host` header
that is not `127.0.0.1`, `localhost`, or `[::1]` with the bound port — the §4.3
DNS-rebinding guard. It is inert for a non-loopback bind, which keeps its
existing token + reverse-proxy model.

## Dispatch and transport exposure

`MdxpDispatcher` owns request-schema `safeParse` validation and returns
`InvalidParams`; handlers and `BridgeReceiver` receive typed data and enforce
business rules only. Keep `@core/bridge/` transport-neutral: the only production
file there allowed to import `ws` is `web-socket-bridge-server.ts`. Other files
use `WebSocketLike` from `web-socket-message-stream.ts`.

For every new MDXP method:

1. Define and publish its schema and method constant in the MDXP repository,
   then bump the published dependency here. Never commit a machine-local
   `link:` or `file:` dependency.
2. Register the schema and typed handler in the dispatcher. Use
   `setHandlers()` only for shell-supplied extension methods; shared
   control-plane methods belong in `registerReadHandlers` or
   `registerWriteHandlers`.
3. Choose and test exposure explicitly: unary HTTP, extension WebSocket, or
   both. Do not assume dispatcher registration exposes every transport.
4. For client notifications, register `conn.onNotification`. For outbound
   notifications, publish through `BridgeEventBus` and let the shell call
   `conn.sendNotification(Notifications.*, params)`. For outbound requests,
   use a domain service and pass a `CancellationToken` when work is cancellable.

Paired extensions may use the WebSocket control plane for `task/list`,
`task/get`, `task/pause`, `task/resume`, `task/remove`, `stats/get`, and
`engine/status`; keep the `dispatcher.has()` and authorization gates.
`download/add` is unary-only, while extensions submit through
`download/submit`. Renderer-only plural task commands must not enter MDXP.
Unary `/mdxp` admits only methods marked agent-facing; dispatcher registration
must not make extension handshake or submit methods reachable over HTTP.
Authenticated SSE streams must close when their pairing token is revoked.

Renderer-initiated URL resolution enters main through `BridgeQueries.*`; main
then sends MDXP `url/probe` / `url/resolve` requests to ready extensions. Use
the shared channel constants. For cancellation, renderer supplies a request ID,
main owns its `CancellationTokenSource`, and the matching cancel query aborts it.

## Native Messaging host

`packages/native-host/` is a standalone Rust executable spawned by Chromium or
Firefox. It reads only the endpoint port, fetches a nonce over loopback, and
returns `{ action: 'requestPair', port, nonce }`. It must not expose the local
CLI token or depend on system Node.js or Electron. Production extension IDs
come from `src/shared/config/native-messaging-extensions.json`; development IDs
may be added only through `MOTRIX_DEV_TRUSTED_EXTENSIONS` and must never ship as
production defaults.

**Pending migration — do not treat the host as MBP1-ready.** `probe.rs` still
issues `GET /nonce` with no custom header, which the bridge now 404s, so the
shipped host's `requestPair` path is broken until it is ported to `POST /nonce`
with `X-Motrix-Bridge: 1`. Nothing in CI catches this: the host's own test
asserts the old request line, so it passes against a server that no longer
serves it. The port is tracked separately and is a release gate for the MBP1
branch.

## Verification

Run the global gate in `commit-and-quality.md`, then the scoped bridge checks;
do not encode a fixed test count:

```bash
pnpm exec biome check src/core/bridge/ src/core/bridge-receiver/ src/main/bridge/ src/server/bridge/
pnpm exec vitest run src/core/bridge/ src/core/bridge-receiver/ src/main/bridge/ src/server/bridge/
```
