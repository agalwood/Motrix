/**
 * Direct remote MBP1 discovery.
 *
 * This module is deliberately only an unauthenticated HTTP adapter. Discovery
 * never obtains a nonce automatically. A later explicit first-pair action may
 * consume the short-lived compatible-discovery capability exactly once to
 * POST `/nonce`; this module still does not open `/pair` or `/v1`, touch
 * credentials, call Native Messaging, scan loopback ports, or launch Motrix.
 * Every document it returns is labelled `untrustedDocument`: only the later
 * MBP1 transcript can authenticate `instanceId` and the backend runtime.
 */
import type { RemoteBackendAuthority } from '@/background/mbp1/backend-authority'
import {
  deriveRemoteBridgeRoute,
  isCanonicalMbp1PairNonce,
  type RemoteBridgeRoute,
  remotePairUrl,
} from '@/background/mbp1/bridge-route'

const SUPPORTED_DISCOVERY_API_VERSION = 1
const SUPPORTED_MBP_VERSION = 1
const SUPPORTED_MDXP_VERSION = '1.0'

const DEFAULT_TIMEOUT_MS = 5_000
export const REMOTE_DISCOVERY_MAX_TIMEOUT_MS = 10_000
export const REMOTE_DISCOVERY_MAX_BODY_BYTES = 64 * 1024
export const REMOTE_NONCE_MAX_BODY_BYTES = 4 * 1024
export const REMOTE_NONCE_CAPABILITY_TTL_MS = 30_000
const REMOTE_NONCE_MAX_CAPABILITY_TTL_MS = 60_000

const MAX_INSTANCE_ID_LENGTH = 128
const MAX_APP_VERSION_LENGTH = 64
const MAX_PROTOCOL_NAME_LENGTH = 32
const MAX_VERSION_LIST_LENGTH = 16
const MAX_PROTOCOL_VERSION = 65_535
const MAX_JSON_DEPTH = 32
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60
/** MBP1 v1 §4.2 fixes nonce lifetime at exactly 60 seconds. */
const NONCE_TTL_SECONDS = 60
const ROUTE_VALIDATION_NONCE = 'AQIDBAUGBwgJCgsMDQ4PEA'

const DISCOVERY_TOP_LEVEL_KEYS = [
  'app',
  'apiVersion',
  'instanceId',
  'appVersion',
  'runtime',
  'extensionPairing',
  'applicationProtocols',
] as const
const EXTENSION_PAIRING_KEYS = ['protocol', 'versions'] as const
const APPLICATION_PROTOCOL_KEYS = ['mdxp'] as const
const NONCE_RESPONSE_KEYS = ['nonce', 'ttlSeconds'] as const
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const REMOTE_NONCE_CAPABILITY_BRAND: unique symbol = Symbol(
  'motrix.mbp1.remote-nonce-capability'
)

export interface RemoteDiscoveryServiceOptions {
  fetchImpl?: typeof fetch
  /** One total deadline covering headers and the complete response body. */
  timeoutMs?: number
  /** Decompressed discovery bytes; production is capped at 64 KiB. */
  maxBodyBytes?: number
  /** Decompressed nonce-response bytes; production is capped at 4 KiB. */
  nonceMaxBodyBytes?: number
  /** Lifetime of one compatible-discovery nonce capability, max 60 seconds. */
  nonceCapabilityTtlMs?: number
}

export interface RemoteDiscoveryRequestOptions {
  signal?: AbortSignal
}

export interface RemoteDiscoveryDocument {
  readonly app: 'motrix-bridge'
  readonly apiVersion: number
  readonly instanceId: string
  readonly appVersion: string
  readonly runtime: 'electron' | 'server'
  readonly extensionPairing: {
    readonly protocol: string
    readonly versions: readonly number[]
  }
  readonly applicationProtocols: {
    readonly mdxp: readonly string[]
  }
}

export type RemoteDiscoveryIncompatibility =
  | 'apiVersion'
  | 'extensionPairing'
  | 'mdxp'

export interface CompatibleRemoteDiscovery {
  /** Opaque, process-local one-shot authority to request one remote nonce. */
  readonly [REMOTE_NONCE_CAPABILITY_BRAND]: true
  readonly status: 'compatible'
  /** Module-issued scope selected by the user, never response-supplied data. */
  readonly authority: RemoteBackendAuthority
  /** Pre-authentication routing and compatibility hints only. */
  readonly untrustedDocument: RemoteDiscoveryDocument
}

