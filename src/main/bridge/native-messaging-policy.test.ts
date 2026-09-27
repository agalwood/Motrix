import { NativeMessagingRegistrationPolicySchema } from '@shared/schemas/native-messaging-policy'
import { describe, expect, it, vi } from 'vitest'
import { resolveNativeMessagingRegistrationPolicy } from './native-messaging-policy'

vi.mock('electron', () => ({ app: {} }))

describe('resolveNativeMessagingRegistrationPolicy', () => {
  it.each([
    {
      isPackaged: true,
      policy: { mode: 'unsupported', reason: 'windows-package' },
    },
    { isPackaged: false, policy: { mode: 'managed' } },
  ])(
    'uses trusted distribution context for a Windows Store flag: %o',
    ({ isPackaged, policy }) => {
      expect(
        resolveNativeMessagingRegistrationPolicy({
          platform: 'win32',
          isPackaged,
          windowsStore: true,
          env: { FLATPAK_ID: 'app.motrix.native' },
        })
      ).toEqual(policy)
    }
  )

  it.each(['win32', 'darwin', 'linux'] as const)(
    'retains managed registration on direct %s builds',
    (platform) => {
      expect(
        resolveNativeMessagingRegistrationPolicy({
          platform,
          isPackaged: true,
          windowsStore: false,
        })
      ).toEqual({ mode: 'managed' })
    }
  )

  it.each(['darwin', 'linux'] as const)(
    'ignores a Windows Store flag on %s',
    (platform) => {
      expect(
        resolveNativeMessagingRegistrationPolicy({
          platform,
          isPackaged: true,
          windowsStore: true,
        })
      ).toEqual({ mode: 'managed' })
    }
  )

  it.each([
    { platform: 'linux', isPackaged: true, mode: 'external' },
    { platform: 'linux', isPackaged: false, mode: 'managed' },
    { platform: 'win32', isPackaged: true, mode: 'managed' },
    { platform: 'darwin', isPackaged: true, mode: 'managed' },
  ] as const)(
    'uses Flatpak policy only for a packaged Linux app: %o',
    (input) => {
      expect(
        resolveNativeMessagingRegistrationPolicy({
          ...input,
          env: { FLATPAK_ID: 'app.motrix.native' },
        })
      ).toEqual({ mode: input.mode })
    }
  )

  it('does not infer Flatpak registration from another package identity', () => {
    expect(
      resolveNativeMessagingRegistrationPolicy({
        platform: 'linux',
        isPackaged: true,
        env: { FLATPAK_ID: 'other.package' },
      })
    ).toEqual({ mode: 'managed' })
  })
})

describe('NativeMessagingRegistrationPolicySchema', () => {
  it.each([
    { mode: 'managed' },
    { mode: 'external' },
    { mode: 'unsupported', reason: 'windows-package' },
    { mode: 'unsupported', reason: 'server' },
  ])(
    'accepts a host policy without implying registration success: %o',
    (value) => {
      expect(
        NativeMessagingRegistrationPolicySchema.safeParse(value).success
      ).toBe(true)
    }
  )

  it.each([
    null,
    {},
    { mode: 'registered' },
    { mode: 'unsupported' },
    { mode: 'unsupported', reason: 'unknown' },
    { mode: 'managed', reason: 'windows-package' },
    { mode: 'managed', registered: true },
    { mode: 'unsupported', reason: 'server', registered: true },
  ])('rejects malformed policy: %o', (value) => {
    expect(
      NativeMessagingRegistrationPolicySchema.safeParse(value).success
    ).toBe(false)
  })
})
