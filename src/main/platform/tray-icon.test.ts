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

import type { TrayIconColor } from '@shared/schemas/tray-icon-color'
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

  it.each([
    { color: 'light' as const, background: 'dark' },
    { color: 'dark' as const, background: 'light' },
  ])(
    'keeps $color artwork independent of the application theme',
    async ({ color, background }) => {
      const provider = createLinuxIconProvider(assetDir, () => color)
      for (const dark of [false, true]) {
        nativeThemeMock.shouldUseDarkColors = dark
        await provider.init()
        for (const active of [false, true]) {
          expect(provider.getIcon(active)).toEqual({
            filePath: path.join(
              assetDir,
              `mo-tray-${background}-${active ? 'active' : 'normal'}.png`
            ),
          })
        }
      }
    }
  )

  it('reloads a changed preference and resumes following the application theme', async () => {
    let color: TrayIconColor = 'light'
    const provider = createLinuxIconProvider(assetDir, () => color)
    await provider.init()
    expect(provider.getIcon(false)).toEqual({
      filePath: path.join(assetDir, 'mo-tray-dark-normal.png'),
    })
    color = 'dark'
    await provider.init()
    expect(provider.getIcon(true)).toEqual({
      filePath: path.join(assetDir, 'mo-tray-light-active.png'),
    })
    color = 'auto'
    nativeThemeMock.shouldUseDarkColors = true
    await provider.init()
    expect(provider.getIcon(true)).toEqual({
      filePath: path.join(assetDir, 'mo-tray-dark-active.png'),
    })
  })
})

describe('formatSpeed', () => {
  it.each([
    [12.34, '12.34 MiB/s'],
    [999.99, '999.99 MiB/s'],
    [999.999, '1000 MiB/s'],
    [1000.23, '1000 MiB/s'],
    [1023.49, '1023 MiB/s'],
    [1023.5, '1.00 GiB/s'],
    [1023.99, '1.00 GiB/s'],
  ])('formats %s MiB/s for the compact tray', (speed, expected) => {
    expect(formatSpeed(Math.round(speed * 1_048_576), 'binary')).toBe(expected)
  })

  it('keeps two decimal places with kilobytes as the minimum unit', () => {
    expect(formatSpeed(0)).toBe('0 KB/s')
    expect(formatSpeed(512)).toBe('0.51 KB/s')
    expect(formatSpeed(50_000)).toBe('50.00 KB/s')
    expect(formatSpeed(999_990)).toBe('999.99 KB/s')
    expect(formatSpeed(999_999)).toBe('1.00 MB/s')
  })
  it('keeps two decimal places for megabytes and above', () => {
    expect(formatSpeed(16_543_210)).toBe('16.54 MB/s')
    expect(formatSpeed(125_000_000)).toBe('125.00 MB/s')
    expect(formatSpeed(1_500_000_000)).toBe('1.50 GB/s')
  })
  it('uses two decimal places with IEC labels and promotes rounded units', () => {
    expect(formatSpeed(0, 'binary')).toBe('0 KiB/s')
    expect(formatSpeed(512, 'binary')).toBe('0.50 KiB/s')
    expect(formatSpeed(50 * 1024, 'binary')).toBe('50.00 KiB/s')
    expect(formatSpeed(1_048_575, 'binary')).toBe('1.00 MiB/s')
    expect(formatSpeed(1_048_576, 'binary')).toBe('1.00 MiB/s')
    expect(formatSpeed(125 * 1_048_576, 'binary')).toBe('125.00 MiB/s')
    expect(formatSpeed(1_073_741_824, 'binary')).toBe('1.00 GiB/s')
  })
})