export interface IncompatibleRemoteDiscovery {
  readonly status: 'incompatible'
  readonly reason: 'backendUpgradeRequired' | 'extensionUpgradeRequired'
  readonly incompatibilities: readonly RemoteDiscoveryIncompatibility[]
  readonly authority: RemoteBackendAuthority
  readonly untrustedDocument: RemoteDiscoveryDocument
}

export type RemoteDiscoveryUnavailableDetail =
  | 'requestAborted'
  | 'requestTimedOut'
  | 'networkError'
  | 'redirectRejected'
  | 'unexpectedResponseUrl'
  | 'httpStatus'
  | 'rateLimited'
  | 'invalidContentType'
  | 'bodyTooLarge'
  | 'responseReadFailed'
  | 'unexpectedRuntimeHint'
  | 'malformedDocument'

export interface UnavailableRemoteDiscovery {
  readonly status: 'unavailable'
  readonly reason: 'remoteDiscoveryUnavailable'
  readonly detail: RemoteDiscoveryUnavailableDetail
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
}

export type RemoteDiscoveryResult =
  | CompatibleRemoteDiscovery
  | IncompatibleRemoteDiscovery
  | UnavailableRemoteDiscovery

export interface ReadyRemoteNonce {
  readonly status: 'ready'
  /** One-shot routing material. Never persist, log, or reuse this value. */
  readonly nonce: string
  /** Untrusted lifetime hint; MBP1 v1 permits 1..60 seconds. */
  readonly ttlSeconds: number
}

export type RemoteNonceUnavailableDetail =
  | 'invalidDiscoveryCapability'
  | 'discoveryCapabilityConsumed'
  | 'discoveryCapabilityExpired'
  | 'requestAborted'
  | 'requestTimedOut'
  | 'networkError'
  | 'redirectRejected'
  | 'unexpectedResponseUrl'
  | 'httpStatus'
  | 'rateLimited'
  | 'invalidContentType'
  | 'bodyTooLarge'
  | 'responseReadFailed'
  | 'malformedNonceResponse'

export interface UnavailableRemoteNonce {
  readonly status: 'unavailable'
  readonly reason: 'remotePairingUnavailable' | 'pairingRateLimited'
  readonly detail: RemoteNonceUnavailableDetail
  readonly httpStatus?: number
  readonly retryAfterSeconds?: number
}

export type RemoteNonceResult = ReadyRemoteNonce | UnavailableRemoteNonce

type AbortSource = 'caller' | 'timeout' | null

interface RequestDeadline {
  readonly signal: AbortSignal
  readonly source: () => AbortSource
  dispose(): void
}

interface RemoteNonceCapabilityState {
  readonly issuer: object
  readonly route: RemoteBridgeRoute
  readonly expiresAt: number
  consumed: boolean
}

const remoteNonceCapabilities = new WeakMap<
  CompatibleRemoteDiscovery,
  RemoteNonceCapabilityState
>()

class BodyTooLargeError extends Error {}

class MalformedDocumentError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  )
}

function isPrintableAscii(value: string, allowSpace: boolean): boolean {
  const minimum = allowSpace ? 0x20 : 0x21
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < minimum || code > 0x7e) return false
  }
  return true
}

function readNumericVersions(value: unknown): readonly number[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_VERSION_LIST_LENGTH
  ) {
    return null
  }
  const result: number[] = []
  const seen = new Set<number>()
  for (const entry of value) {
    if (
      typeof entry !== 'number' ||
      !Number.isSafeInteger(entry) ||
      entry < 0 ||
      entry > MAX_PROTOCOL_VERSION ||
      seen.has(entry)
    ) {
      return null
    }
    seen.add(entry)
    result.push(entry)
  }
  return Object.freeze(result)
}

function parseMdxpVersion(value: string): readonly [number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    major > MAX_PROTOCOL_VERSION ||
    minor > MAX_PROTOCOL_VERSION
  ) {
    return null
  }
  return [major, minor]
}

function readMdxpVersions(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_VERSION_LIST_LENGTH
  ) {
    return null
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      parseMdxpVersion(entry) === null ||
      seen.has(entry)
    ) {
      return null
    }
    seen.add(entry)
    result.push(entry)
  }
  return Object.freeze(result)
}

