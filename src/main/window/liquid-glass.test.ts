import { describe, expect, it } from 'vitest'
import {
  isMacOS26OrLater,
  shouldEnableLiquidGlassByDefault,
  shouldUseLiquidGlassAtRuntime,
} from './liquid-glass'

describe('isMacOS26OrLater', () => {
  it('requires darwin', () => {
    expect(isMacOS26OrLater('linux', '26.0')).toBe(false)
    expect(isMacOS26OrLater('win32', '26.0')).toBe(false)
  })

  it('accepts macOS 26 and newer', () => {
    expect(isMacOS26OrLater('darwin', '26.0')).toBe(true)
    expect(isMacOS26OrLater('darwin', '27.1.2')).toBe(true)
  })

  it('rejects older or missing macOS versions', () => {
    expect(isMacOS26OrLater('darwin', '15.6.1')).toBe(false)
    expect(isMacOS26OrLater('darwin', undefined)).toBe(false)
    expect(isMacOS26OrLater('darwin', '26beta')).toBe(false)
  })
})

describe('shouldEnableLiquidGlassByDefault', () => {
  it('enables the production default on macOS 26 and newer', () => {
    expect(
      shouldEnableLiquidGlassByDefault({
        isDev: false,
        platform: 'darwin',
        systemVersion: '26.0',
      })
    ).toBe(true)
  })

  it('keeps the development default disabled', () => {
    expect(
      shouldEnableLiquidGlassByDefault({
        isDev: true,
        platform: 'darwin',
        systemVersion: '26.0',
      })
    ).toBe(false)
  })

  it('keeps the default disabled on unsupported systems', () => {
    expect(
      shouldEnableLiquidGlassByDefault({
        isDev: false,
        platform: 'darwin',
        systemVersion: '15.6.1',
      })
    ).toBe(false)
    expect(
      shouldEnableLiquidGlassByDefault({
        isDev: false,
        platform: 'linux',
        systemVersion: '26.0',
      })
    ).toBe(false)
  })
})

describe('shouldUseLiquidGlassAtRuntime', () => {
  it('lets the plugin handle fallback on any macOS version once enabled', () => {
    expect(shouldUseLiquidGlassAtRuntime(true, 'darwin')).toBe(true)
  })

  it('does not attach the macOS-only effect on other platforms', () => {
    expect(shouldUseLiquidGlassAtRuntime(true, 'linux')).toBe(false)
    expect(shouldUseLiquidGlassAtRuntime(true, 'win32')).toBe(false)
  })

  it('respects an explicit disabled setting', () => {
    expect(shouldUseLiquidGlassAtRuntime(false, 'darwin')).toBe(false)
  })
})
