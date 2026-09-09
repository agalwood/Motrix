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
  it('formats zero as 0 KB/s', () => {
    expect(formatSpeed(0)).toBe('0 KB/s')
  })

  it('formats bytes as KB/s (minimum unit, no decimal)', () => {
    expect(formatSpeed(512)).toBe('1 KB/s')
    expect(formatSpeed(100)).toBe('0 KB/s')
  })

  it('formats kilobytes without decimal', () => {
    expect(formatSpeed(1024)).toBe('1 KB/s')
    expect(formatSpeed(50 * 1024)).toBe('50 KB/s')
    expect(formatSpeed(200 * 1024)).toBe('200 KB/s')
  })

  it('formats megabytes with one decimal', () => {
    expect(formatSpeed(1048576)).toBe('1.0 MB/s')
    expect(formatSpeed(1.5 * 1024 ** 2)).toBe('1.5 MB/s')
    expect(formatSpeed(88 * 1024 ** 2)).toBe('88.0 MB/s')
  })

  it('formats gigabytes with one decimal', () => {
    expect(formatSpeed(1073741824)).toBe('1.0 GB/s')
    expect(formatSpeed(1.2 * 1024 ** 3)).toBe('1.2 GB/s')
  })
})
