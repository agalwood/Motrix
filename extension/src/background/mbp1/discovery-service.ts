/**
 * MBP1 discovery strategy chain (bridge-pairing-protocol.md §4.1, §4.2, §12).
 *
 * Answers one question: *which loopback endpoint should the next MBP1 handshake
 * be attempted against?* Nothing more. Every value this module returns is a
 * **routing hint and never a trust decision** (§4.1) — `/discovery` is
 * unauthenticated and replayable, and any local process can serve a matching
 * `instanceId`. So a pinned-port hit is a *fast path*, not an
 * authentication; the §6 PAKE or the §8 challenge–response is what actually
 * authenticates, and a wrong hint costs one failed attempt and a sweep.
 *
 * ## The two routes are not interchangeable
 *
 * | Route | Method | Header | Semantics |
 * |---|---|---|---|
 * | `GET /discovery` (§4.1) | GET | none | unauthenticated, replayable liveness hint |
 * | `POST /nonce` (§4.2) | POST | `X-Motrix-Bridge: 1` | one-shot, capped, rate-limited |
 *
 * **Liveness polling uses `/discovery`, never `/nonce`.** Line B shipped
 * exactly the opposite: it used the nonce route as its liveness probe inside a
 * launch-poll loop and burned roughly seventy-five nonces per bootstrap
 * against a server that caps outstanding nonces at 32 and rate-limits
 * issuance. The trap is that `X-Motrix-Bridge: 1` and the `POST` method feel
 * like they belong to "bridge requests" generally; they belong to the nonce
 * fetch alone. This module keeps them in exactly one place — `fetchNonce` —
 * and `ensureNonce` is the only public path that reaches it, once, for the
 * candidate that was actually selected.
 *
 * ## This module never writes to `PinStore`
 *
 * It takes a read-only `PinReader` on purpose. §12 puts both pin writes
 * elsewhere: `commit` happens only after a mutually-authenticated session, and
 * the §8 "not my Motrix" `clear` happens in the reconnect flow that saw the
 * bad accept MAC. Discovery cannot tell "Motrix is not running" from "Motrix
 * moved ports", so clearing a pin on a failed probe would discard a still-
 * correct hint every time the user simply quits the app.
 *
 * Nonces MUST NOT be persisted by any party (§4.2) — they are returned to the
 * caller and never touch `storage.local` here.
 */
import type { Pin } from '@/background/mbp1/pin-store'
import { extensionBrowser } from '@/shared/browser'

/**
 * Where the next handshake should be attempted, and what the transport already
 * supplied. `transport: 'nm'` results come from the Native Messaging host and
 * may carry a nonce and an attestation ticket; `transport: 'probe'` results
 * come from a `/discovery` sweep and never carry either.
 */
export interface DiscoveryResult {
  transport: 'nm' | 'probe'
  wsPort: number
  instanceId?: string
  nonce?: string
  nmTicket?: unknown
  /** Display data only, from a `/discovery` sweep response — absent for an
   *  `nm`-transport result, since the NM bootstrap reply never carries one. */
  appVersion?: string
  /** Unauthenticated compatibility hint from `GET /discovery`. It is used
   * only to fail early with an actionable upgrade message; MBP1 and
   * `motrix/initialize` remain the authoritative checks. */
  compatibility?: BackendCompatibility
}

export type BackendCompatibility =
  | 'compatible'
  | 'backendUpgradeRequired'
  | 'extensionUpgradeRequired'
  | 'unsupportedRemote'

export interface DiscoveryConfig {
  candidatePorts: number[]
  /** Per-request timeout for a single `/discovery` or `/nonce` request. */
  discoveryTimeoutMs: number
  /** The single wall-clock budget for one `wakeAndPoll`. */
  wakeDeadlineMs: number
}

/** One live `/discovery` responder. `appVersion` is display data only. */
export interface LiveCandidate {
  port: number
  instanceId: string
  appVersion: string
  compatibility: BackendCompatibility
}

/**
 * The read-only slice of `PinStore` this module needs. Narrow by design: see
 * the module comment on why discovery must not be able to write a pin.
 */
export interface PinReader {
  get(credentialId: string): Promise<Pin | null>
}

/** §9.1 host reply, as much of it as discovery cares about. */
export interface NativeBootstrapReply {
  port: number
  /** `null`/absent when the host could not fetch one; §4.2 then applies. */
  nonce?: string | null
  /** The §9.2 ticket object, passed through unmodified. */
  nmTicket?: unknown
}

