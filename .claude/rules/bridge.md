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
  credential in its URL and every query, including `?token=`, is rejected by
  the raw-route gate. Only once a route
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
(`loadOrCreateBridgeIdentity`) — so an NM ticket minted before a restart takes
the §9.2 semantic-downgrade path instead of aborting on a stale-generation MAC
mismatch: the ticket then contributes nothing, and identity falls back to what
the verified origin alone establishes (§9.2 only-raise — a stale ticket is
never worse than presenting none). The nonce route is now `POST /nonce` and requires
`X-Motrix-Bridge: 1`; the former `GET /nonce` is gone and 404s.

While bound to a loopback host, every route and upgrade rejects a `Host` header
that is not `127.0.0.1`, `localhost`, or `[::1]` with the bound port — the §4.3
DNS-rebinding guard. It is inert for a non-loopback bind, which keeps its
existing token + reverse-proxy model.

`GET /discovery` additionally reports unauthenticated compatibility hints:
`runtime`, `extensionPairing: { protocol: 'mbp1', versions: [1] }`, and
`applicationProtocols: { mdxp: ['1.0'] }`. They may drive an upgrade message,
but never trust, downgrade, or a port pin; authenticated initialization remains
authoritative. The WebSocket parser caps messages at the largest valid active
envelope (1 MiB plaintext + 24 bytes framing), while the state machines retain
their stricter 16 KiB pre-authentication check.

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

## Envelope close codes

Once §10 AEAD framing is active, envelope faults are classified by a
three-state discriminated union — `peer-violation`, `usage-limit`, `internal`
— and by direction. The direction matters: the same `EnvelopeViolationError`
from inbound `open()` means the peer sent something §10 forbids, but from
outbound `seal()` it means our code tried to seal a frame over the 1 MiB
plaintext cap, so it is `internal` rather than the peer's fault.

The close codes are:

- **`1002` (protocol error)**: a §11 protocol violation (bad frame, tampering,
  replay, a post-activation text frame). The peer sent something §10 forbids.
- **`4001` (usage limit)**: a direction reached its §10 frame- or block-count
  usage bound (2^24 frames or 2^30 encrypted AES blocks per direction). This
  is neither side's fault — §10 requires the closure before either bound is
  exceeded, and the remedy — reconnect and derive fresh keys (§8) — is the
  same whichever direction tripped it. RFC 6455 §7.4.2 reserves 4000–4999 for
  exactly this: private use "by prior agreement" between applications. `1002`
  and `1011` cannot be reused: `1002` would accuse the peer of a violation when
  none occurred, `1011` would claim an internal crash for a routine,
  spec-mandated transition. A conforming client reconnects on any established
  channel close (regardless of code) via §8 and derives fresh keys.
- **`1011` (internal error)**: this process is broken (a bug, not a protocol
  event), including an outbound attempt to seal a plaintext over the 1 MiB
  limit. Such a refused write closes the session rather than leaving
  application state half-delivered.

The extension client cannot mirror this table: a browser's `WebSocket.close`
refuses every code outside 1000/3000–4999, so the client sends `4001` for a
usage bound (either direction) and a bare close for everything else (§11).

An explicit extension revoke first marks the live `BridgeConnection`
unauthorized and not-ready, then durably removes every committed/provisional
credential for its verified Origin before updating `PairingService`. The
same Origin's pending `/pair` and `/v1` sessions are synchronously cancelled,
and new upgrades are refused for the whole durable-revocation critical section.
The best-effort `PairRevoked` notification may drain briefly, but dispatch is
already denied; the underlying WebSocket is then closed and its session-map
entry removed.

