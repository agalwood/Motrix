import nativeMessagingExtensions from '@shared/config/native-messaging-extensions.json' with {
  type: 'json',
}
import type { Browser } from '@shared/protocol/bridge'
import type { IdentityTriState } from './credential-store'

export interface OfficialExtensionEntry {
  readonly browser: Browser
  readonly id: string
}

function freezeEntries(
  entries: ReadonlyArray<OfficialExtensionEntry>
): readonly OfficialExtensionEntry[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({ browser: entry.browser, id: entry.id })
    )
  )
}

/**
 * Store-signed identities compiled into Motrix. This is the only production
 * source of the `official` tier; persisted registry entries never enter it.
 */
export const BUILTIN_OFFICIAL_EXTENSION_ENTRIES = freezeEntries([
  ...nativeMessagingExtensions.chromium.map((id) => ({
    browser: 'chromium' as const,
    id,
  })),
  ...nativeMessagingExtensions.firefox.map((id) => ({
    browser: 'firefox' as const,
    id,
  })),
])

export type ExtensionIdentityEnvironment = 'production' | 'non-production'

export interface ExtensionIdentityResolverOptions {
  /** Must be chosen explicitly by the shell; core never reads process state. */
  readonly environment: ExtensionIdentityEnvironment
  /** Parsed shell configuration. Ignored completely in production. */
  readonly developmentEntries: ReadonlyArray<OfficialExtensionEntry>
}

export interface ExtensionIdentityInput {
  readonly browser: Browser
  /** Origin header accepted and browser-derived by the transport boundary. */
  readonly verifiedOrigin: string
  /** Untrusted pairHello field. Never copied into normalized output. */
  readonly claimedExtensionId: string
}

export type NormalizedExtensionIdentity =
  | {
      readonly browser: 'chromium'
      readonly originHost: string
      readonly verifiedExtensionId: string
    }
  | {
      readonly browser: 'firefox'
      readonly originHost: string
      readonly verifiedExtensionId: null
    }

export const ExtensionIdentityResolutionError =
  'invalid-extension-identity' as const

export interface ExtensionIdentityFailure {
  readonly ok: false
  readonly error: typeof ExtensionIdentityResolutionError
}

export type ExtensionIdentityNormalizationResult =
  | {
      readonly ok: true
      readonly identity: NormalizedExtensionIdentity
    }
  | ExtensionIdentityFailure

export type ExtensionIdentityAttestation =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'verified-nm-ticket'
      /** The callerId returned by successful NM ticket verification. */
      readonly callerId: string
    }

export type ExtensionIdentityEvidence =
  | 'verified-origin'
  | 'verified-nm-ticket'
  | 'none'

export type ExtensionIdentityResolution =
  | {
      readonly ok: true
      readonly identity: IdentityTriState
      readonly evidence: ExtensionIdentityEvidence
      /** A proven store/Gecko id, never the unverified pairHello claim. */
      readonly provenExtensionId: string | null
    }
  | ExtensionIdentityFailure

export interface ExtensionIdentityResolver {
  readonly builtInEntries: readonly OfficialExtensionEntry[]
  /** Empty in production, even if the shell supplied development entries. */
  readonly developmentEntries: readonly OfficialExtensionEntry[]
  /** Frozen effective input for Native Messaging manifest/registry setup. */
  readonly officialEntries: readonly OfficialExtensionEntry[]
  isOfficialId(browser: Browser, id: string): boolean
  resolve(
    identity: NormalizedExtensionIdentity,
    attestation: ExtensionIdentityAttestation
  ): ExtensionIdentityResolution
}

export type IsOfficialExtensionId = (browser: Browser, id: string) => boolean

const INVALID_IDENTITY_RESULT: ExtensionIdentityFailure = Object.freeze({
  ok: false,
  error: ExtensionIdentityResolutionError,
})

function invalidResolution(): ExtensionIdentityResolution {
  return INVALID_IDENTITY_RESULT
}

function keyOf(entry: OfficialExtensionEntry): string {
  return JSON.stringify([entry.browser, entry.id])
}

function deduplicateEntries(
  entries: ReadonlyArray<OfficialExtensionEntry>
): readonly OfficialExtensionEntry[] {
  const unique = new Map<string, OfficialExtensionEntry>()
  for (const entry of entries) {
    if (
      (entry.browser !== 'chromium' && entry.browser !== 'firefox') ||
      entry.id.length === 0
    ) {
      continue
    }
    const frozen = Object.freeze({ browser: entry.browser, id: entry.id })
    unique.set(keyOf(frozen), frozen)
  }
  return Object.freeze([...unique.values()])
}

function containsUnsafeOriginSyntax(value: string): boolean {
  if (value.includes('\\') || value.includes('%') || /\s/u.test(value)) {
    return true
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code >= 0x7f) return true
  }
  return false
}

/**
 * Normalize only transport-derived evidence. The claimed id is used once for
 * Chromium equality and is then discarded; Firefox claims prove nothing.
 */
