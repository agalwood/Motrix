import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import {
  isIssuedRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'

const MAX_RAW_HEADER_ENTRIES = 256
const MAX_RAW_HEADER_NAME_LENGTH = 128
const MAX_FORWARDING_HEADER_LENGTH = 1_024
const MAX_VERIFIED_ORIGIN_LENGTH = 1_024
const MAX_TRUSTED_PROXY_ADDRESSES = 64

export interface RemoteExtensionRateLimit {
  readonly globalCap: number
  readonly perSourceCap: number
  readonly windowMs: number
}

export interface RemoteExtensionAdmissionPolicyOptions {
  /** Parser-issued capability. A copied/deserialized/forged config cannot
   * create admission state, even when it is structurally identical. */
  readonly config: RemoteExtensionConfig
  /** Outstanding, unconsumed nonce reservations. */
  readonly nonceIssuanceCap?: number
  readonly nonceIssuanceTtlMs?: number
  /** Upgraded sockets that have not completed MBP1 first-pair. */
  readonly pairPreAuthSocketCap?: number
  readonly pairPreAuthSocketTtlMs?: number
  /** Upgraded sockets that have not completed MBP1 reconnect. */
  readonly v1PreAuthSocketCap?: number
  readonly v1PreAuthSocketTtlMs?: number
  /** Prompts visible to, but not yet settled by, an authenticated operator. */
  readonly pendingPromptCap?: number
  readonly pendingPromptTtlMs?: number
  /** Public discovery requests. Independent from nonce issuance. */
  readonly discoveryRate?: RemoteExtensionRateLimit
  /** Public nonce requests. Independent from discovery. */
  readonly nonceRate?: RemoteExtensionRateLimit
  /** Exact canonical IP addresses only. Hostnames and CIDRs are not accepted. */
  readonly trustedProxyAddresses?: readonly string[]
  /**
   * Injectable millisecond source. Only progress beyond its observed
   * high-water mark is accumulated, so rollback/replay cannot age entries.
   */
  readonly now?: () => number
}

export interface RemoteExtensionClientSourceInput {
  readonly directPeerAddress: string | undefined
  /** Original HTTP/1 name/value vector, not a coalesced headers object. */
  readonly rawHeaders?: readonly string[]
}

export type RemoteExtensionClientSourceDecision =
  | {
      readonly ok: true
      readonly source: string
      readonly provenance: 'direct-peer' | 'trusted-proxy'
    }
  | {
      readonly ok: false
      readonly reason:
        | 'invalid-direct-peer'
        | 'ambiguous-forwarded-source'
        | 'malformed-forwarded-source'
    }

export type RemoteExtensionAdmissionLeaseKind =
  | 'nonce-issuance'
  | 'pair-pre-auth-socket'
  | 'v1-pre-auth-socket'
  | 'pending-prompt'

export interface RemoteExtensionAdmissionLease {
  readonly kind: RemoteExtensionAdmissionLeaseKind
  /**
   * Idempotent across success, failure, timeout, close, and shutdown paths.
   * The policy's TTL bounds bookkeeping; transport wiring must still close the
   * underlying socket or prompt on its own equal-or-shorter protocol deadline.
   */
  release(): void
}

export type RemoteExtensionAdmissionRejection =
  | 'capacity'
  | 'rate-limited'
  | 'invalid-verified-origin'
  | 'invalid-direct-peer'
  | 'ambiguous-forwarded-source'
  | 'malformed-forwarded-source'
  | 'disposed'

export type RemoteExtensionAdmissionDecision =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: RemoteExtensionAdmissionRejection
    }

export type RemoteExtensionLeaseDecision =
  | { readonly ok: true; readonly lease: RemoteExtensionAdmissionLease }
  | {
      readonly ok: false
      readonly reason: RemoteExtensionAdmissionRejection
    }

export type RemoteExtensionPromptAdmissionDecision =
  | {
      readonly ok: true
      readonly disposition: 'opened'
      readonly lease: RemoteExtensionAdmissionLease
    }
  | { readonly ok: true; readonly disposition: 'deduplicated' }
  | {
      readonly ok: false
      readonly reason: RemoteExtensionAdmissionRejection
    }

