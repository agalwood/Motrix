import { describe, expect, it } from 'vitest'
import {
  isPackagedLinuxFlatpak,
  MOTRIX_FLATPAK_ID,
} from './flatpak-environment'

describe('isPackagedLinuxFlatpak', () => {
  it('recognizes the packaged Motrix Flatpak', () => {
    expect(
      isPackagedLinuxFlatpak({
        platform: 'linux',
        isPackaged: true,
        env: { FLATPAK_ID: MOTRIX_FLATPAK_ID },
      })
    ).toBe(true)
  })

  it.each([
    {
      platform: 'linux' as const,
      isPackaged: false,
      env: { FLATPAK_ID: MOTRIX_FLATPAK_ID },
    },
    {
      platform: 'darwin' as const,
      isPackaged: true,
      env: { FLATPAK_ID: MOTRIX_FLATPAK_ID },
    },
    {
      platform: 'linux' as const,
      isPackaged: true,
      env: { FLATPAK_ID: 'org.example.Other' },
    },
    {
      platform: 'linux' as const,
      isPackaged: true,
      env: {},
    },
  ])('rejects a non-Motrix Flatpak environment: %o', (options) => {
    expect(isPackagedLinuxFlatpak(options)).toBe(false)
  })
})