/**
 * Structural validation is intentionally stricter than `JSON.parse` alone:
 * unknown routing/token fields, duplicate capability entries, and data that
 * could inject control characters into UI/logs are rejected as malformed.
 */
function readDiscoveryDocument(value: unknown): RemoteDiscoveryDocument | null {
  if (!isRecord(value) || !hasExactKeys(value, DISCOVERY_TOP_LEVEL_KEYS)) {
    return null
  }
  if (value.app !== 'motrix-bridge') return null
  if (
    typeof value.apiVersion !== 'number' ||
    !Number.isSafeInteger(value.apiVersion) ||
    value.apiVersion < 0 ||
    value.apiVersion > MAX_PROTOCOL_VERSION
  ) {
    return null
  }
  if (
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0 ||
    value.instanceId.length > MAX_INSTANCE_ID_LENGTH ||
    !isPrintableAscii(value.instanceId, false)
  ) {
    return null
  }
  if (
    typeof value.appVersion !== 'string' ||
    value.appVersion.length === 0 ||
    value.appVersion.length > MAX_APP_VERSION_LENGTH ||
    value.appVersion.trim() !== value.appVersion ||
    !isPrintableAscii(value.appVersion, true)
  ) {
    return null
  }
  if (value.runtime !== 'electron' && value.runtime !== 'server') return null

  const pairing = value.extensionPairing
  if (!isRecord(pairing) || !hasExactKeys(pairing, EXTENSION_PAIRING_KEYS)) {
    return null
  }
  if (
    typeof pairing.protocol !== 'string' ||
    pairing.protocol.length === 0 ||
    pairing.protocol.length > MAX_PROTOCOL_NAME_LENGTH ||
    !isPrintableAscii(pairing.protocol, false)
  ) {
    return null
  }
  const pairingVersions = readNumericVersions(pairing.versions)
  if (pairingVersions === null) return null

  const protocols = value.applicationProtocols
  if (
    !isRecord(protocols) ||
    !hasExactKeys(protocols, APPLICATION_PROTOCOL_KEYS)
  ) {
    return null
  }
  const mdxpVersions = readMdxpVersions(protocols.mdxp)
  if (mdxpVersions === null) return null

  return Object.freeze({
    app: 'motrix-bridge' as const,
    apiVersion: value.apiVersion,
    instanceId: value.instanceId,
    appVersion: value.appVersion,
    runtime: value.runtime,
    extensionPairing: Object.freeze({
      protocol: pairing.protocol,
      versions: pairingVersions,
    }),
    applicationProtocols: Object.freeze({ mdxp: mdxpVersions }),
  })
}

/**
 * `JSON.parse` silently keeps only the last duplicate object member. That is
 * unsuitable for a pre-authentication protocol document: a proxy, log parser,
 * and this client could otherwise disagree about which version or route was
 * advertised. Scan the JSON grammar first and reject duplicate decoded keys.
 */
