// src/shared/protocol/bridge.ts

/** Browser families the bridge pairs with. Canonical home for the union. */
export type Browser = 'chromium' | 'firefox'

/**
 * Compose the session/index key shared by the pairing store, the trusted
 * registry, and the live WebSocket session map. The wire shape is
 * `${browser}:${extensionId}`; keep every call site funneled through here so
 * the three subsystems can never drift apart.
 */
export function makeSessionKey(browser: Browser, extensionId: string): string {
  return `${browser}:${extensionId}`
}

/**
 * Client identity primitive for the bridge. Generalizes the historically
 * browser-coupled `(browser, extensionId)` pair so non-extension clients are
 * first-class. The `kind` discriminant keeps the extension path byte-identical
 * while admitting a `cli` principal (Spec 3) for the unary `POST /mdxp`
 * surface; later specs widen it further (e.g. persisted device-code clients).
 */
export type ClientIdentity =
  | {
      readonly kind: 'extension'
      readonly browser: Browser
      readonly extensionId: string
    }
  | { readonly kind: 'cli'; readonly id: string }

/**
 * Stable session/index key for a {@link ClientIdentity}. For the `extension`
 * kind this is byte-identical to {@link makeSessionKey}
 * (`${browser}:${extensionId}`), so the live session map, persisted pairing
 * keys, and task `sourceMeta.sessionKey` are all unchanged. The `cli` kind is
 * namespaced under a `cli:` prefix so it can never collide with an extension
 * key (`${browser}:${extensionId}`), even for an adversarial cli id.
 */
export function clientKey(identity: ClientIdentity): string {
  switch (identity.kind) {
    case 'extension':
      return makeSessionKey(identity.browser, identity.extensionId)
    case 'cli':
      return `cli:${identity.id}`
  }
}

export const BridgeCommands = {
  RevokePair: 'bridge:revokePair',
  AddTrusted: 'bridge:addTrusted',
  RemoveTrusted: 'bridge:removeTrusted',
  ResolvePair: 'bridge:resolvePair',
} as const

export const BridgeQueries = {
  ListPaired: 'bridge:listPaired',
  ListTrusted: 'bridge:listTrusted',
  ProbeUrl: 'bridge:probeUrl',
  ResolveUrl: 'bridge:resolveUrl',
  CancelResolveUrl: 'bridge:cancelResolveUrl',
  ListPendingPairRequests: 'bridge:listPendingPairRequests',
  GetStatus: 'bridge:getStatus',
} as const

export const BridgeEvents = {
  PairRequested: 'bridge:pairRequested',
  Paired: 'bridge:paired',
  Revoked: 'bridge:revoked',
  Error: 'bridge:error',
  /** A pending request reached a non-TTL terminal outcome. */
  PairRequestSettled: 'bridge:pairRequestSettled',
  /** A pending pair request lapsed past its TTL without a decision. */
  PairRequestExpired: 'bridge:pairRequestExpired',
} as const

export type BridgeCommand = (typeof BridgeCommands)[keyof typeof BridgeCommands]
export type BridgeQuery = (typeof BridgeQueries)[keyof typeof BridgeQueries]
export type BridgeEvent = (typeof BridgeEvents)[keyof typeof BridgeEvents]

/**
 * Renderer-facing paired-client DTO (the token is never exposed). Discriminated
 * on `kind`, mirroring {@link ClientIdentity}: an `extension` carries its
 * `browser`; a `cli` (device-code paired, Spec 7b) does not. `id` is the
 * extension id or the cli id respectively.
 */
export type PairedClientInfo =
  | {
      kind: 'extension'
      id: string
      browser: Browser
      name: string
      identityTrust: IdentityTriState
      status: 'ready' | 'cleanup-pending'
      pairedAt: number
      lastActiveAt: number | null
    }
  | {
      kind: 'cli'
      id: string
      name: string
      pairedAt: number
      lastActiveAt: number | null
    }

export interface TrustedExtensionInfo {
  id: string
  browser: Browser
  source: 'builtin' | 'user-added' | 'imported'
  label?: string
  addedAt: number
}

/**
 * Renderer-facing snapshot of the bridge's current port policy (§4), read by
 * {@link BridgeQueries.GetStatus}. Lets the settings UI surface a degraded
 * (ephemeral-port) bridge as informational, not an error — `endpoint.json`
 * remains the authoritative discovery source, and the CLI and native
 * messaging host are unaffected by this query existing or not.
 */
export interface BridgeStatusInfo {
  /** The port actually bound (`BridgeRuntime.port`). `null` only if a future
   *  caller reads this before a port is bound; today the query handler is
   *  installed after binding, so it always returns a real number. */
  port: number | null
  /** True once every candidate in the §4 port range (or the pinned
   *  `fixedPort`) was taken and the bridge fell back to an ephemeral port —
   *  extension port-probing can no longer find it. */
  degraded: boolean
  /** Whether the durable Extension credential-to-management projection is
   * healthy. `degraded` means Extension access has been gated for this run and
   * the paired list must not be interpreted as complete. */
  extensionPairingHealth: 'ready' | 'degraded'
  /** The persisted port policy (`BridgeSettings.fixedPort`) that produced
   *  `port`/`degraded`. */
  fixedPort: 'auto' | number
  /** The persisted §4.1 discovery routing hint (`BridgeSettings.instanceId`).
   *  A routing hint only — never a security signal. */
  instanceId: string
}

/**
 * The §5/§9.2 tri-state proof level for an extension's identity. A literal
 * copy of core's `IdentityTriState` (`src/core/bridge/credential-store.ts`) —
 * duplicated deliberately because the renderer must not import `@core/`.
 * `src/main/bridge/pairing-dialog-controller.ts` asserts the two stay
 * assignable both ways at compile time, so a future widening of either union
 * fails `tsc` instead of silently diverging.
 */
