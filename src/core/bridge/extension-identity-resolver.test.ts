import { describe, expect, it } from 'vitest'
import {
  BUILTIN_OFFICIAL_EXTENSION_ENTRIES,
  createExtensionIdentityResolver,
  ExtensionIdentityResolutionError,
  type NormalizedExtensionIdentity,
  normalizeExtensionIdentity,
  parseDevTrustedExtensions,
} from './extension-identity-resolver'
import { TrustedExtensionRegistry } from './trusted-extension-registry'

const BUILTIN_CHROMIUM_ID = 'ibpkjhgpbidfmbmomagmldcdlpbmchgi'
const BUILTIN_FIREFOX_ID = 'motrix-extension@motrix.app'
const OTHER_CHROMIUM_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DEV_CHROMIUM_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const FIREFOX_ORIGIN = 'moz-extension://8c1a0d6e-1f2b-4c3d-9e0a-5b6c7d8e9f01'

function normalizedChromium(
  id = BUILTIN_CHROMIUM_ID
): NormalizedExtensionIdentity {
  const result = normalizeExtensionIdentity({
    browser: 'chromium',
    verifiedOrigin: `chrome-extension://${id}`,
    claimedExtensionId: id,
  })
  if (!result.ok) throw new Error('test identity did not normalize')
  return result.identity
}

function normalizedFirefox(): NormalizedExtensionIdentity {
  const result = normalizeExtensionIdentity({
    browser: 'firefox',
    verifiedOrigin: FIREFOX_ORIGIN,
    claimedExtensionId: BUILTIN_FIREFOX_ID,
  })
  if (!result.ok) throw new Error('test identity did not normalize')
  return result.identity
}

describe('extension identity allowlist', () => {
  it('owns a frozen built-in allowlist independent from callers', () => {
    expect(BUILTIN_OFFICIAL_EXTENSION_ENTRIES).toContainEqual({
      browser: 'chromium',
      id: BUILTIN_CHROMIUM_ID,
    })
    expect(BUILTIN_OFFICIAL_EXTENSION_ENTRIES).toContainEqual({
      browser: 'firefox',
      id: BUILTIN_FIREFOX_ID,
    })
    expect(Object.isFrozen(BUILTIN_OFFICIAL_EXTENSION_ENTRIES)).toBe(true)
    for (const entry of BUILTIN_OFFICIAL_EXTENSION_ENTRIES) {
      expect(Object.isFrozen(entry)).toBe(true)
    }
  })

  it('enables explicit development entries only in non-production', () => {
    const entries = [{ browser: 'chromium' as const, id: DEV_CHROMIUM_ID }]
    const development = createExtensionIdentityResolver({
      environment: 'non-production',
      developmentEntries: entries,
    })
    const production = createExtensionIdentityResolver({
      environment: 'production',
      developmentEntries: entries,
    })

    expect(development.isOfficialId('chromium', DEV_CHROMIUM_ID)).toBe(true)
    expect(production.isOfficialId('chromium', DEV_CHROMIUM_ID)).toBe(false)
    expect(production.developmentEntries).toEqual([])
    expect(production.officialEntries).not.toContainEqual(entries[0])
  })

  it('copies and freezes development inputs before they become official', () => {
    const entries = [{ browser: 'chromium' as const, id: DEV_CHROMIUM_ID }]
    const resolver = createExtensionIdentityResolver({
      environment: 'non-production',
      developmentEntries: entries,
    })

    entries[0].id = OTHER_CHROMIUM_ID
    entries.push({ browser: 'chromium', id: OTHER_CHROMIUM_ID })

    expect(resolver.isOfficialId('chromium', DEV_CHROMIUM_ID)).toBe(true)
    expect(resolver.isOfficialId('chromium', OTHER_CHROMIUM_ID)).toBe(false)
    expect(Object.isFrozen(resolver.developmentEntries)).toBe(true)
    expect(Object.isFrozen(resolver.officialEntries)).toBe(true)
    expect(Object.isFrozen(resolver.developmentEntries[0])).toBe(true)
  })

  it('never crosses browser namespaces', () => {
    const resolver = createExtensionIdentityResolver({
      environment: 'production',
      developmentEntries: [],
    })

    expect(resolver.isOfficialId('chromium', BUILTIN_CHROMIUM_ID)).toBe(true)
    expect(resolver.isOfficialId('firefox', BUILTIN_CHROMIUM_ID)).toBe(false)
  })

  it('cannot be elevated by user-added or imported registry entries', async () => {
    const resolver = createExtensionIdentityResolver({
      environment: 'production',
      developmentEntries: [],
    })
    const store = {
      read: async () =>
        JSON.stringify([
          {
            id: OTHER_CHROMIUM_ID,
            browser: 'chromium',
            source: 'user-added',
            addedAt: 1,
          },
          {
            id: 'imported@example.org',
            browser: 'firefox',
            source: 'imported',
            addedAt: 2,
          },
        ]),
      write: async () => {},
    }
    const registry = new TrustedExtensionRegistry(store, [
      ...resolver.officialEntries,
    ])
    await registry.load()

    expect(registry.has(OTHER_CHROMIUM_ID, 'chromium')).toBe(true)
    expect(registry.has('imported@example.org', 'firefox')).toBe(true)
    expect(resolver.isOfficialId('chromium', OTHER_CHROMIUM_ID)).toBe(false)
    expect(resolver.isOfficialId('firefox', 'imported@example.org')).toBe(false)
  })

  it('parses development entries without reading process state', () => {
    expect(
      parseDevTrustedExtensions(
        ' chromium:aaa, bad,firefox:dev@example.org,unknown:nope '
      )
    ).toEqual([
      { browser: 'chromium', id: 'aaa' },
      { browser: 'firefox', id: 'dev@example.org' },
    ])
    expect(parseDevTrustedExtensions(undefined)).toEqual([])
  })
})