class JsonObjectKeyScanner {
  private offset = 0

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace()
    this.scanValue(0)
    this.skipWhitespace()
    if (this.offset !== this.text.length) throw new MalformedDocumentError()
  }

  private scanValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new MalformedDocumentError()
    const char = this.text[this.offset]
    if (char === '{') {
      this.scanObject(depth + 1)
      return
    }
    if (char === '[') {
      this.scanArray(depth + 1)
      return
    }
    if (char === '"') {
      this.scanString()
      return
    }
    if (char === 't') {
      this.scanLiteral('true')
      return
    }
    if (char === 'f') {
      this.scanLiteral('false')
      return
    }
    if (char === 'n') {
      this.scanLiteral('null')
      return
    }
    this.scanNumber()
  }

  private scanObject(depth: number): void {
    this.offset += 1
    this.skipWhitespace()
    if (this.consume('}')) return
    const keys = new Set<string>()
    for (;;) {
      if (this.text[this.offset] !== '"') throw new MalformedDocumentError()
      const key = this.scanString()
      if (keys.has(key) || DANGEROUS_JSON_KEYS.has(key)) {
        throw new MalformedDocumentError()
      }
      keys.add(key)
      this.skipWhitespace()
      if (!this.consume(':')) throw new MalformedDocumentError()
      this.skipWhitespace()
      this.scanValue(depth)
      this.skipWhitespace()
      if (this.consume('}')) return
      if (!this.consume(',')) throw new MalformedDocumentError()
      this.skipWhitespace()
    }
  }

  private scanArray(depth: number): void {
    this.offset += 1
    this.skipWhitespace()
    if (this.consume(']')) return
    for (;;) {
      this.scanValue(depth)
      this.skipWhitespace()
      if (this.consume(']')) return
      if (!this.consume(',')) throw new MalformedDocumentError()
      this.skipWhitespace()
    }
  }

  private scanString(): string {
    const start = this.offset
    this.offset += 1
    while (this.offset < this.text.length) {
      const char = this.text[this.offset]
      if (char === '"') {
        this.offset += 1
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string
        } catch {
          throw new MalformedDocumentError()
        }
      }
      if (char === '\\') {
        this.offset += 1
        const escapeCode = this.text[this.offset]
        if (escapeCode === 'u') {
          const hex = this.text.slice(this.offset + 1, this.offset + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new MalformedDocumentError()
          }
          this.offset += 5
          continue
        }
        if (
          escapeCode !== '"' &&
          escapeCode !== '\\' &&
          escapeCode !== '/' &&
          escapeCode !== 'b' &&
          escapeCode !== 'f' &&
          escapeCode !== 'n' &&
          escapeCode !== 'r' &&
          escapeCode !== 't'
        ) {
          throw new MalformedDocumentError()
        }
        this.offset += 1
        continue
      }
      if (char === undefined || char.charCodeAt(0) <= 0x1f) {
        throw new MalformedDocumentError()
      }
      this.offset += 1
    }
    throw new MalformedDocumentError()
  }

  private scanLiteral(literal: string): void {
    if (
      this.text.slice(this.offset, this.offset + literal.length) !== literal
    ) {
      throw new MalformedDocumentError()
    }
    this.offset += literal.length
  }

  private scanNumber(): void {
    const start = this.offset
    if (this.text[this.offset] === '-') this.offset += 1

    if (this.text[this.offset] === '0') {
      this.offset += 1
    } else {
      if (!this.isDigitOneToNine(this.text[this.offset])) {
        throw new MalformedDocumentError()
      }
      this.offset += 1
      while (this.isDigit(this.text[this.offset])) this.offset += 1
    }

    if (this.text[this.offset] === '.') {
      this.offset += 1
      if (!this.isDigit(this.text[this.offset])) {
        throw new MalformedDocumentError()
      }
      while (this.isDigit(this.text[this.offset])) this.offset += 1
    }

    if (this.text[this.offset] === 'e' || this.text[this.offset] === 'E') {
      this.offset += 1
      if (this.text[this.offset] === '+' || this.text[this.offset] === '-') {
        this.offset += 1
      }
      if (!this.isDigit(this.text[this.offset])) {
        throw new MalformedDocumentError()
      }
      while (this.isDigit(this.text[this.offset])) this.offset += 1
    }

    if (this.offset === start) throw new MalformedDocumentError()
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '0' && value <= '9'
  }

  private isDigitOneToNine(value: string | undefined): boolean {
    return value !== undefined && value >= '1' && value <= '9'
  }

  private skipWhitespace(): void {
    while (
      this.text[this.offset] === ' ' ||
      this.text[this.offset] === '\n' ||
      this.text[this.offset] === '\r' ||
      this.text[this.offset] === '\t'
    ) {
      this.offset += 1
    }
  }

  private consume(expected: string): boolean {
    if (this.text[this.offset] !== expected) return false
    this.offset += 1
    return true
  }
}

function parseStrictJson(text: string): unknown {
  new JsonObjectKeyScanner(text).scan()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MalformedDocumentError()
  }
}

function compareMdxpVersions(a: string, b: string): number {
  const left = parseMdxpVersion(a)
  const right = parseMdxpVersion(b)
  if (left === null || right === null) return 0
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0]
}

