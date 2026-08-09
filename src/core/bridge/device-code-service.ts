import { randomBytes, randomInt } from 'node:crypto'
import { ErrorCodes, makeMdxpError } from '@motrix/mdxp'
import type { PendingPairRequestInfo } from '@shared/protocol/bridge'
import { PairAppCodes } from '@shared/protocol/bridge'
import type { PairedClient, PairingService } from './pairing-service'

/**
 * Device-code pairing for non-extension (cli/agent) clients. Unlike the
 * extension `/pair` WebSocket — which blocks a live socket on a user decision —
 * device-code is poll-based and connectionless:
 *
 *   1. CLI calls `request()`        → { requestId, userCode, expiresAt }
 *   2. user approves in the Motrix UI (out of band)  → `approve(requestId)`
 *   3. CLI polls `poll(requestId)`  → { status, token? }
 *
 * The approval is the security gate (same trust model as the extension pairing
 * dialog). The endpoints that wrap this are intentionally un-authenticated — a
 * fresh CLI has no token yet — so `request()` is rate-limited and every pending
 * request is TTL-bounded and one decision only.
 *
 * Engine-agnostic (`@core/bridge`): the token is minted through the injected
 * {@link PairingService}; the HTTP surface lives in `WebSocketBridgeServer`.
 */

export type DeviceCodeStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface DeviceCodeRequestResult {
  requestId: string
  userCode: string
  expiresAt: number
}

export interface DeviceCodePollResult {
  status: DeviceCodeStatus
  token?: string
}

export interface DeviceCodeServiceOptions {
  /** Pending-request lifetime. Default 5 min. */
  ttlMs?: number
  /** Max `request()` calls per sliding window. Default 10. */
  rateLimitMax?: number
  /** Rate-limit window. Default 60s. */
  rateLimitWindowMs?: number
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
  /**
   * Push hooks for the approval inbox: fired at most once per request, in
   * place of (never in addition to) each other. The lazy {@link
   * DeviceCodeService.poll}/`effectiveStatus` check remains the correctness
   * backstop, but it now ALSO fires this same push at the moment it flips a
   * lapsed entry to `expired` — so a `poll`/`listPending`/`getPending` call
   * that beats the real TTL timer to the punch (see the timer's own note on
   * {@link DeviceCodeService.handleExpiry}) still delivers exactly one
   * `expired` callback, it's just the lazy check that fires it instead of
   * the timer. There is no longer a swallowed-push gap: every path that
   * makes a pending request non-pending fires `settled` or `expired`
   * exactly once, or the request is still pending.
   */
  onLifecycle?: {
    /** A pending request reached a final decision via `approve`/`deny`. */
    settled?: (requestId: string, outcome: 'allowed' | 'denied') => void
    /** A pending request lapsed past its TTL without a decision. */
    expired?: (requestId: string) => void
  }
}

interface PendingRequest {
  requestId: string
  userCode: string
  clientName: string
  clientVersion: string
  /** Resolved cli identity id used at approve time (a validated client handle
   *  or a server-minted random one). Stable per device → re-pair rotates. */
  deviceId: string
  status: DeviceCodeStatus
  /** Set synchronously by `approve()`, before its first `await`, and held
   *  until the mint settles (cleared on failure, moot once `status` moves
   *  off `pending` on success). Blocks the lazy {@link effectiveStatus}
   *  check from flipping an entry to `expired` while a mint is already
   *  atomically committed to landing `approved` — without this, a poll
   *  arriving in the narrow window between `approve()` clearing the timer
   *  and `issueToken()` resolving could observe (and report) `expired` for
   *  a request that is about to settle `approved` a moment later. */
  claimed?: boolean
  token: string | null
  createdAt: number
  expiresAt: number
  /** TTL push timer — fires `onLifecycle.expired` if still pending when it
   *  goes off. Cleared (not just left to fire into a no-op) on every path
   *  that takes the request out of `pending`, so it always fires at most
   *  once and never after the request has settled. */
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_RATE_MAX = 10
const DEFAULT_RATE_WINDOW_MS = 60_000
/** Pickup grace for an approved-but-uncollected entry, applied past its
 *  `expiresAt` before {@link DeviceCodeService.pruneExpired} sweeps it. A CLI
 *  that survived the pairing flow polls again within seconds of approval, so
 *  one minute of slack is generous headroom, not a real wait. */
const COLLECT_GRACE_MS = 60_000

/**
 * Accepted shape of a client-supplied device handle: base64url, 16–64 chars.
 * The length floor (a) demands real entropy (a 128-bit handle is 22 chars) and
 * (b) structurally excludes short reserved ids — notably `local`, the synthetic
 * id of the machine-owner `localToken` — so a client can never make its cli
 * identity collide with a reserved one. Anything else falls back to a minted id.
 */
const DEVICE_HANDLE_RE = /^[A-Za-z0-9_-]{16,64}$/

// Crockford-ish alphabet: no 0/O/1/I to keep the spoken/typed code unambiguous.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export class DeviceCodeService {
  private pending = new Map<string, PendingRequest>()
  private inFlight = new Map<string, Promise<PairedClient>>()
  private requestTimes: number[] = []
  private readonly ttlMs: number
  private readonly rateLimitMax: number
  private readonly rateLimitWindowMs: number
  private readonly now: () => number
  private readonly onLifecycle: DeviceCodeServiceOptions['onLifecycle']

