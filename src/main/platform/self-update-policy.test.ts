import { describe, expect, it } from 'vitest'
import { isElectronSelfUpdateSupported } from './self-update-policy'

describe('Electron self-update policy', () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'rejects Windows package and Snap updates with packaged=%s, metadata=%s',
    (isPackaged, hasUpdateMetadata) => {
      expect(
        isElectronSelfUpdateSupported({
          isPackaged,
          hasUpdateMetadata,
          isWindowsPackage: true,
          isSnap: false,
        })
      ).toBe(false)
      expect(
        isElectronSelfUpdateSupported({
          isPackaged,
          hasUpdateMetadata,
          isWindowsPackage: false,
          isSnap: true,
        })
      ).toBe(false)
    }
  )

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])(
    'requires packaged=%s and metadata=%s for direct-build support=%s',
    (isPackaged, hasUpdateMetadata, supported) => {
      expect(
        isElectronSelfUpdateSupported({
          isPackaged,
          hasUpdateMetadata,
          isWindowsPackage: false,
          isSnap: false,
        })
      ).toBe(supported)
    }
  )
})
