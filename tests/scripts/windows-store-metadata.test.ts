import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import {
  compareWindowsPackageVersions,
  validateWindowsStoreMetadata,
  WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC,
  WINDOWS_STORE_TEST_IDENTITY,
} from '../../scripts/windows-store-metadata.mjs'

const COMMIT = 'a'.repeat(40)

function storeMetadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    profile: 'store',
    architecture: 'x64',
    productVersion: '2.3.4',
    packageVersion: '7.10.2.0',
    source: { commit: COMMIT, tag: 'v2.3.4' },
    // A unit-test fixture supplied to the validator, not a production identity.
    identity: {
      name: 'Example.MetadataFixture',
      publisher: 'CN=Metadata Fixture, O=Example',
      publisherDisplayName: 'Metadata Fixture',
    },
    ...overrides,
  }
}

function testMetadata(overrides: Record<string, unknown> = {}) {
  return storeMetadata({
    profile: 'test',
    productVersion: '2.3.4-beta.41',
    packageVersion: '1.0.1.0',
    source: { commit: COMMIT },
    identity: { ...WINDOWS_STORE_TEST_IDENTITY },
    ...overrides,
  })
}

describe('Windows Store metadata', () => {
  it('exposes one immutable diagnostic contract with no caller-selected paths or identities', () => {
    expect(WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC).toEqual({
      mode: 'native-messaging-probe-v1',
      applicationId: 'MotrixNativeHostP0',
      alias: 'motrix-store-p0-native-host.exe',
      executable: 'diagnostics/motrix-store-p0-probe.exe',
      source: 'tests/fixtures/windows-store-native-messaging/stdio-probe.cs',
    })
    expect(Object.isFrozen(WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC)).toBe(
      true
    )
  })

  it('preserves the explicit test diagnostic mode and omits it from ordinary metadata', () => {
    const input = testMetadata({
      testDiagnostics: WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC.mode,
    })
    const result = validateWindowsStoreMetadata(input)
    expect(result.metadata.testDiagnostics).toBe('native-messaging-probe-v1')
    expect(result.metadata.identity).toEqual(WINDOWS_STORE_TEST_IDENTITY)
    expect(result.metadata.source).toEqual({ commit: COMMIT })
    expect(result.validation.partnerCenterIdentityVerified).toBe(false)
    expect(Object.isFrozen(result.metadata)).toBe(true)
    for (const ordinary of [testMetadata(), storeMetadata()]) {
      expect(
        validateWindowsStoreMetadata(ordinary).metadata
      ).not.toHaveProperty('testDiagnostics')
    }
  })

  it.each([undefined, null, '', false, {}, 'native-messaging-probe-v2'])(
    'rejects an invalid explicit test diagnostic mode %#',
    (testDiagnostics) => {
      expect(() =>
        validateWindowsStoreMetadata(testMetadata({ testDiagnostics }))
      ).toThrow(/testDiagnostics/)
    }
  )

  it.each([
    undefined,
    null,
    '',
    WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC.mode,
  ])(
    'rejects every Store diagnostic property, including undefined: %#',
    (testDiagnostics) => {
      expect(() =>
        validateWindowsStoreMetadata(storeMetadata({ testDiagnostics }))
      ).toThrow(/only allowed for the test profile/)
    }
  )

  it('rejects diagnostic accessors without evaluating them', () => {
    const input = testMetadata()
    Object.defineProperty(input, 'testDiagnostics', {
      get: () => {
        throw new Error('accessor executed')
      },
    })
    expect(() => validateWindowsStoreMetadata(input)).toThrow(
      /must be a data property/
    )
  })

  it('retains the same diagnostic identity and mode across a monotonic test upgrade', () => {
    const a = validateWindowsStoreMetadata(
      testMetadata({
        testDiagnostics: WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC.mode,
      })
    ).metadata
    const b = validateWindowsStoreMetadata({
      ...a,
      packageVersion: '1.0.2.0',
      previousPackageVersions: [a.packageVersion],
    }).metadata
    expect(b.identity).toEqual(a.identity)
    expect(b.source).toEqual(a.source)
    expect(b.testDiagnostics).toBe(a.testDiagnostics)
    expect(() =>
      validateWindowsStoreMetadata({ ...b, packageVersion: a.packageVersion })
    ).toThrow(/must be greater/)
  })

  it('keeps product and package versions independent without inventing evidence', () => {
    const input = storeMetadata({
      previousPackageVersions: [
        '7.2.99.65535',
        '7.10.1.13',
        '6.65535.65535.65535',
      ],
      storeProductId: '9EXAMPLE00000',
    })
    const result = validateWindowsStoreMetadata(input)

    expect(result.metadata).toEqual(input)
    expect(result.validation).toEqual({
      scope: 'syntax-and-supplied-history-only',
      highestSuppliedPackageVersion: '7.10.1.13',
      suppliedVersionCount: 3,
      partnerCenterIdentityVerified: false,
      publisherSubjectVerified: false,
      protectedTagVerified: false,
      sourceCommitVerified: false,
      publishedVersionHistoryVerified: false,
    })
  })

  it('treats omitted history as unknown rather than a verified first release', () => {
    const result = validateWindowsStoreMetadata(storeMetadata())

    expect(result.metadata.previousPackageVersions).toEqual([])
    expect(result.metadata).not.toHaveProperty('storeProductId')
    expect(result.validation.highestSuppliedPackageVersion).toBeNull()
    expect(result.validation.publishedVersionHistoryVerified).toBe(false)
  })

  it('preserves exact identity text for later XML escaping and identity comparison', () => {
    const identity = {
      name: 'Example.Case-Sensitive-Name',
      publisher: 'CN="Fixture & Co", O=Example',
      publisherDisplayName: '测试 Publisher & "Company"',
    }
    expect(
      validateWindowsStoreMetadata(storeMetadata({ identity })).metadata
        .identity
    ).toEqual(identity)
  })

  it('returns detached frozen data while leaving caller input untouched', () => {
    const input = storeMetadata({ previousPackageVersions: ['1.0.0.0'] })
    const before = structuredClone(input)
    const result = validateWindowsStoreMetadata(input)

    expect(input).toEqual(before)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(result)).toBe(true)
    for (const value of [
      result.metadata,
      result.metadata.source,
      result.metadata.identity,
      result.metadata.previousPackageVersions,
      result.validation,
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    input.identity.name = 'Changed.Input.Name'
    expect(result.metadata.identity.name).toBe('Example.MetadataFixture')
  })

  it('allows test prereleases and omits the absent source tag', () => {
    const result = validateWindowsStoreMetadata(testMetadata())

    expect(result.metadata.source).toEqual({ commit: COMMIT })
    expect(result.metadata.source).not.toHaveProperty('tag')
    expect(result.metadata.identity).toEqual(WINDOWS_STORE_TEST_IDENTITY)
  })

  it('allows generic zero-major and revision-bearing versions only in test profile', () => {
    expect(
      validateWindowsStoreMetadata(testMetadata({ packageVersion: '0.0.0.0' }))
        .metadata.packageVersion
    ).toBe('0.0.0.0')
    expect(
      validateWindowsStoreMetadata(
        testMetadata({
          packageVersion: '0.1.0.7',
          previousPackageVersions: ['0.1.0.6'],
        })
      ).metadata.packageVersion
    ).toBe('0.1.0.7')
  })

  it('accepts the largest Store version tuple without numeric overflow', () => {
    expect(
      validateWindowsStoreMetadata(
        storeMetadata({
          packageVersion: '65535.65535.65535.0',
          previousPackageVersions: ['65535.65535.65534.65535'],
        })
      ).metadata.packageVersion
    ).toBe('65535.65535.65535.0')
  })

  it.each([
    null,
    [],
    'metadata',
    new Date(),
    storeMetadata({ schemaVersion: '1' }),
    storeMetadata({ schemaVersion: 2 }),
    storeMetadata({ profile: 'production' }),
    storeMetadata({ architecture: 'arm64' }),
    storeMetadata({ protectedTagVerified: true }),
    storeMetadata({ validation: { partnerCenterIdentityVerified: true } }),
    storeMetadata({
      source: { commit: COMMIT, tag: 'v2.3.4', protected: true },
    }),
    storeMetadata({
      identity: { ...storeMetadata().identity, verified: true },
    }),
  ])('rejects malformed records and unrecognized assertions: %#', (input) => {
    expect(() => validateWindowsStoreMetadata(input)).toThrow()
  })

  it('rejects accessors rather than evaluating caller code', () => {
    const input = storeMetadata()
    Object.defineProperty(input, 'profile', {
      get: () => {
        throw new Error('accessor executed')
      },
    })
    expect(() => validateWindowsStoreMetadata(input)).toThrow(
      /must be a data property/
    )
  })

  it.each([
    'v2.3.4',
    '02.3.4',
    '2.3',
    '2.3.4-beta.1',
    '2.3.4+build.1',
    '2.3.4\n',
  ])(
    'rejects non-stable or malformed Store product version %j',
    (productVersion) => {
      expect(() =>
        validateWindowsStoreMetadata(
          storeMetadata({
            productVersion,
            source: { commit: COMMIT, tag: `v${productVersion}` },
          })
        )
      ).toThrow()
    }
  )

  it.each([
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.0',
    '1.02.3.0',
    '1.2.-3.0',
    '1.2.3e1.0',
    '65536.0.0.0',
    '1.65536.0.0',
    '1.0.65536.0',
    '0.1.0.0',
    '1.0.0.1',
    '1.0.0.65536',
    '1.0.0.0\n',
  ])('rejects unsafe Store package version %j', (packageVersion) => {
    expect(() =>
      validateWindowsStoreMetadata(storeMetadata({ packageVersion }))
    ).toThrow()
  })

  it.each(['a'.repeat(39), 'A'.repeat(40), 'g'.repeat(40), `${COMMIT}\n`])(
    'rejects malformed commit %j',
    (commit) => {
      expect(() =>
        validateWindowsStoreMetadata(
          storeMetadata({ source: { commit, tag: 'v2.3.4' } })
        )
      ).toThrow()
    }
  )

  it.each([undefined, '', '2.3.4', 'v2.3.5', 'v2.3.4\n'])(
    'requires the exact Store source tag %j',
    (tag) => {
      expect(() =>
        validateWindowsStoreMetadata(
          storeMetadata({ source: { commit: COMMIT, tag } })
        )
      ).toThrow()
    }
  )

  it('rejects mismatched optional test tags and malformed test SemVer', () => {
    expect(() =>
      validateWindowsStoreMetadata(
        testMetadata({ source: { commit: COMMIT, tag: 'v2.3.4-beta.40' } })
      )
    ).toThrow(/source.tag/)
    expect(() =>
      validateWindowsStoreMetadata(
        testMetadata({ productVersion: '2.3.4-beta.01' })
      )
    ).toThrow(/SemVer/)
  })

  it.each([
    'ab',
    'a'.repeat(51),
    'Example_Name',
    'Example/Name',
    'con',
    'COM9.app',
    'Aux.app',
    'lpt1',
    'xn--name',
    'Example.XN--name',
    'Example.',
  ])('rejects invalid Windows package name %j', (name) => {
    expect(() =>
      validateWindowsStoreMetadata(
        storeMetadata({ identity: { ...storeMetadata().identity, name } })
      )
    ).toThrow(/identity.name/)
  })

  it.each([
    '',
    'CN=',
    'CN=, O=Example',
    'CN=""',
    'O=Example',
    `CN=${'a'.repeat(8190)}`,
  ])('rejects missing or malformed literal publisher %j', (publisher) => {
    expect(() =>
      validateWindowsStoreMetadata(
        storeMetadata({ identity: { ...storeMetadata().identity, publisher } })
      )
    ).toThrow(/identity.publisher/)
  })

  it.each([
    '',
    ' ',
    'a'.repeat(257),
    'Publisher\tName',
    'Publisher\u0085Name',
    'Publisher\u202eName',
    'Publisher\ud800Name',
  ])('rejects unsafe publisher display text %j', (publisherDisplayName) => {
    expect(() =>
      validateWindowsStoreMetadata(
        storeMetadata({
          identity: { ...storeMetadata().identity, publisherDisplayName },
        })
      )
    ).toThrow(/identity.publisherDisplayName/)
  })

  it.each(['name', 'publisher', 'publisherDisplayName'] as const)(
    'rejects mixed test/Store identity field %s in either profile',
    (key) => {
      expect(() =>
        validateWindowsStoreMetadata(
          storeMetadata({
            identity: {
              ...storeMetadata().identity,
              [key]: WINDOWS_STORE_TEST_IDENTITY[key],
            },
          })
        )
      ).toThrow(/test identity/)
      expect(() =>
        validateWindowsStoreMetadata(
          testMetadata({
            identity: {
              ...WINDOWS_STORE_TEST_IDENTITY,
              [key]: storeMetadata().identity[key],
            },
          })
        )
      ).toThrow(/test identity/)
    }
  )

  it('rejects a case-variant test identity in Store metadata', () => {
    expect(() =>
      validateWindowsStoreMetadata(
        storeMetadata({
          identity: {
            ...storeMetadata().identity,
            name: WINDOWS_STORE_TEST_IDENTITY.name.toUpperCase(),
          },
        })
      )
    ).toThrow(/test identity/)
  })

  it.each([
    ['name', 'Motrix.Store.P0'],
    ['publisher', 'CN=Motrix Store P0 Test'],
    ['publisherDisplayName', 'Motrix P0 Local Test'],
  ])('reserves the earlier test identity field %s', (key, value) => {
    expect(() =>
      validateWindowsStoreMetadata(
        storeMetadata({
          identity: { ...storeMetadata().identity, [key]: value },
        })
      )
    ).toThrow(/test identity/)
  })

  it('allows unrelated identities containing Test without claiming Store registration', () => {
    const identity = {
      name: 'Example.TestingTools',
      publisher: 'CN=Example Testing Company',
      publisherDisplayName: 'Example Testing Company',
    }
    const result = validateWindowsStoreMetadata(storeMetadata({ identity }))

    expect(result.metadata.identity).toEqual(identity)
    expect(result.validation.partnerCenterIdentityVerified).toBe(false)
  })

  it.each(['7.10.2.0', '7.10.2.1', '7.11.0.0', '8.0.0.0'])(
    'rejects a candidate that cannot advance supplied history %s',
    (previous) => {
      expect(() =>
        validateWindowsStoreMetadata(
          storeMetadata({ previousPackageVersions: ['1.0.0.0', previous] })
        )
      ).toThrow(/must be greater/)
    }
  )

  it.each([
    undefined,
    null,
    '1.0.0.0',
    ['1.0.0'],
    ['1.0.0.65536'],
    [1],
    Array(1),
  ])('rejects malformed supplied history %#', (previousPackageVersions) => {
    expect(() =>
      validateWindowsStoreMetadata(storeMetadata({ previousPackageVersions }))
    ).toThrow()
  })

  it('applies the same monotonic policy to test upgrades', () => {
    expect(() =>
      validateWindowsStoreMetadata(
        testMetadata({ previousPackageVersions: ['1.0.1.0'] })
      )
    ).toThrow(/must be greater/)
  })

  it.each(['', undefined, '9EXAMPLE/0000', '9EXAMPLE0000\n'])(
    'rejects unsafe optional Store ID %j',
    (storeProductId) => {
      expect(() =>
        validateWindowsStoreMetadata(storeMetadata({ storeProductId }))
      ).toThrow(/storeProductId/)
    }
  )

  it('prevents a test package from carrying a Store listing ID', () => {
    expect(() =>
      validateWindowsStoreMetadata(
        testMetadata({ storeProductId: '9EXAMPLE00000' })
      )
    ).toThrow(/test profile/)
  })
})

describe('Windows package version ordering', () => {
  it.each([
    ['0.0.0.0', '0.0.0.0', 0],
    ['1.10.0.0', '1.9.65535.65535', 1],
    ['1.0.0.65535', '1.0.1.0', -1],
    ['65535.65535.65535.65535', '65535.65535.65535.65534', 1],
  ])('compares %s with %s component by component', (left, right, expected) => {
    expect(compareWindowsPackageVersions(left, right)).toBe(expected)
  })

  it('validates both operands instead of comparing malformed text', () => {
    expect(() => compareWindowsPackageVersions('1.0.0', '1.0.0.0')).toThrow()
    expect(() =>
      compareWindowsPackageVersions('1.0.0.0', '1.0.0.65536')
    ).toThrow()
  })
})
