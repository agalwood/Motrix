import { describe, expect, it } from 'vitest'
import { createWindowsStoreRuntimeIdentity } from '../../scripts/windows-store-runtime-identity.mjs'
import { WINDOWS_STORE_PAYLOAD_METADATA } from '../helpers/windows-store-payload-fixture'

describe('bundled Windows package identity', () => {
  it('binds source, product and the complete tuple from the validated inputs', () => {
    expect(
      createWindowsStoreRuntimeIdentity(
        WINDOWS_STORE_PAYLOAD_METADATA,
        'Example.Motrix_123456789abcd'
      )
    ).toEqual({
      schemaVersion: 1,
      profile: 'store',
      productVersion: '1.2.3',
      sourceCommit: 'a'.repeat(40),
      expected: {
        name: 'Example.Motrix',
        publisher: 'CN=Example Publisher',
        familyName: 'Example.Motrix_123456789abcd',
        version: '4.5.6.0',
        architecture: 'x64',
        resourceId: '',
      },
    })
  })
  it.each([
    undefined,
    '',
    'Other.Package_123456789abcd',
    'Example.Motrix_123456789abcu',
  ])('requires an independently supplied valid family %#', (family) => {
    expect(() =>
      createWindowsStoreRuntimeIdentity(WINDOWS_STORE_PAYLOAD_METADATA, family)
    ).toThrow()
  })
  it('preserves production stable-version validation', () => {
    expect(() =>
      createWindowsStoreRuntimeIdentity(
        { ...WINDOWS_STORE_PAYLOAD_METADATA, productVersion: '2.0.0-beta.47' },
        'Example.Motrix_123456789abcd'
      )
    ).toThrow()
  })
})