/**
 * The narrow injected port for the NM bootstrap: request one, receive
 * `{port, nonce, nmTicket?}`. Deliberately *not* a dependency on the concrete
 * `NativeBootstrap` class: `ConnectionManager` adapts the production host and
 * tests can drive the same contract without a Native Messaging channel.
 */
export interface NativeBootstrapPort {
  bootstrap(opts: {
    allowLaunch: boolean
    bindingPub?: Uint8Array
  }): Promise<NativeBootstrapReply>
}

/** The two `browser.tabs` calls `wakeAndPoll` needs, and nothing else. */
export interface TabsPort {
  create(props: {
    url: string
  }): Promise<{ id?: number | undefined } | undefined>
  remove(tabId: number): Promise<void>
}

export interface DiscoveryServiceOptions extends Partial<DiscoveryConfig> {
  pins: PinReader
  nativeBootstrap?: NativeBootstrapPort
  fetchImpl?: typeof fetch
  tabs?: TabsPort
}

/** §4: the bridge binds the first free port of this range. */
const DEFAULT_CANDIDATE_PORTS = [16802, 16803, 16804, 16805, 16806]

/**
 * One knob covers the pinned probe and every sweep probe, because they are the
 * same request to the same kind of endpoint; two knobs would only invite them
 * to drift. 500 ms is generous for loopback — a port with nothing on it fails
 * immediately with a connection refusal, so this bounds only the case where
 * something accepted the connection and then went quiet.
 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 500

const DEFAULT_WAKE_DEADLINE_MS = 20_000

/**
 * Gap between sweeps inside `wakeAndPoll`. Repeating `GET /discovery` is cheap
 * by design — §4.1 is unauthenticated, replayable and `no-store`, with none of
 * §4.2's one-shot or capped semantics — which is exactly why it is the right
 * liveness probe and `/nonce` is not.
 */
const WAKE_POLL_INTERVAL_MS = 500

const WAKE_URL = 'motrix://open'

/** Matches `NativeBootstrap`'s existing bound on a host-supplied nonce. */
const MAX_NONCE_LENGTH = 512
const MAX_INSTANCE_ID_LENGTH = 128
const MAX_APP_VERSION_LENGTH = 64

const SUPPORTED_MBP1_VERSION = 1
const SUPPORTED_MDXP_VERSION = '1.0'

function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  )
}

function isPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

/**
 * §4.2's nonce is an "opaque ASCII string". ASCII is not cosmetic: the nonce
 * is bound into the §6.4 AAD through `enc()`, which rejects a byte >= 0x80, so
 * a non-ASCII nonce would throw mid-handshake on every attempt. Rejecting it
 * here degrades to "no nonce", which the caller can recover from.
 */
function readNonce(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_NONCE_LENGTH) return null
  if (!isPrintableAscii(value)) return null
  return value
}

/**
 * Parses a `GET /discovery` body (§4.1).
 *
 * `app === 'motrix-bridge'` is the only acceptance gate, and `apiVersion` is
 * checked for *shape* but deliberately **not** for value. Gating a hint on a
 * version number would make a newer Motrix invisible to this extension
 * entirely; version incompatibility is the wire protocol's job and surfaces as
 * §11's `unsupportedVersion`, which is a far better outcome for the user than
 * "no Motrix found".
 *
 * `instanceId` is required because it is the hint `tryPinnedPort` compares
 * against — a document without one is useless as a routing hint. `appVersion`
 * is display data only, so a document missing it still describes a live
 * Motrix and must not be discarded; it degrades to an empty string.
 */
function readNumericVersions(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const versions = value.filter(
    (entry): entry is number =>
      typeof entry === 'number' && Number.isInteger(entry) && entry >= 0
  )
  return versions.length === value.length ? versions : null
}

function readStringVersions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const versions = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0
  )
  return versions.length === value.length ? versions : null
}

function isStrictlyNewerMdxp(version: string): boolean {
  const match = /^(\d+)\.(\d+)$/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 1 || (major === 1 && minor > 0)
}

/**
 * Classifies explicit discovery capabilities. Missing or malformed fields are
 * an old/incomplete backend, while a well-formed set containing only versions
 * newer than this client is the one case that asks the user to update the
 * extension. This avoids blaming the extension for an older Motrix build.
 */