export interface RemoteExtensionAdmissionSnapshot {
  readonly nonceIssuances: number
  readonly pairPreAuthSockets: number
  readonly v1PreAuthSockets: number
  readonly pendingPrompts: number
  readonly discoveryRequestsInWindow: number
  readonly nonceRequestsInWindow: number
  readonly discoverySourcesInWindow: number
  readonly nonceSourcesInWindow: number
}

const DEFAULT_DISCOVERY_RATE: RemoteExtensionRateLimit = Object.freeze({
  globalCap: 120,
  perSourceCap: 30,
  windowMs: 60_000,
})

const DEFAULT_NONCE_RATE: RemoteExtensionRateLimit = Object.freeze({
  globalCap: 60,
  perSourceCap: 10,
  windowMs: 60_000,
})

export const DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS = Object.freeze({
  nonceIssuanceCap: 32,
  nonceIssuanceTtlMs: 60_000,
  pairPreAuthSocketCap: 32,
  pairPreAuthSocketTtlMs: 150_000,
  v1PreAuthSocketCap: 32,
  v1PreAuthSocketTtlMs: 15_000,
  pendingPromptCap: 3,
  pendingPromptTtlMs: 120_000,
  discoveryRate: DEFAULT_DISCOVERY_RATE,
  nonceRate: DEFAULT_NONCE_RATE,
})

const ALLOWED: RemoteExtensionAdmissionDecision = Object.freeze({ ok: true })

function rejected(reason: RemoteExtensionAdmissionRejection): {
  readonly ok: false
  readonly reason: RemoteExtensionAdmissionRejection
} {
  return Object.freeze({ ok: false, reason })
}

function invalidConfiguration(): never {
  throw new Error('invalid remote extension admission configuration')
}

function requirePositiveSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalidConfiguration()
  return value
}

function validateRateLimit(
  value: RemoteExtensionRateLimit
): RemoteExtensionRateLimit {
  return Object.freeze({
    globalCap: requirePositiveSafeInteger(value.globalCap),
    perSourceCap: requirePositiveSafeInteger(value.perSourceCap),
    windowMs: requirePositiveSafeInteger(value.windowMs),
  })
}

function containsUnsafeHeaderCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function mappedIpv4Address(value: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value)
  if (match === null) return null

  const high = Number.parseInt(match[1] ?? '', 16)
  const low = Number.parseInt(match[2] ?? '', 16)
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.')
}

/**
 * Canonical dotted IPv4 or lower-case RFC 5952-style IPv6, without brackets.
 * IPv4-mapped IPv6 is deliberately collapsed to dotted IPv4 so one network
 * peer cannot acquire separate allowlist identities or rate-limit buckets via
 * the two socket address representations.
 */
function canonicalIpAddress(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 64 ||
    containsUnsafeHeaderCharacter(value) ||
    /\p{White_Space}/u.test(value) ||
    value.includes('%') ||
    value.includes('[') ||
    value.includes(']')
  ) {
    return null
  }

  const version = isIP(value)
  if (version === 4) return value
  if (version !== 6) return null

  try {
    const hostname = new URL(`http://[${value}]/`).hostname
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null
    const canonical = hostname.slice(1, -1).toLowerCase()
    return mappedIpv4Address(canonical) ?? canonical
  } catch {
    return null
  }
}

function parseTrustedProxyAddresses(
  values: readonly string[] | undefined
): ReadonlySet<string> {
  if (values === undefined) return new Set()
  if (!Array.isArray(values) || values.length > MAX_TRUSTED_PROXY_ADDRESSES) {
    invalidConfiguration()
  }

  const result = new Set<string>()
  for (const value of values) {
    const canonical = canonicalIpAddress(value)
    if (canonical === null || canonical !== value || result.has(canonical)) {
      invalidConfiguration()
    }
    result.add(canonical)
  }
  return result
}

type ForwardedParseResult =
  | { readonly ok: true; readonly source: string }
  | {
      readonly ok: false
      readonly reason:
        | 'ambiguous-forwarded-source'
        | 'malformed-forwarded-source'
    }

function malformedForwarding(): ForwardedParseResult {
  return Object.freeze({ ok: false, reason: 'malformed-forwarded-source' })
}

function ambiguousForwarding(): ForwardedParseResult {
  return Object.freeze({ ok: false, reason: 'ambiguous-forwarded-source' })
}