On-disk state lives under `<userData>/bridge/`: `pairing.json`,
`registry.json`, `endpoint.json` (mode 0600), `local-token` (mode 0600), and
`mbp1-credentials.json`. The writers request 0600 on every platform, but
Node's `chmod` on Windows manipulates only the read-only bit — see the
attestation-root passage under **Native Messaging host** for what that means
for what the host can attest there.

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
`engine/status`, plus the user-gesture-only `task/reveal`; keep the
`dispatcher.has()` and authorization gates. `task/reveal` accepts only a
public task id, derives the path inside the Electron shell, is not agent-facing,
and must never be exposed by unary `/mdxp`. The headless server does not
register it, and `motrix/initialize.capabilities.taskReveal` must be derived
from the dispatcher's actual registration so older/headless peers report it as
unsupported rather than advertising a dead method.
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
~200ms but never fetches more than one nonce per resolution attempt. A
successful liveness probe settles the resolution either way: if the nonce
fetch then fails, `resolve_endpoint` reports `NotRunning` rather than
falling through to a launch, because `fetch_nonce` answers `None` for any
non-2xx — including the 429/503 the §4.2 outstanding-nonce cap and issuance
rate limit return — and retrying there would amplify exactly the load that
caused the refusal.

The **broker** path cannot yet reach one nonce per resolution. `NotRunning`
is all the versioned stdio contract can say, so a live bridge that refuses a
nonce is indistinguishable to the companion from one that is down: it
launches and calls `WaitForEndpoint`, fetching a second nonce. Bounded at two
per resolution and never a loop, but real — separating the two states needs a
broker-protocol response the current contract cannot express without
breaking older companions. It
must not expose the local CLI token itself to the extension or depend on
system Node.js or Electron. Production extension IDs come from
`src/shared/config/native-messaging-extensions.json`; development IDs may
be added only through `MOTRIX_DEV_TRUSTED_EXTENSIONS` and must never ship as
production defaults.

For a `bootstrap` request, the host also mints a §9.2 NM attestation ticket
(`mint_ticket_for_bootstrap` in `main.rs`), returned as `nmTicket` in
`{ action: 'requestPair', protocolVersion: 1, port, nonce, nmTicket? }` —
`protocolVersion` is always emitted, by both `request_pair` and
`request_pair_with_ticket`, and §9.1 makes it normative — whenever every trusted
input is available: an argv-extracted caller identity, an owner-checked
`localToken` and ASCII `generation` from `endpoint.json`, and the
extension's `bindingPub`. A missing input degrades to a ticketless reply
rather than fabricating one — ticketless resolves to `unverified` on the
server, the same outcome as presenting no ticket at all, which is safer
than a structurally broken ticket (§9.2 aborts on that). `localToken`
itself never reaches the wire, only the MAC key it derives.

`endpoint.json`'s `localToken`/`generation` are trusted for minting only
when the file passes `is_owner_only` on the already-open handle (§9.1); a
file that fails it still yields a port, but those two fields are dropped. On
Unix that is a 0600 owner-and-mode check. On Windows it is the deliberately
weaker analogue documented on `is_owner_only` itself: owner = current process
user, and every DACL entry either a deny-family ACE or a plain allow ACE for
that user, `LocalSystem`, or `BUILTIN\Administrators` — any other ACE type
(the conditional/object allow variants included) fails the check closed and
drops the fields. SYSTEM and Administrators are admitted because they can
already rewrite anything the user owns, which means an administrator can
*read* `localToken` on Windows — do not read the ticket-minting path above
as attesting anything stronger than that there.

On Flatpak, only the **broker** (`motrix-native-host-broker`) speaks HTTP:
`probe_bridge` reaches `probe.rs` through `resolve_endpoint`, so the broker
inherits the `POST /nonce` / `X-Motrix-Bridge: 1` migration. The companion
(`motrix-flatpak-native-host`) makes **no** HTTP calls of its own — it has no
reference to `probe_liveness` or `fetch_nonce` — and reaches the bridge only by
spawning the broker over stdio. Both are ticketless by design; neither calls
`mint_ticket`. That scope decision stands.

**Do not "simplify" this by giving the companion a direct probe call.** The
indirection is the sandbox boundary: the companion runs outside the Flatpak
sandbox and the broker inside it, and routing every bridge request through the
stdio contract is what keeps that boundary a single, auditable seam. A direct
call would read as removing a pointless hop.

## Verification

Run the global gate in `commit-and-quality.md`, then the scoped bridge checks;
do not encode a fixed test count:

```bash
pnpm exec biome check src/core/bridge/ src/core/bridge-receiver/ src/main/bridge/ src/server/bridge/
pnpm exec vitest run src/core/bridge/ src/core/bridge-receiver/ src/main/bridge/ src/server/bridge/
```
