import { extensionBrowser as browser } from '@/shared/browser'
/**
 * MBP1 client pin store (bridge-pairing-protocol.md §12, §4.1).
 *
 * A pin records where a given credential last authenticated: `{port,
 * instanceId}`, keyed by `credentialId`. Its only purpose is to skip the
 * candidate-port sweep on the next reconnect.
 *
 * **A pin is a routing hint and never a trust decision** (§4.1). Neither
 * `port` nor `instanceId` is authenticated by anything — `/discovery` is
 * unauthenticated and replayable, and any local process can serve a matching
 * `instanceId`. So nothing in this module, and nothing that reads it, may
 * decide anything on the strength of a pin beyond *which endpoint to try
 * first*. A matching pin is a fast path; the reconnect challenge–response
 * (§8) is what actually authenticates. A stale, wrong, or forged pin can
 * therefore only cost a failed attempt and a sweep.
 *
 * That is also why nothing here is encrypted or hardened: there is no secret
 * in a pin. `browser.storage.local` is sandboxed to the extension and
 * protected by OS user isolation, as for other extension settings.
 *
 * Boundedness is a caller obligation, not a policy this store enforces: §12
 * requires the post-authentication prune to delete "all other stored
 * credentials **and pins** for that same principal", and
 * `CredentialStore.prunePrincipalExcept` returns exactly the ids to pass to
 * `clear`. No eviction policy is implemented here because a cap can never be
 * needed for safety — it is the caller's loop that keeps the map the size of
 * the live credential set.
 */

import {
  assertBackendAuthority,
  type BackendAuthority,
  LOCAL_BACKEND_AUTHORITY,
} from '@/background/mbp1/backend-authority'
import { createOperationQueue } from '@/background/mbp1/operation-queue'

/** §12: what a pin holds. `port` is loopback; `instanceId` is the §4.1 hint. */
export interface Pin {
  port: number
  instanceId: string
}

interface StoredPins {
  version: 1
  pins: Record<string, Pin>
}

type StoredPinsRead = { kind: 'known'; set: StoredPins } | { kind: 'future' }

const STORAGE_KEY = 'motrix.mbp1.pins'

/**
 * A bound on the persisted `instanceId`, whose only job is to stop a corrupted
 * or oversized value from growing `storage.local` without limit. Motrix's own
 * value is a UUID.
 */
const MAX_INSTANCE_ID_LENGTH = 128

/**
 * A pinned `instanceId` is plain ASCII, matched by frames.ts's own (private)
 * schema-level check for the same field on the wire (`asciiString()`).
 * Duplicated here as a cheap boolean predicate rather than imported, because
 * `canonical.ts`'s `assertAscii` throws and allocates UTF-8 bytes this check
 * has no use for.
 */
function isAsciiString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false
  }
  return true
}

/**
 * Validates one persisted pin.
 *
 * The checks stop at "present, in range, bounded, and ASCII" on purpose.
 * `ReconnectFlow` (§8) feeds a pinned `instanceId` straight into `enc()` when
 * building the reconnect transcript `RT`, and `enc` throws on non-ASCII
 * input. This store's check is a **second layer**, not the only thing
 * standing between a corrupted pin and a crash: `ReconnectFlow` independently
 * guards the same value (and the other three strings `RT` feeds to `enc()`)
 * before it ever reaches `enc()`, so this check narrows *when* a bad value is
 * caught rather than being the sole reason it is. Both the wire path that
 * writes a pin (`pairAccept.instanceId` is `asciiString()`) and the flow that
 * reads one back are already ASCII-safe, so this is defence in depth against
 * a corrupted or hand-edited `storage.local` value, not a live bug. Rejecting
 * a pin still costs only a candidate sweep (§4.1 makes it a hint), while
 * inventing a stricter format beyond ASCII would risk discarding a perfectly
 * good hint from a future Motrix.
 */
function readPin(value: unknown): Pin | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<Pin>
  if (
    typeof raw.port !== 'number' ||
    !Number.isInteger(raw.port) ||
    raw.port < 1 ||
    raw.port > 65_535
  ) {
    return null
  }
  if (
    typeof raw.instanceId !== 'string' ||
    raw.instanceId.length === 0 ||
    raw.instanceId.length > MAX_INSTANCE_ID_LENGTH ||
    !isAsciiString(raw.instanceId)
  ) {
    return null
  }
  return { port: raw.port, instanceId: raw.instanceId }
}

/**
 * Drops unreadable entries individually rather than discarding the whole map.
 * One corrupted pin should cost one extra sweep, not a sweep for every
 * credential the user has.
 */
function readStoredPins(value: unknown): StoredPinsRead {
  const empty: StoredPins = { version: 1, pins: {} }
  if (!value || typeof value !== 'object') {
    return { kind: 'known', set: empty }
  }
  const stored = value as Partial<StoredPins>
  // A future version is uninterpretable; guessing at its fields could route a
  // reconnect at an endpoint the user never authenticated against.
  if (Object.hasOwn(stored, 'version') && stored.version !== 1) {
    return { kind: 'future' }
  }
  if (stored.version !== 1) return { kind: 'known', set: empty }
  const rawPins = stored.pins
  if (!rawPins || typeof rawPins !== 'object' || Array.isArray(rawPins)) {
    return { kind: 'known', set: empty }
  }
  // Null-prototype, because the assignment below is a **Set** with a key this
  // side does not choose: §6.7 makes `credentialId` server-chosen, so a paired
  // Motrix can offer `"__proto__"`. `JSON.parse` stores that as a real own
  // property, `Object.entries` yields it, and on a normal object the Set would
  // invoke `Object.prototype`'s setter and replace this map's prototype instead
  // of adding a key — after which `get('port')` would inherit a number typed as
  // `Pin`. With no prototype there is no setter to invoke and no chain to
  // inherit from, so the key lands as data like any other.
  const pins: Record<string, Pin> = Object.create(null)
  for (const [credentialId, rawPin] of Object.entries(
    rawPins as Record<string, unknown>
  )) {
    if (credentialId.length === 0) continue
    const pin = readPin(rawPin)
    if (pin !== null) pins[credentialId] = pin
  }
  return { kind: 'known', set: { version: 1, pins } }
}