describe('normalizeExtensionIdentity', () => {
  it('derives Chromium identity only when the verified Origin host strictly matches the claim', () => {
    const result = normalizeExtensionIdentity({
      browser: 'chromium',
      verifiedOrigin: `chrome-extension://${BUILTIN_CHROMIUM_ID}`,
      claimedExtensionId: BUILTIN_CHROMIUM_ID,
    })

    expect(result).toEqual({
      ok: true,
      identity: {
        browser: 'chromium',
        originHost: BUILTIN_CHROMIUM_ID,
        verifiedExtensionId: BUILTIN_CHROMIUM_ID,
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.ok && Object.isFrozen(result.identity)).toBe(true)
    expect(result).not.toHaveProperty('claimedExtensionId')
  })

  it('returns one fixed, attacker-free error for a Chromium claim mismatch', () => {
    const attackerClaim = 'attacker-controlled-claim'
    const result = normalizeExtensionIdentity({
      browser: 'chromium',
      verifiedOrigin: `chrome-extension://${BUILTIN_CHROMIUM_ID}`,
      claimedExtensionId: attackerClaim,
    })

    expect(result).toEqual({
      ok: false,
      error: ExtensionIdentityResolutionError,
    })
    expect(JSON.stringify(result)).not.toContain(attackerClaim)
    expect(JSON.stringify(result)).not.toContain(BUILTIN_CHROMIUM_ID)
  })

  it.each([
    ['wrong scheme', `https://${BUILTIN_CHROMIUM_ID}`],
    ['empty host', 'chrome-extension:///'],
    ['userinfo', `chrome-extension://user@${BUILTIN_CHROMIUM_ID}`],
    ['port', `chrome-extension://${BUILTIN_CHROMIUM_ID}:1234`],
    ['path', `chrome-extension://${BUILTIN_CHROMIUM_ID}/path`],
    ['query', `chrome-extension://${BUILTIN_CHROMIUM_ID}?x=1`],
    ['empty query', `chrome-extension://${BUILTIN_CHROMIUM_ID}?`],
    ['fragment', `chrome-extension://${BUILTIN_CHROMIUM_ID}#x`],
    ['empty fragment', `chrome-extension://${BUILTIN_CHROMIUM_ID}#`],
    ['empty port delimiter', `chrome-extension://${BUILTIN_CHROMIUM_ID}:`],
    ['backslash', `chrome-extension://${BUILTIN_CHROMIUM_ID}\\alias`],
    ['percent alias', `chrome-extension://${BUILTIN_CHROMIUM_ID}%2ealias`],
    ['unicode alias', 'chrome-extension://ídentity'],
  ])(
    'fails closed with the same error for a malformed Origin (%s)',
    (_label, verifiedOrigin) => {
      expect(
        normalizeExtensionIdentity({
          browser: 'chromium',
          verifiedOrigin,
          claimedExtensionId: BUILTIN_CHROMIUM_ID,
        })
      ).toEqual({
        ok: false,
        error: ExtensionIdentityResolutionError,
      })
    }
  )

  it.each([
    ['chrome-extension://ídentity', '%C3%ADdentity'],
    ['chrome-extension://foo%2ebar', 'foo%2ebar'],
  ])(
    'rejects a normalized host alias even when the claim copies it (%s)',
    (verifiedOrigin, claimedExtensionId) => {
      const result = normalizeExtensionIdentity({
        browser: 'chromium',
        verifiedOrigin,
        claimedExtensionId,
      })

      expect(result).toEqual({
        ok: false,
        error: ExtensionIdentityResolutionError,
      })
      expect(JSON.stringify(result)).not.toContain(claimedExtensionId)
    }
  )

  it('does not promote a Firefox claim into verified output', () => {
    const claimedExtensionId = 'recognizable-but-self-reported@example.org'
    const result = normalizeExtensionIdentity({
      browser: 'firefox',
      verifiedOrigin: FIREFOX_ORIGIN,
      claimedExtensionId,
    })

    expect(result).toEqual({
      ok: true,
      identity: {
        browser: 'firefox',
        originHost: '8c1a0d6e-1f2b-4c3d-9e0a-5b6c7d8e9f01',
        verifiedExtensionId: null,
      },
    })
    expect(JSON.stringify(result)).not.toContain(claimedExtensionId)
  })
})

describe('ExtensionIdentityResolver.resolve', () => {
  const resolver = createExtensionIdentityResolver({
    environment: 'production',
    developmentEntries: [],
  })

  it('classifies an allowlisted ticketless Chromium Origin as official', () => {
    expect(resolver.resolve(normalizedChromium(), { kind: 'none' })).toEqual({
      ok: true,
      identity: 'official',
      evidence: 'verified-origin',
      provenExtensionId: BUILTIN_CHROMIUM_ID,
    })
  })

  it('classifies another ticketless Chromium Origin as attested-non-official', () => {
    expect(
      resolver.resolve(normalizedChromium(OTHER_CHROMIUM_ID), { kind: 'none' })
    ).toEqual({
      ok: true,
      identity: 'attested-non-official',
      evidence: 'verified-origin',
      provenExtensionId: OTHER_CHROMIUM_ID,
    })
  })

  it('keeps ticketless remote Firefox unverified and excludes its claim', () => {
    const result = resolver.resolve(normalizedFirefox(), { kind: 'none' })

    expect(result).toEqual({
      ok: true,
      identity: 'unverified',
      evidence: 'none',
      provenExtensionId: null,
    })
    expect(JSON.stringify(result)).not.toContain(BUILTIN_FIREFOX_ID)
  })

  it.each([
    [BUILTIN_FIREFOX_ID, 'official'],
    ['other@example.org', 'attested-non-official'],
  ] as const)(
    'preserves valid NM ticket classification for caller %s',
    (callerId, expectedIdentity) => {
      expect(
        resolver.resolve(normalizedFirefox(), {
          kind: 'verified-nm-ticket',
          callerId,
        })
      ).toEqual({
        ok: true,
        identity: expectedIdentity,
        evidence: 'verified-nm-ticket',
        provenExtensionId: callerId,
      })
    }
  )

  it('preserves a valid Chromium NM ticket only when it agrees with the Origin', () => {
    expect(
      resolver.resolve(normalizedChromium(), {
        kind: 'verified-nm-ticket',
        callerId: BUILTIN_CHROMIUM_ID,
      })
    ).toEqual({
      ok: true,
      identity: 'official',
      evidence: 'verified-nm-ticket',
      provenExtensionId: BUILTIN_CHROMIUM_ID,
    })

    const mismatch = resolver.resolve(normalizedChromium(), {
      kind: 'verified-nm-ticket',
      callerId: OTHER_CHROMIUM_ID,
    })
    expect(mismatch).toEqual({
      ok: false,
      error: ExtensionIdentityResolutionError,
    })
    expect(JSON.stringify(mismatch)).not.toContain(OTHER_CHROMIUM_ID)
  })

  it('returns the fixed error without echoing malformed ticket evidence', () => {
    const attackerData = 'attacker\u0000ticket'
    const result = resolver.resolve(normalizedFirefox(), {
      kind: 'verified-nm-ticket',
      callerId: attackerData,
    })

    expect(result).toEqual({
      ok: false,
      error: ExtensionIdentityResolutionError,
    })
    expect(JSON.stringify(result)).not.toContain('attacker')
  })
})
