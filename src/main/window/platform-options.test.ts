import { describe, expect, it } from 'vitest'
import { buildPlatformOptions } from './platform-options'

describe('buildPlatformOptions', () => {
  it('returns hiddenInset titleBarStyle for macOS', () => {
    const opts = buildPlatformOptions('darwin')
    expect(opts.titleBarStyle).toBe('hiddenInset')
    expect(opts.vibrancy).toBe('under-window')
    expect(opts.backgroundColor).toBe('#00000000')
    expect(opts.trafficLightPosition).toEqual({ x: 20, y: 20 })
  })

  it('uses dark title-bar symbols for the light Windows theme', () => {
    const opts = buildPlatformOptions('win32')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toEqual({
      color: '#00000000',
      symbolColor: '#1d1d1f',
      height: 54,
    })
  })

  it('uses light title-bar symbols for the dark Windows theme', () => {
    const opts = buildPlatformOptions('win32', {
      shouldUseDarkColors: true,
    })
    expect(opts.titleBarOverlay).toMatchObject({ symbolColor: '#f5f5f5' })
  })

  it('uses a configured Windows title-bar symbol color', () => {
    const opts = buildPlatformOptions('win32', {
      windowControlsSymbolColor: '#1d1d1f',
    })
    expect(opts.titleBarOverlay).toMatchObject({ symbolColor: '#1d1d1f' })
  })

  it('returns hidden titleBarStyle for Linux', () => {
    const opts = buildPlatformOptions('linux')
    expect(opts.titleBarStyle).toBe('hidden')
    expect(opts.titleBarOverlay).toBeUndefined()
    expect(opts.vibrancy).toBeUndefined()
  })

  it('omits vibrancy and uses solid backgroundColor on macOS when vibrancy: false', () => {
    const opts = buildPlatformOptions('darwin', { vibrancy: false })
    expect(opts.titleBarStyle).toBe('hiddenInset')
    expect(opts.vibrancy).toBeUndefined()
    expect(opts.visualEffectState).toBeUndefined()
    expect(opts.backgroundColor).toBe('#ffffff')
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