  constructor(
    private pairing: PairingService,
    opts: DeviceCodeServiceOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.rateLimitMax = opts.rateLimitMax ?? DEFAULT_RATE_MAX
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? DEFAULT_RATE_WINDOW_MS
    this.now = opts.now ?? Date.now
    this.onLifecycle = opts.onLifecycle
  }

  /** Create a pending device-code request. Throws `RateLimited` over the
   *  window limit. `deviceId` is the caller's persisted device handle: when it
   *  is a valid handle the cli identity is keyed on it, so the SAME device
   *  re-pairing rotates its prior token (and closes its old SSE) instead of
   *  accumulating a second principal; otherwise a fresh id is minted. */
  request(
    clientName: string,
    clientVersion: string,
    deviceId?: string
  ): DeviceCodeRequestResult {
    const t = this.now()
    this.pruneExpired(t)
    this.enforceRateLimit(t)

    const requestId = randomBytes(32).toString('base64url')
    const userCode = this.makeUserCode()
    const entry: PendingRequest = {
      requestId,
      userCode,
      clientName,
      clientVersion,
      deviceId: this.resolveDeviceId(deviceId),
      status: 'pending',
      token: null,
      createdAt: t,
      expiresAt: t + this.ttlMs,
      timer: this.armTimer(requestId, this.ttlMs),
    }
    this.pending.set(requestId, entry)
    return { requestId, userCode, expiresAt: entry.expiresAt }
  }