function classifyDocument(
  authority: RemoteBackendAuthority,
  document: RemoteDiscoveryDocument
): RemoteDiscoveryResult {
  // A Desktop bridge exposed behind the configured public URL is the wrong
  // target, not evidence that either side's protocol version is old. Keep the
  // authenticated `unexpectedRuntime` verdict for initialize; discovery can
  // report only this pre-authentication diagnostic hint.
  if (document.runtime !== 'server') {
    return unavailable('unexpectedRuntimeHint')
  }

  const incompatibilities: RemoteDiscoveryIncompatibility[] = []
  const onlyNewer: boolean[] = []

  if (document.apiVersion !== SUPPORTED_DISCOVERY_API_VERSION) {
    incompatibilities.push('apiVersion')
    onlyNewer.push(document.apiVersion > SUPPORTED_DISCOVERY_API_VERSION)
  }
  const pairing = document.extensionPairing
  if (
    pairing.protocol !== 'mbp1' ||
    !pairing.versions.includes(SUPPORTED_MBP_VERSION)
  ) {
    incompatibilities.push('extensionPairing')
    onlyNewer.push(
      pairing.protocol === 'mbp1' &&
        pairing.versions.every((version) => version > SUPPORTED_MBP_VERSION)
    )
  }

  const mdxpVersions = document.applicationProtocols.mdxp
  if (!mdxpVersions.includes(SUPPORTED_MDXP_VERSION)) {
    incompatibilities.push('mdxp')
    onlyNewer.push(
      mdxpVersions.every(
        (version) => compareMdxpVersions(version, SUPPORTED_MDXP_VERSION) > 0
      )
    )
  }

  if (incompatibilities.length === 0) {
    return Object.freeze({
      [REMOTE_NONCE_CAPABILITY_BRAND]: true as const,
      status: 'compatible' as const,
      authority,
      untrustedDocument: document,
    })
  }
  return Object.freeze({
    status: 'incompatible' as const,
    reason: onlyNewer.every(Boolean)
      ? ('extensionUpgradeRequired' as const)
      : ('backendUpgradeRequired' as const),
    incompatibilities: Object.freeze(incompatibilities),
    authority,
    untrustedDocument: document,
  })
}

function unavailable(
  detail: RemoteDiscoveryUnavailableDetail,
  extra: Pick<
    UnavailableRemoteDiscovery,
    'httpStatus' | 'retryAfterSeconds'
  > = {}
): UnavailableRemoteDiscovery {
  return Object.freeze({
    status: 'unavailable' as const,
    reason: 'remoteDiscoveryUnavailable' as const,
    detail,
    ...extra,
  })
}

function nonceUnavailable(
  detail: RemoteNonceUnavailableDetail,
  extra: Pick<UnavailableRemoteNonce, 'httpStatus' | 'retryAfterSeconds'> = {}
): UnavailableRemoteNonce {
  return Object.freeze({
    status: 'unavailable' as const,
    reason:
      detail === 'rateLimited'
        ? ('pairingRateLimited' as const)
        : ('remotePairingUnavailable' as const),
    detail,
    ...extra,
  })
}

/**
 * The single MBP1 v1 nonce DTO shared with Motrix's NonceService. The Server
 * lifetime is exactly 60 seconds. Rejecting any other value prevents a
 * superficially similar, non-MBP1 endpoint from being classified as ready.
 */
function readNonceResponse(value: unknown): ReadyRemoteNonce | null {
  if (!isRecord(value) || !hasExactKeys(value, NONCE_RESPONSE_KEYS)) {
    return null
  }
  if (!isCanonicalMbp1PairNonce(value.nonce)) {
    return null
  }
  if (
    typeof value.ttlSeconds !== 'number' ||
    !Number.isSafeInteger(value.ttlSeconds) ||
    value.ttlSeconds !== NONCE_TTL_SECONDS
  ) {
    return null
  }
  return Object.freeze({
    status: 'ready' as const,
    nonce: value.nonce,
    ttlSeconds: value.ttlSeconds,
  })
}

function readRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^(0|[1-9]\d{0,5})$/.test(value)) return undefined
  const seconds = Number(value)
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined
}

/** Process-local monotonic time keeps a wall-clock adjustment from extending
 * a nonce capability. A service-worker restart drops the WeakMap entirely. */
function monotonicNow(): number {
  return globalThis.performance.now()
}