function parseXForwardedFor(value: string): ForwardedParseResult {
  if (
    value.length === 0 ||
    value.length > MAX_FORWARDING_HEADER_LENGTH ||
    value.includes(',') ||
    value.trim() !== value ||
    containsUnsafeHeaderCharacter(value)
  ) {
    return value.includes(',') ? ambiguousForwarding() : malformedForwarding()
  }
  const source = canonicalIpAddress(value)
  return source === null ? malformedForwarding() : { ok: true, source }
}

function parseForwardedForValue(value: string): string | null {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 4 || value.includes('\\')) {
      return null
    }
    const inner = value.slice(1, -1)
    if (!inner.startsWith('[') || !inner.endsWith(']')) return null
    const literal = inner.slice(1, -1)
    if (isIP(literal) !== 6) return null
    return canonicalIpAddress(literal)
  }

  if (value.includes('"') || value.includes('[') || value.includes(']')) {
    return null
  }
  if (isIP(value) !== 4) return null
  return canonicalIpAddress(value)
}

function parseForwarded(value: string): ForwardedParseResult {
  if (
    value.length === 0 ||
    value.length > MAX_FORWARDING_HEADER_LENGTH ||
    containsUnsafeHeaderCharacter(value) ||
    /\p{White_Space}/u.test(value)
  ) {
    return malformedForwarding()
  }
  if (value.includes(',')) return ambiguousForwarding()

  const parameters = value.split(';')
  const names = new Set<string>()
  let source: string | null = null
  for (const parameter of parameters) {
    if (parameter.length === 0 || parameter.trim() !== parameter) {
      return malformedForwarding()
    }
    const separator = parameter.indexOf('=')
    if (separator <= 0 || separator === parameter.length - 1) {
      return malformedForwarding()
    }
    const name = parameter.slice(0, separator).toLowerCase()
    const parameterValue = parameter.slice(separator + 1)
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)) {
      return malformedForwarding()
    }
    if (names.has(name)) {
      return name === 'for' ? ambiguousForwarding() : malformedForwarding()
    }
    names.add(name)

    if (name === 'for') {
      source = parseForwardedForValue(parameterValue)
      if (source === null) return malformedForwarding()
      continue
    }
    if (
      parameterValue.length > MAX_FORWARDING_HEADER_LENGTH ||
      containsUnsafeHeaderCharacter(parameterValue) ||
      parameterValue.includes(',')
    ) {
      return malformedForwarding()
    }
  }

  return source === null ? malformedForwarding() : { ok: true, source }
}

function resolveForwardedSource(
  rawHeaders: readonly string[]
): ForwardedParseResult | null {
  if (
    !Array.isArray(rawHeaders) ||
    rawHeaders.length > MAX_RAW_HEADER_ENTRIES ||
    rawHeaders.length % 2 !== 0
  ) {
    return malformedForwarding()
  }

  const forwarded: string[] = []
  const xForwardedFor: string[] = []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]
    const value = rawHeaders[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string') {
      return malformedForwarding()
    }
    if (
      name.length === 0 ||
      name.length > MAX_RAW_HEADER_NAME_LENGTH ||
      containsUnsafeHeaderCharacter(name)
    ) {
      return malformedForwarding()
    }
    const normalizedName = name.toLowerCase()
    if (normalizedName === 'forwarded') forwarded.push(value)
    if (normalizedName === 'x-forwarded-for') xForwardedFor.push(value)
  }

  if (forwarded.length === 0 && xForwardedFor.length === 0) return null
  if (
    forwarded.length > 1 ||
    xForwardedFor.length > 1 ||
    (forwarded.length === 1 && xForwardedFor.length === 1)
  ) {
    return ambiguousForwarding()
  }
  if (forwarded.length === 1) return parseForwarded(forwarded[0] ?? '')
  return parseXForwardedFor(xForwardedFor[0] ?? '')
}

function normalizeVerifiedOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_VERIFIED_ORIGIN_LENGTH ||
    containsUnsafeHeaderCharacter(value) ||
    /\p{White_Space}/u.test(value) ||
    value.includes('\\') ||
    value.includes('%')
  ) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    (parsed.protocol !== 'chrome-extension:' &&
      parsed.protocol !== 'moz-extension:') ||
    parsed.host === '' ||
    parsed.hostname !== parsed.host ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    !/^[a-z0-9-]+$/u.test(parsed.hostname.toLowerCase())
  ) {
    return null
  }
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}`
}

class AdmissionLease implements RemoteExtensionAdmissionLease {
  private released = false

  constructor(
    readonly kind: RemoteExtensionAdmissionLeaseKind,
    private readonly releaseSlot: () => void
  ) {}

  release(): void {
    if (this.released) return
    this.released = true
    this.releaseSlot()
  }
}

class ExpiringCapacity {
  private readonly entries = new Map<symbol, number>()

  constructor(
    private readonly cap: number,
    private readonly ttlMs: number,
    private readonly kind: RemoteExtensionAdmissionLeaseKind
  ) {}

  hasCapacity(now: number): boolean {
    this.sweep(now)
    return this.entries.size < this.cap
  }

  acquire(now: number): RemoteExtensionAdmissionLease | null {
    if (!this.hasCapacity(now)) return null
    const leaseId = Symbol(this.kind)
    const expiresAt = now + this.ttlMs
    this.entries.set(leaseId, expiresAt)
    return new AdmissionLease(this.kind, () => {
      this.entries.delete(leaseId)
    })
  }

  size(now: number): number {
    this.sweep(now)
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  private sweep(now: number): void {
    for (const [leaseId, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(leaseId)
    }
  }
}

class SlidingWindowRate {
  private globalAttempts: number[] = []
  private readonly sourceAttempts = new Map<string, number[]>()

  constructor(private readonly options: RemoteExtensionRateLimit) {}

  admit(source: string, now: number): boolean {
    this.prune(now)
    if (this.globalAttempts.length >= this.options.globalCap) return false

    const perSource = this.sourceAttempts.get(source) ?? []
    if (perSource.length >= this.options.perSourceCap) return false

    this.globalAttempts.push(now)
    perSource.push(now)
    this.sourceAttempts.set(source, perSource)
    return true
  }

  snapshot(now: number): {
    readonly requests: number
    readonly sources: number
  } {
    this.prune(now)
    return {
      requests: this.globalAttempts.length,
      sources: this.sourceAttempts.size,
    }
  }

  clear(): void {
    this.globalAttempts = []
    this.sourceAttempts.clear()
  }

  private prune(now: number): void {
    const cutoff = now - this.options.windowMs
    this.globalAttempts = this.globalAttempts.filter(
      (timestamp) => timestamp > cutoff
    )
    for (const [source, timestamps] of this.sourceAttempts) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff)
      if (recent.length === 0) this.sourceAttempts.delete(source)
      else this.sourceAttempts.set(source, recent)
    }
  }
}

interface PendingPromptSlot {
  readonly leaseId: symbol
  readonly expiresAt: number
}

class MonotonicElapsedClock {
  private sourceHighWaterMark: number | undefined
  private logicalNow = 0

  constructor(
    private readonly source: () => number,
    private readonly maximumHorizonMs: number
  ) {}

  now(): number {
    let candidate: number
    try {
      candidate = this.source()
    } catch {
      invalidConfiguration()
    }
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      invalidConfiguration()
    }

    const previousHighWaterMark = this.sourceHighWaterMark
    if (previousHighWaterMark === undefined) {
      this.sourceHighWaterMark = candidate
      return this.logicalNow
    }
    if (candidate <= previousHighWaterMark) return this.logicalNow

    const delta = candidate - previousHighWaterMark
    const maximumSafeNow = Number.MAX_SAFE_INTEGER - this.maximumHorizonMs
    if (delta > maximumSafeNow - this.logicalNow) invalidConfiguration()

    this.sourceHighWaterMark = candidate
    this.logicalNow += delta
    return this.logicalNow
  }
}

/**
 * Pure, unwired admission boundary for the public remote-Extension surface.
 *
 * Every client-controlled cardinality is bounded by an independent global
 * cap. Forwarded source fields affect only an additional per-source rate
 * bucket, and only after the direct socket peer matches an exact configured
 * proxy IP. The class performs no I/O, logging, listening, route registration,
 * or bearer-credential work.
 */
export class RemoteExtensionAdmissionPolicy {
  private readonly trustedProxyAddresses: ReadonlySet<string>
  private readonly clock: MonotonicElapsedClock
  private readonly nonceIssuances: ExpiringCapacity
  private readonly pairPreAuthSockets: ExpiringCapacity
  private readonly v1PreAuthSockets: ExpiringCapacity
  private readonly promptCap: number
  private readonly promptTtlMs: number
  private readonly pendingPrompts = new Map<string, PendingPromptSlot>()
  private readonly discoveryRate: SlidingWindowRate
  private readonly nonceRate: SlidingWindowRate
  private disposed = false

  constructor(options: RemoteExtensionAdmissionPolicyOptions) {
    if (
      !isIssuedRemoteExtensionConfig(options.config) ||
      options.config.status !== 'enabled'
    ) {
      invalidConfiguration()
    }
    const nonceIssuanceCap = requirePositiveSafeInteger(
      options.nonceIssuanceCap ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.nonceIssuanceCap
    )
    const nonceIssuanceTtlMs = requirePositiveSafeInteger(
      options.nonceIssuanceTtlMs ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.nonceIssuanceTtlMs
    )
    const pairPreAuthSocketCap = requirePositiveSafeInteger(
      options.pairPreAuthSocketCap ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.pairPreAuthSocketCap
    )
    const pairPreAuthSocketTtlMs = requirePositiveSafeInteger(
      options.pairPreAuthSocketTtlMs ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.pairPreAuthSocketTtlMs
    )
    const v1PreAuthSocketCap = requirePositiveSafeInteger(
      options.v1PreAuthSocketCap ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.v1PreAuthSocketCap
    )
    const v1PreAuthSocketTtlMs = requirePositiveSafeInteger(
      options.v1PreAuthSocketTtlMs ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.v1PreAuthSocketTtlMs
    )
    this.promptCap = requirePositiveSafeInteger(
      options.pendingPromptCap ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.pendingPromptCap
    )
    this.promptTtlMs = requirePositiveSafeInteger(
      options.pendingPromptTtlMs ??
        DEFAULT_REMOTE_EXTENSION_ADMISSION_LIMITS.pendingPromptTtlMs
    )
    this.trustedProxyAddresses = parseTrustedProxyAddresses(
      options.trustedProxyAddresses
    )
    const discoveryRate = validateRateLimit(
      options.discoveryRate ?? DEFAULT_DISCOVERY_RATE
    )
    const nonceRate = validateRateLimit(options.nonceRate ?? DEFAULT_NONCE_RATE)
    const nowSource = options.now ?? (() => Math.floor(performance.now()))
    if (typeof nowSource !== 'function') invalidConfiguration()
    this.clock = new MonotonicElapsedClock(
      nowSource,
      Math.max(
        nonceIssuanceTtlMs,
        pairPreAuthSocketTtlMs,
        v1PreAuthSocketTtlMs,
        this.promptTtlMs,
        discoveryRate.windowMs,
        nonceRate.windowMs
      )
    )

    this.nonceIssuances = new ExpiringCapacity(
      nonceIssuanceCap,
      nonceIssuanceTtlMs,
      'nonce-issuance'
    )
    this.pairPreAuthSockets = new ExpiringCapacity(
      pairPreAuthSocketCap,
      pairPreAuthSocketTtlMs,
      'pair-pre-auth-socket'
    )
    this.v1PreAuthSockets = new ExpiringCapacity(
      v1PreAuthSocketCap,
      v1PreAuthSocketTtlMs,
      'v1-pre-auth-socket'
    )
    this.discoveryRate = new SlidingWindowRate(discoveryRate)
    this.nonceRate = new SlidingWindowRate(nonceRate)
  }

  resolveClientSource(
    input: RemoteExtensionClientSourceInput
  ): RemoteExtensionClientSourceDecision {
    const directPeer = canonicalIpAddress(input.directPeerAddress)
    if (directPeer === null) {
      return Object.freeze({ ok: false, reason: 'invalid-direct-peer' })
    }
    if (!this.trustedProxyAddresses.has(directPeer)) {
      return Object.freeze({
        ok: true,
        source: directPeer,
        provenance: 'direct-peer',
      })
    }

    const forwarded = resolveForwardedSource(input.rawHeaders ?? [])
    if (forwarded === null) {
      return Object.freeze({
        ok: true,
        source: directPeer,
        provenance: 'direct-peer',
      })
    }
    if (!forwarded.ok) return forwarded
    return Object.freeze({
      ok: true,
      source: forwarded.source,
      provenance: 'trusted-proxy',
    })
  }

  admitDiscoveryRequest(
    input: RemoteExtensionClientSourceInput
  ): RemoteExtensionAdmissionDecision {
    if (this.disposed) return rejected('disposed')
    const source = this.resolveClientSource(input)
    if (!source.ok) return rejected(source.reason)
    return this.discoveryRate.admit(source.source, this.now())
      ? ALLOWED
      : rejected('rate-limited')
  }

  admitNonceRequest(
    input: RemoteExtensionClientSourceInput
  ): RemoteExtensionLeaseDecision {
    if (this.disposed) return rejected('disposed')
    const source = this.resolveClientSource(input)
    if (!source.ok) return rejected(source.reason)

    const now = this.now()
    if (!this.nonceIssuances.hasCapacity(now)) return rejected('capacity')
    if (!this.nonceRate.admit(source.source, now)) {
      return rejected('rate-limited')
    }
    const lease = this.nonceIssuances.acquire(now)
    if (lease === null) return rejected('capacity')
    return Object.freeze({ ok: true, lease })
  }

  acquirePairPreAuthSocket(): RemoteExtensionLeaseDecision {
    return this.acquireCapacity(this.pairPreAuthSockets)
  }

  acquireV1PreAuthSocket(): RemoteExtensionLeaseDecision {
    return this.acquireCapacity(this.v1PreAuthSockets)
  }

  acquirePendingPrompt(
    verifiedOrigin: string
  ): RemoteExtensionPromptAdmissionDecision {
    if (this.disposed) return rejected('disposed')
    const origin = normalizeVerifiedOrigin(verifiedOrigin)
    if (origin === null) return rejected('invalid-verified-origin')

    const now = this.now()
    this.sweepPrompts(now)
    if (this.pendingPrompts.has(origin)) {
      return Object.freeze({ ok: true, disposition: 'deduplicated' })
    }
    if (this.pendingPrompts.size >= this.promptCap) {
      return rejected('capacity')
    }

    const leaseId = Symbol('pending-prompt')
    const expiresAt = now + this.promptTtlMs
    this.pendingPrompts.set(origin, { leaseId, expiresAt })
    const lease = new AdmissionLease('pending-prompt', () => {
      const current = this.pendingPrompts.get(origin)
      if (current?.leaseId === leaseId) this.pendingPrompts.delete(origin)
    })
    return Object.freeze({ ok: true, disposition: 'opened', lease })
  }

  snapshot(): RemoteExtensionAdmissionSnapshot {
    const now = this.now()
    this.sweepPrompts(now)
    const discovery = this.discoveryRate.snapshot(now)
    const nonce = this.nonceRate.snapshot(now)
    return Object.freeze({
      nonceIssuances: this.nonceIssuances.size(now),
      pairPreAuthSockets: this.pairPreAuthSockets.size(now),
      v1PreAuthSockets: this.v1PreAuthSockets.size(now),
      pendingPrompts: this.pendingPrompts.size,
      discoveryRequestsInWindow: discovery.requests,
      nonceRequestsInWindow: nonce.requests,
      discoverySourcesInWindow: discovery.sources,
      nonceSourcesInWindow: nonce.sources,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.nonceIssuances.clear()
    this.pairPreAuthSockets.clear()
    this.v1PreAuthSockets.clear()
    this.pendingPrompts.clear()
    this.discoveryRate.clear()
    this.nonceRate.clear()
  }

  private acquireCapacity(
    capacity: ExpiringCapacity
  ): RemoteExtensionLeaseDecision {
    if (this.disposed) return rejected('disposed')
    const lease = capacity.acquire(this.now())
    return lease === null
      ? rejected('capacity')
      : Object.freeze({ ok: true, lease })
  }

  private sweepPrompts(now: number): void {
    for (const [origin, slot] of this.pendingPrompts) {
      if (slot.expiresAt <= now) this.pendingPrompts.delete(origin)
    }
  }

  private now(): number {
    return this.clock.now()
  }
}
