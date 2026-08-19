# Motrix Bridge Pairing Protocol — MBP1

Normative specification, version 1 (`protocolVersion = 1`).

This document defines the wire contract for pairing and authenticating the
Motrix browser extension against the Motrix bridge server. It fixes every
cryptographic parameter at byte level. The words **MUST**, **MUST NOT**,
**SHOULD**, and **MAY** are used as in RFC 2119 / RFC 8174.

Status: **draft pending independent cryptographic review**. Implementation of
this protocol MUST NOT begin before that review is complete (see
[§14](#14-review-and-implementation-gates)).

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
`@noble/curves` 1.6.0; before Phase-A release the maintainers MUST record the
audit basis for the pinned version — a reviewed upstream diff from the audited
release, or a newer audit — in the review log (Appendix C). Any version bump
re-runs the full vector suite and updates this pin.
WebCrypto X25519/Ed25519 MUST NOT be used: it requires Chrome 133 / Firefox
130, while the extension supports Chrome 120+ / Firefox 121+ (see Appendix B).
Symmetric primitives (AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256) MAY use
WebCrypto, which is universally available at those minimums. All secret
comparisons MUST be constant-time. Scalar multiplication MUST be
constant-time with respect to the scalar (noble-curves satisfies this).

---

## 4. Transport surfaces and ingress demultiplexing

The bridge server listens on loopback, on the first free port of the candidate
range **16802–16806** (falling back to an ephemeral port). Four surfaces are
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

### 4.1 `GET /discovery`

Unauthenticated, replayable, **a hint and never a trust decision**. Response
(`Cache-Control: no-store`):

```json
{ "app": "motrix-bridge", "apiVersion": 1,
  "instanceId": "<persisted per-install UUID>", "appVersion": "2.0.0-beta.20" }
```

`instanceId` is a routing hint used to pick which candidate port to try first.
It MUST NOT be treated as a security signal. Extensions MUST commit a port pin
only after a mutually-authenticated MBP1 session on that port.

### 4.2 `POST /nonce`

Replaces the former `GET /nonce`; the GET route MUST be removed (respond 404).
The request MUST carry the custom header `X-Motrix-Bridge: 1`; because the
header makes the request non-simple, cross-origin web pages are blocked by the
browser preflight (the server grants no CORS). Response:

```json
{ "nonce": "<one-shot opaque ASCII string>", "ttlSeconds": 60 }
```

Nonces are one-shot, expire after 60 seconds, are consumed only by `/pair`,
and MUST NOT be persisted by any party. The server MUST cap outstanding nonces
(default 32), apply a global issuance rate limit, and apply per-verified-origin
quotas where an origin exists.

### 4.3 Host-header validation

While bound to loopback, every HTTP route and WebSocket upgrade MUST reject
(403) any request whose `Host` is not exactly `127.0.0.1[:port]`,
`localhost[:port]`, or `[::1][:port]`. This closes DNS rebinding. (The server
shell binding non-loopback keeps its existing token + reverse-proxy model and
is out of MBP1 scope.)

---

## 5. Extension identity tri-state

The approval dialog MUST distinguish three identity states; proving *which*
extension called is not the same as proving it is *official*:

| State | Condition | UI |
|---|---|---|
| `official` | The proven caller identity — the Chromium verified `Origin` host, or the `callerId` inside a valid NM attestation ticket (§9) — appears on the immutable allowlist `src/shared/config/native-messaging-extensions.json` | May show Motrix branding |
| `attested-non-official` | A valid ticket proves the exact caller ID, but that ID is not on the allowlist | Raw proven ID, no branding |
| `unverified` | No attestation: any Firefox `/pair` without a ticket (a `moz-extension://<UUID>` origin cannot be mapped to a Gecko ID), and candidate-sweep peers | Warning styling, raw claimed ID |

Rules:

- "Official" is read **only** from the immutable allowlist — never from the
  NM manifest set, which includes user-added registry IDs.
- The verified origin comes from the WebSocket upgrade `Origin` header only —
  never from query parameters or from self-reported message fields.
- On Chromium, if the `Origin` host does not equal `claimedExtensionId`, the
  server MUST reject the pairing. On Firefox, the `moz-extension://` origin
  cannot be checked against the claimed Gecko ID; without a ticket the state
  is `unverified`.
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
validate the Host header and `Origin`; enforce the pending-pair dedup (keyed
by verified origin) and the global pending cap and backoff (§7.3) **before
creating any session state or dialog**; validate `nmTicket` if present (§9),
requiring `nmTicket`'s `bindingPub` to equal `ticketBindingKey` and
`callerId` to equal `claimedExtensionId`; resolve the identity tri-state; then
queue exactly one approval dialog.

#### `pairAccept` (B→A)

```json
{ "type": "pairAccept", "protocolVersion": 1, "instanceId": "<UUID>" }
```

Sent when the dialog is queued. The extension popup then prompts for the
code. `pairAccept` carries no approval semantics — the extension MUST NOT
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
AAD = encU32BE(protocolVersion) ‖ enc(pairNonce) ‖ enc(ticketDigestOrEmpty)
ticketDigest = SHA-256(canonical ‖ mac)
```

where, when an `nmTicket` was presented, `canonical` is the ticket's §9.2
canonical MAC input (which includes `bindingPub`) and `mac` its 32-byte MAC —
each side computing over the ticket exactly as it sent/received it — and
`ticketDigestOrEmpty` is the empty string when no ticket was presented. An
in-path attacker that modifies any ticket byte (including its MAC) therefore
desynchronizes the AAD and breaks key confirmation: ticket tampering **fails
the pairing closed** instead of silently downgrading it. A ticket both sides
see identically but which fails validation (§9.2) still downgrades visibly to
`unverified`.

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
under the strict RFC 8032 rules of §9.1 — never ZIP-215/cofactored
verification) before sending `cB`. A MUST verify `cB` before sending anything
further. Both
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
2. **A** writes `{credentialId, mutualKey, state:"provisional"}` to
   `storage.local`, then sends **`credentialAck`**
   `{ "type": "credentialAck", "credentialId": "<same>" }`.
3. **B** marks the credential `committed` durably, then sends
   **`credentialCommitted`** `{ "type": "credentialCommitted" }`. A marks its
   copy `committed`.

Atomicity rules:

- A provisional server credential also authenticates a reconnect (§8); a
  successful challenge–response is itself an authenticated acknowledgment and
  promotes it to `committed` on both sides. A worker death anywhere in the
  flow therefore leaves no unusable half-state: either both sides can
  complete reconnect, or the client re-pairs.
- Provisional server credentials expire (default 10 minutes) if never acked
  or used.
- On **rotation** (same flow run inside an authenticated `/v1` session):
  commit-new and revoke-old MUST be a **single durable server transaction**
  (or a rotation journal replayed on startup), so a crash can never leave
  both credentials valid or neither. The client keeps an explicit
  active-credential pointer with deterministic recovery ordering: on
  reconnect it MUST try the **newest provisional credential first** (the
  server persists its provisional before offering, so this succeeds whenever
  the offer was sent), promote it on success, and delete the superseded
  entry; only if that credential is rejected with `authFailed` does it fall
  back to the previous committed credential and discard the orphaned
  provisional one. Explicit revocation closes live sessions.
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
After upgrade (Host and Origin checks as in §4.3/§5), the server speaks
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
   MUST be verified with **strict RFC 8032 semantics** (canonical `R`,
   `S < ℓ`, cofactorless equation — with noble-curves, `zip215: false`);
   ZIP-215/cofactored verification MUST NOT be used. Without the small-order
   check, `bindingPub` = identity with `ticketProof` = (identity ‖ 0) passes
   even the strict verification equation for every message, turning the
   ticket into a bearer object. Implementations MUST include every
   small-order/torsion point encoding as negative tests.
2. Extension → host: `{ "action": "bootstrap", "protocolVersion": 1,
   "bindingPub": "<b64url 32 bytes>" }`.
3. The host reads `endpoint.json` (0600 owner-only — that file ownership *is*
   the attestation root), checks liveness of the recorded port (TCP /
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

Validation (server): recompute `mac` in constant time; `v`, `purpose`, and
`protocolVersion` exact; `serverGeneration` equals the server's **current
generation** — a UUIDv4 regenerated at every bridge-server start and published
to the host as a new `generation` field in `endpoint.json` (additive; the
existing `writtenAt` stays diagnostic-only); `exp` in the future and at most
60 s from mint; the ticket unseen before (one-shot: the server caches the MAC
until `exp`); `callerId` equal to `pairHello.claimedExtensionId`; `bindingPub`
equal to `pairHello.ticketBindingKey` and valid per §9.1. A validation failure
downgrades the ticket's contribution to `unverified` **and** is surfaced as
such in the dialog; it does not by itself abort the pairing (the code-entry
anchor still applies). Two boundary rules apply:

- **Precedence with §5**: ticket state can only *raise* an identity, never
  lower one — a Chromium verified origin on the allowlist establishes
  `official` with or without a ticket; a failed ticket leaves a Firefox or
  unknown caller at `unverified`.
- **Tampering is not a downgrade**: because the ticket digest is bound into
  the PAKE AAD (§6.4), a ticket modified in transit breaks key confirmation
  and the pairing fails closed; only a ticket both sides saw identically can
  reach this validation step at all.

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
- Maximum plaintext per frame: 1 MiB. Text frames after channel activation
  are a protocol violation.

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
| `aborted` | user dismissed the dialog | |
| `authFailed` | `/v1` challenge–response failed | uniform for unknown-ID and bad-MAC |
| `protocolViolation` | malformed/out-of-order frame, bad point encoding, oversize | immediate close |
| `pairingFailed` | internal failure (e.g. `w = 0`) | generic |

Beyond `codeMismatch`/`attemptsRemaining` (which the user needs) the server
MUST NOT reveal which internal step failed. Implementations MUST NOT log
codes, `w`, PAKE intermediates, keys, MACs, or tickets at any log level.

---

## 12. Credential and pin lifecycle (extension side)

- `PinStore` is a versioned store keyed by `credentialId` holding
  `{port, instanceId}`. A pin is committed **only after** a
  mutually-authenticated session on that port — never from `/discovery`.
- Pinned-port mismatch → full candidate sweep for the matching `instanceId`
  → re-commit only post-auth; otherwise clear the pin and fall back to fresh
  code-entry pairing.
- `storage.local` credential entries carry `state: "provisional" |
  "committed"` (§6.7), plus an active-credential pointer. Recovery order on
  reconnect: newest provisional first, promote on success and delete the
  superseded entry; on `authFailed` fall back to the previous committed
  credential and delete the orphaned provisional one; only when no stored
  credential authenticates does the flow return to first pair.

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
4. **`nmTicket`** — `ticketKey` derivation and canonical MAC (§9.2), plus
   **weak binding-key rejections**: the identity encoding and other
   small-order point encodings MUST be rejected by §9.1 validation, and the
   identity-key forgery `(R = identity, S = 0)` MUST fail.
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
   MBP1 protocol code is written. The review record (reviewer, date, findings,
   resolutions) is kept in Appendix C.
2. The implementation MUST pin exact versions of `@noble/curves` (≥ 1.6.0)
   and `@noble/hashes`, and record the audit reports they correspond to.
3. The facts in Appendix B MUST be re-validated against the actual
   minimum-version browser build matrix (Chrome 120, Firefox 121) before
   Phase-A release; they are cited from vendor documentation, not from this
   repository's own evidence.

---

## Appendix A — Security properties and acceptance criteria

A malicious loopback listener replaying a real `instanceId` must not obtain:
the pairing code, any credential, a completed MDXP initialize, or any
download submission. Specifically:

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

## Appendix B — Externally-verified browser facts

Verified against vendor documentation on 2026-08-19; re-confirm against the
build matrix per §14.3.

| Fact | Value | Source |
|---|---|---|
| WebCrypto X25519 availability | Chrome/Edge 133+, Firefox 130+, Safari 17+ — **above** the extension minimums (Chrome 120 / Firefox 121), hence bundled noble-curves | [caniuse: SubtleCrypto X25519](https://caniuse.com/mdn-api_subtlecrypto_importkey_x25519) |
| Firefox MV3 host permissions | Before Firefox 127, MV3 host permissions are **not** granted at install; from 127 they appear in the install prompt and are granted, but remain revocable at any time, and update-added host permissions are not prompted | [Mozilla Add-ons blog, "Manifest V3 updates" (2024-05-14)](https://blog.mozilla.org/addons/2024/05/14/manifest-v3-updates/) |
| MV3 service-worker keepalive | From Chrome 116, WebSocket activity resets the 30 s service-worker idle timer; keepalive requires exchanging a message within each 30 s window | [Chrome developers: WebSockets in service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) |
| Extension minimums | `minimum_chrome_version: "120"`, Gecko `strict_min_version: "121.0"` | `motrix-extension/packages/ext/manifest.config.ts` |

Consequence of the Firefox rows: before probing loopback the extension MUST
check `permissions.contains({origins:["http://127.0.0.1/*"]})`, request within
a user gesture when missing, and show an explicit degraded state on refusal.
The acceptance matrix covers Firefox 121–126, 127+, and manual revocation.

## Appendix C — Review log

| Round | Date | Reviewer | Verdict | Summary |
|---|---|---|---|---|
| 1 | 2026-08-19 | Independent adversarial cryptographic review (Codex) | NOT APPROVED — 0 High / 4 Medium / 6 Low | SPAKE2 construction and all published vectors independently reproduced as correct. Mediums: one-sided attempt accounting (M1), unjustified 2^40-frame GCM limit (M2), ZIP-215/small-order `bindingPub` forgery (M3), non-transactional rotation (M4). Lows: ticket `v` outside the MAC and no ticket/AAD binding, non-uniform scalar sampling wording and wrong `w = 0` probability, reused HKDF traffic labels, thin negative-vector coverage, unspecified `/v1` pre-channel framing, unpinned dependency versions. |
| 1-rev | 2026-08-19 | Spec revision (this document) | Findings addressed | Both-sides attempt limits with disconnect-proof accounting (§6.5/§7.2/§7.3); 2^24-frame / 2^30-block AEAD bounds (§10); strict Ed25519 verification plus canonical/small-order/torsion-free `bindingPub` validation with negative tests (§9.1); transactional rotation and deterministic client recovery (§6.7/§12); ticket `v` MACed and the ticket digest bound into AAD with fail-closed tamper semantics and §5 precedence (§6.4/§9.2); rejection-sampled scalars and corrected probability (§6.3/§6.2); distinct pair/reconnect HKDF labels (§6.6); all four RFC P-256 vectors, dirTag-only and weak-key negatives (§13); `/v1` framing and deadline (§8); exact noble pins with audit-basis requirement (§3). Awaiting re-review. |

[RFC 9382]: https://www.rfc-editor.org/rfc/rfc9382
[RFC 5869]: https://www.rfc-editor.org/rfc/rfc5869
[RFC 8032]: https://www.rfc-editor.org/rfc/rfc8032
[RFC 7914]: https://www.rfc-editor.org/rfc/rfc7914
[RFC 4648]: https://www.rfc-editor.org/rfc/rfc4648
