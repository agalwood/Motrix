import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
}))

vi.mock('@resvg/resvg-wasm', () => ({
  initWasm: vi.fn(),
  Resvg: vi.fn(),
}))

import { formatSpeed } from './tray-icon'

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
