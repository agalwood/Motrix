import { describe, expect, it } from 'vitest'
import {
  buildPlatformOptions,
  buildWindowControlsOverlay,
} from './platform-options'

describe('buildPlatformOptions', () => {
  it('returns hiddenInset titleBarStyle for macOS', () => {
    const opts = buildPlatformOptions('darwin')
    expect(opts.titleBarStyle).toBe('hiddenInset')
    expect(opts.vibrancy).toBe('under-window')
    expect(opts.backgroundColor).toBe('#00000000')
    expect(opts.trafficLightPosition).toEqual({ x: 20, y: 20 })
  })

  it('hides the Windows title bar without enabling native caption controls', () => {
    const opts = buildPlatformOptions('win32')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toBeUndefined()
    expect(opts.backgroundColor).toBe('#ffffff')
  })

  it('uses a dark first-paint background for Windows', () => {
    const opts = buildPlatformOptions('win32', {
      shouldUseDarkColors: true,
    })
    expect(opts.backgroundColor).toBe('#09090b')
  })

  it('uses native Linux controls over the renderer surface', () => {
    const opts = buildPlatformOptions('linux')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toEqual({
      color: '#ffffff00',
      symbolColor: '#262626',
      height: 54,
    })
    expect(opts.vibrancy).toBeUndefined()
    expect(opts.backgroundColor).toBe('#ffffff')
  })

  it('uses a dark first-paint background for Linux', () => {
    const opts = buildPlatformOptions('linux', {
      shouldUseDarkColors: true,
    })
    expect(opts.backgroundColor).toBe('#09090b')
    expect(opts.titleBarOverlay).toMatchObject({ symbolColor: '#fafafa' })
  })

  it('omits vibrancy and uses solid backgroundColor on macOS when vibrancy: false', () => {
    const opts = buildPlatformOptions('darwin', { vibrancy: false })
    expect(opts.titleBarStyle).toBe('hiddenInset')
    expect(opts.vibrancy).toBeUndefined()
    expect(opts.visualEffectState).toBeUndefined()
    expect(opts.backgroundColor).toBe('#ffffff')
  })

  it('uses a dark solid macOS background when vibrancy is unavailable', () => {
    const opts = buildPlatformOptions('darwin', {
      vibrancy: false,
      shouldUseDarkColors: true,
    })
    expect(opts.backgroundColor).toBe('#09090b')
  })

  it('uses transparent macOS chrome without vibrancy for Liquid Glass', () => {
    const opts = buildPlatformOptions('darwin', { liquidGlass: true })
    expect(opts.titleBarStyle).toBe('hiddenInset')
    expect(opts.transparent).toBe(true)
    expect(opts.vibrancy).toBeUndefined()
    expect(opts.visualEffectState).toBeUndefined()
    expect(opts.backgroundColor).toBe('#00000000')
  })

  it('defaults vibrancy to true when option omitted on macOS', () => {
    const opts = buildPlatformOptions('darwin', {})
    expect(opts.vibrancy).toBe('under-window')
    expect(opts.backgroundColor).toBe('#00000000')
  })
})

// Electron 45's Freedesktop provider forces overlay RGB opaque and uses it
// for Breeze hover glyphs, with symbolColor as the hovered button's fill.
// Guard the effective pair, not just the normal glyph's color on the web UI.
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

it.each([false, true])(
  'keeps Breeze hover glyph contrast while preserving transparency (dark=%s)',
  (dark) => {
    const overlay = buildWindowControlsOverlay(dark)
    expect(overlay.color.slice(7)).toBe('00')
    const fill = luminance(overlay.symbolColor)
    const glyph = luminance(overlay.color)
    const contrast =
      (Math.max(fill, glyph) + 0.05) / (Math.min(fill, glyph) + 0.05)
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  }
)