function readCompatibility(doc: Record<string, unknown>): {
  compatibility: BackendCompatibility
} {
  const runtime =
    doc.runtime === 'electron' || doc.runtime === 'server'
      ? doc.runtime
      : undefined
  if (runtime === 'server') return { compatibility: 'unsupportedRemote' }

  const pairing =
    doc.extensionPairing && typeof doc.extensionPairing === 'object'
      ? (doc.extensionPairing as Record<string, unknown>)
      : null
  const applicationProtocols =
    doc.applicationProtocols && typeof doc.applicationProtocols === 'object'
      ? (doc.applicationProtocols as Record<string, unknown>)
      : null
  const mbp1Versions = readNumericVersions(pairing?.versions)
  const mdxpVersions = readStringVersions(applicationProtocols?.mdxp)

  if (
    runtime === undefined ||
    pairing?.protocol !== 'mbp1' ||
    mbp1Versions === null ||
    mdxpVersions === null
  ) {
    return { compatibility: 'backendUpgradeRequired' }
  }

  const supportsMbp1 = mbp1Versions.includes(SUPPORTED_MBP1_VERSION)
  const supportsMdxp = mdxpVersions.includes(SUPPORTED_MDXP_VERSION)
  if (supportsMbp1 && supportsMdxp) {
    return { compatibility: 'compatible' }
  }

  const incompatibleMbp1IsOnlyNewer =
    supportsMbp1 ||
    mbp1Versions.every((version) => version > SUPPORTED_MBP1_VERSION)
  const incompatibleMdxpIsOnlyNewer =
    supportsMdxp || mdxpVersions.every(isStrictlyNewerMdxp)
  if (incompatibleMbp1IsOnlyNewer && incompatibleMdxpIsOnlyNewer) {
    return { compatibility: 'extensionUpgradeRequired' }
  }
  return { compatibility: 'backendUpgradeRequired' }
}

export function readDiscoveryDoc(
  port: number,
  body: unknown
): LiveCandidate | null {
  // An array needs no separate guard: it has no `app`, so the gate below
  // rejects it.
  if (!body || typeof body !== 'object') return null
  const doc = body as Record<string, unknown>
  if (doc.app !== 'motrix-bridge') return null
  if (typeof doc.apiVersion !== 'number' || !Number.isFinite(doc.apiVersion)) {
    return null
  }
  const instanceId = doc.instanceId
  if (
    typeof instanceId !== 'string' ||
    instanceId.length === 0 ||
    instanceId.length > MAX_INSTANCE_ID_LENGTH
  ) {
    return null
  }
  const rawAppVersion = doc.appVersion
  const appVersion =
    typeof rawAppVersion === 'string' &&
    rawAppVersion.length <= MAX_APP_VERSION_LENGTH
      ? rawAppVersion
      : ''
  const compatibility = readCompatibility(doc)
  return { port, instanceId, appVersion, ...compatibility }
}

