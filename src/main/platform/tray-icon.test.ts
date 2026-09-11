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
  it('keeps integer kilobytes as the minimum unit in decimal mode', () => {
    expect(formatSpeed(0)).toBe('0 KB/s')
    expect(formatSpeed(512)).toBe('1 KB/s')
    expect(formatSpeed(50_000)).toBe('50 KB/s')
    expect(formatSpeed(999_999)).toBe('1000 KB/s')
  })
  it('keeps one decimal place for megabytes and above in decimal mode', () => {
    expect(formatSpeed(16_500_000)).toBe('16.5 MB/s')
    expect(formatSpeed(125_000_000)).toBe('125.0 MB/s')
    expect(formatSpeed(1_500_000_000)).toBe('1.5 GB/s')
  })
  it('preserves the original binary rounding with IEC labels', () => {
    expect(formatSpeed(0, 'binary')).toBe('0 KiB/s')
    expect(formatSpeed(512, 'binary')).toBe('1 KiB/s')
    expect(formatSpeed(50 * 1024, 'binary')).toBe('50 KiB/s')
    expect(formatSpeed(1_048_575, 'binary')).toBe('1024 KiB/s')
    expect(formatSpeed(1_048_576, 'binary')).toBe('1.0 MiB/s')
    expect(formatSpeed(125 * 1_048_576, 'binary')).toBe('125.0 MiB/s')
    expect(formatSpeed(1_073_741_824, 'binary')).toBe('1.0 GiB/s')
  })
})