function createRequestDeadline(
  timeoutMs: number,
  callerSignal?: AbortSignal
): RequestDeadline {
  const controller = new AbortController()
  let source: AbortSource = null
  const abort = (next: Exclude<AbortSource, null>): void => {
    if (controller.signal.aborted) return
    source = next
    controller.abort()
  }
  const onCallerAbort = (): void => abort('caller')

  if (callerSignal?.aborted) {
    abort('caller')
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timeout = controller.signal.aborted
    ? undefined
    : setTimeout(() => abort('timeout'), timeoutMs)

  return {
    signal: controller.signal,
    source: () => source,
    dispose() {
      if (timeout !== undefined) clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', onCallerAbort)
      // Force-close any fetch-backed body whose best-effort stream
      // cancellation did not settle. This runs after the terminal result has
      // been selected, so it cannot change its diagnostic classification.
      if (!controller.signal.aborted) controller.abort()
    },
  }
}

async function readWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

/**
 * Race the fetch headers promise against our own deadline instead of assuming
 * an injected/browser fetch implementation settles when its signal aborts.
 * If a non-conforming fetch resolves later, eagerly cancel its body so the
 * already-terminal adapter call does not leave an unobserved response alive.
 */
function fetchWithAbort(
  promise: Promise<Response>,
  signal: AbortSignal
): Promise<Response> {
  if (signal.aborted) {
    void promise.then(cancelBody, () => undefined)
    return Promise.reject(new DOMException('aborted', 'AbortError'))
  }
  return new Promise<Response>((resolve, reject) => {
    let terminal = false
    const onAbort = (): void => {
      if (terminal) return
      terminal = true
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (response) => {
        signal.removeEventListener('abort', onAbort)
        if (terminal || signal.aborted) {
          cancelBody(response)
          return
        }
        terminal = true
        resolve(response)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (terminal) return
        terminal = true
        reject(error)
      }
    )
  })
}

function cancelBody(response: Response): void {
  // Cleanup must never become a second unbounded network operation after the
  // adapter has already reached a terminal result. A fetch-backed stream is
  // also tied to the request AbortSignal, so this is only an eager hint.
  void response.body?.cancel().catch(() => undefined)
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader.read(), signal)
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new BodyTooLargeError()
      chunks.push(value)
    }
  } catch (error) {
    // Do not await a hostile/stalled stream's cleanup. The request deadline is
    // a total deadline, including the body and cleanup paths.
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A synthetic stream can keep a read pending after cancellation. The
      // fetch AbortSignal still owns network cleanup; never mask the result.
    }
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new MalformedDocumentError()
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false
  return /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
    value.trim()
  )
}

function validateRoute(route: RemoteBridgeRoute): RemoteBackendAuthority {
  // The pair helper is the current module boundary that verifies the opaque
  // BridgeRoute issuance registry. It also revalidates the nested authority.
  remotePairUrl(route, ROUTE_VALIDATION_NONCE)
  const canonical = deriveRemoteBridgeRoute(route.authority)
  if (
    route.discoveryUrl !== canonical.discoveryUrl ||
    route.nonceUrl !== canonical.nonceUrl ||
    route.v1Url !== canonical.v1Url ||
    remotePairUrl(route, ROUTE_VALIDATION_NONCE) !==
      remotePairUrl(canonical, ROUTE_VALIDATION_NONCE)
  ) {
    throw new Error('BridgeRoute is not canonical for its BackendAuthority')
  }
  return route.authority
}

/**
 * Fetch one configured remote authority exactly once. All transport and parse
 * failures are data, while forged capabilities remain programmer errors and
 * reject before any network request.
 */
export class RemoteDiscoveryService {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxBodyBytes: number
  private readonly nonceMaxBodyBytes: number
  private readonly nonceCapabilityTtlMs: number
  private readonly nonceIssuer = Object.freeze({})

  constructor(options: RemoteDiscoveryServiceOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBodyBytes = options.maxBodyBytes ?? REMOTE_DISCOVERY_MAX_BODY_BYTES
    const nonceMaxBodyBytes =
      options.nonceMaxBodyBytes ?? REMOTE_NONCE_MAX_BODY_BYTES
    const nonceCapabilityTtlMs =
      options.nonceCapabilityTtlMs ?? REMOTE_NONCE_CAPABILITY_TTL_MS
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > REMOTE_DISCOVERY_MAX_TIMEOUT_MS
    ) {
      throw new Error('remote discovery timeout is outside the policy bound')
    }
    if (
      !Number.isInteger(maxBodyBytes) ||
      maxBodyBytes < 1 ||
      maxBodyBytes > REMOTE_DISCOVERY_MAX_BODY_BYTES
    ) {
      throw new Error('remote discovery body cap is outside the policy bound')
    }
    if (
      !Number.isInteger(nonceMaxBodyBytes) ||
      nonceMaxBodyBytes < 1 ||
      nonceMaxBodyBytes > REMOTE_NONCE_MAX_BODY_BYTES
    ) {
      throw new Error('remote nonce body cap is outside the policy bound')
    }
    if (
      !Number.isInteger(nonceCapabilityTtlMs) ||
      nonceCapabilityTtlMs < 1 ||
      nonceCapabilityTtlMs > REMOTE_NONCE_MAX_CAPABILITY_TTL_MS
    ) {
      throw new Error('remote nonce capability TTL is outside the policy bound')
    }
    // Browser-native fetch is receiver-sensitive in MV3 service workers.
    // Calling an unbound copy as `this.fetchImpl(...)` supplies this service
    // object as the receiver and Chromium rejects it with `Illegal invocation`.
    // Injected test transports remain untouched; only the native global is
    // bound to the realm that owns it.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = timeoutMs
    this.maxBodyBytes = maxBodyBytes
    this.nonceMaxBodyBytes = nonceMaxBodyBytes
    this.nonceCapabilityTtlMs = nonceCapabilityTtlMs
  }

  async discover(
    route: RemoteBridgeRoute,
    options: RemoteDiscoveryRequestOptions = {}
  ): Promise<RemoteDiscoveryResult> {
    const authority = validateRoute(route)
    const deadline = createRequestDeadline(this.timeoutMs, options.signal)
    if (deadline.signal.aborted) {
      deadline.dispose()
      return unavailable('requestAborted')
    }

    try {
      let response: Response
      try {
        response = await fetchWithAbort(
          this.fetchImpl(route.discoveryUrl, {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: deadline.signal,
          }),
          deadline.signal
        )
      } catch {
        if (deadline.source() === 'caller') {
          return unavailable('requestAborted')
        }
        if (deadline.source() === 'timeout') {
          return unavailable('requestTimedOut')
        }
        return unavailable('networkError')
      }

      if (deadline.signal.aborted) {
        cancelBody(response)
        return unavailable(
          deadline.source() === 'timeout' ? 'requestTimedOut' : 'requestAborted'
        )
      }
      if (response.type === 'opaqueredirect' || response.redirected) {
        cancelBody(response)
        return unavailable('redirectRejected')
      }
      if (response.url !== route.discoveryUrl) {
        cancelBody(response)
        return unavailable('unexpectedResponseUrl')
      }
      if (response.status >= 300 && response.status < 400) {
        cancelBody(response)
        return unavailable('redirectRejected', { httpStatus: response.status })
      }
      if (response.status === 429) {
        cancelBody(response)
        const retryAfterSeconds = readRetryAfterSeconds(
          response.headers.get('retry-after')
        )
        return unavailable('rateLimited', {
          httpStatus: response.status,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        })
      }
      if (response.status !== 200) {
        cancelBody(response)
        return unavailable('httpStatus', { httpStatus: response.status })
      }
      if (!isJsonContentType(response.headers.get('content-type'))) {
        cancelBody(response)
        return unavailable('invalidContentType')
      }

      let text: string
      try {
        text = await readBoundedBody(
          response,
          this.maxBodyBytes,
          deadline.signal
        )
      } catch (error) {
        if (deadline.source() === 'caller') {
          return unavailable('requestAborted')
        }
        if (deadline.source() === 'timeout') {
          return unavailable('requestTimedOut')
        }
        if (error instanceof BodyTooLargeError) {
          return unavailable('bodyTooLarge')
        }
        if (error instanceof MalformedDocumentError) {
          return unavailable('malformedDocument')
        }
        return unavailable('responseReadFailed')
      }

      let document: RemoteDiscoveryDocument | null
      try {
        document = readDiscoveryDocument(parseStrictJson(text))
      } catch {
        document = null
      }
      if (document === null) return unavailable('malformedDocument')
      const result = classifyDocument(authority, document)
      if (result.status === 'compatible') {
        remoteNonceCapabilities.set(result, {
          issuer: this.nonceIssuer,
          route,
          expiresAt: monotonicNow() + this.nonceCapabilityTtlMs,
          consumed: false,
        })
      }
      return result
    } finally {
      deadline.dispose()
    }
  }

  /**
   * Consume one compatible discovery result to issue one remote pairing nonce.
   *
   * The result identity is the capability: copies, JSON clones, and
   * incompatible/unavailable results are absent from the process-local
   * registry. A result also carries an opaque issuer identity, so another
   * service instance cannot use it. Issuer mismatch burns the capability, and
   * the valid issuer flips `consumed` synchronously before expiry and the first
   * await, so cross-instance misuse and concurrent calls both burn it without
   * a second POST. Every terminal attempt requires a new discovery.
   */
  async requestNonce(
    discovery: CompatibleRemoteDiscovery,
    options: RemoteDiscoveryRequestOptions = {}
  ): Promise<RemoteNonceResult> {
    if (typeof discovery !== 'object' || discovery === null) {
      return nonceUnavailable('invalidDiscoveryCapability')
    }
    const capability = remoteNonceCapabilities.get(discovery)
    if (
      capability === undefined ||
      discovery[REMOTE_NONCE_CAPABILITY_BRAND] !== true
    ) {
      return nonceUnavailable('invalidDiscoveryCapability')
    }
    if (capability.issuer !== this.nonceIssuer) {
      capability.consumed = true
      return nonceUnavailable('invalidDiscoveryCapability')
    }
    if (capability.consumed) {
      return nonceUnavailable('discoveryCapabilityConsumed')
    }

    // This write is the linearization point for concurrent requests. It must
    // remain before expiry, caller-abort, and every network await.
    capability.consumed = true
    if (monotonicNow() >= capability.expiresAt) {
      return nonceUnavailable('discoveryCapabilityExpired')
    }

    const deadline = createRequestDeadline(this.timeoutMs, options.signal)
    if (deadline.signal.aborted) {
      deadline.dispose()
      return nonceUnavailable('requestAborted')
    }

    const { route } = capability
    try {
      let response: Response
      try {
        response = await fetchWithAbort(
          this.fetchImpl(route.nonceUrl, {
            method: 'POST',
            headers: { 'X-Motrix-Bridge': '1' },
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: deadline.signal,
          }),
          deadline.signal
        )
      } catch {
        if (deadline.source() === 'caller') {
          return nonceUnavailable('requestAborted')
        }
        if (deadline.source() === 'timeout') {
          return nonceUnavailable('requestTimedOut')
        }
        return nonceUnavailable('networkError')
      }

      if (deadline.signal.aborted) {
        cancelBody(response)
        return nonceUnavailable(
          deadline.source() === 'timeout' ? 'requestTimedOut' : 'requestAborted'
        )
      }
      if (response.type === 'opaqueredirect' || response.redirected) {
        cancelBody(response)
        return nonceUnavailable('redirectRejected')
      }
      if (response.url !== route.nonceUrl) {
        cancelBody(response)
        return nonceUnavailable('unexpectedResponseUrl')
      }
      if (response.status >= 300 && response.status < 400) {
        cancelBody(response)
        return nonceUnavailable('redirectRejected', {
          httpStatus: response.status,
        })
      }
      if (response.status === 429) {
        cancelBody(response)
        const retryAfterSeconds = readRetryAfterSeconds(
          response.headers.get('retry-after')
        )
        return nonceUnavailable('rateLimited', {
          httpStatus: response.status,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        })
      }
      if (response.status !== 200) {
        cancelBody(response)
        return nonceUnavailable('httpStatus', { httpStatus: response.status })
      }
      if (!isJsonContentType(response.headers.get('content-type'))) {
        cancelBody(response)
        return nonceUnavailable('invalidContentType')
      }

      let text: string
      try {
        text = await readBoundedBody(
          response,
          this.nonceMaxBodyBytes,
          deadline.signal
        )
      } catch (error) {
        if (deadline.source() === 'caller') {
          return nonceUnavailable('requestAborted')
        }
        if (deadline.source() === 'timeout') {
          return nonceUnavailable('requestTimedOut')
        }
        if (error instanceof BodyTooLargeError) {
          return nonceUnavailable('bodyTooLarge')
        }
        if (error instanceof MalformedDocumentError) {
          return nonceUnavailable('malformedNonceResponse')
        }
        return nonceUnavailable('responseReadFailed')
      }

      let result: ReadyRemoteNonce | null
      try {
        result = readNonceResponse(parseStrictJson(text))
      } catch {
        result = null
      }
      return result ?? nonceUnavailable('malformedNonceResponse')
    } finally {
      deadline.dispose()
    }
  }
}