function toProbeResult(candidate: LiveCandidate): DiscoveryResult {
  return {
    transport: 'probe',
    wsPort: candidate.port,
    instanceId: candidate.instanceId,
    // `readDiscoveryDoc` already degrades a missing/oversized appVersion to
    // '' rather than discarding the candidate — an empty string here means
    // exactly that, not "field absent".
    appVersion: candidate.appVersion,
    compatibility: candidate.compatibility,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Feature detection also supports hosts without the tabs API. */
function resolveBrowserTabs(): TabsPort | null {
  const ambient = extensionBrowser.tabs
  if (!ambient || typeof ambient !== 'object') return null
  const tabs = ambient as Partial<TabsPort>
  if (typeof tabs.create !== 'function') return null
  return tabs as TabsPort
}

export class DiscoveryService {
  private readonly pins: PinReader
  private readonly config: DiscoveryConfig
  private readonly nativeBootstrap: NativeBootstrapPort | null
  private readonly fetchImpl: typeof fetch | null
  private readonly tabs: TabsPort | null

  constructor(options: DiscoveryServiceOptions) {
    this.pins = options.pins
    this.config = {
      candidatePorts: options.candidatePorts ?? DEFAULT_CANDIDATE_PORTS,
      discoveryTimeoutMs:
        options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      wakeDeadlineMs: options.wakeDeadlineMs ?? DEFAULT_WAKE_DEADLINE_MS,
    }
    this.nativeBootstrap = options.nativeBootstrap ?? null
    this.fetchImpl = options.fetchImpl ?? null
    this.tabs = options.tabs ?? null
  }

  /**
   * The §12 fast path: probe the port this credential last authenticated on
   * and accept it only if the responder reports the same `instanceId`.
   *
   * The `instanceId` match is a routing check, not an authentication — anything
   * local can echo the value back. It earns its place by catching the common
   * benign case where a *different* Motrix instance (or an unrelated service)
   * now holds that port, so the flow sweeps instead of spending its §8
   * challenge–response on an endpoint that provably is not the pinned one.
   *
   * Returns `null` on a mismatch, a dead port, or no pin — and leaves the pin
   * in place either way (see the module comment).
   */
  async tryPinnedPort(credentialId: string): Promise<DiscoveryResult | null> {
    const pin = await this.pins.get(credentialId)
    if (pin === null) return null
    return this.probePin(pin)
  }

  /** Probes every candidate port concurrently and collects the live ones (§4.1). */
  async sweepCandidates(): Promise<LiveCandidate[]> {
    return this.sweep(this.config.discoveryTimeoutMs)
  }

  /**
   * The §12 reconnect chain: pinned port → sweep for the pin's `instanceId` →
   * give up.
   *
   * With **no pin stored** — an interrupted rotation can leave a
   * `commit-uncertain` credential that never got one — the chain falls back to
   * the sweep and accepts it only when there is **exactly one** live
   * candidate. Picking one of several would be discovery data deciding
   * something, which §4.1 rules out; and refusing to try the single obvious
   * candidate would force a re-pair the protocol does not require. The
   * ambiguous case returns `null` and lands in the same recovery branch as a
   * mismatch.
   *
   * Returns `null` rather than throwing when nothing matches: "no endpoint
   * found" is an ordinary outcome the recovery order has to handle anyway.
   */
  async discoverForReconnect(
    credentialId: string
  ): Promise<DiscoveryResult | null> {
    const pin = await this.pins.get(credentialId)
    if (pin !== null) {
      const pinned = await this.probePin(pin)
      if (pinned !== null) return pinned
    }
    const live = await this.sweepCandidates()
    if (pin !== null) {
      const match = live.find(
        (candidate) => candidate.instanceId === pin.instanceId
      )
      return match === undefined ? null : toProbeResult(match)
    }
    const only = live.length === 1 ? live[0] : undefined
    return only === undefined ? null : toProbeResult(only)
  }

  /** One existing v1 NM call; its nonce is deliberately unused for /v1. */
  async wakeForReconnect(
    credentialIds: string[]
  ): Promise<Map<string, DiscoveryResult>> {
    const matches = new Map<string, DiscoveryResult>()
    if (this.nativeBootstrap === null || credentialIds.length === 0)
      return matches
    const reply = await this.nativeBootstrap.bootstrap({ allowLaunch: true })
    if (!isValidPort(reply.port)) return matches
    const live = await this.probe(reply.port, this.config.discoveryTimeoutMs)
    if (live === null) return matches
    // Preserve the no-pin rule: one unambiguous live instance, including a
    // host-selected ephemeral port outside the ordinary candidate range.
    const pins = await Promise.all(credentialIds.map((id) => this.pins.get(id)))
    const candidates = pins.some((pin) => pin === null)
      ? await this.sweepCandidates()
      : []
    const ports = new Set([
      ...candidates.map((candidate) => candidate.port),
      reply.port,
    ])
    for (const [index, id] of credentialIds.entries()) {
      const pin = pins[index]
      if (
        (pin && pin.instanceId === live.instanceId) ||
        (pin === null && ports.size === 1)
      ) {
        matches.set(id, toProbeResult(live))
      }
    }
    return matches
  }

  /**
   * Enumerates every endpoint a first pairing could target, for the user to
   * choose from.
   *
   * The NM bootstrap is preferred when a host port is injected: it is the only
   * path that can produce a §9.2 attestation ticket, and it returns a nonce
   * for free. On success it is the *only* result — a host that answered has
   * already told us which instance it speaks for, so offering a choice
   * alongside it would just invite the user to pick a less-attested route.
   *
   * **No nonce is fetched here.** `/nonce` is one-shot and capped (§4.2), so
   * fetching one per candidate would burn the server's budget on candidates
   * the user never picks. Call `ensureNonce` on the selected result instead.
   *
   * `allowLaunch` is forwarded to the host, which wakes a sleeping Motrix only
   * when it is literally `true`. This method does not escalate to
   * `wakeAndPoll` on an empty sweep: that needs a user gesture to open a tab,
   * so it is the caller's decision, not a silent side effect of discovery.
   */
  async discoverForFirstPair(opts: {
    allowLaunch: boolean
    bindingPub?: Uint8Array
  }): Promise<DiscoveryResult[]> {
    const viaNm = await this.tryNativeBootstrap(
      opts.allowLaunch,
      opts.bindingPub
    )
    if (viaNm !== null) return [viaNm]
    const live = await this.sweepCandidates()
    return live.map(toProbeResult)
  }

  /**
   * Opens `motrix://open` to wake Motrix, then polls `GET /discovery` against
   * a **single wall-clock deadline** and returns whatever came up.
   *
   * The deadline is one budget for the whole call, not per port and not per
   * sweep, so a slow or half-open port cannot extend it: each probe's own
   * timeout is clamped to the time left.
   *
   * Poll requests are §4.1 `GET /discovery` **only** — never §4.2 `POST
   * /nonce`. See the module comment for what happened the one time that was
   * confused.
   *
   * A tab that could not be created is not fatal: Motrix may already be
   * starting for some other reason, so the poll runs regardless.
   */
  async wakeAndPoll(): Promise<DiscoveryResult[]> {
    const deadline = Date.now() + this.config.wakeDeadlineMs
    const tabId = await this.openWakeTab()
    while (Date.now() < deadline) {
      const live = await this.sweep(
        Math.min(this.config.discoveryTimeoutMs, deadline - Date.now())
      )
      if (live.length > 0) {
        // Motrix answered, so the wake tab has done its job and is litter.
        // This is the *only* place it is closed: on the timeout path the
        // navigation may still be sitting on an external-protocol
        // confirmation the user has not answered yet, and closing that would
        // cancel the very wake we asked for. The timeout path therefore has a
        // single exit below, so that stays one testable invariant instead of
        // two branches a test can miss.
        await this.closeWakeTab(tabId)
        return live.map(toProbeResult)
      }
      // Clamped so the gap cannot push past the deadline either — without it
      // the call overshoots the budget it advertises by up to one interval.
      // `Math.max(0, ...)` because a sweep can itself overrun the budget, and a
      // negative delay makes Node warn and silently round up to 1 ms.
      await sleep(
        Math.max(0, Math.min(WAKE_POLL_INTERVAL_MS, deadline - Date.now()))
      )
    }
    return []
  }

  /**
   * Completes `result` with a §4.2 nonce, fetching one only if it does not
   * already have it. Returns `null` when no usable nonce could be obtained.
   *
   * This is the **only** public path that reaches `POST /nonce`, and it must be
   * called at most once, for the candidate the user actually selected. An NM
   * result whose host already supplied a nonce is returned untouched and costs
   * zero requests.
   *
   * A `/v1` reconnect needs no nonce (§4), so nothing on the reconnect chain
   * calls this.
   */
  async ensureNonce(result: DiscoveryResult): Promise<DiscoveryResult | null> {
    if (result.nonce !== undefined) return result
    const nonce = await this.fetchNonce(result.wsPort)
    return nonce === null ? null : { ...result, nonce }
  }

  /**
   * Resolves the compatibility hint for the candidate the user actually chose.
   * Probe candidates already carry their parsed `/discovery` document. Native
   * Messaging replies do not, so they receive exactly one liveness probe here.
   * The host may already have minted a nonce; an incompatible result is still
   * rejected by `ConnectionManager` before that nonce or the pairing backoff is
   * touched.
   */
  async preflightCompatibility(
    result: DiscoveryResult
  ): Promise<DiscoveryResult> {
    if (result.compatibility !== undefined) return result
    const live = await this.probe(result.wsPort, this.config.discoveryTimeoutMs)
    if (live === null) {
      return { ...result, compatibility: 'backendUpgradeRequired' }
    }
    return {
      ...result,
      instanceId: live.instanceId,
      appVersion: live.appVersion,
      compatibility: live.compatibility,
    }
  }

  private async probePin(pin: Pin): Promise<DiscoveryResult | null> {
    const live = await this.probe(pin.port, this.config.discoveryTimeoutMs)
    if (live === null || live.instanceId !== pin.instanceId) return null
    return { transport: 'probe', wsPort: pin.port, instanceId: live.instanceId }
  }

  /**
   * Probes all candidates concurrently. The result keeps **candidate-port
   * order**, not completion order, so a user-facing list is stable across
   * sweeps — it is an enumeration, not a ranking.
   */
  private async sweep(timeoutMs: number): Promise<LiveCandidate[]> {
    const probes = await Promise.all(
      this.config.candidatePorts.map((port) => this.probe(port, timeoutMs))
    )
    return probes.filter(
      (candidate): candidate is LiveCandidate => candidate !== null
    )
  }

  /**
   * One `GET /discovery` (§4.1). Never rejects: a refused connection, a
   * timeout, a non-2xx status and a body that is not a Motrix discovery
   * document are all just "not live here".
   */
  private async probe(
    port: number,
    timeoutMs: number
  ): Promise<LiveCandidate | null> {
    if (timeoutMs <= 0) return null
    try {
      const response = await this.request(
        `http://127.0.0.1:${port}/discovery`,
        {
          // No method override and no `X-Motrix-Bridge` header: those belong to
          // the §4.2 nonce fetch, and putting them here is the bug this module's
          // header table exists to prevent.
          signal: AbortSignal.timeout(timeoutMs),
        }
      )
      if (!response.ok) return null
      return readDiscoveryDoc(port, await response.json())
    } catch {
      return null
    }
  }

  /** One `POST /nonce` (§4.2). The only place the bridge header is sent. */
  private async fetchNonce(port: number): Promise<string | null> {
    try {
      const response = await this.request(`http://127.0.0.1:${port}/nonce`, {
        method: 'POST',
        // §4.2: this custom header makes the request non-simple, so a
        // cross-origin page is blocked by the browser's preflight.
        headers: { 'X-Motrix-Bridge': '1' },
        signal: AbortSignal.timeout(this.config.discoveryTimeoutMs),
      })
      if (!response.ok) return null
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') return null
      return readNonce((body as Record<string, unknown>).nonce)
    } catch {
      return null
    }
  }

  /**
   * `cache: 'no-store'` keeps a stale hint from being replayed out of the HTTP
   * cache, and `redirect: 'error'` keeps a loopback impostor from bouncing
   * either request — including the one carrying `X-Motrix-Bridge` — to a
   * non-loopback host.
   */
  private request(url: string, init: RequestInit): Promise<Response> {
    const impl = this.fetchImpl ?? globalThis.fetch
    return impl(url, { cache: 'no-store', redirect: 'error', ...init })
  }

  private async tryNativeBootstrap(
    allowLaunch: boolean,
    bindingPub?: Uint8Array
  ): Promise<DiscoveryResult | null> {
    if (this.nativeBootstrap === null) return null
    let reply: NativeBootstrapReply
    try {
      reply = await this.nativeBootstrap.bootstrap({
        allowLaunch,
        ...(bindingPub === undefined ? {} : { bindingPub }),
      })
    } catch {
      // No host installed, host error, or NM timeout: fall through to the
      // sweep rather than failing discovery outright.
      return null
    }
    if (!isValidPort(reply.port)) return null
    const result: DiscoveryResult = { transport: 'nm', wsPort: reply.port }
    const nonce = readNonce(reply.nonce)
    if (nonce !== null) result.nonce = nonce
    // A ticket is passed through byte-for-byte. §9.2 and §6.4 make a
    // *downgraded* ticket land in `unverified` -- worse than presenting none --
    // so it is tempting to drop one that looks stale. Doing that would game
    // the identity the approval dialog shows, which is the user's only signal
    // about what the server actually verified. A host that has no ticket sends
    // none, and that (absent, not null) is what the ticketless path needs.
    if (reply.nmTicket !== undefined && reply.nmTicket !== null) {
      result.nmTicket = reply.nmTicket
    }
    return result
  }

  private async openWakeTab(): Promise<number | null> {
    const tabs = this.tabs ?? resolveBrowserTabs()
    if (tabs === null) return null
    try {
      const tab = await tabs.create({ url: WAKE_URL })
      return typeof tab?.id === 'number' ? tab.id : null
    } catch {
      return null
    }
  }

  /** Tolerates an already-closed tab, and a `tabs` port without `remove`. */
  private async closeWakeTab(tabId: number | null): Promise<void> {
    if (tabId === null) return
    const tabs = this.tabs ?? resolveBrowserTabs()
    if (tabs === null || typeof tabs.remove !== 'function') return
    try {
      await tabs.remove(tabId)
    } catch {
      // The browser may well have closed it already after the protocol handoff.
    }
  }
}