  /** Start (or re-start) a request's TTL push timer. `unref()`'d so a lone
   *  pending request never keeps the process alive. Shared by `request()`
   *  and `approve()`'s mint-failure re-arm (Fix 5) so there is exactly one
   *  place that constructs this timer. */
  private armTimer(
    requestId: string,
    ms: number
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.handleExpiry(requestId), ms)
    timer.unref?.()
    return timer
  }

  /** Timer-driven push counterpart to the lazy {@link effectiveStatus} check:
   *  fires `onLifecycle.expired` exactly once, and only for a request that is
   *  STILL pending when its TTL elapses. Every other exit path (approve,
   *  deny, one-time poll delivery, `dispose`) clears the timer first, so by
   *  the time this runs for a settled/collected/disposed request, either the
   *  entry is gone or its status is no longer `pending` — either way this is
   *  a silent no-op, never a duplicate lifecycle event. If the lazy {@link
   *  effectiveStatus} check already flipped this entry to `expired` (and
   *  fired the push itself) a hair before this timer's macrotask ran, this
   *  is also a no-op — the push already went out exactly once. */
  private handleExpiry(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (entry) this.expireEntry(entry)
  }

  /** Single choke point for the `pending → expired` transition: clears the
   *  TTL timer, flips the status, and fires the `expired` push — exactly
   *  once, because it no-ops for anything not still `pending`. Callers layer
   *  their own extra guards (`claimed`, TTL comparison) on top; keeping the
   *  clear/flip/push sequence here means it cannot drift between the timer,
   *  lazy-read, and dispose paths. */
  private expireEntry(entry: PendingRequest): void {
    if (entry.status !== 'pending') return
    this.clearTimer(entry)
    entry.status = 'expired'
    this.onLifecycle?.expired?.(entry.requestId)
  }

  /** Cancel a request's TTL push timer. Safe to call more than once
   *  (`clearTimeout` on an already-fired/-cleared timer is a no-op) — several
   *  call sites clear defensively rather than track "did I already clear
   *  this". */
  private clearTimer(entry: PendingRequest): void {
    clearTimeout(entry.timer)
  }

  /** A valid client handle is used verbatim as the cli identity id (stable →
   *  re-pair rotates). Anything missing/malformed/reserved falls back to a
   *  freshly minted 128-bit id (never trust an unvalidated client string as an
   *  identity key). */
  private resolveDeviceId(deviceId?: string): string {
    if (deviceId && DEVICE_HANDLE_RE.test(deviceId)) return deviceId
    return randomBytes(16).toString('base64url')
  }

  /** Read current state. Unknown ids report `expired` so a poller cannot probe
   *  which requestIds ever existed. The approved token is delivered EXACTLY
   *  ONCE: the first poll that returns it consumes the pending entry, so a
   *  leaked/replayed requestId cannot re-collect (or race the CLI for) the
   *  agent bearer token — subsequent polls report `expired`. */
  poll(requestId: string): DeviceCodePollResult {
    const entry = this.pending.get(requestId)
    if (!entry) return { status: 'expired' }
    const status = this.effectiveStatus(entry)
    if (status === 'approved' && entry.token) {
      const token = entry.token
      // Defensive: `approve()` already cleared this on the way to `approved`,
      // but a torn-down/no-op timer is still a valid one to clear again.
      this.clearTimer(entry)
      this.pending.delete(requestId) // one-time delivery
      return { status, token }
    }
    return { status }
  }

  /** Approve a pending request: mint a cli token via the PairingService and
   *  bind it to the request. Returns the issued {@link PairedClient}. Throws if
   *  the request is missing/expired/settled. Concurrent allows (toast + inbox,
   *  two operator windows, a double-click) dedupe onto one in-flight mint, so
   *  exactly one token is issued and `entry.token` is consistent.
   *
   *  Concurrency scope: `inFlight` only collapses simultaneous approves that
   *  overlap during the async `mint()` call. A second approve arriving AFTER the
   *  first settles hits `requirePending` (status is already 'approved') and is
   *  rejected with `pair.request.unavailable` — not a second mint. Cross-window
   *  / duplicate-paired safety ultimately rests on `PairingService.issueToken`
   *  rotating by identity (persist-then-swap), so even a duplicate mint for the
   *  same `deviceId` converges to one stored pairing.
   *
   *  Lifecycle push: the TTL timer is cleared BEFORE `mint()` starts (not
   *  after it resolves) — `issueToken` is async and the timer would otherwise
   *  remain armed across that `await`, free to fire mid-mint and emit
   *  `expired` for a request that is about to settle `approved`. Clearing the
   *  timer alone still leaves a gap though: the LAZY {@link effectiveStatus}
   *  check (poll/listPending/getPending) has no timer to consult and would
   *  otherwise judge a past-TTL, still-`pending` entry `expired` even though
   *  it is mid-mint. `entry.claimed` closes that: set synchronously, before
   *  the first `await`, in the same breath as clearing the timer (JS cannot
   *  interleave another call into the still-running synchronous prefix of
   *  this one), it tells `effectiveStatus` "this pending entry already has a
   *  terminal transition committed — don't lazily expire it out from under
   *  the mint in flight." `onLifecycle.settled('allowed')` fires only once
   *  `mint()` actually resolves — a concurrent second `approve()` returns the
   *  same in-flight promise above and never reaches this line, so settled
   *  never double-fires. If `mint()` rejects, `claimed` is cleared and the
   *  TTL timer re-armed for whatever time remains (Fix 5) so the request
   *  goes back to being plain `pending` — poll-able, retry-able, and still
   *  TTL-bounded — instead of stuck forever with a dead timer. */
  async approve(requestId: string): Promise<PairedClient> {
    const inFlight = this.inFlight.get(requestId)
    if (inFlight) return inFlight
    const entry = this.requirePending(requestId)
    this.clearTimer(entry)
    entry.claimed = true
    const promise = this.mint(entry)
    this.inFlight.set(requestId, promise)
    try {
      const paired = await promise
      this.onLifecycle?.settled?.(requestId, 'allowed')
      return paired
    } catch (err) {
      // Mint failed: `entry.status` is still 'pending' (mint flips it only
      // after issueToken resolves) unless something else already moved the
      // request to a terminal state (e.g. `dispose()` mid-mint) — only
      // re-arm/un-claim in the former case, a terminal entry stays terminal.
      if (entry.status === 'pending') {
        entry.claimed = false
        entry.timer = this.armTimer(
          requestId,
          Math.max(0, entry.expiresAt - this.now())
        )
      }
      throw err
    } finally {
      // Clear whether mint resolved or threw — a later approve can retry.
      this.inFlight.delete(requestId)
    }
  }

  private async mint(entry: PendingRequest): Promise<PairedClient> {
    const paired = await this.pairing.issueToken(
      { kind: 'cli', id: entry.deviceId },
      entry.clientName
    )
    entry.status = 'approved'
    entry.token = paired.token
    return paired
  }

  /** Deny a pending request. Returns whether the deny actually landed —
   *  `false` if the request is missing/expired/settled, or if an approve is
   *  currently minting for it (don't settle mid-flight): the caller must be
   *  able to tell a real deny apart from a no-op, rather than reporting
   *  apparent success for a decision that never landed anywhere (mirrors the
   *  extension `PairingDialogController.settle()` contract). */
  deny(requestId: string): boolean {
    if (this.inFlight.has(requestId)) return false
    const entry = this.pending.get(requestId)
    if (!entry) return false
    if (this.effectiveStatus(entry) !== 'pending') return false
    entry.status = 'denied'
    this.clearTimer(entry)
    this.onLifecycle?.settled?.(requestId, 'denied')
    return true
  }

  /** Pending request metadata for the approval UI (used by the HTTP layer to
   *  build the PairRequested event). */
  getPending(requestId: string): {
    requestId: string
    userCode: string
    clientName: string
    clientVersion: string
  } | null {
    const entry = this.pending.get(requestId)
    if (!entry || this.effectiveStatus(entry) !== 'pending') return null
    return {
      requestId: entry.requestId,
      userCode: entry.userCode,
      clientName: entry.clientName,
      clientVersion: entry.clientVersion,
    }
  }

  /** Snapshot of every currently-pending request, for the approval inbox. A
   *  list-form of {@link getPending}: token-free, plus `createdAt`/`expiresAt`
   *  for ordering + the TTL countdown. Filters on `effectiveStatus` (not the
   *  raw `status` field) so a past-TTL entry never appears even before the next
   *  `pruneExpired()` sweep (which only runs inside `request()`). */
  listPending(): PendingPairRequestInfo[] {
    const out: PendingPairRequestInfo[] = []
    // Snapshot before the loop so a future change to effectiveStatus that
    // deletes from this.pending cannot corrupt the iterator mid-iteration.
    for (const entry of [...this.pending.values()]) {
      if (this.effectiveStatus(entry) !== 'pending') continue
      out.push({
        kind: 'cli' as const,
        requestId: entry.requestId,
        userCode: entry.userCode,
        clientName: entry.clientName,
        clientVersion: entry.clientVersion,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      })
    }
    return out
  }

  private requirePending(requestId: string): PendingRequest {
    const entry = this.pending.get(requestId)
    if (!entry || this.effectiveStatus(entry) !== 'pending') {
      throw makeMdxpError(
        ErrorCodes.ResourceUnavailable,
        `pairing request not found or no longer pending: ${requestId}`,
        { appCode: PairAppCodes.Unavailable }
      )
    }
    return entry
  }

  /** Lazily resolve a pending entry to `expired` once past its TTL; settled
   *  states (approved/denied) are sticky. A `claimed` entry (Fix 1: an
   *  `approve()` already atomically committed to a terminal transition, mint
   *  still in flight) is exempt — it stays `pending` here no matter how far
   *  past its TTL the clock has moved, so a poll racing a near-TTL approve
   *  observes `pending` (never a spurious `expired`) right up until the mint
   *  actually resolves. This is also the PUSH path for a lapsed request that
   *  a live poll/listPending/getPending call discovers before the real TTL
   *  timer's macrotask runs: it fires `onLifecycle.expired` itself (the
   *  timer then finds a non-`pending` entry and no-ops, so this can never
   *  double-fire).
   *
   *  INVARIANT: must only mutate `entry.status` — must NOT delete from
   *  `this.pending`. Callers such as `listPending` iterate the map while
   *  calling this method; deletion mid-iteration would skip entries. */
  private effectiveStatus(entry: PendingRequest): DeviceCodeStatus {
    if (
      entry.status === 'pending' &&
      !entry.claimed &&
      this.now() > entry.expiresAt
    ) {
      this.expireEntry(entry)
    }
    return entry.status
  }

  private enforceRateLimit(t: number): void {
    const cutoff = t - this.rateLimitWindowMs
    this.requestTimes = this.requestTimes.filter((ts) => ts > cutoff)
    if (this.requestTimes.length >= this.rateLimitMax) {
      throw makeMdxpError(
        ErrorCodes.RateLimited,
        'too many pairing requests; try again shortly',
        { appCode: PairAppCodes.RateLimited }
      )
    }
    this.requestTimes.push(t)
  }

  /** Drop entries past their TTL so the map cannot grow unbounded. Past
   *  `expiresAt` there are three kinds of entry, and only one is actually
   *  swept here:
   *   - **mid-mint** (`inFlight` still holds its promise — `approve()` set
   *     `claimed` synchronously before its first await): NEVER swept.
   *     Sweeping here would orphan the mint; `expireEntry` (via the TTL
   *     timer or the lazy `effectiveStatus` check) owns this entry's
   *     terminal cleanup, not this loop.
   *   - **approved but uncollected** (`claimed` is true, the mint already
   *     resolved, `inFlight` is clear): gets a bounded pickup grace past
   *     `expiresAt` ({@link COLLECT_GRACE_MS}) before being swept, so a poll
   *     that's merely running a little behind the CLI's own clock still
   *     collects its token. Once the grace elapses with nobody having
   *     called `poll()`, the entry — and the token it was holding — is
   *     dropped here; poll's one-time delivery is the only other place that
   *     ever clears a claimed entry.
   *   - **plain abandoned** (never polled, never approved, or denied):
   *     swept immediately, same as before.
   *  An approved entry that WAS collected is already gone (one-time
   *  delivery), so it never reaches this loop at all. */
  private pruneExpired(t: number): void {
    for (const [id, entry] of this.pending) {
      if (t > entry.expiresAt) {
        if (this.inFlight.has(id)) continue // mid-mint: never sweep
        if (entry.claimed && t <= entry.expiresAt + COLLECT_GRACE_MS) continue
        this.clearTimer(entry)
        this.pending.delete(id)
      }
    }
  }

  private makeUserCode(): string {
    const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
    const group = () => Array.from({ length: 4 }, pick).join('')
    return `${group()}-${group()}`
  }

  /** Terminate every still-pending request and clear its TTL timer. Called on
   *  bridge shutdown, mirroring {@link PairingDialogController.dispose}: the
   *  renderer's device-code prompt toast is `timeout: 0` with no local TTL of
   *  its own, so — unlike the sweep this method used to do — merely clearing
   *  timers would leave that toast stuck forever with dead Allow/Deny buttons
   *  (e.g. hot-disabling `browserBridgeEnabled` tears down this instance
   *  without the CLI ever polling again). Flipping to `expired` and firing
   *  the push here closes it correctly. Deliberately NOT guarded on
   *  `claimed`: an `approve()` mid-mint for a request disposed here still
   *  gets its own `settled(allowed)` push once the drained mint resolves —
   *  a second, later lifecycle event for the same request, which is benign
   *  (it closes an already-closed toast) rather than something to suppress
   *  with extra bookkeeping. */
  dispose(): void {
    for (const entry of this.pending.values()) {
      this.clearTimer(entry)
      this.expireEntry(entry)
    }
  }
}
