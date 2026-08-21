---
description: MDXP bridge lifecycle, authorization, transports, and protocol boundaries
paths: ["src/core/bridge/**", "src/core/bridge-receiver/**", "src/main/bridge/**", "src/server/bridge/**", "src/shared/protocol/bridge.ts", "src/shared/schemas/bridge-settings.ts", "src/shared/config/native-messaging-extensions.json", "packages/native-host/**", "docs/bridge-pairing-protocol.md", "package.json"]
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

Approval is proven by typing the pairing code, never by clicking an Allow
button. The dialog shows an 8-symbol Crockford-alphabet code grouped
`XXXX-XXXX` (`mbp1/pairing-code.ts`), lives 120 seconds, and *is* the SPAKE2
password: it never travels a network channel and MUST NOT be logged at any
level (§7.1). A pairing session resolves to one of three identities —
`official`, `attested-non-official`, `unverified` — and `official` is decided
by the immutable allowlist only, never the NM manifest set and never the
user-added trusted-extension registry (§5).

Pair nonces are one-shot, expire after 60 seconds, and are consumed only by
`/pair` — before the route does anything else, so a refused upgrade never
reaches a session or a dialog. Never persist them. `endpoint.json` contains
discovery information and the local CLI bearer token, `localToken`, which is
now dual-purpose: the native-messaging host also derives its §9.2 ticket-MAC
key from it (`ticketKey = HKDF(UTF8(localToken), "MBP1/nm-ticket/v1", "mac",
32)`) but MUST NOT expose it to the extension. `localToken` persists across
bridge restarts — only `serverGeneration` rotates on every start
(`loadOrCreateBridgeIdentity`) — so an NM ticket minted before a restart
downgrades to `unverified` instead of aborting on a stale-generation MAC
mismatch. The nonce route is now `POST /nonce` and requires
`X-Motrix-Bridge: 1`; the former `GET /nonce` is gone and 404s.

While bound to a loopback host, every route and upgrade rejects a `Host` header
that is not `127.0.0.1`, `localhost`, or `[::1]` with the bound port — the §4.3
DNS-rebinding guard. It is inert for a non-loopback bind, which keeps its
existing token + reverse-proxy model.

Nothing SPAKE2-adjacent may be logged at any level: the pairing code, `w`, any
PAKE intermediate, derived keys, MACs, or NM tickets (§11). A `pairError` frame
carries only its nine-code vocabulary (`unsupportedVersion`, `busy`,
`rateLimited`, `codeMismatch`, `expired`, `aborted`, `authFailed`,
`protocolViolation`, `pairingFailed`) and never a step-identifying detail.

The bridge tries the candidate port range 16802–16806 in order and falls back
to an ephemeral port, reported as `degraded`, once every candidate is taken.
`bridge.fixedPort` pins a single port instead and is applied by restarting the
runtime. `endpoint.json` stays the authoritative discovery record for both the
CLI and the Native Messaging host regardless of which port was chosen. The
server shell deliberately keeps its own explicit configured host and port and
never walks the candidate range.

## MBP1 module map

`src/core/bridge/mbp1/` implements `docs/bridge-pairing-protocol.md`:
`canonical.ts` (§2 encoding primitives), `scrypt-w.ts` (§6.2 password-to-scalar
derivation), `pairing-code.ts` (§7.1 code generation/display/normalization),
`spake2-core.ts` (§6.3–6.6 the generic SPAKE2 core), `transcript.ts` (§6.4
transcript construction), `reconnect-mac.ts` (§8 reconnect MAC),
`reconnect-rate-limit.ts` (§8 per-origin and global reconnect rate limiting,
deliberately separate from `flood-control.ts`'s §7.3 counters),
`envelope.ts` + `envelope-message-stream.ts` (§10 AEAD framing),
`ticket-verify.ts` (§9 NM ticket verification), `frames.ts` (§6.1/§11 wire
frame schemas and the `pairError` vocabulary), `nonce-service.ts` (§4.2
one-shot pairing nonces), `flood-control.ts` (§7.3 pairing admission limits),
`pre-auth-table.ts` (§4 pre-authentication bookkeeping), `pair-session.ts`
(§6 the `/pair` state machine), `reconnect-session.ts` (§8 the `/v1` state
machine). Alongside it: `../credential-store.ts` (§6.7 durable MBP1
credentials), `../bridge-identity.ts` (§9.2 the persistent `localToken` /
rotating `serverGeneration` loader), and `../endpoint-file-writer.ts` (the
`endpoint.json` writer).

On-disk state lives under `<userData>/bridge/`: `pairing.json`,
`registry.json`, `endpoint.json` (mode 0600), `local-token` (mode 0600), and
`mbp1-credentials.json`.

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
Firefox. It reads `endpoint.json`, probes `GET /discovery` for liveness
(§4.1), and fetches exactly one `POST /nonce` with `X-Motrix-Bridge: 1`
(§4.2) once liveness succeeds — the launch-poll loop probes liveness every
~200ms but never fetches more than one nonce per resolution attempt. It
must not expose the local CLI token itself to the extension or depend on
system Node.js or Electron. Production extension IDs come from
`src/shared/config/native-messaging-extensions.json`; development IDs may
be added only through `MOTRIX_DEV_TRUSTED_EXTENSIONS` and must never ship as
production defaults.

For a `bootstrap` request, the host also mints a §9.2 NM attestation ticket
(`mint_ticket_for_bootstrap` in `main.rs`), returned as `nmTicket` in
`{ action: 'requestPair', port, nonce, nmTicket? }`, whenever every trusted
input is available: an argv-extracted caller identity, an owner-checked
`localToken` and ASCII `generation` from `endpoint.json`, and the
extension's `bindingPub`. A missing input degrades to a ticketless reply
rather than fabricating one — ticketless resolves to `unverified` on the
server, the same outcome as presenting no ticket at all, which is safer
than a structurally broken ticket (§9.2 aborts on that). `localToken`
itself never reaches the wire, only the MAC key it derives.

`endpoint.json`'s `localToken`/`generation` are trusted for minting only
when the file passes a `#[cfg(unix)]` 0600 owner-and-mode check on the
already-open handle (§9.1); a file that fails it still yields a port, but
those two fields are dropped. That check is Unix-only: on Windows,
`localToken` and `generation` pass through unchecked, and the attestation
root rests on default per-user `%APPDATA%` NTFS isolation rather than on
anything this code verifies. §9.1's "0600 owner-only" wording is itself
Unix-specific, so this is not a spec violation — but do not read the
ticket-minting path above as attesting anything stronger than that on
Windows.

The Flatpak companion and broker (`motrix-flatpak-native-host`,
`motrix-native-host-broker`) share `probe.rs`, so they pick up the
`POST /nonce` / `X-Motrix-Bridge: 1` migration, but remain ticketless by
design — neither calls `mint_ticket`. That scope decision stands.

## Verification

Run the global gate in `commit-and-quality.md`, then the scoped bridge checks;
do not encode a fixed test count:

```bash
pnpm exec biome check src/core/bridge/ src/core/bridge-receiver/ src/main/bridge/ src/server/bridge/
pnpm exec vitest run src/core/bridge/ src/core/bridge-receiver/ src/main/bridge/ src/server/bridge/
```
