import { describe, expect, it, vi } from 'vitest'
import { extensionBrowser } from '@/shared/browser'
import { supportsAutoOpenPopup } from '@/shared/platformCapabilities'

describe('automatic action popup capability', () => {
  it.each([
    ['Chrome/126.0', false],
    ['Chrome/127.0', true],
    ['Chrome/127.0 Edg/127.0', true],
    ['Firefox/148.0', false],
    ['Firefox/149.0', true],
    ['Unknown/200.0', false],
  ])('checks gesture-free API availability for %s', (userAgent, expected) => {
    Object.assign(extensionBrowser, { action: { openPopup: vi.fn() } })
    expect(supportsAutoOpenPopup(userAgent)).toBe(expected)
  })
  it('requires the actual browser API even on a supported browser version', () => {
    Object.assign(extensionBrowser, { action: {} })
    expect(supportsAutoOpenPopup('Chrome/151.0')).toBe(false)
  })
})