export type IdentityTriState =
  | 'official'
  | 'attested-non-official'
  | 'unverified'

/**
 * Renderer-facing pairing-approval prompt payload. Discriminated on `kind`:
 * an `extension` pairing (the browser `/pair` handshake) vs a `cli` device-code
 * pairing (Spec 7b). The approval toast branches on `kind` — a `cli` request
 * carries the human-verifiable `userCode` instead of a browser/extensionId.
 *
 * Under MBP1 (§5) no self-reported extension name/version is ever displayed:
 * `extensionId` is the pairHello `claimedExtensionId` — proven whenever
 * `identity !== 'unverified'`, claimed-only when `unverified` — and `code` is
 * the §7.1 pairing code the user types into the extension to actually
 * authorize it. There is no `decision` to make here any more: approval is
 * proven by typing the code, not by a click in this dialog.
 */
export type PairRequestPayload =
  | {
      kind: 'extension'
      pairingNonce: string
      extensionId: string
      browser: Browser
      identity: IdentityTriState
      /** The §7.1 display form, grouped `XXXX-XXXX`. Render verbatim — never
       *  reformat, and never log (§7.1/§11: it is the PAKE password). */
      code: string
    }
  | {
      kind: 'cli'
      requestId: string
      userCode: string
      clientName: string
      clientVersion: string
    }

/**
 * Renderer → main/server decision for a pairing prompt. Mirrors
 * {@link PairRequestPayload}'s discriminant: a `cli` decision approves/denies
 * a device-code request by its `requestId`. An `extension` request has
 * shrunk to a pure dismiss — under MBP1 the desktop dialog only DISPLAYS the
 * code (§7.1); there is no Allow/Deny affordance, since approval is proven by
 * typing the code into the extension, not by a click here.
 */
export type ResolvePairParams =
  | {
      kind: 'extension'
      pairingNonce: string
      extensionId: string
      browser: Browser
    }
  | {
      kind: 'cli'
      requestId: string
      decision: 'allow' | 'deny'
    }

/**
 * Renderer-safe DTO for a pending pairing request, shown in the approval
 * inbox. Discriminated on `kind`, mirroring {@link PairRequestPayload}: a
 * `cli` device-code request (token-free by construction, mirrors
 * {@link getPending}'s projection; `deviceId` — identity-keying material — is
 * deliberately excluded) vs an `extension` `/pair` handshake still awaiting
 * the code being typed into the extension. Both add `createdAt`/`expiresAt`
 * for ordering + the TTL countdown.
 */
export type PendingPairRequestInfo =
  | {
      kind: 'cli'
      requestId: string
      userCode: string
      clientName: string
      clientVersion: string
      createdAt: number
      expiresAt: number
    }
  | {
      kind: 'extension'
      pairingNonce: string
      extensionId: string
      browser: Browser
      identity: IdentityTriState
      code: string
      /** Server operator evidence. Optional because the Desktop shell does
       * not have a public authority and keeps its existing prompt shape. */
      verifiedOrigin?: string
      originHost?: string
      claimedExtensionId?: string
      attestationClass?: IdentityTriState
      publicAuthority?: string
      createdAt: number
      expiresAt: number
    }

/**
 * Stable identity for prompt isolation and lifecycle routing. Mirrors the two
 * kinds a pending request can have: `cli:${requestId}` for a device-code
 * request (namespaced under `cli:`, matching {@link clientKey}'s cli prefix,
 * so the two spaces cannot collide) and `${browser}:${extensionId}:${pairingNonce}`
 * for an extension request — byte-identical to
 * {@link PairingDialogController}'s existing map key.
 */
export function pairRequestKey(
  info:
    | Pick<
        Extract<PendingPairRequestInfo, { kind: 'cli' }>,
        'kind' | 'requestId'
      >
    | Pick<
        Extract<PendingPairRequestInfo, { kind: 'extension' }>,
        'kind' | 'pairingNonce' | 'extensionId' | 'browser'
      >
): string {
  return info.kind === 'cli'
    ? `cli:${info.requestId}`
    : `${info.browser}:${info.extensionId}:${info.pairingNonce}`
}

/** Payload for {@link BridgeEvents.PairRequestSettled}: a pending pair
 *  request (identified by {@link pairRequestKey}) reached a non-TTL terminal
 *  outcome. `aborted` is transport/session teardown, never operator denial. */
export interface PairRequestSettledPayload {
  key: string
  outcome: 'allowed' | 'denied' | 'aborted'
}

/** Payload for {@link BridgeEvents.PairRequestExpired}: a pending pair
 *  request (identified by {@link pairRequestKey}) lapsed past its TTL without
 *  a decision. */
export interface PairRequestExpiredPayload {
  key: string
}

/**
 * Result of a cli `ResolvePair`. A discriminated RETURN VALUE rather than a
 * thrown error: a thrown MDXP error loses its `code`/`data.appCode` over the
 * web `/rpc` transport (it becomes a generic 500 message), whereas a return
 * value round-trips intact over both Electron IPC and HTTP. `'unavailable'`
 * means the request was no longer pending (expired / denied-elsewhere /
 * already approved).
 */
export type ResolvePairResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' }

/** appCodes attached to device-code pairing errors (DeviceCodeService). Shared
 *  so the per-shell ResolvePair handlers match the same string the service
 *  throws — never re-type the literal. */
export const PairAppCodes = {
  Unavailable: 'pair.request.unavailable',
  RateLimited: 'pair.request.rateLimited',
} as const