/** Fixed fail-closed error that never includes persisted pin contents. */
export class UnsupportedPinStoreVersionError extends Error {
  constructor() {
    super('pin store version is unsupported')
  }
}

/** Remote MBP1 routes are fixed and deliberately have no local port pin. */
export class RemotePinStoreUnsupportedError extends Error {
  constructor() {
    super('remote backend authorities do not use the local pin store')
  }
}

// The storage key is global to the extension realm, so serialization must be
// global too. This also keeps a future-version guard atomic with the mutation
// that follows it when an accidental second PinStore instance exists.
const enqueuePinOperation = createOperationQueue()

export class PinStore {
  /**
   * Pins are a loopback candidate optimization and therefore local-only.
   * A remote branch must model the absence of this dependency explicitly; it
   * cannot obtain a silent no-op PinStore and cannot contaminate local pins.
   */
  constructor(authority: BackendAuthority = LOCAL_BACKEND_AUTHORITY) {
    assertBackendAuthority(authority)
    if (authority.kind !== 'local') throw new RemotePinStoreUnsupportedError()
  }

  /** The pin for `credentialId`, or `null` if none is stored or it is unreadable. */
  async get(credentialId: string): Promise<Pin | null> {
    return enqueuePinOperation(async () => {
      const set = await this.read(false)
      if (set === null) return null
      const { pins } = set
      return pins[credentialId] ?? null
    })
  }

  /**
   * Records where `credentialId` authenticated, replacing any previous pin for
   * it.
   *
   * **Post-mutual-authentication only.** §12: "A pin is committed **only
   * after** a mutually-authenticated session on that port — never from
   * `/discovery`." That invariant is enforced by the caller, not by this
   * store: the store cannot observe whether a session authenticated, and a
   * flag saying so would be exactly as trustworthy as the caller passing it.
   * So the rule lives here in the doc comment and in the two call sites — the
   * end of `PairingFlow` and the end of `ReconnectFlow`, both after key
   * confirmation.
   *
   * Committing early is not a privilege escalation — a pin authenticates
   * nothing (§4.1) — but it would defeat the point: the client would pin
   * whatever answered `/discovery` first, so a local impostor could park
   * itself in front of the real Motrix on every subsequent reconnect and turn
   * a one-off failed attempt into a persistent one.
   */
  async commit(credentialId: string, pin: Pin): Promise<void> {
    return enqueuePinOperation(async () => {
      const set = await this.read(true)
      if (set === null) throw new UnsupportedPinStoreVersionError()
      await this.write({
        version: 1,
        pins: { ...set.pins, [credentialId]: pin },
      })
    })
  }

  /**
   * Forgets the pin for `credentialId`.
   *
   * Two callers, and both need this to be a **no-op on an unknown id**:
   *
   * - The §12 post-authentication prune loops over the ids
   *   `CredentialStore.prunePrincipalExcept` returns, most of which never had
   *   a pin at all (a credential only gets one once it has authenticated
   *   somewhere).
   * - §8's "not my Motrix" recovery clears the pin after a `reconnectAccept`
   *   whose MAC does not verify, which can happen on a credential whose pin
   *   was already cleared by an earlier attempt.
   *
   * Throwing in either case would turn "nothing to do" into an error the
   * caller has to swallow, and a swallowed error is how the other ids in the
   * prune loop stop getting cleared.
   */
  async clear(credentialId: string): Promise<void> {
    return enqueuePinOperation(async () => {
      const set = await this.read(true)
      if (set === null) throw new UnsupportedPinStoreVersionError()
      if (!(credentialId in set.pins)) return
      const pins = { ...set.pins }
      delete pins[credentialId]
      await this.write({ version: 1, pins })
    })
  }

  private async read(forMutation: boolean): Promise<StoredPins | null> {
    const obj = await browser.storage.local.get(STORAGE_KEY)
    const stored = readStoredPins((obj as Record<string, unknown>)[STORAGE_KEY])
    if (stored.kind === 'future') {
      if (forMutation) throw new UnsupportedPinStoreVersionError()
      return null
    }
    return stored.set
  }

  private async write(set: StoredPins): Promise<void> {
    if (Object.keys(set.pins).length === 0) {
      await browser.storage.local.remove(STORAGE_KEY)
      return
    }
    await browser.storage.local.set({ [STORAGE_KEY]: set })
  }

  /**
   * Serializes every operation, reads included. Each mutation is a
   * read-modify-write against a single `storage.local` key, so two overlapping
   * ones would both read the pre-mutation snapshot and the later write would
   * clobber the earlier — losing a pin for a credential that is still live.
   * The module-level queue intentionally serializes accidental multiple store
   * instances because every instance addresses this same local-only key.
   */
}
