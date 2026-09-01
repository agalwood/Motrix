# Motrix Bridge Pairing Protocol — MBP1

Normative specification, version 1 (`protocolVersion = 1`).

This document defines the wire contract for pairing and authenticating the
Motrix browser extension against the Motrix bridge server. It fixes every
cryptographic parameter at byte level. The words **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are used as in RFC 2119 / RFC 8174.

Status: **cryptographic-review gate satisfied** (six independent adversarial
review rounds, all re-confirming 0 High; findings resolved, residual Low items
tracked to implementation — see the Appendix C review log). Phase-A
implementation may begin; the remaining Phase-A prerequisites in
[§14](#14-review-and-implementation-gates) still apply.

Release context: MBP1 is merged but not yet released. The browser Extension is
also unpublished, and only a small number of historical Server beta builds
exist. The supported profile therefore converges directly on MBP1; there is no
legacy Extension bearer migration or downgrade window. The remote Server
transport requirements in §4.4 are normative additions to the same MBP1 v1
wire protocol, not a second ciphersuite or remote-only frame fork.

Related documents: [RFC 9382] (SPAKE2), [RFC 5869] (HKDF), [RFC 8032]
(edwards25519 encoding), [RFC 7914] (scrypt), [RFC 4648] (base32 background;
MBP1 uses the Crockford alphabet defined in §7). The MDXP application protocol
is unchanged by MBP1 and is specified in the `@motrix/mdxp` package; the MBP1
secure channel sits **below** MDXP.

---

## 1. Overview

The Native-Messaging (NM) era authenticated the server implicitly: the
WebSocket port came from `endpoint.json`, an owner-only (0600) file, so
connecting to that port proved the peer was the user's own Motrix. Fixed
candidate ports (16802–16806) remove that proof. MBP1 replaces it with:

1. **First pair** — a code-entry balanced PAKE (SPAKE2, [RFC 9382]) whose
   password is a short-lived pairing code **displayed by Motrix and typed by
   the user into the extension**. A fake server has no dialog and no code, so
   there is nothing for the user to type: first pair fails closed by
   construction.
2. **Reconnect** — mutual challenge–response over a long-lived symmetric
   credential (`mutualKey`). No bearer token ever appears on the wire or in a
   URL.
3. **Secure channel** — every post-handshake frame in both directions is
   wrapped in an AES-256-GCM envelope with strict sequence numbers. MDXP
   payloads travel only inside this envelope.
4. **NM attestation** — where Native Messaging works, the NM host mints a
   one-shot ticket that proves *which* extension is calling, feeding the
   `official / attested-non-official / unverified` identity tri-state shown in
   the approval dialog.

Remote Motrix Server uses the same SPAKE2, reconnect, credential commit, AEAD,
and MDXP-inside-MBP1 ordering over WS or WSS. It deliberately omits NM tickets: a
Chromium Origin remains verifiable at the WebSocket boundary, while remote
Firefox is displayed as `unverified`. The pairing code is displayed only by an
authenticated Server operator UI and typed by the user into the Extension.

Roles: the **extension is party A** (initiator, uses point *M*), the **Motrix
bridge server is party B** (responder, uses point *N*), exactly as prescribed
by [RFC 9382] §3.1.

### 1.1 What MBP1 does not defend against

Stated so no reader over-reads the guarantee. Out of scope: same-UID local
code (it can `ptrace` Motrix and read `storage.local`), root or raw-socket /
eBPF-capable code, shared X11 input injection, a compromised browser. The
attacker MBP1 must stop is a **co-resident different-UID user**: they can
squat a loopback candidate port and actively connect or relay, but they cannot
read another UID's 0600 files or passively intercept another UID's established
loopback streams.

A **transparent relay** (squat a port, forward one PAKE session frame-for-frame
to the real Motrix) establishes a single end-to-end key it cannot read. The
AEAD channel denies it plaintext, forgery, and tampering; what remains — its
presence in the path, traffic sizes and timing, and being the port the
extension pins — is an intrinsic residual of loopback port squatting and is
documented, not claimed closed.

For the remote Server profile, the network attacker additionally controls DNS,
routes, redirects, reverse-proxy inputs, and unauthenticated discovery. Public
PKI/WSS, when configured, authenticates the network authority and protects
connection metadata; MBP1 authenticates continuity of the paired Server
instance on both WS and WSS. Discovery remains an untrusted hint.
Operator-session compromise, a compromised browser, Server host compromise,
and a byte-identical clone of the complete Server data directory remain outside
the cryptographic guarantee. The first supported deployment is one logical
Server instance (or a sticky single backend), not active-active replication.

---

## 2. Notation and canonical encoding

- `x ‖ y` — concatenation of byte strings.
- `len64LE(s)` — the length of `s` in bytes as an **8-byte little-endian**
  integer (matching [RFC 9382] §3.2).
- `enc(s)` — `len64LE(s) ‖ s`. Unless stated otherwise, strings are encoded
  as UTF-8; every string field in a canonical structure MUST be ASCII-only
  and implementations MUST reject non-ASCII input in those fields.
- `encU32BE(n)` / `encU64BE(n)` — 4-/8-byte big-endian unsigned integers.
- `OS2IP(b)` — big-endian interpretation of byte string `b` as an integer.
- `I2OSP(n, k)` — `n` as a `k`-byte big-endian string.
- Base64 in JSON wire messages is **base64url without padding** ([RFC 4648]
  §5). Decoders MUST reject padded or non-canonical input.
- "Constant-time comparison" means a byte-wise comparison whose running time
  does not depend on the position of the first differing byte.

---

## 3. Ciphersuite (fixed; no negotiation)

MBP1 v1 supports exactly one ciphersuite. There is no negotiation and no
downgrade path; a peer that cannot speak it fails the handshake.

| Component | Choice |
|---|---|
| Group *G* | edwards25519 ([RFC 8032]); base point *P* = RFC 8032 base point; order `ℓ = 2^252 + 27742317777372353535851937790883648493`; cofactor `h = 8` |
| Point encoding | 32-byte RFC 8032 compressed encoding for `pA`, `pB`, `K` |
| PAKE | SPAKE2 ([RFC 9382]), ciphersuite SPAKE2-edwards25519-SHA256-HKDF-HMAC (Table 1 row 6) |
| Hash | SHA-256 |
| KDF | HKDF-SHA-256 ([RFC 5869]) |
| MAC | HMAC-SHA-256 |
| MHF (password→scalar) | scrypt ([RFC 7914]), `N=2^14, r=8, p=1, dkLen=64` |
| AEAD | AES-256-GCM, 12-byte nonces, 16-byte tags |
| Signature (ticket binding) | Ed25519 ([RFC 8032]) |

**Fixed points** *M* and *N* are the edwards25519 constants from
[RFC 9382] §6 (32-byte RFC 8032 encodings, hex):

```
M = d048032c6ea0b6d697ddc2e86bda85a33adac920f1bf18e1b0c6d166a5cecdaf
N = d3bfb518f44f3430f29d0c92af503865a1ed3281dc69b35dd868ba85f886c4ab
```

**Implementation source.** Curve arithmetic, SPAKE2 composition, scrypt, and
Ed25519 MUST come from bundled, independently audited libraries pinned at an
**exact** version on the TypeScript side: **`@noble/curves@2.0.1`** and
**`@noble/hashes@2.0.1`** (the versions the normative test vectors were
generated with). The Cure53 audit of September 2024 was performed at
`@noble/curves` 1.6.0. **Pending confirmation before Phase-A release:** the
maintainer review of the upstream diff from 1.6.0 to 2.0.1 that completes the
audit basis for this pin has not yet been performed; the review log
(Appendix C) records this status. Any version bump re-runs the full vector
suite and updates this pin.
WebCrypto X25519/Ed25519 MUST NOT be used: it requires Chrome 133 / Firefox
130, while the extension supports Chrome 120+ / Firefox 121+ (see Appendix B).
Symmetric primitives (AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256) MAY use
WebCrypto, which is universally available at those minimums. All secret
comparisons MUST be constant-time. Scalar multiplication MUST be
constant-time with respect to the scalar (noble-curves satisfies this).

---

## 4. Transport surfaces and ingress demultiplexing

The Desktop bridge listens on loopback, on the first free port of the candidate
range **16802–16806** (falling back to an ephemeral port). The remote Server
profile exposes the same four logical surfaces behind an explicit disabled-by-
default feature bundle and a public WS/WSS authority (§4.4). Four surfaces are
relevant to MBP1:

| Surface | Method | Auth | Purpose |
|---|---|---|---|
| `/discovery` | `GET` | none | Probe hint: is something Motrix-shaped here, and which instance? |
| `/nonce` | `POST` + header | none | One-shot pairing nonce issuance |
| `/pair` | WS upgrade, `?nonce=` | MBP1 first pair | Code-entry PAKE pairing |
| `/v1` | WS upgrade, no query credentials | MBP1 reconnect | Challenge–response session |

**Demultiplexing is decided by route alone, before any nonce is consumed, any
session object is created, or any dialog is queued.** `/pair` accepts only the
MBP1 first-pair state machine; `/v1` accepts only the MBP1 reconnect state
machine. There is no token-only mode, no `?token=` query parameter, and no
legacy frame format to downgrade into. Connections on either route live in a
pre-authentication table with hard deadlines and caps until MBP1 completes;
they never enter the live-session map and cannot evict an authenticated
session.

**Both WebSocket routes require the `motrix-bridge.v1` subprotocol.** The
client MUST offer it in `Sec-WebSocket-Protocol`; a request whose offered list
does not include it is rejected with **401** before the route is examined, and
before any nonce is consumed. This is a hard gate, not a hint: a client that
omits it cannot reach either state machine.

---

### 4.1 `GET /discovery`

Unauthenticated, replayable, **a hint and never a trust decision**. Response
(`Cache-Control: no-store`):

```json
{ "app": "motrix-bridge", "apiVersion": 1,
  "instanceId": "<persisted per-install UUID>", "appVersion": "2.0.0-beta.20",
  "runtime": "electron" | "server",
  "extensionPairing": { "protocol": "mbp1", "versions": [1] },
  "applicationProtocols": { "mdxp": ["1.0"] } }
```

For Desktop, `instanceId` is a routing hint used to pick which candidate port
to try first. For remote Server, it is a compatibility/identity hint only; the
configured authority already fixes the route. In both profiles the value is
unauthenticated until pair/reconnect proves it through the MBP1 transcript/MAC.
The compatibility fields let an extension stop before pairing and explain an
upgrade requirement, but remain unauthenticated hints: they MUST NOT select a
legacy downgrade, grant trust, or replace post-authentication capability
confirmation. Extensions MUST commit a port pin only after a
mutually-authenticated MBP1 session on that port.

### 4.2 `POST /nonce`

Replaces the former `GET /nonce`; the GET route MUST be removed (respond 404).
The request MUST carry the custom header `X-Motrix-Bridge: 1`; because the
header makes the request non-simple, cross-origin web pages are blocked by the
browser preflight (the server grants no CORS). Response:

```json
{ "nonce": "<22-char unpadded base64url>", "ttlSeconds": 60 }
```

This exact two-key DTO is shared by local and remote MBP1 v1 clients; the
remote profile MUST NOT remove `ttlSeconds`, add identity fields, or otherwise
fork the response shape. `nonce` is the canonical unpadded base64url encoding
of exactly 16 random bytes (22 characters; unused tail bits are zero). Both
fields are unauthenticated short-lived hints.

Nonces are one-shot, expire after 60 seconds, are consumed only by `/pair`,
and MUST NOT be persisted by any party. The server MUST cap outstanding nonces
(default 32), apply a global issuance rate limit, and apply per-verified-origin
quotas where an origin exists.

### 4.3 Host-header validation

While bound to loopback, every HTTP route and WebSocket upgrade MUST reject
(403) any request whose `Host` is not exactly `127.0.0.1[:port]`,
`localhost[:port]`, or `[::1][:port]`. This closes DNS rebinding. (The server
shell's CLI/agent bearer routes remain a separate audience and never authorize
Extension `/pair` or `/v1`. The remote Extension Host rules are §4.4.)

### 4.4 Remote Motrix Server profile

Remote Extension support MUST be opt-in and fail closed. The canonical
configuration inputs are:

```text
MOTRIX_REMOTE_EXTENSION_ENABLED=false
MOTRIX_REMOTE_EXTENSION_PUBLIC_URL=ws(s)://host[:port][/base-path]
MOTRIX_PUBLIC_URL=http(s)://operator-host[:port][/base-path]
MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP=false
```

When enabled, both public URLs are required. The WebSocket URL accepts only WS
or WSS. The operator URL accepts HTTPS by default. An HTTP operator URL is
accepted only when `MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP=true` supplies a second,
explicit opt-in; startup then warns that the operator token, pairing codes,
session cookies, and administrator traffic lack TLS protection. This exception
is for a trusted LAN only and is forbidden for Internet-facing or untrusted-LAN
deployments. Neither operator scheme is rewritten or selected as a fallback.
The parser MUST reject all other schemes, userinfo, query, fragment, raw Unicode
whitespace, ASCII controls, backslashes, percent-encoded path separators
(including layered encoding), unstable canonicalization, and overlong values.
Invalid input closes only the remote Extension surface; CLI/agent and Desktop
behavior remain independent. Diagnostics contain fixed codes and variable
names, never full URLs, paths, codes, credentials, or tokens.

The WS/WSS public URL's canonical pathname is the only route prefix. The Server
accepts exactly `${prefix}/discovery`, `${prefix}/nonce`, `${prefix}/pair`, and
`${prefix}/v1`, with no unprefixed alias. Discovery, nonce, and v1 accept no
query; pair accepts exactly one canonical `nonce=<base64url>` query. An old
`token` query therefore selects no remote route and is rejected before a
pre-authentication socket or credential lookup exists. The Server compares a
strictly parsed request Host's canonical hostname plus effective port to the
configured public authority, rejects duplicate/malformed Host, and ignores
arbitrary `X-Forwarded-Host`. Host validation is defense in depth, not an ACL:
the origin listener MUST remain on loopback/private bind or behind a firewall,
and only an explicitly configured trusted proxy may supply a source address.
Arbitrary `X-Forwarded-For` is ignored.

For WSS, TLS MAY terminate at a trusted reverse proxy and the browser-visible
certificate MUST be trusted and hostname-valid. The proxy preserves Host,
Origin, Upgrade, `Sec-WebSocket-Protocol`, and the exact base path. Explicit WS
is also a production configuration: MBP1 still encrypts application payloads,
but TLS does not protect server network identity or connection metadata. Clients
warn without blocking. Neither side automatically upgrades, downgrades, or
falls back between schemes.

Remote first pair is ticketless: `pairHello` omits `nmTicket` and
`ticketBindingKey`; there is no Native Messaging, candidate-port sweep, App
launch, or local degraded-state warning. Pairing/reconnect use unchanged MBP1
v1 frames. `/v1` has no credential query, old `?token=` is rejected by the
public raw-route gate, raw MDXP is rejected, and CLI/operator bearers cannot
enter either Extension route.

The pairing code is released only through an authenticated operator snapshot or
event channel. HTTP snapshot/mutation responses use `Cache-Control: no-store`;
cookie-authenticated operator WebSockets require an Origin exactly matching the
canonical `MOTRIX_PUBLIC_URL`, and mutation CSRF remains enforced. Codes do not
enter URL, log, persistent browser storage, clipboard, CLI output, or
notification text. The user reads the code and types it into the Extension.
Origin/CSRF, HttpOnly, SameSite, no-store, and login-rate controls remain active
in explicitly authorized HTTP mode, but they do not provide confidentiality or
prevent an on-path attacker from reading or altering operator traffic.

Nonce issuance, `/pair` pre-auth sockets, `/v1` pre-auth sockets, pending
prompts, and discovery/nonce request rates each have independent global hard
caps. Prompt dedup uses verified Origin but rotating forged Origins cannot evade
global caps. `settings.bridge.instanceId` is stable across restart;
`serverGeneration` rotates per process start and CLI `localToken` remains a
separate credential/audience.

All four routes are one atomic feature bundle. Until configuration, credential
store, prompt controller/operator delivery, handlers/capability producer,
bookkeeping, rate limits, and durable revoke are all present before listener
start, every route—including `/nonce`—MUST stay 404. Feature-off, historical
Server, wrong URL, and a proxy-generated 404 are intentionally indistinguishable
to an unauthenticated client; only a valid discovery document can prove a
version incompatibility.

### 4.5 Remote Server deployment profile (beta)

The first beta supports exactly one logical Motrix Server identity. Run one
Server process for one data directory and route every Extension request for an
authority to that same process. A reverse proxy may provide TLS termination,
but round-robin/active-active backends, cloned data directories, and automatic
failover to a different bridge identity are unsupported. The bridge data-dir
lock and Server-process ownership record intentionally make accidental second
writers fail closed; they are not a distributed lock.

A minimal origin configuration is:

```text
MOTRIX_MDXP_HOST=127.0.0.1
MOTRIX_MDXP_PORT=16801
MOTRIX_REMOTE_EXTENSION_ENABLED=true
MOTRIX_REMOTE_EXTENSION_PUBLIC_URL=wss://motrix.example/bridge
MOTRIX_PUBLIC_URL=https://motrix.example
```

After the MBP1 listener and all four remote routes are ready, the Server logs
the canonical `MOTRIX_REMOTE_EXTENSION_PUBLIC_URL` as
`extensionServerAddress`. This is the exact address the user pastes into the
Extension. The ordinary Server HTTP port (`PORT`, default 8080) is not the
Extension address unless a reverse proxy on that port forwards all four routes
to the bridge. The origin bridge port is `MOTRIX_MDXP_PORT` (default 16801), but
users should normally copy the logged public address rather than reconstructing
one from either listener port. Disabled or invalid remote configuration prints
no pairing-ready address.

The public reverse proxy maps `/bridge/discovery`, `/bridge/nonce`,
`/bridge/pair`, and `/bridge/v1` to `http://127.0.0.1:16801` without stripping
or rewriting `/bridge`. It MUST forward the original `Host`, `Origin`,
`Upgrade`, `Connection`, and `Sec-WebSocket-Protocol` values. Do not expose
port 16801 outside the host, do not set `MOTRIX_MDXP_HOST` to a public address,
and do not use `X-Forwarded-Host` or `X-Forwarded-For` as an authentication
signal. The proxy/firewall permits only the four exact paths and SHOULD add
edge request/connection limits in addition to Motrix's conservative global
limits. Because Motrix deliberately does not trust forwarded client addresses,
origin-side per-client limits collapse to the proxy peer; edge per-IP limits
are therefore required for an Internet-facing beta.

When WSS is configured, the TLS certificate MUST chain to a trust anchor accepted
by the target browser and cover the exact configured hostname. Self-signed
certificates, hostname mismatch, and expired certificates are unsupported;
explicit WS is supported but never selected as a fallback. Before
enabling the feature, verify that the operator UI is reachable over its
canonical HTTPS origin, that its authenticated event channel can display a
pairing request/code, and that the proxy preserves the WebSocket subprotocol.
If any required value is absent or invalid, keep
`MOTRIX_REMOTE_EXTENSION_ENABLED=false`; the four public routes remain closed.

Back up the bridge data directory only as part of a single-instance Server
backup. Restoring it to a replacement host preserves the Server identity and
existing Extension credentials, so the replacement MUST take over the same
DNS name and trusted TLS identity and the old process MUST be offline. Cloning
the backup into two live Servers is forbidden. To intentionally create a new
Server identity, start from a fresh bridge data directory and pair every
Extension again. Rollback to a historical token-era Server does not migrate
credentials: disable the remote feature, forget the pairing in the Extension,
upgrade Motrix, and perform a fresh MBP1 pair.

---

## 5. Extension identity tri-state

The approval dialog MUST distinguish three identity states; proving *which*
extension called is not the same as proving it is *official*:

| State | Condition | UI |
|---|---|---|
| `official` | The Chromium verified `Origin` host, or the `callerId` inside a valid NM attestation ticket (§9), appears on the immutable allowlist `src/shared/config/native-messaging-extensions.json` | May show Motrix branding |
| `attested-non-official` | A valid ticket proves a non-allowlisted caller, or a ticketless Chromium WebSocket Origin proves a non-allowlisted extension ID | Raw proven ID, no branding |
| `unverified` | Any Firefox `/pair` without a ticket (a `moz-extension://<UUID>` origin cannot be mapped to a Gecko ID), and local candidate-sweep peers without attestation | Warning styling, raw claimed ID |

Rules:

- "Official" is read **only** from the immutable allowlist — never from the
  NM manifest set, which includes user-added registry IDs.
- The verified origin comes from the WebSocket upgrade `Origin` header only —
  never from query parameters or from self-reported message fields.
- On Chromium, if the `Origin` host does not equal `claimedExtensionId`, the
  server MUST reject the pairing. On Firefox, the `moz-extension://` origin
  cannot be checked against the claimed Gecko ID; without a ticket the state
  is `unverified`.
- Ticketless Chromium is permitted in the remote profile, but Origin proof does
  not promote a user-added registry entry to `official`; only the immutable
  allowlist can do that. Ticketless remote Firefox always remains `unverified`.
- The verified origin is bound to the session, the credential principal, the
  rate-limit keys, and the PAKE transcript (§6.4). Native local processes can
  forge any `Origin` header; origin binding raises the bar only inside
  browsers. The user-facing boundary remains the pairing code plus the
  approval dialog, backed by global prompt caps that fake-origin rotation
  cannot bypass.

---

## 6. First pair — code-entry SPAKE2

### 6.1 Message flow

All `/pair` messages before channel activation are single WebSocket **text**
frames containing exactly one JSON object with a `type` discriminator. Binary
fields are base64url. Unknown `type`, out-of-order messages, duplicate
messages, oversized frames (> 16 KiB pre-authentication), or schema-invalid
JSON MUST abort the connection with `protocolViolation`.

```
extension (A)                                Motrix (B)
    |                                            |
    |-- pairHello ------------------------------>|  validate nonce, origin,
    |                                            |  ticket; queue approval
    |<------------------------------- pairAccept |  dialog (shows code)
    |                                            |
    |            user reads code in Motrix window|
    |            user types code into extension  |
    |                                            |
    |-- pakeA {pA} ----------------------------->|
    |<----------------------------- pakeB {pB}   |
    |-- confirmA {cA, ticketProof?} ------------>|  verify cA (+ proof)
    |<----------------------------- confirmB {cB}|
    |            verify cB                       |
    |============ AEAD channel active ===========|
    |<------------------------- credentialOffer  |
    |   persist to storage.local                 |
    |-- credentialAck --------------------------->|  commit durable
    |<--------------------- credentialCommitted  |
    |============ MDXP initialize... ============|
```

#### `pairHello` (A→B)

```json
{ "type": "pairHello", "protocolVersion": 1,
  "browser": "chromium" | "firefox",
  "claimedExtensionId": "<store ID or Gecko ID>",
  "clientInstallationId": "<UUIDv4 persisted in storage.local>",
  "nmTicket": { ... },            // optional, §9
  "ticketBindingKey": "<b64url 32-byte Ed25519 public key>"  // required iff nmTicket present
}
```

On receipt the server MUST, in order: validate the `?nonce=` (one-shot,
unexpired) — an invalid nonce closes the socket before any further work;
validate the profile-specific Host rule (§4.3 or §4.4) and `Origin`; enforce the pending-pair dedup (keyed
by verified origin) and the global pending cap and backoff (§7.3) **before
creating any session state or dialog**; validate `nmTicket` if present (§9),
requiring `nmTicket`'s `bindingPub` to equal `ticketBindingKey` and
`callerId` to equal `claimedExtensionId`; resolve the identity tri-state; then
queue exactly one approval dialog.

#### `pairAccept` (B→A)

```json
{ "type": "pairAccept", "protocolVersion": 1, "instanceId": "<UUID>" }
```

Sent when the Desktop dialog or authenticated Server operator prompt is queued.
The Extension popup then prompts for the code. `pairAccept` carries no approval semantics — the extension MUST NOT
treat any server message as "the user approved"; only successful key
confirmation proves that.

#### `pakeA` / `pakeB`

```json
{ "type": "pakeA", "pA": "<b64url 32 bytes>" }
{ "type": "pakeB", "pB": "<b64url 32 bytes>" }
```

#### `confirmA` / `confirmB`

```json
{ "type": "confirmA", "cA": "<b64url 32 bytes>",
  "ticketProof": "<b64url 64-byte Ed25519 signature>" }   // required iff nmTicket was sent
{ "type": "confirmB", "cB": "<b64url 32 bytes>" }
```

### 6.2 Pairing code → scalar `w`

The pairing code (§7) normalizes to an 8-character string over the Crockford
alphabet. Let `pw` be its 8 ASCII bytes. Both sides compute:

```
salt = "MBP1/w/v1" ‖ UTF8(pairNonce)
h    = scrypt(pw, salt, N=2^14, r=8, p=1, dkLen=64)
w    = OS2IP(h) mod ℓ
```

`pairNonce` is the exact ASCII nonce string consumed by this `/pair`
connection, making `w` session-unique. If `w = 0`, abort with
`pairingFailed` (probability ≈ 2^-252; no retry semantics are attached).
Reducing a 512-bit hash mod ℓ leaves negligible bias (RFC 9382 §3.2 requires
only 64 extra bits). scrypt is used as the RFC-recommended MHF; its cost is
paid once per attempt and additionally forecloses offline grinding of a
recorded active-attack transcript even within the code's lifetime.

### 6.3 SPAKE2 computation

Per [RFC 9382] §3.3 with A = extension, B = Motrix:

- A draws `x` uniformly from `[1, ℓ)` by **rejection sampling** ([RFC 9382]
  §7): draw 32 CSPRNG bytes, interpret big-endian, redraw while the value is 0
  or ≥ ℓ. `X = x·P`, `pA = w·M + X`.
- B draws `y` the same way. `Y = y·P`, `pB = w·N + Y`.
- Received points MUST decode as canonical RFC 8032 encodings of points on
  the curve; anything else aborts with `protocolViolation`. (noble-curves
  rejects non-canonical encodings.)
- A computes `K = h·x·(pB − w·N)`; B computes `K = h·y·(pA − w·M)`; `h = 8`.
  If `K` is the identity element, abort (this is a failed attempt, §7.2).
- `x`, `y` MUST be fresh per protocol run and never reused; all PAKE state is
  in-memory only and is destroyed when the run ends for any reason.

### 6.4 Transcript `TT` and identities

```
A_id = enc("MBP1/A/v1") ‖ enc(browser) ‖ enc(verifiedOrigin)
     ‖ enc(claimedExtensionId) ‖ enc(clientInstallationId)
B_id = enc("MBP1/B/v1") ‖ enc("motrix-bridge") ‖ enc(instanceId)

TT = enc(A_id) ‖ enc(B_id) ‖ enc(pA) ‖ enc(pB) ‖ enc(K) ‖ enc(I2OSP(w, 32))
```

- `browser` is the exact string from `pairHello`; `verifiedOrigin` is the
  ASCII serialization of the `Origin` header value (e.g.
  `chrome-extension://<id>` or `moz-extension://<uuid>`) — the extension
  computes its own origin locally; any disagreement breaks key confirmation
  by construction (misbinding property).
- `pA`, `pB`, `K` are 32-byte point encodings; `w` is encoded big-endian
  padded to 32 bytes (constant length, RFC 9382 §3.3).

**AAD** (bound into confirmation keys, RFC 9382 §4):

```
AAD = encU32BE(protocolVersion) ‖ enc(pairNonce)
    ‖ enc(ticketBindingKeyOrEmpty) ‖ enc(ticketDigestOrEmpty)

ticketDigest = SHA-256(
      encU32BE(v) ‖ enc(purpose) ‖ encU32BE(ticketProtocolVersion)
    ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId)
    ‖ encU64BE(exp) ‖ enc(bindingPub) ‖ enc(mac))
```

- `ticketBindingKeyOrEmpty` is the raw 32-byte `pairHello.ticketBindingKey`
  when an `nmTicket` was presented, else the empty string.
- `ticketDigest` is computed over **the canonical encodings above of the
  parsed values of every ticket field** — `v` and `ticketProtocolVersion` as
  U32, `exp` as U64, strings as UTF-8, and `bindingPub`/`mac` as the raw bytes
  their base64url decodes to. (Raw JSON spelling/whitespace is *not* hashed;
  each party re-encodes the values it parsed.) `ticketDigestOrEmpty` is empty
  when no ticket was presented. This deliberately does **not** reuse the §9.2
  canonical MAC input (which fixes `purpose` to a constant domain tag), so that
  flipping *any* wire field — `mac`, `purpose`, `bindingPub`, `callerId`,
  `serverGeneration`, `browser`, `exp`, `v`, or `ticketProtocolVersion` —
  changes the digest.

Because both the separate `ticketBindingKey` field and every ticket field are
bound here, an in-path attacker that modifies any of them desynchronizes the
two parties' AAD and breaks key confirmation: such tampering **fails the
pairing closed**, never a silent `unverified` downgrade. Ordering note: the
server runs §9.2 ticket validation at `pairHello`, *before* key confirmation.
So a tampered ticket does not "avoid" validation — validation runs on whatever
the server received; it is *key confirmation* that later fails, because the two
parties' digests differ. Content-level problems on a ticket both sides received
identically resolve per §5/§9.2: an unknown generation or expired ticket
downgrades to `unverified`, while a valid ticket whose `callerId` is not on the
allowlist yields `attested-non-official` (not `unverified`).

### 6.5 Key schedule and confirmation

Per [RFC 9382] §4 with SHA-256:

```
Ke ‖ Ka   = SHA-256(TT)                       (16 bytes each)
KcA ‖ KcB = HKDF-SHA-256(ikm=Ka, salt=empty,
             info="ConfirmationKeys" ‖ AAD, L=32)   (16 bytes each)
cA = HMAC-SHA-256(KcA, TT)
cB = HMAC-SHA-256(KcB, TT)
```

A sends `cA` first. B MUST verify `cA` (and `ticketProof` when a ticket was
presented: an Ed25519 signature by the ticket-binding private key over
`"MBP1/ticket-proof/v1" ‖ TT`, verified against the ticket's `bindingPub`
under the RFC 8032 strict rules of §9.1 — `zip215: false`, never the
permissive ZIP-215 default) before sending `cB`. A MUST verify `cB` before
sending anything further. Both
verifications are constant-time. A failed verification is a **failed attempt**
(§7.2) and B responds with `pairError {code:"codeMismatch",
attemptsRemaining}` — after which a fresh run (new `pakeA` with fresh `x`,
same code while it lives) MAY follow on the same connection.

**Both sides enforce the attempt limits independently.** The extension MUST
enforce its own ceiling of **3 protocol runs per pairing session** and an
absolute session deadline of **180 s** from `pairHello`, plus its own global
failure backoff, regardless of what the peer reports: a server-supplied
`attemptsRemaining` is untrusted display data and MUST NOT extend the local
limits. Without this, a fake or relaying listener could feed the client
`codeMismatch` indefinitely and harvest one password test per induced run.

### 6.6 Pair-session traffic keys

After mutual confirmation:

```
kC2S = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-pair-traffic-c2s", L=32)
kS2C = HKDF-SHA-256(ikm=Ke, salt="MBP1/pair/v1", info="MBP1-pair-traffic-s2c", L=32)
```

The `info` labels are deliberately distinct from the reconnect labels (§8):
every HKDF/HMAC invocation in MBP1 carries a globally unique label, so key
separation never rests on incidental differences in IKM or salt alone.

All subsequent frames on the connection, both directions — credential
messages and MDXP alike — travel inside the AEAD envelope (§10).

### 6.7 Credential issuance — two-phase commit

Inside the AEAD channel:

1. **B→A `credentialOffer`** `{ "type": "credentialOffer", "credentialId":
   "<UUIDv4>", "mutualKey": "<b64url 32 CSPRNG bytes>" }`. The server persists
   the credential durably in state `provisional` **before** sending.
2. **A** writes `{credentialId, mutualKey, state:"provisional", sub:"unacked"}`
   to `storage.local`; then, **before transmitting `credentialAck`, A durably
   flips the sub-state `unacked → commit-uncertain`** (write-ahead), and only
   then sends **`credentialAck`** `{ "type": "credentialAck", "credentialId":
   "<same>" }`. The write-ahead is mandatory: `commit-uncertain` must mean "the
   ack **may** have been sent," so a crash between the durable flip and the send
   still lands in the retain-forever state, never the age-out state.
3. **B** marks the credential `committed` durably, then sends
   **`credentialCommitted`** `{ "type": "credentialCommitted" }`. A marks its
   copy `committed`.

Atomicity rules:

- A provisional server credential also authenticates a reconnect (§8); a
  successful challenge–response is itself an authenticated acknowledgment and
  promotes it to `committed`. **Durable-promotion ordering (server):** on a
  reconnect that promotes a provisional credential, the server MUST, in order,
  (i) verify `reconnectResponse`, (ii) **durably** promote the provisional to
  `committed` — and, for a rotation, CAS-promote-new **and** revoke-old in the
  same durable transaction — and only then (iii) send `reconnectAccept`. It
  MUST NOT send `reconnectAccept` while the promotion is not yet durable, or a
  crash after the accept could leave the just-authenticated credential merely
  provisional and let it later expire. If the server permits the "rotation
  journal replayed on startup" alternative to a single transaction, that replay
  MUST complete — converging to exactly one valid credential per principal —
  **before `/v1` begins accepting authentication**, so no client ever
  authenticates against a half-applied rotation.
- **Durable-commit ordering (client).** On authenticating, the client MUST, in
  **one atomic durable write**, both mark the authenticated credential
  `committed` **and** set `activeCredentialId` to it — the state and the pointer
  can never disagree — and only **after** that write may it prune the others. A
  crash after the atomic write but before pruning is therefore harmless: storage
  may briefly hold two `committed` entries, but `activeCredentialId`
  unambiguously names the live one. **Recovery order:** try
  `activeCredentialId` first if set; then the newest `commit-uncertain`
  provisional; then any other `committed`; then any remaining provisional. This
  guarantees a crash-before-prune never selects the revoked predecessor, and a
  worker death anywhere leaves a reconnectable state — either side completes
  reconnect, or the client re-pairs; never a stranded client.
- Provisional server credentials expire (default 10 minutes) if never acked or
  used. **Server provisional cardinality is bounded, not merely time-bounded:**
  at most **one** outstanding provisional successor may exist per
  `{principal, currentCommittedCredentialId}`. A repeated offer for the same
  `{principal, currentCommittedCredentialId}` (e.g. the worker died before
  storing the previous offer and the client retried on the unchanged committed
  credential) MUST reuse/replace that single slot idempotently rather than
  accumulate `P₁…Pₙ`; the single-flight CAS below enforces the same bound
  against concurrent rotations.
- On **rotation** (same flow run inside an authenticated `/v1` session):
  commit-new and revoke-old MUST be a **single durable server transaction**
  (or a rotation journal replayed on startup), so a crash can never leave
  both credentials valid or neither. The transaction is a **compare-and-swap
  on the principal's current committed `credentialId`**, and the server
  serializes rotations per principal (**single-flight**): two concurrent
  rotations started from the same old credential cannot both commit — the
  second observes the changed current id and is rejected, so exactly one
  successor exists. On the "idempotent re-offer" path (a repeated offer for the
  same `{principal, currentCommittedCredentialId}` after a lost offer),
  idempotent means the server **re-offers the identical `{credentialId,
  mutualKey}`** it already persisted in the single slot — never a freshly minted
  replacement — so a client that stored the earlier offer and one that did not
  converge on the same successor.
- **Client recovery never destroys a credential on an unauthenticated
  signal.** `authFailed` (§11) is a pre-channel message any listener can
  forge, so it MUST NOT by itself delete a stored credential. On reconnect the
  client follows the recovery order above (`activeCredentialId` first, then
  newest `commit-uncertain`, then other `committed`, then any remaining
  provisional). Once an authenticated session is established (mutual
  `reconnectAccept` verified, §8), the credential that authenticated is provably
  the live one, and the client MUST then delete **all other stored credentials
  and pins for that same principal** — the prune after authentication is
  mandatory, not optional, so interrupted rotations cannot accumulate stale
  mutual keys. A run in which no stored credential authenticates leaves the
  retained set in place for a later retry; the flow falls back to fresh
  code-entry pairing only when the user asks or a credential is explicitly
  revoked. Before any successful authentication the client bounds its retained
  set to **at most two** entries per principal — the current committed
  credential and the single newest provisional one.
- **Provisional expiry is state-dependent, never blind.** A client provisional
  credential carries a sub-state: `unacked` (the durable `unacked →
  commit-uncertain` write-ahead of step 2 has not happened) or
  `commit-uncertain` (that write-ahead is durable, so `credentialAck` **may**
  have been sent). An **`unacked`** provisional MAY be aged out after
  **10 minutes** — the write-ahead never completed, so the ack was never sent
  and the server never committed it, matching the server's own provisional
  expiry. A **`commit-uncertain`** provisional MUST NOT be age-deleted: the ack
  may have reached the server, which may then have atomically committed it and
  revoked the old credential (§6.7 rotation), so discarding it could strand the
  client on a revoked credential. A `commit-uncertain`
  credential is retained until an authenticated reconnect resolves which
  credential is live (it is tried first on reconnect), then promoted or pruned
  by the mandatory post-auth rule above. **Orphan cleanup (first pair only):** a
  `commit-uncertain` credential from **first pairing** — one whose principal has
  **no** other committed credential, so there is nothing to be stranded on — MAY
  be removed once the server's first-pair provisional TTL (10 minutes) has
  provably elapsed with no successful reconnect: after that window the server can
  no longer hold it, so it is unusable and safe to drop, and the flow re-pairs.
  A `commit-uncertain` credential produced by **rotation** (a prior committed
  credential exists) is never age-deleted, since only reconnect can prove which
  of the two the server kept. This keeps stale secrets bounded (two
  per principal) while guaranteeing that a worker death anywhere in the ack/
  commit window still leaves a reconnectable state, as §6.7's two-phase commit
  requires. This also denies a fake listener the ability to make the client
  discard its only valid credential by replaying `authFailed`. Explicit
  user revocation MUST immediately mark the live session unauthorized, then
  durably delete every committed and provisional credential whose
  `{browser, verifiedOrigin}` matches the selected extension identity before
  removing display/pairing bookkeeping. At the start of that durable critical
  section the server MUST cancel every pending `/pair` and `/v1` session for
  the same verified Origin and refuse new upgrades for it until the section
  ends, so an already-admitted handshake cannot mint or adopt a replacement
  credential after the delete. It then sends the authenticated revocation
  notification where possible and closes the live WebSocket; the short
  notification-drain window admits no control-plane requests, and a previously
  issued key cannot reconnect. Before the durable credential deletion, Server
  deployments MUST persist a pending-revoke marker keyed by verified identity.
  Startup restores that identity's deny gate and retries deletion before any
  remote Extension listener opens. If deletion fails, no authenticated revoke
  notification is sent, live/pre-auth sessions remain closed, bookkeeping stays
  visible as “revocation incomplete,” and the gate remains closed across
  restart. If the marker itself cannot be persisted, all four remote Extension
  routes enter degraded/closed state rather than risk reviving the old key.
- Credential principal: `{browser, verifiedOrigin, clientInstallationId}`. A
  second browser profile is a **new principal** and pairs as a new
  credential; issuing or rotating one credential MUST NOT affect another.
- Expired or revoked credentials always require a fresh code-entry pairing —
  never silent re-trust.

This mirrors the extension's existing "persist, then send
`motrix/initialized`" ordering.

### 6.8 MV3 service-worker lifecycle

PAKE secrets exist only in worker memory. The open `/pair` WebSocket resets
the worker idle timer on supported Chromium (see Appendix B); if the worker
dies mid-pairing anyway, the server times the session out, the nonce and code
die with it, no partial credential survives (§6.7), and the popup offers
retry. Implementations MUST test worker death both before and after approval.

---

## 7. Pairing code

### 7.1 Format

- **Alphabet**: Crockford base32 — `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
  (32 symbols; excludes `I`, `L`, `O`, `U`).
- **Length**: 8 symbols = exactly 40 bits, drawn from 5 CSPRNG bytes: split
  the 40 bits big-endian into eight 5-bit groups; each group indexes the
  alphabet.
- **Display**: uppercase, grouped `XXXX-XXXX`, shown **only** in the Motrix
  approval dialog. The code is the PAKE password: it MUST never travel over
  any network channel in any form, and MUST never be logged.
- **Input normalization** (extension side, before local validation): strip
  ASCII hyphens and spaces; uppercase; map `O→0`, `I→1`, `L→1`; then require
  exactly 8 alphabet symbols. A string failing local validation MUST be
  rejected in the popup without any network traffic (it does not consume an
  attempt).

### 7.2 Lifetime and attempts

- One code per pairing session, generated when the approval dialog is queued.
- The code dies at the earliest of: **120 s** after generation, the dialog
  being dismissed, the WebSocket closing, or the **3rd failed attempt**.
- A **failed attempt** is any protocol run on the session that reaches `pakeA`
  and ends without mutual confirmation **for any reason** — bad `cA`, bad
  `ticketProof`, identity `K`, malformed point after `pakeA`, protocol abort,
  or the socket closing mid-run. Attempt accounting is kept independently on
  both sides (§6.5); disconnection MUST NOT reset it below what the code has
  already consumed.
- After the 3rd failure the server sends
  `pairError {code:"rateLimited"}`, closes the socket, and invalidates the
  nonce and code.

### 7.3 Global backoff and prompt caps

- At most **one** approval dialog is visible at a time; concurrent `/pair`
  requests beyond the pending cap (default 3 queued) are rejected with
  `pairError {code:"busy"}` **before** any session mutation. Pending-pair
  dedup is keyed by verified origin.
- A global failure counter increments whenever a pairing session that queued
  a dialog **or consumed at least one attempt** ends without mutual
  confirmation — including disconnects, aborts, dismissals, expiry, and
  exhaustion. A guesser therefore cannot dodge the counter by closing the
  socket before exhausting a code. Before dialog `n` (counting consecutive
  failures), the server enforces a lockout of `min(30 · 2^(n−1), 3600)`
  seconds during which new `/pair` sessions are rejected with `rateLimited`.
  The counter resets on a successful pairing or after 24 h.
- **Client-side global backoff (analogous to, not keyed like, the server
  counter).** The extension keeps a **single truly global** first-pair failure
  counter in `storage.local` — **one counter for all unauthenticated
  first-pair targets**, deliberately **not** keyed by `instanceId`, `port`, or
  any other attacker-controllable value (a fake listener that returns a fresh
  `instanceId` every session must not obtain a fresh counter; `instanceId` is
  never a security signal, §4.1). It increments on any first-pair session that
  reached `pakeA` and ended without mutual confirmation, including one the
  extension itself abandoned by closing the socket. Before starting first-pair
  session `n` (consecutive global failures) the extension enforces the
  `min(30 · 2^(n−1), 3600)` second lockout, refusing to open `/pair` and
  showing a "try again later" state; it resets on a successful pairing or after
  24 h. This is the client analogue of the server counter (§7.3) and defeats
  the same online-guessing attack, though the two count at slightly different
  points — the server increments once a code-bearing dialog is queued, the
  client once a session reaches `pakeA`. An **authenticated, per-`instanceId`**
  reconnect-failure subcounter MAY additionally exist, but it is separate from
  and never substitutes for this global first-pair counter. Both client limits
  (per-session ≤3 runs, this global backoff) hold regardless of any
  server-reported `attemptsRemaining`.
- The counter is process-lifetime state; a same-UID attacker who can restart
  Motrix is out of scope (§1.1). The 40-bit code space at 3 attempts per
  session and this lockout schedule yields a success probability for an
  online guesser of ≈ `3·k / 2^40` after `k` sessions — with the cap, fewer
  than ~700 sessions per day, i.e. ≈ 2·10⁻⁹ per day of sustained attack, each
  session requiring a fresh user-approved dialog on the victim's screen.

---

## 8. Reconnect — challenge–response on `/v1`

`/v1` upgrades carry **no** credentials in the URL. Pre-channel messages on
`/v1` follow exactly the §6.1 framing rules: single WebSocket text frames,
one JSON object with a `type` discriminator per frame, base64url binary
fields, a 16 KiB pre-authentication frame cap, and abort with
`protocolViolation` on unknown types, out-of-order or duplicate messages,
oversized frames, or schema-invalid JSON. The whole challenge–response MUST
complete within **10 s** of the upgrade or the server closes the socket.
After upgrade (profile-specific Host checks as in §4.3/§4.4 and Origin checks
as in §5), the server speaks
first:

```json
{ "type": "reconnectChallenge", "protocolVersion": 1, "S": "<b64url 32 CSPRNG bytes>" }
```

Client responds:

```json
{ "type": "reconnectResponse", "credentialId": "<UUIDv4>",
  "C": "<b64url 32 CSPRNG bytes>", "mac": "<b64url 32 bytes>" }
```

with the reconnect transcript

```
RT  = enc("MBP1/reconnect/v1") ‖ encU32BE(protocolVersion)
    ‖ enc(credentialId) ‖ enc(browser) ‖ enc(verifiedOrigin) ‖ enc(instanceId)
mac = HMAC-SHA-256(mutualKey, "MBP1-R/c" ‖ S ‖ C ‖ RT)
```

`browser` and `verifiedOrigin` are the stored credential principal's values on
the client side and the live connection's values on the server side; a
mismatch fails the MAC (misbinding property). The server verifies in constant
time. On success it replies:

```json
{ "type": "reconnectAccept", "mac": "<b64url HMAC-SHA-256(mutualKey, \"MBP1-R/s\" ‖ S ‖ C ‖ RT)>" }
```

The client MUST verify `reconnectAccept.mac` **before sending anything
else** — a fake listener learns nothing usable from replaying `/discovery`
data, and the client MUST treat verification failure as "not my Motrix"
(clear the port pin, fall back to sweep / re-pair; never silent re-trust).

Failure behavior: for an unknown `credentialId` or a bad MAC the server MUST
behave identically — constant-time verification against a dummy key when the
ID is unknown, one uniform `pairError {code:"authFailed"}`, then close — so
the surface does not become a credential-ID oracle. Reconnect attempts are
rate-limited per verified origin and globally.

Traffic keys:

```
kC2S = HKDF-SHA-256(ikm=mutualKey, salt=S ‖ C, info="MBP1-traffic-c2s", L=32)
kS2C = HKDF-SHA-256(ikm=mutualKey, salt=S ‖ C, info="MBP1-traffic-s2c", L=32)
```

All further frames are AEAD-wrapped (§10). MDXP `motrix/initialize` remains
the first application message, now inside the envelope.

---

## 9. NM attestation ticket

Browsers pass the calling extension's identity to NM hosts (Chromium: caller
origin in argv; Firefox: extension ID as an argument). The NM host reads it
and mints a one-shot ticket so the server can resolve the §5 tri-state. This
is the **only** ticket type in MBP1.

### 9.1 Bootstrap flow (extension ↔ host over NM stdio)

1. The extension generates an **ephemeral Ed25519 keypair** (`bindingPriv`,
   `bindingPub`) for this bootstrap.

   **Binding-key validation (server side).** `bindingPub` MUST decode as a
   canonical RFC 8032 point encoding that is on the curve, is **not the
   identity, not of small order, and lies in the prime-order subgroup**
   (torsion-free); anything else makes the ticket invalid. `ticketProof`
   MUST be verified in **RFC 8032 strict mode — `zip215: false` in
   noble-curves 2.0.1** — which enforces a canonical `R` encoding and
   `S < ℓ` and rejects the malleable/non-canonical inputs ZIP-215 (the
   permissive default, `zip215: true`) would accept. The permissive ZIP-215
   mode MUST NOT be used. Note that noble's strict mode still checks the
   **cofactored** group equation `[8]·S·B = [8]·R + [8]·k·A`, not a
   cofactorless one; MBP1 does not rely on cofactorless equality. The
   security of the possession proof comes from `bindingPriv` being secret
   **combined with** the mandatory `bindingPub` validation above: without the
   small-order/torsion check, `bindingPub` = identity with `ticketProof` =
   (identity ‖ 0) satisfies the equation for every message and turns the
   ticket into a bearer object, which the validation forecloses.
   Implementations MUST include every small-order/torsion `bindingPub`
   encoding as negative tests. A signer that legitimately knows `bindingPriv`
   can still produce a torsion-tweaked signature (`R = rB + T`, `S = r + k·a`)
   that noble's cofactored equation accepts; this is a **conformance caveat,
   not a forgery** (it requires the private key), so vectors MUST NOT assert
   its rejection.
2. Extension → host: `{ "action": "bootstrap", "protocolVersion": 1,
   "bindingPub": "<b64url 32 bytes>" }`.
3. The host reads `endpoint.json` (0600 owner-only — that file ownership *is*
   the attestation root; the Windows analogue is owner = current user plus a
   DACL admitting only that user, `LocalSystem`, and
   `BUILTIN\Administrators`, failing closed on any ACE type the check cannot
   prove harmless), checks liveness of the recorded port (TCP /
   `/discovery` probe; unauthenticated is sufficient — the MBP1 client
   authenticates the server itself downstream), wakes Motrix if needed,
   obtains a fresh nonce via `POST /nonce`, mints the ticket, and replies:
   `{ "action": "requestPair", "protocolVersion": 1, "port": <n>,
   "nonce": "<...>", "nmTicket": { ... } }`.
4. The extension forwards the ticket in `pairHello.nmTicket` together with
   `ticketBindingKey = bindingPub`, and later proves possession of
   `bindingPriv` via `confirmA.ticketProof` (§6.5). The binding prevents a
   ticket from being replayed onto any handshake other than the one holding
   the private key.

The host MUST NOT expose `localToken` to the extension, MUST NOT log ticket
material, and holds no `clientInstallationId` (the PAKE transcript binds that
instead).

### 9.2 Ticket format

Wire form (JSON, inside `pairHello`):

```json
{ "v": 1, "purpose": "mbp1-attestation", "protocolVersion": 1,
  "serverGeneration": "<UUID>", "browser": "chromium" | "firefox",
  "callerId": "<verified caller identity from the browser>",
  "exp": 1755600000, "bindingPub": "<b64url 32 bytes>",
  "mac": "<b64url 32 bytes>" }
```

Canonical MAC input (field order fixed, independent of JSON key order):

```
ticketKey = HKDF-SHA-256(ikm=UTF8(localToken), salt="MBP1/nm-ticket/v1",
                         info="mac", L=32)
mac = HMAC-SHA-256(ticketKey,
        enc("mbp1-attestation") ‖ encU32BE(v) ‖ encU32BE(protocolVersion)
      ‖ enc(serverGeneration) ‖ enc(browser) ‖ enc(callerId)
      ‖ encU64BE(exp) ‖ enc(bindingPub raw 32 bytes))
```

Every wire field of the ticket except `mac` itself is covered by the MAC —
including the format version `v` — so no field can be swapped independently.
The MAC's leading `enc("mbp1-attestation")` is a fixed domain tag, not the
wire `purpose`; the wire `purpose` value is instead pinned by the AAD ticket
digest (§6.4), which hashes the **canonical encodings of the ticket's parsed
field values** (per §6.4, not the raw JSON serialization), so tampering
`purpose` (or any other wire field) desynchronizes the two parties' AAD and
fails key confirmation closed rather than merely downgrading.

**Validation runs at `pairHello`, before key confirmation** — the server
validates whatever ticket it received; it never waits for byte-identity to be
proven. `pairHello` additionally requires `nmTicket.browser ==
pairHello.browser` (a ticket minted for a different browser than the one
pairing does not bind this session).

**Check order is normative: the `mac` is verified first.** `ticketKey` derives
from `localToken` alone, so `localToken` MUST persist across bridge restarts —
only `serverGeneration` rotates. The server recomputes the `mac` with the
current `localToken`-derived `ticketKey` before any other check; a `mac`
failure aborts immediately, and only a valid-`mac` ticket proceeds to the
generation / `exp` / `callerId` checks. This is what makes an honest ticket
minted by a **previous** server generation (valid `mac` under the persistent
`localToken`, stale `serverGeneration`) resolve as the semantic
`unverified` **downgrade** rather than being misclassified as a bad-`mac`
abort — and conversely keeps a genuinely forged `mac` an abort regardless of
its generation field. Because there is no authenticated mint timestamp, the
`exp` bound is a **remaining-lifetime** limit (`exp ≤ now + 60 s`), not a proof
of original mint time.

**Every outcome is defined — the map below is exhaustive.** Each check maps to
exactly one of three dispositions: **abort** (`pairError`, no pairing),
**downgrade** (proceed with a lower identity than `official`), or **defer**
(decided later in the flow).

| Ticket condition | Disposition |
|---|---|
| `mac` fails constant-time recompute | **abort** (`protocolViolation`) |
| `v` / `purpose` / `protocolVersion` not exact | **abort** (`protocolViolation`) |
| `bindingPub` fails §9.1 (malformed, identity, small-order, non-torsion-free) | **abort** (`protocolViolation`) |
| `bindingPub != pairHello.ticketBindingKey` | **abort** (`protocolViolation`) |
| `callerId != pairHello.claimedExtensionId` | **abort** (`protocolViolation`) |
| `nmTicket.browser != pairHello.browser` | **abort** (`protocolViolation`) |
| ticket MAC already seen (one-shot replay) | **abort** (`protocolViolation`) |
| `exp` more than 60 s after now (remaining lifetime > 60 s) | **abort** (`protocolViolation`) |
| authentic ticket, unknown/stale `serverGeneration` | **downgrade** → `unverified` |
| authentic ticket, `exp` in the past (expired) | **downgrade** → `unverified` |
| authentic ticket, valid, `callerId` not on allowlist | **downgrade** → `attested-non-official` (§5) |
| authentic ticket, valid, `callerId` on allowlist | `official` (§5) |
| `confirmA.ticketProof` schema-invalid (not 64 bytes) | **defer** → `protocolViolation` (§6.5) |
| `confirmA.ticketProof` well-formed but fails strict verify | **defer** → `codeMismatch`, consumes an attempt (§6.5/§7.2) |

Rationale for the two structural rules that most affect security:

- **Abort, not downgrade, on structural/cryptographic failure.** A legitimate
  extension never presents such a ticket, and an in-transit modification is
  already caught by the AAD binding at key confirmation (§6.4). Aborting
  resolves the otherwise contradictory case where §6.5 requires a valid
  `ticketProof` that an invalid `bindingPub` can never satisfy. Structural
  validation happens **before** the approval dialog and does not touch the
  prompt/failure counters, so it does not amplify the DoS surface; a corrupted
  legitimate ticket causes a self-heal re-bootstrap, never credential
  compromise.
- **`ticketProof` verification is not a `pairHello` outcome.** The server
  cannot know at `pairHello` that "the proof verifies" — the proof arrives in
  `confirmA` (§6.5). So §9.2 validates only the *ticket*, and the proof's
  outcome is deferred to §6.5 exactly as the last two rows state.

Two boundary rules apply:

- **Precedence with §5**: a ticket's identity contribution can only *raise* an
  identity, never lower one — a Chromium verified origin on the allowlist
  establishes `official` with or without a ticket. A **structural abort takes
  precedence over identity**, however: if a *presented* ticket hits any abort
  row above, the pairing aborts even for a caller that would otherwise be
  `official` by verified origin (a legitimate official caller never presents a
  structurally-broken ticket, and the client simply re-bootstraps ticketless).
  A caller that presents **no** ticket is unaffected — origin alone resolves
  its identity per §5.
- **Tampering is not a downgrade**: because the ticket digest is bound into the
  PAKE AAD (§6.4), a ticket modified in transit desynchronizes the two
  parties' AAD and fails key confirmation closed — an in-transit tamper never
  silently becomes a semantic downgrade.

`callerId` values: Chromium — the 32-char extension ID extracted from the
`chrome-extension://<id>/` origin argv; Firefox — the Gecko ID argument. The
ticket proves *which* extension called; whether it is *official* is decided
by the allowlist (§5).

---

## 10. AEAD envelope

Active on `/pair` after §6.6 and on `/v1` after §8, in both directions, for
**every** frame. The envelope sits below MDXP: MDXP JSON-RPC payload bytes are
the plaintext, unchanged.

```
frame     = seq64BE ‖ AES-256-GCM(key = k_dir, nonce, plaintext, aad)
nonce     = dirTag(4 bytes BE) ‖ seq64BE          (12 bytes)
dirTag    = 0x00000001 (client→server) | 0x00000002 (server→client)
aad       = "MBP1/env/v1" (ASCII, 11 bytes)
```

- Frames are WebSocket **binary** messages; one frame per message.
- `seq` starts at 0 per direction and increments by exactly 1 per frame.
  The receiver MUST require `seq` equal to its expected counter (strict
  monotonic, no window); any gap, repeat, or GCM authentication failure MUST
  close the connection immediately (`envelopeViolation`). This is the replay
  protection: replay = strict sequence check.
- Keys are per-direction (§6.6/§8), so nonce uniqueness holds per key by
  construction. Uniqueness alone is not a usage bound: a connection MUST be
  closed — and re-established via reconnect, deriving fresh keys — before
  either direction exceeds **2^24 frames** or **2^30 encrypted AES blocks
  (16 GiB of plaintext)**, whichever comes first. These bounds keep the
  combined AES-GCM confidentiality/integrity advantage comfortably below the
  ≈2^-57 target used by the TLS 1.3 analysis (RFC 8446 §5.5; cf. RFC 9053
  §4.1.1); MDXP control traffic sits orders of magnitude below them. There is
  no in-place rekey in v1.
- Maximum plaintext per frame: 1 MiB. The server's WebSocket parser MUST cap a
  message at the corresponding maximum envelope size (1 MiB + 8-byte sequence
  + 16-byte tag), replacing the transport's larger default so an unauthenticated
  peer cannot force it to buffer an oversized message first. The stricter
  16 KiB pre-authentication frame rule remains independently enforced by the
  pairing/reconnect state machines. Text frames after channel activation are a
  protocol violation.

Because the envelope key is PAKE- or credential-derived, a fake or relayed
endpoint that observed the full handshake still cannot read or modify URLs,
cookies, headers, or commands.

---

## 11. Error and close semantics

`pairError` (`/pair` and `/v1`, pre-channel):

```json
{ "type": "pairError", "code": "<code>", "attemptsRemaining": 2 }
```

| Code | Meaning | Notes |
|---|---|---|
| `unsupportedVersion` | `protocolVersion` ≠ 1 | fail closed, no negotiation |
| `busy` | pending-pair cap or dedup hit | before any session mutation |
| `rateLimited` | global backoff or attempt exhaustion | §7.3 |
| `codeMismatch` | key confirmation failed | carries `attemptsRemaining` |
| `expired` | nonce or code lifetime exceeded | |
| `denied` | authenticated operator explicitly denied the prompt | terminal until an explicit retry |
| `aborted` | PairSession/controller shut down without an operator decision | retryable; never infer denial |
| `authFailed` | `/v1` challenge–response failed | uniform for unknown-ID and bad-MAC |
| `protocolViolation` | malformed/out-of-order frame, bad point encoding, oversize | immediate close |
| `pairingFailed` | internal failure (e.g. `w = 0`) | generic |

Beyond `codeMismatch`/`attemptsRemaining` (which the user needs) the server
MUST NOT reveal which internal step failed. Implementations MUST NOT log
codes, `w`, PAKE intermediates, keys, MACs, or tickets at any log level.

**WebSocket close codes.** Once the AEAD channel is active there is no
`pairError` — §10 violations and usage bounds are reported by closing:

| Code | Meaning | Client action |
|---|---|---|
| `1002` | Any §10/§11 protocol violation. Uniform: it never says which check failed. | Treat this attempt as failed. |
| `4001` | A §10 per-direction usage bound was reached (2^24 frames or 2^30 encrypted blocks). Neither side misbehaved. | Reconnect (§8) and derive fresh keys. |
| `1011` | A genuine internal fault on the closing side. | Treat as a peer defect. |

An outbound attempt to seal more than the 1 MiB plaintext limit is the local
process's internal fault, not a peer protocol violation, and therefore closes
with `1011`; the refused application frame MUST NOT leave the session live.

`4001` sits in the private-use range [RFC 6455] §7.4.2 reserves for
application agreement; no standard code fits, since `1002` would accuse the
peer of a violation that did not occur and `1011` would claim a defect for a
routine, spec-mandated transition.

Only a server can send all three codes: the browser WebSocket API refuses
every close code outside 1000/3000–4999, so an extension client sends `4001`
when one of its own §10 usage bounds trips and a bare close (surfacing as
`1005`, "no status received") for every other fault. That asymmetry is
conformant because of the next rule.

**Clients MUST NOT branch on the close code.** Every close of an established
envelope channel means "re-establish it via §8", and a conforming client that
never learns these numbers still behaves correctly — the codes exist to make a
log legible, not to carry protocol state. Implementations MUST NOT assign a
different meaning to `4001`.

---

## 12. Credential and pin lifecycle (extension side)

- Client credentials are scoped outside the MBP1 wire principal by a
  `BackendAuthority`: `local`, or `{endpointId, canonicalWsBase}`. That
  authority is a storage/lifecycle namespace only and MUST NOT be inserted into
  `A_id`, `B_id`, `TT`, or reconnect MAC input. A URL change creates a new
  authority scope; a display-name change does not.
- `PinStore` is local-only and keyed by `credentialId`, holding
  `{port, instanceId}`. A pin is committed **only after** a
  mutually-authenticated session on that port — never from `/discovery`.
- Pinned-port mismatch → full candidate sweep for the matching `instanceId`
  → re-commit only post-auth; otherwise clear the pin and fall back to fresh
  code-entry pairing.
- Remote authorities perform no port sweep and store no pin. Their committed
  credential durably includes the `authenticatedInstanceId`; reconnect uses
  that retained identity rather than the discovery hint. If the same authority
  retains a different authenticated instance, first pair/rotation MUST fail
  with an explicit identity-change state until the user forgets the old scope.
- `storage.local` credential entries carry `state: "provisional" |
  "committed"` and, for provisionals, the `unacked` / `commit-uncertain`
  sub-state (§6.7), plus an `activeCredentialId` pointer written **atomically
  with** the `committed` transition. Recovery order on reconnect:
  `activeCredentialId` first if set, then the newest `commit-uncertain`
  provisional, then any other `committed`, then any remaining provisional (so
  two `committed` entries left by a crash-before-prune are disambiguated by the
  pointer, never by guessing). A credential is deleted **only after an
  authenticated session proves which one is live** (§6.7); a pre-channel
  `authFailed` never deletes a credential on its own, so a forged `authFailed`
  cannot strand the client.
  When no stored credential authenticates, the retained set stays for a later
  retry and the flow returns to first pair only on explicit user action or
  revocation. Retained state is bounded: at most the committed credential plus
  the newest provisional one per principal. Provisional entries carry a
  sub-state (§6.7): an `unacked` one expires after 10 minutes, but a
  `commit-uncertain` one (its `credentialAck` was sent, so the server may have
  committed it) is never age-deleted — it is retained and tried first on
  reconnect until an authenticated session resolves it. A successful
  authentication MUST delete every other credential and its `PinStore` entry
  for that principal, so interrupted rotations leave no unbounded stale-secret
  inventory yet never strand the client on a revoked credential.

---

## 13. Test vectors

Cross-implementation vectors are normative and live in
[`bridge-pairing-protocol-vectors.json`](./bridge-pairing-protocol-vectors.json)
next to this document. CI in both repositories (and the Rust native host for
the ticket vectors) MUST validate against them. The file contains, with all
byte strings hex-encoded:

1. **`spake2`** — full first-pair runs over edwards25519 with fixed inputs
   (`code`, `pairNonce`, identities, and the scalars `w`, `x`, `y` given
   directly, as in the RFC vectors) and expected `pA`, `pB`, `K`, `TT`, `Ke`,
   `Ka`, `KcA`, `KcB`, `cA`, `cB`, traffic keys. Because [RFC 9382]
   Appendix B provides vectors only for P-256, implementations of the generic
   SPAKE2 core MUST additionally validate against **all four** RFC P-256
   vectors to prove the core composition (TT layout, key schedule) before the
   edwards25519 instantiation is trusted.
2. **`scryptW`** — pairing-code normalization and `w` derivation (§6.2).
3. **`reconnect`** — `RT`, client and server MACs, traffic keys (§8).
4. **`nmTicket`** — `ticketKey` derivation, canonical MAC, and `ticketDigest`
   (§9.2/§6.4), plus **weak binding-key rejections**: the identity encoding,
   other small-order point encodings, and a **dirty (non-torsion-free)**
   `bindingPub` MUST be rejected by §9.1 validation; the identity-key forgery
   `(R = identity, S = 0)` MUST fail; `S ≥ ℓ` and non-canonical `R`
   signatures MUST be rejected by strict verification; and tampering any wire
   field (including `mac` and `purpose`) MUST fail key confirmation closed via
   the §6.4 AAD binding.
5. **`envelope`** — AEAD frames for given keys/plaintexts, including expected
   rejection cases: wrong sequence number, tampered ciphertext, and a
   **direction-tag-only** mismatch (same key, flipped `dirTag`) so an
   implementation that ignores `dirTag` cannot pass.

Beyond the vector file, implementation test suites MUST cover the stateful
cases that vectors cannot express: retry-limit enforcement on both sides
(§6.5/§7.2), global-counter accounting across disconnects (§7.3), and
rotation crash points (§6.7).

The vectors are generated by a reference script checked in with the Phase-A
implementation; regenerating them MUST be deterministic given the recorded
inputs.

---

## 14. Review and implementation gates

1. This document MUST pass an **independent cryptographic review** before any
   MBP1 protocol code is written. **Satisfied** — six independent adversarial
   rounds (2026-08-19), every one re-confirming 0 High; the final round cleared
   the last Medium and left only implementation-tracked Low items. The full
   review record (reviewer, date, findings, resolutions) is Appendix C.
2. The implementation MUST pin exact versions of `@noble/curves` (2.0.1) and
   `@noble/hashes` (2.0.1), and record the audit basis they correspond to (§3).
3. The facts in Appendix B MUST be re-validated against the actual
   minimum-version browser build matrix (Chrome 120, Firefox 121) before
   Phase-A release; they are cited from vendor documentation, not from this
   repository's own evidence.

---

## Appendix A — Security properties and acceptance criteria

A malicious loopback listener, or a remote network endpoint serving forged
discovery and replaying a real `instanceId`, must not obtain: the pairing code,
any credential, a completed MDXP initialize, or any download submission.
Specifically:

- **Terminating MITM** (own PAKE with each side) cannot produce two confirmed
  keys without the code; a grinder test with adversarial key generation MUST
  fail. SPAKE2 has no short public digest to grind, so chosen-key collision
  attacks on SAS-style comparison do not apply.
- **Transparent relay** obtains neither plaintext nor a valid credential
  (AEAD tamper/read tests); its ability to stay in-path is out of scope by
  the threat model (§1.1), not a passed criterion.
- **Transcript misbinding** — any swap of origin, browser, IDs, versions,
  nonce, or binding key between the parties MUST break key confirmation
  (§6.4/§6.5) or the reconnect MAC (§8).
- **Post-handshake integrity** — frame tampering, reordering, replay, or
  cross-direction reflection MUST close the connection (§10).
- **Online guessing** — bounded by 3 attempts per session enforced
  **independently on both sides**, disconnect-proof attempt accounting, and
  the global lockout schedule (§6.5/§7.2/§7.3); a peer-supplied
  `attemptsRemaining` never extends a local limit.
- **Ticket replay and forgery** — one-shot cache, 60 s expiry, generation
  binding, the Ed25519 possession proof with strict verification and
  small-order/torsion rejection (§9.1), and the AAD-bound ticket digest
  (§6.4) make a captured or tampered ticket unusable on any other handshake
  or server generation; small-order `bindingPub` forgeries MUST be rejected.
- **AEAD usage bounds** — sessions close before 2^24 frames or 2^30 encrypted
  blocks per direction (§10).
- **Remote authority and transport** — production accepts canonical WS/WSS and
  preserves the configured scheme. Redirects cannot change authority, discovery
  cannot replace authenticated identity, and old query tokens/raw MDXP never
  enter a session (§4.4). WSS adds PKI network identity and metadata protection;
  MBP1 protects application payloads on both transports.
- **Atomic exposure and revoke** — dependency omission keeps all four remote
  routes at 404; revoke cuts authorization first, persists a restart-safe deny
  marker, deletes credentials durably before notifying, and never reopens on a
  failed delete (§4.4/§6.7).

## Appendix B — Externally-verified browser facts

Verified against vendor documentation on 2026-08-19; re-confirm against the
build matrix per §14.3.

| Fact | Value | Source |
|---|---|---|
| WebCrypto X25519 availability | Chrome/Edge 133+, Firefox 130+, Safari 17+ — **above** the extension minimums (Chrome 120 / Firefox 121), hence bundled noble-curves | [caniuse: SubtleCrypto X25519](https://caniuse.com/mdn-api_subtlecrypto_importkey_x25519) |
| Firefox MV3 host permissions | Before Firefox 127, MV3 host permissions are **not** granted at install; from 127 they appear in the install prompt and are granted, but remain revocable at any time, and update-added host permissions are not prompted | [Mozilla Add-ons blog, "Manifest V3 updates" (2024-05-14)](https://blog.mozilla.org/addons/2024/05/14/manifest-v3-updates/) |
| MV3 service-worker keepalive | From Chrome 116, WebSocket activity resets the 30 s service-worker idle timer; keepalive requires exchanging a message within each 30 s window | [Chrome developers: WebSockets in service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) |
| Extension minimums | `minimum_chrome_version: "120"`, Gecko `strict_min_version: "121.0"` | `motrix-extension/packages/ext/manifest.config.ts` |

The current Extension manifest uses required host access, so there is no
actionable optional-host-permission reauthorization flow and UI MUST NOT offer
one. If a future release narrows this to optional origins, it must check and
request the exact local/remote authority only inside a user gesture, preserve
credentials on refusal/revocation, and add Firefox 121–126, 127+, and manual
revocation coverage before making that profile supported.

## Appendix C — Review log

| Round | Date | Reviewer | Verdict | Summary |
|---|---|---|---|---|
| 1 | 2026-08-19 | Independent adversarial cryptographic review (Codex) | NOT APPROVED — 0 High / 4 Medium / 6 Low | SPAKE2 construction and all published vectors independently reproduced as correct. Mediums: one-sided attempt accounting (M1), unjustified 2^40-frame GCM limit (M2), ZIP-215/small-order `bindingPub` forgery (M3), non-transactional rotation (M4). Lows: ticket `v` outside the MAC and no ticket/AAD binding, non-uniform scalar sampling wording and wrong `w = 0` probability, reused HKDF traffic labels, thin negative-vector coverage, unspecified `/v1` pre-channel framing, unpinned dependency versions. |
| 1-rev | 2026-08-19 | Spec revision | Findings addressed | Both-sides attempt limits with disconnect-proof accounting (§6.5/§7.2/§7.3); 2^24-frame / 2^30-block AEAD bounds (§10); strict Ed25519 verification plus canonical/small-order/torsion-free `bindingPub` validation with negative tests (§9.1); transactional rotation and deterministic client recovery (§6.7/§12); ticket `v` MACed and the ticket digest bound into AAD with fail-closed tamper semantics and §5 precedence (§6.4/§9.2); rejection-sampled scalars and corrected probability (§6.3/§6.2); distinct pair/reconnect HKDF labels (§6.6); all four RFC P-256 vectors, dirTag-only and weak-key negatives (§13); `/v1` framing and deadline (§8); exact noble pins with audit-basis requirement (§3). |
| 2 | 2026-08-19 | Independent re-review (Codex) | NOT APPROVED — 0 High; M2/M3/L2/L3/L5/L6 closed; M1/M4/L1/L4 partial; 1 new Low (N1) | M1: client-side global backoff underspecified. M4: (1) an unauthenticated `authFailed` could delete the client's only valid credential; (2) no single-flight/CAS against concurrent rotations. L1: MAC hard-codes `purpose` and AAD omitted the separate `ticketBindingKey`, so those two fields downgraded rather than failing closed. L4: missing dirty-torsion / non-canonical `R` / `S ≥ ℓ` negatives. N1: noble 2.0.1 `zip215:false` uses the cofactored equation, so the "cofactorless" wording was inaccurate. |
| 2-rev | 2026-08-19 | Spec revision | Findings addressed | Client global backoff specified; rotation single-flight CAS; client never deletes a credential on an unauthenticated `authFailed`; AAD binds `ticketBindingKey` plus a `ticketDigest` over the ticket's wire fields; verification wording corrected to RFC 8032 strict (cofactored); vectors add dirty-torsion / `S ≥ ℓ` / non-canonical `R` / per-field tamper negatives. |
| 3 | 2026-08-19 | Independent re-review (Codex) | NOT APPROVED — 0 High; M4(1)/M4(2)/L1/N1 closed; M1 partial (Medium blocker); L4 partial (Low blocker); 2 new Low | M1: the client counter was keyed by the attacker-controllable `instanceId`, so a fake listener returning a fresh `instanceId` each session got a fresh counter. L4: vectors carried only prose for `S ≥ ℓ` / non-canonical `R` (no malicious bytes) and covered only two small-order encodings. New Low: post-auth prune was only `MAY` and client provisional credentials had no expiry/bound (stale-secret growth). New Low: §6.4 prose said an unlisted `callerId` downgrades to `unverified` (contradicting §5/§9.2 `attested-non-official`) and implied validation runs only after byte-identity. |
| 3-rev | 2026-08-19 | Spec revision | Findings addressed | Client first-pair backoff is a single truly-global counter (§7.3); post-auth prune mandatory, retained set bounded (§6.7/§12); §6.4 identity/encoding prose corrected; vectors carry real malicious bytes for `S ≥ ℓ` / non-canonical `R`, the full small-order set, and all-field tamper self-checks (§13). |
| 4 | 2026-08-19 | Independent re-review (Codex) | NOT APPROVED — 0 High; M1/L4 closed; 1 Medium + 2 Low | Medium: the unconditional 10-minute client provisional expiry could delete a `commit-uncertain` credential the server had already committed during rotation, stranding the client on a revoked credential. Low: §9.2 still said the digest hashes wire fields "verbatim" and that only a byte-identical ticket "reaches validation", contradicting §6.4's canonical-parsed rule and pairHello-ordering. Low: §9.2's blanket "any validation failure → downgrade, do not abort" conflicted with §6.5/§9.1, where an invalid/small-order `bindingPub` makes the required `ticketProof` impossible. Global-counter first-pair griefing assessed as an accepted availability residual (§1.1); multi-profile prune found sound. |
| 4-rev | 2026-08-19 | Spec revision | Findings addressed | State-dependent provisional expiry; §9.2 canonical-parsed digest, pairHello-ordered validation, and abort-vs-downgrade split. |
| 5 | 2026-08-19 | Independent re-review (Codex) | NOT APPROVED — 0 High; round-4 Low wording closed; 1 Medium (durable ordering) + 3 Low | Medium: crash-consistent ordering was incomplete — `commit-uncertain` did not require the durable `unacked → commit-uncertain` write-ahead **before** sending `credentialAck`, and reconnect promotion did not require the server to durably promote/CAS-revoke **before** sending `reconnectAccept`; a crash in either gap could still strand the client. Low: server provisional successors were time-bounded but not cardinality-bounded (repeated crashed offers could accumulate `P₁…Pₙ`). Low: the §9.2 outcome split was not exhaustive (replayed MAC, `callerId`/`bindingPub`/`browser` mismatch, over-long `exp`, and the `ticketProof`-verify-failure case were undefined or unassigned). Construction and all vectors independently revalidated; no High. |
| 5-rev | 2026-08-19 | Spec revision | Findings addressed | Client write-ahead before `credentialAck`; server durable promote/CAS-revoke before `reconnectAccept`; server provisional bounded with idempotent re-offer; §9.2 outcome map made exhaustive with the `browser` check and deferrals. |
| 6 | 2026-08-19 | Independent re-review (Codex) | NOT APPROVED — 0 High; 1 Medium + 4 Low | Medium: a crash after the client's committed-write but before pruning could leave two `committed` entries with the active pointer still on the predecessor, and recovery did not say how to choose — a conforming client could loop on the revoked credential. Low: the journal alternative needed a replay-before-`/v1` barrier; "idempotent re-offer" was under-defined; first-pair orphan `commit-uncertain` cleanup was undefined; §9.2 lacked a MAC-first check order (so an honest prior-generation ticket could be misclassified) and over-claimed a "mint window". Construction and all vectors independently reproduced; no High. Reviewer: once the Medium is fixed the Low items are deferrable to implementation tracking and the gate may be considered satisfied. |
| 6-rev | 2026-08-19 | Spec revision (this document) | Findings addressed; gate satisfied | The client writes `committed` **and** `activeCredentialId` in one atomic durable write before pruning, and recovery tries `activeCredentialId` first, so a crash-before-prune is disambiguated by the pointer, never by guessing (§6.7/§12). Journal replay MUST finish before `/v1` accepts auth; "idempotent re-offer" re-sends the identical stored `{credentialId, mutualKey}`; a first-pair orphan `commit-uncertain` (no committed sibling) may be cleaned after the 10-minute server provisional TTL (§6.7). §9.2 now fixes MAC-first check order, requires `localToken` to persist while only `serverGeneration` rotates, and reframes `exp` as a remaining-lifetime bound. **Six independent adversarial rounds re-confirmed 0 High; the Medium is closed; the residual Low items are tracked to implementation. Pre-implementation cryptographic-review gate is satisfied.** |
| Dep-pin | 2026-08-20 | Maintainer (dependency audit-basis record, §14.2) | Recorded — diff review pending | Pinned `@noble/curves@2.0.1` and `@noble/hashes@2.0.1` at exact versions in the TypeScript implementation (§3). Audit basis: the Cure53 audit of September 2024 was performed at `@noble/curves` 1.6.0; the second pillar of that basis — a maintainer review of the upstream diff from 1.6.0 to 2.0.1 — is **pending maintainer confirmation before Phase-A release**; no such review has been performed yet. |

[RFC 9382]: https://www.rfc-editor.org/rfc/rfc9382
[RFC 5869]: https://www.rfc-editor.org/rfc/rfc5869
[RFC 8032]: https://www.rfc-editor.org/rfc/rfc8032
[RFC 7914]: https://www.rfc-editor.org/rfc/rfc7914
[RFC 4648]: https://www.rfc-editor.org/rfc/rfc4648
