import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { nativeImageMock, nativeThemeMock } = vi.hoisted(() => ({
  nativeImageMock: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
  nativeThemeMock: { shouldUseDarkColors: false },
}))

vi.mock('electron', () => ({
  nativeImage: nativeImageMock,
  nativeTheme: nativeThemeMock,
}))

vi.mock('@resvg/resvg-wasm', () => ({
  initWasm: vi.fn(),
  Resvg: vi.fn(),
}))

import { createLinuxIconProvider, formatSpeed } from './tray-icon'

describe('createLinuxIconProvider', () => {
  const assetDir = path.join(process.cwd(), 'extra', 'tray')

  beforeEach(() => {
    vi.clearAllMocks()
    nativeThemeMock.shouldUseDarkColors = false
    nativeImageMock.createFromPath.mockImplementation((filePath: string) => ({
      filePath,
    }))
  })

  it.each([
    { dark: true, theme: 'dark', color: 'white' },
    { dark: false, theme: 'light', color: 'dark blue' },
  ])('uses $color icons for the $theme theme', async ({ dark, theme }) => {
    nativeThemeMock.shouldUseDarkColors = dark
    const provider = createLinuxIconProvider(assetDir)

    await provider.init()

    for (const active of [false, true]) {
      expect(provider.getIcon(active)).toEqual({
        filePath: path.join(
          assetDir,
          `mo-tray-${theme}-${active ? 'active' : 'normal'}.png`
        ),
      })
    }
  })

  it('reloads both cached icons using the current theme', async () => {
    const provider = createLinuxIconProvider(assetDir)
    await provider.init()
    const previousNormal = provider.getIcon(false)
    const previousActive = provider.getIcon(true)

    nativeThemeMock.shouldUseDarkColors = true
    await provider.init()

    expect(provider.getIcon(false)).not.toBe(previousNormal)
    expect(provider.getIcon(true)).not.toBe(previousActive)
    expect(provider.getIcon(false)).toEqual({
      filePath: path.join(assetDir, 'mo-tray-dark-normal.png'),
    })
    expect(provider.getIcon(true)).toEqual({
      filePath: path.join(assetDir, 'mo-tray-dark-active.png'),
    })
  })
})

describe('formatSpeed', () => {
  it('matches renderer decimal speed units', () => {
    expect(formatSpeed(0)).toBe('0 B/s')
    expect(formatSpeed(512)).toBe('512 B/s')
    expect(formatSpeed(50_000)).toBe('50.0 KB/s')
    expect(formatSpeed(16_500_000)).toBe('16.5 MB/s')
  })
  it('matches the selected binary speed units', () => {
    expect(formatSpeed(1_048_576, 'binary')).toBe('1.0 MiB/s')
    expect(formatSpeed(1_073_741_824, 'binary')).toBe('1.0 GiB/s')
  })
})