export function normalizeExtensionIdentity(
  input: ExtensionIdentityInput
): ExtensionIdentityNormalizationResult {
  const scheme =
    input.browser === 'chromium' ? 'chrome-extension:' : 'moz-extension:'
  const prefix = `${scheme}//`
  if (
    input.verifiedOrigin.length === 0 ||
    !input.verifiedOrigin.startsWith(prefix) ||
    containsUnsafeOriginSyntax(input.verifiedOrigin)
  ) {
    return INVALID_IDENTITY_RESULT
  }

  let parsed: URL
  try {
    parsed = new URL(input.verifiedOrigin)
  } catch {
    return INVALID_IDENTITY_RESULT
  }

  if (
    parsed.protocol !== scheme ||
    parsed.hostname.length === 0 ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return INVALID_IDENTITY_RESULT
  }

  // WHATWG parsing normalizes aliases such as a trailing bare `:`, `?`, or
  // `#`. Identity evidence must be the exact canonical Origin bytes, not
  // merely something whose parsed host happens to match an official id.
  if (input.verifiedOrigin !== `${prefix}${parsed.hostname}`) {
    return INVALID_IDENTITY_RESULT
  }

  if (
    input.browser === 'chromium' &&
    parsed.hostname !== input.claimedExtensionId
  ) {
    return INVALID_IDENTITY_RESULT
  }

  const identity: NormalizedExtensionIdentity =
    input.browser === 'chromium'
      ? Object.freeze({
          browser: 'chromium',
          originHost: parsed.hostname,
          verifiedExtensionId: parsed.hostname,
        })
      : Object.freeze({
          browser: 'firefox',
          originHost: parsed.hostname,
          verifiedExtensionId: null,
        })
  return Object.freeze({ ok: true, identity })
}

function validProvenId(value: string): boolean {
  if (value.length === 0) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

/**
 * Build one immutable resolver. User/imported registry entries are
 * intentionally not an input, so mutating that registry cannot raise trust.
 */
export function createExtensionIdentityResolver(
  options: ExtensionIdentityResolverOptions
): ExtensionIdentityResolver {
  const builtInEntries = BUILTIN_OFFICIAL_EXTENSION_ENTRIES
  const developmentEntries =
    options.environment === 'non-production'
      ? deduplicateEntries(options.developmentEntries)
      : Object.freeze([])
  const officialEntries = deduplicateEntries([
    ...builtInEntries,
    ...developmentEntries,
  ])
  const officialIds = new Set(officialEntries.map(keyOf))

  const isOfficialId = (browser: Browser, id: string): boolean =>
    officialIds.has(JSON.stringify([browser, id]))

  const resolve = (
    identity: NormalizedExtensionIdentity,
    attestation: ExtensionIdentityAttestation
  ): ExtensionIdentityResolution =>
    resolveNormalizedExtensionIdentity(identity, attestation, isOfficialId)

  return Object.freeze({
    builtInEntries,
    developmentEntries,
    officialEntries,
    isOfficialId,
    resolve,
  })
}

/**
 * Resolve already-normalized transport evidence. PairSession uses this form
 * with its injected immutable-allowlist predicate, keeping wire options and
 * test doubles stable while sharing the classification rules with shells.
 */
export function resolveNormalizedExtensionIdentity(
  identity: NormalizedExtensionIdentity,
  attestation: ExtensionIdentityAttestation,
  isOfficialId: IsOfficialExtensionId
): ExtensionIdentityResolution {
  if (
    identity.originHost.length === 0 ||
    (identity.browser === 'chromium' &&
      (identity.verifiedExtensionId.length === 0 ||
        identity.verifiedExtensionId !== identity.originHost)) ||
    (identity.browser === 'firefox' && identity.verifiedExtensionId !== null)
  ) {
    return invalidResolution()
  }

  if (attestation.kind === 'verified-nm-ticket') {
    if (
      !validProvenId(attestation.callerId) ||
      (identity.browser === 'chromium' &&
        attestation.callerId !== identity.verifiedExtensionId)
    ) {
      return invalidResolution()
    }
    return Object.freeze({
      ok: true,
      identity: isOfficialId(identity.browser, attestation.callerId)
        ? 'official'
        : 'attested-non-official',
      evidence: 'verified-nm-ticket',
      provenExtensionId: attestation.callerId,
    })
  }

  if (identity.browser === 'firefox') {
    return Object.freeze({
      ok: true,
      identity: 'unverified',
      evidence: 'none',
      provenExtensionId: null,
    })
  }

  return Object.freeze({
    ok: true,
    identity: isOfficialId('chromium', identity.verifiedExtensionId)
      ? 'official'
      : 'attested-non-official',
    evidence: 'verified-origin',
    provenExtensionId: identity.verifiedExtensionId,
  })
}

/**
 * Parse a shell-provided comma-separated `<browser>:<id>` list. This helper
 * reads no environment variable; the shell must supply the string and choose
 * the resolver environment explicitly.
 */
export function parseDevTrustedExtensions(
  raw: string | undefined
): readonly OfficialExtensionEntry[] {
  if (!raw) return Object.freeze([])
  const entries: OfficialExtensionEntry[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    const browser = trimmed.slice(0, colon).trim()
    const id = trimmed.slice(colon + 1).trim()
    if (!id) continue
    if (browser !== 'chromium' && browser !== 'firefox') continue
    entries.push({ browser, id })
  }
  return freezeEntries(entries)
}
