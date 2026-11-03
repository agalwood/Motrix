import { describe, expect, it } from 'vitest'
import { shouldUseManualWindowDrag } from './window-drag'

describe('shouldUseManualWindowDrag', () => {
  it('uses native dragging outside the affected macOS versions', () => {
    expect(shouldUseManualWindowDrag('darwin', '27.1.1')).toBe(false)
    expect(shouldUseManualWindowDrag('win32', '27.2')).toBe(false)
    expect(shouldUseManualWindowDrag('web', '27.2')).toBe(false)
    expect(shouldUseManualWindowDrag('darwin', undefined)).toBe(false)
  })

  it('enables the fallback from macOS 27.2 onward', () => {
    expect(shouldUseManualWindowDrag('darwin', '27.2')).toBe(true)
    expect(shouldUseManualWindowDrag('darwin', '27.3.1')).toBe(true)
    expect(shouldUseManualWindowDrag('darwin', '28.0')).toBe(true)
  })
})
